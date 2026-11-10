// Subagents as pi processes in Rex panes. The parent opens each in a minimized floating pane, `rex wait`s on
// it in the background, and posts the child's last assistant message back as a new turn. A child
// runs with PI_SUBAGENT=1: it exits when its turn ends, takes the parent's messages on PI_SUBAGENT_SOCKET,
// and may spawn only PI_SUBAGENT_ALLOWED.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentDef, loadAgents } from "./agents.ts";

const ENTRY = "rex-subagent";
const RESULT = "rex-subagent-result";
const DELIVERED = "rex-subagent-delivered";
const WIDGET = "rex-subagents";
const ROOT = join(getAgentDir(), "subagents");
const MAX_RESULT_CHARS = 40_000;
const READONLY_TOOLS = ["read", "grep", "find", "bash"];
const SPAWN_TOOLS = ["subagent", "subagent_message", "subagent_wait", "subagent_list"];
// Model families the pstack sheet and agent files use; pi-claude-code serves them under claude-code/.
const FAMILIES: Record<string, string> = {
  opus: "claude-code/claude-opus-5-5",
  fable: "claude-code/claude-fable-5-1",
  sonnet: "claude-code/claude-sonnet-5-5",
  haiku: "claude-code/claude-haiku-5-5",
};
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type Status = "running" | "done" | "failed";
interface Child {
  name: string;
  agent?: string;
  block: string;
  sessionFile: string;
  cwd: string;
  worktree?: { path: string; branch: string };
  piArgs: string[];
  env: string[];
  status: Status;
  startedAt: number;
  exitCode?: number;
  outcome?: Outcome;
  // false from the moment a run finishes until its result is in the parent's transcript
  delivered?: boolean;
}
interface Outcome {
  name: string;
  status: Status;
  text: string;
}

const isChild = process.env.PI_SUBAGENT === "1";
const allowed = process.env.PI_SUBAGENT_ALLOWED?.split(",").filter(Boolean);

function lastAssistant(sessionFile: string): { text: string; ok: boolean } {
  let lines: string[];
  try {
    lines = readFileSync(sessionFile, "utf8").split("\n");
  } catch {
    return { text: "(no session file)", ok: false };
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      return { text: "(subagent session contains invalid JSON)", ok: false };
    }
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    const m = e.message;
    const text = (m.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (m.errorMessage) return { text: `${text}\n\nError: ${m.errorMessage}`.trim(), ok: false };
    if (text) return { text, ok: m.stopReason === "stop" };
  }
  return { text: "(no assistant reply)", ok: false };
}

function resolveModel(model: string | undefined, ctx: ExtensionContext): string | undefined {
  if (!model || model === "inherit-parent" || model === "auto") {
    return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  }
  return FAMILIES[model] ?? model;
}

// Unix socket paths are capped near 100 bytes, so a child's socket is named by a hash of its transcript path.
const socketPath = (sessionFile: string) =>
  join(tmpdir(), `pi-subagent-${createHash("sha256").update(sessionFile).digest("hex").slice(0, 16)}.sock`);

// One request per connection: {"message"} in, {"ok"} or {"error"} back.
function listen(path: string, onMessage: (message: string) => void): Server {
  rmSync(path, { force: true });
  const server = createServer((socket) => {
    socket.on("error", () => {});
    createInterface({ input: socket }).once("line", (line) => {
      let reply: { ok: true } | { error: string };
      try {
        const { message } = JSON.parse(line);
        if (typeof message !== "string" || !message) throw new Error("empty message");
        onMessage(message);
        reply = { ok: true };
      } catch (e) {
        reply = { error: e instanceof Error ? e.message : String(e) };
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  server.on("error", () => {});
  server.listen(path, () => chmodSync(path, 0o600));
  return server.unref();
}

function post(path: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(5000, () => socket.destroy(new Error("the subagent did not answer")));
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("the subagent closed the connection")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ message })}\n`));
    createInterface({ input: socket }).once("line", (line) => {
      try {
        const reply = JSON.parse(line);
        if (reply.ok) resolve();
        else reject(new Error(reply.error));
      } catch (e) {
        reject(e);
      }
      socket.destroy();
    });
  });
}

// A forked child starts from a copy of the parent's active branch. This extension's entries stay behind:
// a child allowed to spawn would adopt the parent's subagents on restore.
function writeFork(sessionFile: string, cwd: string, parent: ExtensionContext["sessionManager"]) {
  const header = SessionManager.create(cwd, dirname(sessionFile), { parentSession: parent.getSessionFile() }).getHeader();
  const dropped = new Map<string, string | null>();
  const entries: object[] = [];
  for (const e of parent.getBranch()) {
    const mapped = e.parentId === null ? undefined : dropped.get(e.parentId);
    const parentId = mapped === undefined ? e.parentId : mapped;
    if (e.type === "custom" && (e.customType === ENTRY || e.customType === DELIVERED)) dropped.set(e.id, parentId);
    else entries.push({ ...e, parentId });
  }
  writeFileSync(sessionFile, [header, ...entries].map((e) => `${JSON.stringify(e)}\n`).join(""));
}

const runKey = (c: { name: string; startedAt: number }) => `${c.name}@${c.startedAt}`;

const elapsed = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function (pi: ExtensionAPI) {
  const children = new Map<string, Child>();
  const finished = new Map<string, Promise<Outcome>>();
  const claimed = new Set<string>();
  const usedNames = new Set<string>();
  let ui: ExtensionContext | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let spawnLock: Promise<unknown> = Promise.resolve();
  // Aborted on session_shutdown: a wait still pending then belongs to a dead runtime, whose pi and
  // ctx throw on use. The replacement runtime re-watches running children from the session entries.
  let live = new AbortController();

  if (isChild) {
    const socket = process.env.PI_SUBAGENT_SOCKET;
    let inbox: Server | undefined;
    pi.on("session_start", async () => {
      // A steer queues behind the current turn's tool calls; an idle child starts a new turn with it.
      if (socket) inbox = listen(socket, (message) => pi.sendUserMessage(message, { deliverAs: "steer" }));
    });
    pi.on("session_shutdown", async () => {
      inbox?.close();
      inbox = undefined;
    });
    pi.on("agent_end", async (event, ctx) => {
      const last = [...event.messages].reverse().find((m) => m.role === "assistant") as
        | { stopReason?: string }
        | undefined;
      // An interrupted turn leaves the pane open for whoever pressed Escape.
      if (last?.stopReason === "aborted") return;
      if ([...children.values()].some((c) => c.status === "running")) return;
      ctx.shutdown();
    });
    if (!allowed) return;
  }

  const persist = (c: Child) => pi.appendEntry<Child>(ENTRY, { ...c });

  function outcomeFor(c: Child, text: string): Outcome {
    const body = text.length > MAX_RESULT_CHARS ? `…${text.slice(-MAX_RESULT_CHARS)}` : text;
    const wt = c.worktree ? `\nWorktree: ${c.worktree.path} (branch ${c.worktree.branch})` : "";
    return { name: c.name, status: c.status, text: `${body}${wt}` };
  }

  function announce(c: Child, triggerTurn: boolean) {
    pi.sendMessage(
      {
        customType: RESULT,
        content: `Subagent ${c.name} ${c.status} (transcript ${c.sessionFile}).\n\n${c.outcome!.text}`,
        display: true,
        details: { name: c.name, status: c.status, startedAt: c.startedAt },
      },
      { triggerTurn, deliverAs: "followUp" },
    );
  }

  // The result reached the parent's transcript, as a message or in a subagent_wait result.
  function confirm(c: Child | undefined) {
    if (c?.delivered !== false) return;
    c.delivered = true;
    pi.appendEntry(DELIVERED, { name: c.name, startedAt: c.startedAt });
  }

  // For an idle pi. Without a turn the message is appended at once, and extensions get no message_end for it.
  function append(c: Child) {
    announce(c, false);
    confirm(c);
  }

  async function steer(c: Child, message: string, signal?: AbortSignal) {
    // A child takes a few seconds to start listening.
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        return await post(socketPath(c.sessionFile), message);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ECONNREFUSED") throw e;
        if (c.status !== "running") throw new Error(`Subagent ${c.name} finished before taking the message; send it again to resume it.`);
        if (signal?.aborted || Date.now() > deadline) throw new Error(`Subagent ${c.name} has not started listening for messages; retry shortly.`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  function render() {
    if (!ui?.hasUI) return;
    const running = [...children.values()].filter((c) => c.status === "running");
    if (!running.length) {
      ui.ui.setWidget(WIDGET, undefined);
      if (ticker) clearInterval(ticker);
      ticker = undefined;
      return;
    }
    ui.ui.setWidget(
      WIDGET,
      running.map((c) => `▸ ${c.name}${c.agent && c.agent !== c.name ? ` (${c.agent})` : ""}  ${elapsed(Date.now() - c.startedAt)}`),
    );
    ticker ??= setInterval(render, 1000);
  }

  function watch(c: Child) {
    const done = (async (): Promise<Outcome> => {
      const signal = live.signal;
      const r = await pi.exec("rex", ["wait", c.block], { signal }).catch(() => undefined);
      if (signal.aborted || !r) return { name: c.name, status: c.status, text: "(session replaced before the subagent finished)" };
      const { text, ok } = lastAssistant(c.sessionFile);
      c.status = r.code === 0 && ok ? "done" : "failed";
      c.exitCode = r.code;
      const outcome = outcomeFor(c, text);
      c.outcome = outcome;
      c.delivered = false;
      persist(c);
      render();
      if (!claimed.has(c.name)) announce(c, true);
      return outcome;
    })();
    finished.set(c.name, done);
  }

  async function rexApi(method: string, args: object) {
    const r = await pi.exec("rex", ["api", "call", "-s", process.env.REX_SESSION!, method, JSON.stringify(args)]);
    if (r.code !== 0) throw new Error(`rex ${method} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return JSON.parse(r.stdout);
  }

  // Each child gets its own floating layer in the parent's window, minimized at once so the
  // parent's layout stays put; the user restores a child's pane to watch it.
  async function float(c: Child, task: string): Promise<string> {
    const run = async () => {
      const view = await rexApi("session.view", {});
      const win = view.windows?.find((w: any) => w.layers?.some((l: any) => l.blocks?.some((b: any) => b.block_id === process.env.REX_BLOCK)));
      const created = await rexApi("session.new_layer", {
        ...(win ? { window_id: win.window_id } : {}),
        bounds: [0.1, 0.1, 0.8, 0.8],
        focus: false,
        layout: {
          block: {
            flavor: "com.superlogical.terminal.shell",
            label: c.name,
            options: { cwd: c.cwd, command: ["env", ...c.env, `PI_SUBAGENT_SOCKET=${socketPath(c.sessionFile)}`, "pi", ...c.piArgs, "--session", c.sessionFile, "--", task] },
          },
        },
      });
      // A failed minimize leaves a visible child, which still works.
      await rexApi("session.set_layer_state", { layer_id: created.layer_id, state: "minimized" }).catch(() => undefined);
      return created.block_ids[0] as string;
    };
    const p = spawnLock.then(run, run);
    spawnLock = p.catch(() => undefined);
    return p;
  }

  function uniqueName(base: string) {
    const clean = base.replace(/[^A-Za-z0-9_.-]/g, "-");
    let name = clean;
    let i = 2;
    while (usedNames.has(name)) name = `${clean}-${i++}`;
    // Reserve before awaiting the pane: sibling spawns must not share a transcript.
    usedNames.add(name);
    return name;
  }

  async function addWorktree(cwd: string, name: string) {
    const top = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (top.code !== 0) throw new Error(`worktree: ${cwd} is not in a git repo`);
    const stamp = Date.now().toString(36);
    const branch = `subagent/${name}-${stamp}`;
    const path = join(ROOT, "worktrees", `${basename(top.stdout.trim())}-${name}-${stamp}`);
    const r = await pi.exec("git", ["worktree", "add", "-b", branch, path, "HEAD"], { cwd });
    if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
    return { path, branch };
  }

  function lookup(agent: string | undefined): AgentDef | undefined {
    if (!agent) {
      if (allowed) throw new Error(`This subagent may only spawn named agents: ${allowed.join(", ")}`);
      return undefined;
    }
    if (allowed && !allowed.includes(agent)) throw new Error(`This subagent may only spawn: ${allowed.join(", ")}`);
    const def = loadAgents().get(agent);
    if (!def) throw new Error(`Unknown agent "${agent}". Known: ${[...loadAgents().keys()].join(", ")}`);
    return def;
  }

  function restore(ctx: ExtensionContext) {
    // Tree navigation keeps the runtime: detach old watchers before rebuilding this branch.
    live.abort();
    live = new AbortController();
    ui = ctx;
    children.clear();
    finished.clear();
    claimed.clear();
    usedNames.clear();
    // Names stay reserved across branches because their transcript files are shared.
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type === "custom" && e.customType === ENTRY) usedNames.add((e.data as Child).name);
    }
    const delivered = new Set<string>();
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type !== "custom") continue;
      if (e.customType === ENTRY) {
        const c = { ...(e.data as Child) };
        children.set(c.name, c);
      } else if (e.customType === DELIVERED) {
        delivered.add(runKey(e.data as Child));
      }
    }
    for (const c of children.values()) {
      if (c.status === "running") {
        watch(c);
        continue;
      }
      finished.set(c.name, Promise.resolve(c.outcome ?? outcomeFor(c, lastAssistant(c.sessionFile).text)));
      if (c.delivered !== false) continue;
      if (delivered.has(runKey(c))) c.delivered = true;
      // The last runtime ended with this result still queued: add it now, without starting a turn.
      else append(c);
    }
    render();
  }

  pi.on("session_start", async (_e, ctx) => restore(ctx));
  pi.on("session_tree", async (_e, ctx) => restore(ctx));

  pi.on("message_end", async (event) => {
    const m = event.message as { role: string; customType?: string; details?: { name?: string; startedAt?: number } };
    if (m.role !== "custom" || m.customType !== RESULT) return;
    const c = children.get(m.details?.name ?? "");
    if (c?.startedAt === m.details?.startedAt) confirm(c);
  });

  // Escape empties pi's queue, taking a queued result with it. Put it back in the transcript, but leave
  // an agent the user just stopped alone.
  pi.on("agent_settled", async (event, ctx) => {
    if (ctx.hasPendingMessages()) return;
    for (const c of children.values()) {
      if (c.delivered !== false || claimed.has(c.name)) continue;
      if (event.aborted) append(c);
      else announce(c, true);
    }
  });

  pi.on("session_shutdown", async () => {
    live.abort();
    ui = undefined;
    if (ticker) clearInterval(ticker);
    ticker = undefined;
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Start a subagent: a separate pi in a minimized floating Rex pane, with its own context. Returns at once; " +
      "the child's final message arrives later as a new message (or collect several with subagent_wait). " +
      "The child sees only the task unless fork is set, so write a self-contained brief.",
    promptSnippet: "Start a pi subagent in a Rex pane (background; result arrives as a message)",
    promptGuidelines: [
      "After starting subagents, keep working on the main thread on anything that does not need their results (independent edits, reading, verification), and call subagent_wait only when the next step needs those results.",
      "Don't redo a running subagent's task on the main thread, and don't edit files a running non-worktree subagent may be editing.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Self-contained brief for the child" }),
      agent: Type.Optional(Type.String({ description: "Agent definition name (see subagent_list). Omit for a general-purpose child with the default tools." })),
      name: Type.Optional(Type.String({ description: "Unique handle for subagent_message/subagent_wait (default: the agent name)" })),
      model: Type.Optional(Type.String({ description: "opus, fable, sonnet, haiku, a provider/id, or inherit-parent. Default: the agent's model, else this session's" })),
      thinking: Type.Optional(StringEnum(THINKING, { description: "Reasoning effort. Default: the agent's, else this session's" })),
      readonly: Type.Optional(Type.Boolean({ description: "Limit the child to read, grep, find and bash, and tell it not to edit files" })),
      worktree: Type.Optional(Type.Boolean({ description: "Run the child in a new git worktree on its own branch" })),
      fork: Type.Optional(Type.Boolean({ description: "Start the child from a copy of this conversation, with the task as its next message" })),
      cwd: Type.Optional(Type.String({ description: "Working directory (default: this session's)" })),
    }),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      ui = ctx;
      if (!process.env.REX_BLOCK || !process.env.REX_SESSION) throw new Error("subagent needs pi running in a Rex pane (REX_BLOCK or REX_SESSION is unset).");
      const def = lookup(p.agent);
      const name = uniqueName(p.name ?? def?.name ?? "agent");
      let cwd = p.cwd ?? ctx.cwd;
      const worktree = p.worktree ? await addWorktree(cwd, name) : undefined;
      if (worktree) cwd = worktree.path;

      const dir = join(ROOT, ctx.sessionManager.getSessionId());
      mkdirSync(dir, { recursive: true });
      const sessionFile = join(dir, `${name}.jsonl`);
      const promptFile = join(dir, `${name}.prompt.md`);
      writeFileSync(
        promptFile,
        [
          `You are subagent "${name}", started by another pi session. Your final message is returned to it verbatim, so make it complete and self-contained.`,
          p.fork ? "Your history is a copy of that session's conversation up to the moment it started you; your task is the message after it." : "",
          p.readonly ? "Read-only task: do not edit, write, move or delete files, and run only commands that change nothing." : "",
          def?.systemPrompt ?? "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );

      if (p.fork) writeFork(sessionFile, cwd, ctx.sessionManager);

      const model = resolveModel(p.model ?? def?.model, ctx);
      const thinking = p.thinking ?? def?.thinking ?? pi.getThinkingLevel();
      let tools = p.readonly ? READONLY_TOOLS : def?.tools;
      if (tools && def?.spawns?.length) tools = [...tools, ...SPAWN_TOOLS];
      const piArgs = [
        ...(model ? ["--model", model] : []),
        "--thinking", thinking,
        ...(tools ? ["--tools", tools.join(",")] : []),
        "--append-system-prompt", promptFile,
      ];
      const env = ["PI_SUBAGENT=1", `PI_SUBAGENT_NAME=${name}`, ...(def?.spawns?.length ? [`PI_SUBAGENT_ALLOWED=${def.spawns.join(",")}`] : [])];

      const c: Child = { name, agent: def?.name, block: "", sessionFile, cwd, worktree, piArgs, env, status: "running", startedAt: Date.now() };
      c.block = await float(c, p.task);
      children.set(name, c);
      persist(c);
      watch(c);
      render();
      const desc = [def ? `agent ${def.name}` : "general-purpose", model, `thinking ${thinking}`, tools ? `tools ${tools.join(",")}` : "default tools"].filter(Boolean).join(", ");
      return {
        content: [{ type: "text", text: `Started ${name} (${desc}) in Rex pane ${c.block}${worktree ? `, worktree ${worktree.path}` : ""}. Its result arrives as a message when it finishes.` }],
        details: { name, block: c.block },
      };
    },
  });

  pi.registerTool({
    name: "subagent_message",
    label: "Message subagent",
    exposure: "deferred",
    description:
      "Send a message to a subagent by name. A running child reads it at its next turn boundary; a finished child is resumed with the message as its next task, in a new pane.",
    parameters: Type.Object({
      name: Type.String(),
      message: Type.String(),
    }),
    async execute(_id, p, signal, _onUpdate, ctx) {
      ui = ctx;
      const c = children.get(p.name);
      if (!c) throw new Error(`No subagent "${p.name}". Known: ${[...children.keys()].join(", ") || "none"}`);
      if (c.status === "running") {
        await steer(c, p.message, signal);
        return { content: [{ type: "text", text: `Sent to ${c.name}.` }], details: {} };
      }
      const resumed: Child = { ...c, status: "running", startedAt: Date.now(), outcome: undefined, exitCode: undefined, delivered: undefined };
      resumed.block = await float(resumed, p.message);
      claimed.delete(c.name);
      children.set(c.name, resumed);
      persist(resumed);
      watch(resumed);
      render();
      return { content: [{ type: "text", text: `Resumed ${c.name} in Rex pane ${c.block}. Its result arrives as a message.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for subagents",
    description: "Block until the named subagents (default: all running) finish, and return their final messages together instead of one message each.",
    parameters: Type.Object({
      names: Type.Optional(Type.Array(Type.String())),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    async execute(_id, p, signal, _onUpdate, ctx) {
      ui = ctx;
      const names = p.names ?? [...children.values()].filter((c) => c.status === "running").map((c) => c.name);
      const unknown = names.filter((n) => !finished.has(n));
      if (unknown.length) throw new Error(`No subagent: ${unknown.join(", ")}`);
      const pending = names.filter((n) => children.get(n)?.status === "running");
      for (const n of pending) claimed.add(n);
      const runtime = live;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopWaiting: () => void;
      const stop = new Promise<"stopped">((resolve) => {
        stopWaiting = () => resolve("stopped");
        signal?.addEventListener("abort", stopWaiting, { once: true });
        runtime.signal.addEventListener("abort", stopWaiting, { once: true });
        if (signal?.aborted || runtime.signal.aborted) stopWaiting();
        if (p.timeoutSeconds) timer = setTimeout(stopWaiting, p.timeoutSeconds * 1000);
      });
      const all = Promise.all(names.map((n) => finished.get(n)!));
      let r: Outcome[] | "stopped";
      try {
        r = await Promise.race([all, stop]);
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", stopWaiting!);
        runtime.signal.removeEventListener("abort", stopWaiting!);
      }
      if (runtime.signal.aborted) {
        return { content: [{ type: "text", text: "Wait cancelled: session or active branch changed." }], details: {} };
      }
      if (r === "stopped") {
        // Whatever is still running reports by message as usual.
        const still = pending.filter((n) => children.get(n)?.status === "running");
        for (const n of still) claimed.delete(n);
        const done = names.filter((n) => !still.includes(n));
        const got = await Promise.all(done.map((n) => finished.get(n)!));
        for (const n of done) confirm(children.get(n));
        const text = [...got.map((o) => `## ${o.name} (${o.status})\n\n${o.text}`), `Still running: ${still.join(", ")}`].join("\n\n");
        return { content: [{ type: "text", text }], details: {} };
      }
      for (const n of names) confirm(children.get(n));
      return { content: [{ type: "text", text: r.map((o) => `## ${o.name} (${o.status})\n\n${o.text}`).join("\n\n") }], details: {} };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List subagents",
    exposure: "deferred",
    description: "List the agent definitions subagent can start, and this session's subagents with their status.",
    parameters: Type.Object({}),
    async execute() {
      const defs = [...loadAgents().values()]
        .filter((a) => !allowed || allowed.includes(a.name))
        .map((a) => `- ${a.name}: ${a.description}${a.model ? ` [${a.model}]` : ""}${a.tools ? ` tools: ${a.tools.join(",")}` : ""}`);
      const kids = [...children.values()].map((c) => `- ${c.name}: ${c.status}${c.agent ? ` (${c.agent})` : ""}, pane ${c.block}, transcript ${c.sessionFile}`);
      return {
        content: [{ type: "text", text: `Agents:\n${defs.join("\n") || "(none)"}\n\nSubagents:\n${kids.join("\n") || "(none)"}` }],
        details: {},
      };
    },
  });
}
