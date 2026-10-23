import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentDef {
  name: string;
  description: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  spawns?: string[];
  systemPrompt: string;
  file: string;
}

const BUNDLED_DIR = join(dirname(fileURLToPath(import.meta.url)), "agents");
// pi loads each extension in its own module instance, so other extensions (pstack) add
// agent directories through a process global instead of importing this module.
const REGISTERED = Symbol.for("rex-subagents.agentDirs");

export function registeredAgentDirs(): Set<string> {
  const g = globalThis as { [REGISTERED]?: Set<string> };
  return (g[REGISTERED] ??= new Set());
}

const list = (v: unknown) =>
  typeof v === "string"
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function readDir(dir: string): AgentDef[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const file = join(dir, n);
    const { frontmatter: fm, body } = parseFrontmatter(readFileSync(file, "utf8"));
    const name = str(fm.name);
    if (!name) return [];
    return [
      {
        name,
        description: str(fm.description) ?? "",
        model: str(fm.model),
        thinking: str(fm.thinking),
        tools: list(fm.tools),
        spawns: list(fm.spawns),
        systemPrompt: body.trim(),
        file,
      },
    ];
  });
}

// Later directories win: ~/.pi/agent/agents overrides registered and bundled agents of the same name.
export function loadAgents(): Map<string, AgentDef> {
  const dirs = [BUNDLED_DIR, ...registeredAgentDirs(), join(getAgentDir(), "agents")];
  const agents = new Map<string, AgentDef>();
  for (const dir of dirs) for (const a of readDir(dir)) agents.set(a.name, a);
  return agents;
}
