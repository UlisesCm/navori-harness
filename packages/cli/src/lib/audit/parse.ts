import { readFileSync, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type AgentRun,
  type SessionAudit,
  type TokenTotals,
  addTokens,
  emptyTokens,
} from "./model.ts";

/**
 * Transcript JSONL → domain model.
 *
 * The format is INTERNAL to Claude Code and documented as unstable ("scripts
 * that parse these files directly can break on any release"), so every access
 * here is defensive: unknown record types are skipped and counted, never
 * thrown. A malformed transcript must degrade the report, not kill the command.
 */

/** Narrowing helpers — the parser never trusts a field's shape. */
type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function path(rec: Rec, ...keys: string[]): unknown {
  let cur: unknown = rec;
  for (const k of keys) {
    if (!isRec(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Canonical strings that mark a tool result the harness blocked or the user
 * refused. Successful manual approvals are NOT detectable — a granted prompt
 * is indistinguishable from a pre-approved tool — and the report says so
 * rather than implying full coverage.
 */
const FRICTION_PATTERNS = [
  "BLOCKED by guard",
  "Permission for this action was denied",
  "hook error",
  "The user doesn't want to proceed",
];

/**
 * Matches a skill file however it was opened: tool `Skill`, `cat`, `Read`.
 *
 * Captures only the directory segment immediately before `SKILL.md` — that is
 * the skill's slug. A greedy path prefix here would swallow the segment and
 * leave a single character behind.
 */
const SKILL_PATH_RE = /([\w-]+)\/SKILL\.md/g;

interface ParsedLines {
  lines: Rec[];
  parseErrors: number;
  linesRead: number;
}

/** Reads a JSONL file, counting rather than throwing on malformed lines. */
export function readJsonl(file: string): ParsedLines {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return { lines: [], parseErrors: 0, linesRead: 0 };
  }
  const lines: Rec[] = [];
  let parseErrors = 0;
  let linesRead = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    linesRead++;
    try {
      const obj: unknown = JSON.parse(line);
      if (isRec(obj)) lines.push(obj);
      else parseErrors++;
    } catch {
      parseErrors++;
    }
  }
  return { lines, parseErrors, linesRead };
}

/**
 * Sums usage across assistant messages, de-duplicating by `message.id`.
 *
 * Streaming re-emits one line per content block with an IDENTICAL usage
 * payload (894 lines → 461 unique ids in the reference session). Summing
 * without grouping inflates every token figure roughly 2x, so this keeps the
 * LAST line of each id group — the one carrying the final counters.
 */
export function sumTokens(lines: Rec[]): TokenTotals {
  const byId = new Map<string, Rec>();
  let anonymous = emptyTokens();
  for (const l of lines) {
    if (str(l.type) !== "assistant") continue;
    const id = str(path(l, "message", "id"));
    if (id) byId.set(id, l);
    else anonymous = addTokens(anonymous, usageOf(l));
  }
  let total = anonymous;
  for (const l of byId.values()) total = addTokens(total, usageOf(l));
  return total;
}

function usageOf(line: Rec): TokenTotals {
  const u = path(line, "message", "usage");
  if (!isRec(u)) return emptyTokens();
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreation: num(u.cache_creation_input_tokens),
    thinking: num(path(u, "output_tokens_details", "thinking_tokens")),
  };
}

/**
 * The price of the agent merely existing: `cache_creation` of its first
 * assistant message, which covers system prompt + CLAUDE.md hierarchy +
 * agent definition + git status.
 */
function startupTokensOf(lines: Rec[]): number {
  for (const l of lines) {
    if (str(l.type) !== "assistant") continue;
    return num(path(l, "message", "usage", "cache_creation_input_tokens"));
  }
  return 0;
}

/** Every `tool_use` block across the assistant messages of one transcript. */
function toolUses(lines: Rec[]): Rec[] {
  const out: Rec[] = [];
  for (const l of lines) {
    if (str(l.type) !== "assistant") continue;
    for (const block of arr(path(l, "message", "content"))) {
      if (isRec(block) && str(block.type) === "tool_use") out.push(block);
    }
  }
  return out;
}

function countTools(uses: Rec[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const u of uses) {
    const name = str(u.name);
    if (name) counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/**
 * Skills actually loaded, by whichever route.
 *
 * The explicit `Skill` tool is the documented path but in practice barely
 * used: the reference session shows 0 `Skill` calls and 34 `SKILL.md` files
 * opened with `cat` through Bash. Counting only the tool would report "no
 * skills used" — false. So the Bash command string and Read paths are scanned
 * too, and the result is deliberately a superset.
 */
function collectSkills(uses: Rec[]): string[] {
  const found = new Set<string>();
  for (const u of uses) {
    const name = str(u.name);
    if (name === "Skill") {
      const s = str(path(u, "input", "skill"));
      if (s) found.add(s);
      continue;
    }
    const haystack = str(path(u, "input", "command")) ?? str(path(u, "input", "file_path")) ?? "";
    for (const m of haystack.matchAll(SKILL_PATH_RE)) {
      const slug = m[1];
      // Skip 1-2 char segments: those are placeholders from documentation and
      // globs (`<id>/SKILL.md`, `*/SKILL.md`), never real skill slugs.
      if (slug && slug.length > 2) found.add(slug);
    }
  }
  return [...found].sort();
}

/** Blocks and denials that reached the model's context (and so cost tokens). */
function countFriction(lines: Rec[]): number {
  let n = 0;
  for (const l of lines) {
    if (str(l.type) !== "user") continue;
    for (const block of arr(path(l, "message", "content"))) {
      if (!isRec(block) || block.is_error !== true) continue;
      const text =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      if (FRICTION_PATTERNS.some((p) => text.includes(p))) n++;
    }
  }
  return n;
}

/**
 * Bash commands issued 3+ times in one run.
 *
 * Repetition is the cheapest rework signal there is: the same quality gate run
 * five times, or a command retried after a block, costs full tokens each time
 * because every result re-enters the context.
 */
function repeatedCommands(uses: Rec[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const u of uses) {
    if (str(u.name) !== "Bash") continue;
    const cmd = str(path(u, "input", "command"));
    if (!cmd) continue;
    const key = cmd.replace(/\s+/g, " ").trim();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: Record<string, number> = {};
  for (const [cmd, n] of counts) {
    if (n >= 3) out[cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd] = n;
  }
  return out;
}

/** The harness's own review verdict, when the agent emitted one. */
function findVerdict(lines: Rec[]): "APPROVED" | "CHANGES_REQUESTED" | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l || str(l.type) !== "assistant") continue;
    for (const block of arr(path(l, "message", "content"))) {
      const text = isRec(block) ? (str(block.text) ?? "") : "";
      if (text.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
      if (text.includes("APPROVED")) return "APPROVED";
    }
  }
  return null;
}

function timestamps(lines: Rec[]): { first: string; last: string } {
  let first = "";
  let last = "";
  for (const l of lines) {
    const t = str(l.timestamp);
    if (!t) continue;
    if (!first || t < first) first = t;
    if (!last || t > last) last = t;
  }
  return { first, last };
}

function durationMs(first: string, last: string): number {
  const a = Date.parse(first);
  const b = Date.parse(last);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : 0;
}

/** Parses one subagent transcript plus its sidecar meta.json. */
export function parseAgentRun(jsonlFile: string): AgentRun | null {
  const { lines } = readJsonl(jsonlFile);
  if (lines.length === 0) return null;

  const agentId =
    str(lines.find((l) => str(l.agentId))?.agentId) ??
    basename(jsonlFile)
      .replace(/^agent-/, "")
      .replace(/\.jsonl$/, "");

  // The sidecar is the authoritative source of agentType (77/77 present in the
  // reference session); absent, the caller supplies the parent's subagent_type.
  let agentType = "unknown";
  let description = "";
  let spawnDepth = 1;
  const metaFile = jsonlFile.replace(/\.jsonl$/, ".meta.json");
  if (existsSync(metaFile)) {
    try {
      const meta: unknown = JSON.parse(readFileSync(metaFile, "utf-8"));
      if (isRec(meta)) {
        agentType = str(meta.agentType) ?? agentType;
        description = str(meta.description) ?? "";
        spawnDepth = num(meta.spawnDepth) || 1;
      }
    } catch {
      // A corrupt sidecar must not lose the agent: keep the transcript data.
    }
  }

  const { first, last } = timestamps(lines);
  const uses = toolUses(lines);
  const model = lines
    .map((l) => str(path(l, "message", "model")))
    .find((m): m is string => m !== null);

  return {
    agentId,
    agentType,
    model: model ?? null,
    description,
    startedAt: first,
    endedAt: last,
    durationMs: durationMs(first, last),
    spawnDepth,
    tokens: sumTokens(lines),
    startupTokens: startupTokensOf(lines),
    overlapsWith: [],
    toolCounts: countTools(uses),
    skillsRead: collectSkills(uses),
    frictionEvents: countFriction(lines),
    repeatedCommands: repeatedCommands(uses),
    verdict: findVerdict(lines),
  };
}

/** Fills `overlapsWith` by comparing agent windows pairwise. */
export function markOverlaps(agents: AgentRun[]): void {
  for (const a of agents) {
    a.overlapsWith = agents
      .filter(
        (b) => b.agentId !== a.agentId && b.startedAt <= a.endedAt && a.startedAt <= b.endedAt,
      )
      .map((b) => b.agentId);
  }
}

/** Parses a full session: the orchestrator transcript plus every subagent. */
export function parseSession(mainJsonl: string): SessionAudit {
  const { lines, parseErrors, linesRead } = readJsonl(mainJsonl);
  const sessionId =
    str(lines.find((l) => str(l.sessionId))?.sessionId) ??
    basename(mainJsonl).replace(/\.jsonl$/, "");

  const { first, last } = timestamps(lines);
  const uses = toolUses(lines);

  const ccVersions = [...new Set(lines.map((l) => str(l.version)).filter((v): v is string => !!v))];

  const permissionModes: Record<string, number> = {};
  for (const l of lines) {
    if (str(l.type) !== "permission-mode") continue;
    const mode = str(l.mode) ?? str(l.permissionMode);
    if (mode) permissionModes[mode] = (permissionModes[mode] ?? 0) + 1;
  }

  const prs = [
    ...new Set(
      lines
        .filter((l) => str(l.type) === "pr-link")
        .map((l) => num(l.prNumber))
        .filter((n) => n > 0),
    ),
  ];

  // The human's own words: `promptSource: "typed"` separates them from
  // hook injections and task notifications (`system`, `isMeta`).
  const typed = lines.find((l) => str(l.type) === "user" && str(l.promptSource) === "typed");
  const rawPrompt = typed ? path(typed, "message", "content") : null;
  const initialPrompt =
    typeof rawPrompt === "string"
      ? rawPrompt
      : Array.isArray(rawPrompt)
        ? arr(rawPrompt)
            .map((b) => (isRec(b) ? (str(b.text) ?? "") : ""))
            .join(" ")
            .trim()
        : "";

  const agents: AgentRun[] = [];
  const subagentsDir = mainJsonl.replace(/\.jsonl$/, "") + "/subagents";
  if (existsSync(subagentsDir)) {
    for (const f of readdirSync(subagentsDir)) {
      if (!f.startsWith("agent-") || !f.endsWith(".jsonl")) continue;
      const run = parseAgentRun(join(subagentsDir, f));
      if (run) agents.push(run);
    }
  }
  agents.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  markOverlaps(agents);

  // Fallback for agents whose sidecar is missing: recover the type from the
  // parent's Agent tool_use input.
  const spawnTypes = uses
    .filter((u) => str(u.name) === "Agent")
    .map((u) => str(path(u, "input", "subagent_type")))
    .filter((t): t is string => t !== null);
  for (const a of agents) {
    if (a.agentType === "unknown" && spawnTypes.length > 0) {
      a.agentType = spawnTypes.shift() ?? "unknown";
    }
  }

  return {
    sessionId,
    startedAt: first,
    endedAt: last,
    wallClockMs: durationMs(first, last),
    initialPrompt,
    gitBranch: str(lines.find((l) => str(l.gitBranch))?.gitBranch),
    cwd: str(lines.find((l) => str(l.cwd))?.cwd),
    ccVersions,
    permissionModes,
    prs,
    orchestrator: {
      tokens: sumTokens(lines),
      startupTokens: startupTokensOf(lines),
      toolCounts: countTools(uses),
      skillsRead: collectSkills(uses),
      frictionEvents: countFriction(lines),
      repeatedCommands: repeatedCommands(uses),
    },
    agents,
    signals: [],
    parseErrors,
    linesRead,
  };
}
