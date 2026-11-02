import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, afterEach, test as nodeTest } from "node:test";

const test = (name: string, fn: () => Promise<void>) => nodeTest(name, { timeout: 1000 }, fn);
import { fileURLToPath } from "node:url";

// Resolve the installed harness, not a second copy of its runtime dependencies.
const piBin = realpathSync(execFileSync("/bin/bash", ["-c", "command -v pi"], { encoding: "utf8" }).trim());
const piDir = process.env.PI_PACKAGE_DIR ?? resolve(dirname(piBin), "../lib/pi/node_modules/@earendil-works/pi-coding-agent");
const require = createRequire(join(piDir, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(piDir, "dist/index.js"),
    "@earendil-works/pi-ai": resolve(piDir, "../pi-ai/dist/compat.js"),
    typebox: require.resolve("typebox"),
  },
});
const source = process.env.SUBAGENT_EXTENSION ?? fileURLToPath(new URL("../index.ts", import.meta.url));
const fixture = JSON.parse(readFileSync(new URL("./recorded.json", import.meta.url), "utf8"));
const agentDir = mkdtempSync(join(tmpdir(), "rex-recovery-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.REX_BLOCK = fixture.child.block;
process.env.REX_SESSION = "session:test";
delete process.env.PI_SUBAGENT;
const { default: extension } = await jiti.import(source);
after(() => rmSync(agentDir, { recursive: true, force: true }));
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(branchChildren: any[], otherChildren: any[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "rex-recovery-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, "child.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "message", message: fixture.message }) + "\n");
  const child = { ...fixture.child, cwd: dir, sessionFile, piArgs: [], env: [] };
  const entries = (items: any[]) => items.map((patch) => ({ type: "custom", customType: "rex-subagent", data: { ...child, ...patch } }));
  let branch = entries(branchChildren);
  const all = [...branch, ...entries(otherChildren)];
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const messages: any[] = [];
  const persisted: any[] = [];
  const waits: { signal: AbortSignal; finish: (code?: number) => void }[] = [];
  let splitError = false;
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: any) => {
      const entry = { type: "custom", customType, data: structuredClone(data) };
      branch.push(entry);
      all.push(entry);
      persisted.push(entry);
    },
    sendMessage: (message: any) => messages.push(message),
    getThinkingLevel: () => "medium",
    exec: async (_command: string, args: string[], opts: any) => {
      if (args[0] === "wait") return new Promise((resolveWait) => {
        const finish = (code = 0) => resolveWait({ code });
        opts.signal.addEventListener("abort", () => finish(1), { once: true });
        waits.push({ signal: opts.signal, finish });
      });
      if (args[0] === "api") {
        const method = args[4];
        if (method === "session.view") return { code: 0, stdout: JSON.stringify({ windows: [] }) };
        if (method === "session.set_layer_state") return { code: 0, stdout: "{}" };
        if (method === "session.new_layer") {
          if (splitError) return { code: 1, stderr: "recorded pane unavailable" };
          return { code: 0, stdout: JSON.stringify({ layer_id: "layer:test", block_ids: [fixture.child.block] }) };
        }
      }
      throw new Error(`Unexpected exec: ${args.join(" ")}`);
    },
  };
  extension(pi);
  const ctx = {
    hasUI: false,
    cwd: dir,
    sessionManager: { getBranch: () => branch, getEntries: () => all, getSessionId: () => fixture.sessionId },
  };
  const emit = async (name: string) => handlers.get(name)?.({}, ctx);
  cleanups.push(() => emit("session_shutdown"));
  const call = (name: string, params = {}, signal?: AbortSignal) => tools.get(name).execute("", params, signal, undefined, ctx);
  const wait = (params = {}, signal?: AbortSignal) => call("subagent_wait", params, signal);
  const list = async () => (await call("subagent_list")).content[0].text;
  return {
    child, sessionFile, messages, persisted, waits, ctx, emit, call, wait, list,
    navigate: async (items: any[]) => { branch = entries(items); await emit("session_tree"); },
    failSplits: () => { splitError = true; },
    branch: () => branch,
  };
}

const answer = fixture.message.content.find((part: any) => part.type === "text").text;

test("restores only active-branch children and can wait for a legacy completed child", async () => {
  const h = harness([{ status: "done" }], [{ name: "abandoned", status: "running" }]);
  await h.emit("session_start");
  assert.doesNotMatch(await h.list(), /abandoned/);
  const result = await h.wait({ names: [h.child.name] });
  assert.match(result.content[0].text, /\(done\)/);
  assert.ok(result.content[0].text.includes(answer));
  assert.equal(h.waits.length, 0);
  assert.equal(h.messages.length, 0);
});

test("restores persisted outcomes without needing the child transcript or sending duplicate notifications", async () => {
  const h = harness([{ status: "failed", outcome: { name: fixture.child.name, status: "failed", text: answer } }]);
  rmSync(h.sessionFile);
  await h.emit("session_start");
  const result = await h.wait({ names: [h.child.name] });
  assert.ok(result.content[0].text.includes(answer));
  assert.match(result.content[0].text, /\(failed\)/);
  assert.equal(h.messages.length, 0);
});

test("reports a missing or malformed legacy transcript without breaking session restoration", async () => {
  const h = harness([{ status: "done" }]);
  writeFileSync(h.sessionFile, "{partial");
  await h.emit("session_start");
  assert.match((await h.wait({ names: [h.child.name] })).content[0].text, /invalid JSON/);
  rmSync(h.sessionFile);
  await h.emit("session_start");
  assert.match((await h.wait({ names: [h.child.name] })).content[0].text, /no session file/);
});

test("running children survive runtime replacement and persist a reusable outcome", async () => {
  const h = harness([{}]);
  await h.emit("session_start");
  const oldWait = h.waits[0];
  await h.emit("session_shutdown");
  await h.emit("session_start");
  assert.equal(oldWait.signal.aborted, true);
  assert.equal(h.waits.length, 2);
  const waiting = h.wait({ names: [h.child.name], timeoutSeconds: 1 });
  h.waits[1].finish();
  const result = await waiting;
  assert.ok(result.content[0].text.includes(answer));
  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0].data.outcome.text, answer);
  assert.equal(h.messages.length, 0);
  await h.emit("session_start");
  assert.ok((await h.wait({ names: [h.child.name] })).content[0].text.includes(answer));
  assert.equal(h.waits.length, 2);
});

test("watch completion does not mutate historical entry data", async () => {
  const h = harness([{}]);
  const historical = structuredClone(h.branch()[0]);
  await h.emit("session_start");
  h.waits[0].finish();
  await h.wait({ names: [h.child.name] });
  assert.deepEqual(h.branch()[0], historical);
});

test("tree navigation detaches abandoned watchers and cancels pending waits", async () => {
  const h = harness([{}]);
  await h.emit("session_start");
  const waiting = h.wait({ names: [h.child.name] });
  await h.navigate([]);
  assert.match((await waiting).content[0].text, /active branch changed/);
  assert.equal(h.waits[0].signal.aborted, true);
  assert.doesNotMatch(await h.list(), new RegExp(h.child.name));
  assert.equal(h.persisted.length, 0);
  assert.equal(h.messages.length, 0);
});

test("timed-out waits release notification ownership and completion is delivered once", async () => {
  const h = harness([{}]);
  await h.emit("session_start");
  assert.match((await h.wait({ names: [h.child.name], timeoutSeconds: 0.001 })).content[0].text, /Still running/);
  h.waits[0].finish();
  await new Promise(setImmediate);
  await h.wait({ names: [h.child.name] });
  assert.equal(h.messages.length, 1);
  assert.ok(h.messages[0].content.includes(answer));
});

test("an already aborted wait releases ownership for later notification", async () => {
  const h = harness([{}]);
  await h.emit("session_start");
  const signal = AbortSignal.abort();
  assert.match((await h.wait({ names: [h.child.name] }, signal)).content[0].text, /Still running/);
  h.waits[0].finish();
  await new Promise(setImmediate);
  await h.wait({ names: [h.child.name] });
  assert.equal(h.messages.length, 1);
});

test("resuming a finished child discards its previous outcome", async () => {
  const h = harness([{ status: "done", outcome: { name: fixture.child.name, status: "done", text: "old result" } }]);
  await h.emit("session_start");
  await h.call("subagent_message", { name: h.child.name, message: "Continue" });
  assert.equal(h.persisted[0].data.outcome, undefined);
  assert.equal(h.persisted[0].data.status, "running");
  const waiting = h.wait({ names: [h.child.name] });
  h.waits[0].finish();
  assert.ok((await waiting).content[0].text.includes(answer));
});

test("failed resume keeps the completed child and its outcome", async () => {
  const h = harness([{ status: "done", outcome: { name: fixture.child.name, status: "done", text: answer } }]);
  await h.emit("session_start");
  h.failSplits();
  await assert.rejects(h.call("subagent_message", { name: h.child.name, message: "Continue" }), /rex session.new_layer failed/);
  assert.match(await h.list(), /: done/);
  assert.ok((await h.wait({ names: [h.child.name] })).content[0].text.includes(answer));
});

test("abandoned branch names stay reserved without restoring the abandoned child", async () => {
  const h = harness([], [{}]);
  await h.emit("session_start");
  const result = await h.call("subagent", { name: h.child.name, task: "Inspect configuration" });
  assert.equal(result.details.name, `${h.child.name}-2`);
  assert.equal(h.waits.length, 1);
});

test("concurrent sibling spawns reserve different transcript names", async () => {
  const h = harness([]);
  await h.emit("session_start");
  const results = await Promise.all([
    h.call("subagent", { name: h.child.name, task: "Inspect configuration" }),
    h.call("subagent", { name: h.child.name, task: "Inspect configuration" }),
  ]);
  assert.deepEqual(results.map((result) => result.details.name), [h.child.name, `${h.child.name}-2`]);
  assert.notEqual(h.persisted[0].data.sessionFile, h.persisted[1].data.sessionFile);
});
