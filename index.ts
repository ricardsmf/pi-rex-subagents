// Subagents as pi processes in Rex panes. The parent splits a pane beside itself, `rex wait`s on
// it in the background, and posts the child's last assistant message back as a new turn. A child
// runs with PI_SUBAGENT=1: it exits when its turn ends, and may spawn only PI_SUBAGENT_ALLOWED.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentDef, loadAgents } from "./agents.ts";

const ENTRY = "rex-subagent";
const RESULT = "rex-subagent-result";
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
  let lastPane: string | undefined;
  // Aborted on session_shutdown: a wait still pending then belongs to a dead runtime, whose pi and
  // ctx throw on use. The replacement runtime re-watches running children from the session entries.
  let live = new AbortController();

  if (isChild) {
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
      persist(c);
      render();
      if (!claimed.has(c.name)) {
        pi.sendMessage(
          {
            customType: RESULT,
            content: `Subagent ${c.name} ${c.status} (transcript ${c.sessionFile}).\n\n${outcome.text}`,
            display: true,
            details: { name: c.name, status: c.status },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
      return outcome;
    })();
    finished.set(c.name, done);
  }

  async function split(c: Child, task: string): Promise<string> {
    const run = async () => {
      // Stack children below the newest one; the first goes to the right of the parent.
      const anchors: [string, string][] = lastPane ? [[lastPane, "below"], [process.env.REX_BLOCK!, "right"]] : [[process.env.REX_BLOCK!, "right"]];
      let err = "";
      for (const [anchor, dir] of anchors) {
        const r = await pi.exec("rex", [
          "split", "--json", "--focus=false", "-b", anchor, `--split=${dir}`,
          ...(dir === "right" ? ["--ratio", "45"] : []),
          "--label", c.name, "--cwd", c.cwd,
          "--", "env", ...c.env, "pi", ...c.piArgs, "--session", c.sessionFile, "--", task,
        ]);
        if (r.code === 0) {
          lastPane = JSON.parse(r.stdout).block_ids[0] as string;
          return lastPane;
        }
        err = r.stderr.trim() || r.stdout.trim();
      }
      throw new Error(`rex split failed: ${err}`);
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
    // Reserve before awaiting split: sibling spawns must not share a transcript.
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
    lastPane = undefined;
    // Names stay reserved across branches because their transcript files are shared.
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type === "custom" && e.customType === ENTRY) usedNames.add((e.data as Child).name);
    }
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "custom" && e.customType === ENTRY) {
        const c = { ...(e.data as Child) };
        children.set(c.name, c);
      }
    }
    for (const c of children.values()) {
      if (c.status === "running") watch(c);
      else finished.set(c.name, Promise.resolve(c.outcome ?? outcomeFor(c, lastAssistant(c.sessionFile).text)));
    }
    render();
  }

  pi.on("session_start", async (_e, ctx) => restore(ctx));
  pi.on("session_tree", async (_e, ctx) => restore(ctx));

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
      "Start a subagent: a separate pi in a Rex pane beside this one, with its own context. Returns at once; " +
      "the child's final message arrives later as a new message (or collect several with subagent_wait). " +
      "The child sees only the task, so write a self-contained brief.",
    promptSnippet: "Start a pi subagent in a Rex pane (background; result arrives as a message)",
    promptGuidelines: [
      "After starting subagents, keep working on the main thread on anything that does not need their results (independent edits, reading, verification), and call subagent_wait only when the next step needs those results.",
      "Don't redo a running subagent's task on the main thread, and don't edit files a running non-worktree subagent may be editing.",
      "With nothing left to do but wait, end the turn or call subagent_wait; each subagent result arrives as a message when it finishes.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Self-contained brief for the child" }),
      agent: Type.Optional(Type.String({ description: "Agent definition name (see subagent_list). Omit for a general-purpose child with the default tools." })),
      name: Type.Optional(Type.String({ description: "Unique handle for subagent_message/subagent_wait (default: the agent name)" })),
      model: Type.Optional(Type.String({ description: "opus, fable, sonnet, haiku, a provider/id, or inherit-parent. Default: the agent's model, else this session's" })),
      thinking: Type.Optional(StringEnum(THINKING, { description: "Reasoning effort. Default: the agent's, else this session's" })),
      readonly: Type.Optional(Type.Boolean({ description: "Limit the child to read, grep, find and bash, and tell it not to edit files" })),
      worktree: Type.Optional(Type.Boolean({ description: "Run the child in a new git worktree on its own branch" })),
      cwd: Type.Optional(Type.String({ description: "Working directory (default: this session's)" })),
    }),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      ui = ctx;
      if (!process.env.REX_BLOCK) throw new Error("subagent needs pi running in a Rex pane (REX_BLOCK is unset).");
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
          p.readonly ? "Read-only task: do not edit, write, move or delete files, and run only commands that change nothing." : "",
          def?.systemPrompt ?? "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );

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
      c.block = await split(c, p.task);
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
    description:
      "Send a message to a subagent by name. A running child reads it at its next turn boundary; a finished child is resumed with the message as its next task, in a new pane.",
    parameters: Type.Object({
      name: Type.String(),
      message: Type.String(),
    }),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      ui = ctx;
      const c = children.get(p.name);
      if (!c) throw new Error(`No subagent "${p.name}". Known: ${[...children.keys()].join(", ") || "none"}`);
      if (c.status === "running") {
        // A newline would submit early, so the message goes in as one line.
        const text = p.message.replace(/\s*\n\s*/g, " ");
        const sent = await pi.exec("rex", ["send", "-b", c.block, text]);
        const enter = sent.code === 0 ? await pi.exec("rex", ["send-key", "-b", c.block, "enter"]) : sent;
        if (enter.code !== 0) throw new Error(`rex send failed: ${enter.stderr.trim()}`);
        return { content: [{ type: "text", text: `Sent to ${c.name}.` }], details: {} };
      }
      const resumed: Child = { ...c, status: "running", startedAt: Date.now(), outcome: undefined, exitCode: undefined };
      resumed.block = await split(resumed, p.message);
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
        const text = [...got.map((o) => `## ${o.name} (${o.status})\n\n${o.text}`), `Still running: ${still.join(", ")}`].join("\n\n");
        return { content: [{ type: "text", text }], details: {} };
      }
      return { content: [{ type: "text", text: r.map((o) => `## ${o.name} (${o.status})\n\n${o.text}`).join("\n\n") }], details: {} };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List subagents",
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
