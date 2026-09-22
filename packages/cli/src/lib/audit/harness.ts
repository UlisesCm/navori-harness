import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listMarkers } from "../health.ts";

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
  /**
   * Frontmatter `omitClaudeMd: true` — per the sub-agents doc, such an agent
   * loads only the managed policy files (or none at all, from managed
   * settings), never the CLAUDE.md hierarchy this catalog measures. Optional
   * so existing `DeclaredAgent` literals elsewhere in the audit module (test
   * fixtures, `report.ts`) do not need updating just to add this field;
   * absent reads as `false`, the same permissive default `parseAgent` used
   * before this field existed.
   */
  omitClaudeMd?: boolean;
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
  /**
   * The subset of `skills` that navori renders, by their managed marker.
   *
   * The `unused-skills` finding used to name every idle skill in one bag —
   * 35 of them on a real session — which told the reader nothing about what to
   * do: a skill the preset ships and one the user wrote by hand are the same
   * sentence but different decisions.
   */
  managedSkills: string[];
  sections: DeclaredSection[];
  claudeMdTokens: number;
  /**
   * The `~/.claude/CLAUDE.md` layer a subagent also loads at startup, per the
   * sub-agents doc ("every level of the CLAUDE.md hierarchy the main
   * conversation loads, including `~/.claude/CLAUDE.md`"). `null` when this
   * machine has none.
   *
   * Only size and section TITLES travel here, never the body (#926): the
   * global file is scoped to the MACHINE, not the repo, and a report shared
   * between repos would otherwise leak whatever it holds — on the machine
   * this was written on, another workspace's project dictionary. Titles are
   * still enough to surface the finding this exists for ("this section
   * doesn't apply to anything in this repo") without exposing content.
   */
  globalClaudeMd?: { tokens: number; sections: Array<{ title: string; tokens: number }> } | null;
  /**
   * Hierarchy layers this audit never attempts to read: `CLAUDE.local.md`,
   * managed policy files, and any `AGENTS.md` loaded as project instructions
   * (#926). Declared explicitly rather than silently missing from
   * `claudeMdTokens`, so a signal built on it states what it did not observe
   * instead of presenting the repo's `CLAUDE.md` — or `CLAUDE.md` + the
   * global — as the whole hierarchy a subagent pays for.
   */
  notObserved?: string[];
  /** The MCP servers this harness instructs agents to use. Exposed from
   *  `MCP_HINTS` rather than re-listed by the report: a server named in two
   *  places is a server that will be named in only one of them after the next
   *  edit. */
  mcpFamilies: string[];
}

/**
 * MCP tool families the harness may instruct agents to use.
 *
 * A RECOGNITION table over the prose of the repo being AUDITED — not a
 * declaration of which plugins this navori bundles. The two are different
 * questions and only the first one belongs here: `navori audit` runs against
 * whatever `CLAUDE.md` a repo has on disk, which is routinely the output of an
 * older render, of another engine, or of a server the user wired by hand.
 *
 * So an entry OUTLIVES its plugin, and `codegraph` is the live case: it was
 * retired from the engine on 2026-09-15, and every repo that has not
 * re-rendered still ships the `codegraph-protocol` block in its `CLAUDE.md`.
 * Dropping the entry does not merely stop naming a server — it silently moves
 * numbers, which is the failure this whole module exists to prevent. An
 * unattributed section contributes 0 to `barredMcpTokens`, so in
 * `unreachableInstructions` (`signals.ts`) the agent is skipped by
 * `if (perRun === 0) continue` and vanishes from the `affected` count; `wasted`
 * shrinks by exactly what that section cost; `if (wasted === 0) return []` can
 * kill the finding outright; and `wasted >= UNREACHABLE_HIGH_TOKENS` can demote
 * it from `high` to `warn`. Nothing in the output says any of that happened, and
 * `schemaVersion` does not move for a hint-table edit.
 *
 * The rule for appending, then, is "a server some harness in the park names",
 * not "a plugin this binary ships" — and an entry is only ever removed when no
 * audited repo can still be carrying that prose.
 */
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

/**
 * `omitClaudeMd: true` in the frontmatter — the one boolean flag this module
 * reads that way. Anything else (missing, `false`, unparseable) reads as
 * `false`, the safe default: assuming an agent loads the hierarchy when it
 * actually skips it only under-attributes a cost, never invents one.
 */
function parseOmitClaudeMd(fm: string): boolean {
  const m = /^omitClaudeMd:[ \t]*(\S+)/m.exec(fm);
  return m?.[1]?.replace(/^["']|["']$/g, "") === "true";
}

function parseAgent(file: string, name: string): DeclaredAgent {
  let body = "";
  try {
    body = readFileSync(file, "utf-8");
  } catch {
    return { name, tools: null, hasMcp: true, omitClaudeMd: false };
  }
  const fm = frontmatter(body);
  const tools = parseToolsField(fm);
  const omitClaudeMd = parseOmitClaudeMd(fm);
  if (!tools) return { name, tools: null, hasMcp: true, omitClaudeMd };
  return {
    name,
    tools,
    hasMcp: tools.some((t) => t.startsWith("mcp__") || t === "*"),
    omitClaudeMd,
  };
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

/**
 * Hierarchy layers this audit never attempts to read (#926): `CLAUDE.local.md`
 * is repo-local but frequently gitignored and out of the render pipeline this
 * module otherwise trusts; managed policy files and `AGENTS.md` project
 * instructions have no single, predictable path this function can assume
 * across engines. Declared as a constant so the report always names what it
 * skipped, not just what it read.
 */
const HIERARCHY_NOT_OBSERVED = ["CLAUDE.local.md", "managed policy files", "AGENTS.md"];

/**
 * The `~/.claude/CLAUDE.md` layer, read for size and section titles only —
 * never the body (see `HarnessCatalog.globalClaudeMd`). `null` when the file
 * does not exist, which is a legitimate machine state, not a gap.
 */
function readGlobalClaudeMd(
  homeDir: string,
): { tokens: number; sections: Array<{ title: string; tokens: number }> } | null {
  let body = "";
  try {
    body = readFileSync(join(homeDir, ".claude", "CLAUDE.md"), "utf-8");
  } catch {
    return null;
  }
  return {
    tokens: Math.round(body.length / 4),
    sections: parseSections(body).map((s) => ({ title: s.title, tokens: s.tokens })),
  };
}

/**
 * Reads the declared harness of a repo. Missing pieces degrade to empty.
 *
 * `homeDir` defaults to the real home directory and exists as a parameter
 * only so tests can point it at a fixture instead of this machine's actual
 * `~/.claude/CLAUDE.md` (#926) — production callers never pass it.
 */
export function readHarnessCatalog(repoRoot: string, homeDir: string = homedir()): HarnessCatalog {
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
  const managedSkills: string[] = [];
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      let file: string | null = null;
      let name = "";
      if (entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md"))) {
        file = join(skillsDir, entry.name, "SKILL.md");
        name = entry.name;
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
        file = join(skillsDir, entry.name);
        name = entry.name.replace(/\.md$/, "");
      }
      if (!file) continue;
      skills.push(name);
      // The marker is the only honest witness of provenance: a name proves
      // nothing (a user skill may share a name with a shipped one) and the
      // preset list would have to be re-derived per release.
      if (listMarkers(file).length > 0) managedSkills.push(name);
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
    managedSkills: managedSkills.sort(),
    sections: parseSections(claudeMd),
    claudeMdTokens: Math.round(claudeMd.length / 4),
    globalClaudeMd: readGlobalClaudeMd(homeDir),
    notObserved: [...HIERARCHY_NOT_OBSERVED],
  };
}

/**
 * The navori version the recorder itself was rendered at, or null.
 *
 * WHY THIS FILE and not a scan of every managed marker: the question the report
 * has to answer is "which harness shaped this session", and the only honest
 * witness is the code that wrote the log. `audit-mode-trigger.sh` is that code —
 * no recorder, no session log, no report. Reading its own marker ties the
 * version to the artifact that produced the data rather than to whatever the
 * rest of the repo happened to be rendered at, which in a half-applied `render`
 * is not the same number.
 *
 * Read at `--start`, never at report time: a report generated weeks later would
 * otherwise stamp today's on-disk version onto a session that ran under an older
 * one — exactly the inversion this field exists to prevent.
 */
export function renderedHarnessVersion(repoRoot: string): string | null {
  const recorder = join(repoRoot, ".claude", "hooks", "audit-mode-trigger.sh");
  for (const marker of listMarkers(recorder)) {
    if (marker.version) return marker.version;
  }
  return null;
}

/**
 * Whether an agent's declared `tools:` lets it reach ONE server.
 *
 * A blanket `mcp__engram__*` grants engram and nothing else; an absent
 * `tools:` inherits everything.
 */
export function reaches(declared: DeclaredAgent | undefined, server: string): boolean {
  if (!declared || declared.tools === null) return true;
  return declared.tools.some(
    (tool) => tool === "*" || tool === `mcp__${server}__*` || tool.startsWith(`mcp__${server}__`),
  );
}

/**
 * Per server, the CLAUDE.md tokens an agent pays at startup for instructions it
 * cannot execute. Servers it can reach are absent, not zero.
 *
 * This lives HERE, exported, because two callers need the same answer and used
 * to compute it differently: the per-agent card crossed section↔server (fine),
 * while the `unreachable-instructions` signal used a single `hasMcp` boolean —
 * true if the agent reached ANY server. An agent with engram but not codegraph
 * was therefore "not blind", and its barred codegraph section vanished from the
 * finding while still being printed on its own card. One report, two numbers.
 */
export function barredMcpTokens(
  declared: DeclaredAgent | undefined,
  cat: HarnessCatalog,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const section of cat.sections) {
    for (const server of section.requiresMcp) {
      if (reaches(declared, server)) continue;
      out[server] = (out[server] ?? 0) + section.tokens;
    }
  }
  return out;
}
