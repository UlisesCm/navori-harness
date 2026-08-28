import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads what the harness DECLARES, so the audit can compare it against what a
 * session actually did.
 *
 * This is the half no external tool can produce: Claude Code's transcript
 * records the SIZE of an agent's initial context but never its CONTENT, so
 * attributing that cost to specific CLAUDE.md sections — or noticing that a
 * section orders a tool the agent cannot reach — requires reading the repo's
 * own harness files.
 */

export interface DeclaredAgent {
  name: string;
  /** `tools:` frontmatter split into names; null when the field is absent. */
  tools: string[] | null;
  /**
   * Whether the agent can reach MCP tools.
   *
   * `tools:` is an allowlist that covers MCP servers too (per the subagents
   * docs), so an explicit list without any `mcp__` entry means every MCP tool
   * is unreachable for that agent — however emphatically CLAUDE.md instructs
   * otherwise. Omitting `tools:` inherits everything.
   */
  hasMcp: boolean;
}

export interface DeclaredSection {
  title: string;
  chars: number;
  /** Rough token estimate (chars/4). Labelled as an estimate in the report. */
  tokens: number;
  /** MCP servers this section instructs the reader to use. */
  requiresMcp: string[];
}

export interface HarnessCatalog {
  agents: DeclaredAgent[];
  skills: string[];
  sections: DeclaredSection[];
  claudeMdTokens: number;
  /** The MCP servers this harness instructs agents to use. Exposed from
   *  `MCP_HINTS` rather than re-listed by the report: a server named in two
   *  places is a server that will be named in only one of them after the next
   *  edit. */
  mcpFamilies: string[];
}

/** MCP tool families the harness may instruct agents to use. */
const MCP_HINTS: Array<{ server: string; pattern: RegExp }> = [
  { server: "codegraph", pattern: /codegraph_explore|mcp__codegraph/ },
  { server: "engram", pattern: /mem_search|mem_save|mem_context|mcp__engram/ },
];

function parseAgent(file: string, name: string): DeclaredAgent {
  let body = "";
  try {
    body = readFileSync(file, "utf-8");
  } catch {
    return { name, tools: null, hasMcp: true };
  }
  const m = /^tools:\s*(.+)$/m.exec(body);
  if (!m?.[1]) return { name, tools: null, hasMcp: true };
  const tools = m[1]
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return { name, tools, hasMcp: tools.some((t) => t.startsWith("mcp__") || t === "*") };
}

/** Splits CLAUDE.md on `## ` headings and sizes each section. */
function parseSections(claudeMd: string): DeclaredSection[] {
  const parts = claudeMd.split(/^(?=## )/m);
  const out: DeclaredSection[] = [];
  for (const part of parts) {
    const title = (part.split("\n", 1)[0] ?? "").replace(/^#+\s*/, "").trim();
    if (!title) continue;
    const requiresMcp = MCP_HINTS.filter((h) => h.pattern.test(part)).map((h) => h.server);
    out.push({
      title,
      chars: part.length,
      tokens: Math.round(part.length / 4),
      requiresMcp,
    });
  }
  return out;
}

/** Reads the declared harness of a repo. Missing pieces degrade to empty. */
export function readHarnessCatalog(repoRoot: string): HarnessCatalog {
  const agentsDir = join(repoRoot, ".claude", "agents");
  const agents: DeclaredAgent[] = [];
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (!f.endsWith(".md")) continue;
      agents.push(parseAgent(join(agentsDir, f), f.replace(/\.md$/, "")));
    }
  }

  const skillsDir = join(repoRoot, ".claude", "skills");
  const skills: string[] = [];
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md"))) {
        skills.push(entry.name);
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
        skills.push(entry.name.replace(/\.md$/, ""));
      }
    }
  }

  let claudeMd = "";
  try {
    claudeMd = readFileSync(join(repoRoot, "CLAUDE.md"), "utf-8");
  } catch {
    // No CLAUDE.md: adherence signals that need it simply won't fire.
  }

  return {
    agents: agents.sort((a, b) => a.name.localeCompare(b.name)),
    mcpFamilies: MCP_HINTS.map((h) => h.server).sort(),
    skills: skills.sort(),
    sections: parseSections(claudeMd),
    claudeMdTokens: Math.round(claudeMd.length / 4),
  };
}
