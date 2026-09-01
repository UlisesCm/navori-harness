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

/**
 * The YAML frontmatter block, or "" when the file has none.
 *
 * Only the frontmatter declares anything. A `tools:` line in the BODY is prose —
 * an example, a template, an agent that documents the field — and reading it as
 * a declaration reported an agent with full access as blind, which fabricates
 * `high`-severity waste out of a paragraph (#561).
 */
function frontmatter(body: string): string {
  return /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body)?.[1] ?? "";
}

/** Trims each entry, drops YAML quoting, and discards the empties. */
function normalizeTools(values: string[]): string[] {
  return values
    .map((v) =>
      v
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * `tools:` in any of the three shapes YAML accepts for it: an inline
 * comma-separated list, a flow sequence, or a block list underneath. Null when
 * the field is absent or empty — the agent then inherits everything, which is
 * also the safe answer for an unparseable field: it withholds a signal instead
 * of inventing one.
 */
function parseToolsField(fm: string): string[] | null {
  // `[ \t]` and not `\s`: `\s` crosses the newline, and a block list would then
  // be read as the single entry `- Read` (#561).
  const inline = /^tools:[ \t]*(\S.*?)[ \t]*$/m.exec(fm);
  if (inline?.[1]) {
    const tools = normalizeTools(inline[1].replace(/^\[/, "").replace(/\]$/, "").split(","));
    return tools.length > 0 ? tools : null;
  }
  const block = /^tools:[ \t]*\r?\n((?:[ \t]*-[ \t]*.+(?:\r?\n|$))+)/m.exec(fm);
  if (block?.[1]) {
    const entries = block[1].split(/\r?\n/).map((line) => line.replace(/^[ \t]*-[ \t]*/, ""));
    const tools = normalizeTools(entries);
    return tools.length > 0 ? tools : null;
  }
  return null;
}

function parseAgent(file: string, name: string): DeclaredAgent {
  let body = "";
  try {
    body = readFileSync(file, "utf-8");
  } catch {
    return { name, tools: null, hasMcp: true };
  }
  const tools = parseToolsField(frontmatter(body));
  if (!tools) return { name, tools: null, hasMcp: true };
  return { name, tools, hasMcp: tools.some((t) => t.startsWith("mcp__") || t === "*") };
}

/**
 * Offsets where a real `## ` heading starts.
 *
 * Real means: not inside a fenced block. A CLAUDE.md that documents a template
 * carries headings inside ``` fences, and taking one as a section boundary both
 * invents a section and truncates the one it interrupted — moving that
 * section's `requiresMcp` and its token cost onto a phantom (#561).
 */
function headingOffsets(claudeMd: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  let fenced = false;
  for (const line of claudeMd.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && line.startsWith("## ")) offsets.push(offset);
    offset += line.length + 1; // the "\n" that split() removed
  }
  return offsets;
}

/** Splits CLAUDE.md on `## ` headings and sizes each section. */
function parseSections(claudeMd: string): DeclaredSection[] {
  // Slice on the offsets rather than String.split: every byte of the file lands
  // in exactly one section, which is what makes the token totals add up.
  const bounds = [0, ...headingOffsets(claudeMd), claudeMd.length];
  const parts: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const part = claudeMd.slice(bounds[i], bounds[i + 1]);
    if (part.length > 0) parts.push(part);
  }
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
