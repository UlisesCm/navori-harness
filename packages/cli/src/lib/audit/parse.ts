import { readFileSync, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type AgentRun,
  type HookEvent,
  type SessionAudit,
  type SkillSource,
  type SkillUse,
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

/**
 * The bucket a call lands in when it happened before the transcript declared any
 * mode. Named rather than folded into a real mode: attributing those calls to
 * whichever mode came later would be inventing data, and they are usually the
 * session's first few.
 */
export const MODE_UNDECLARED = "(undeclared)";

/**
 * Tool calls split by the permission mode in force when each ran (#584).
 *
 * BY POSITION, not by time, and that is forced: a `permission-mode` line of the
 * transcript carries only `{type, sessionId, permissionMode}` — no timestamp to
 * join on. What it does have is its place in an append-only file, interleaved
 * with the messages, so the mode governing a call is the last such line before
 * it. The transitions are the check that this lands right: `EnterPlanMode`
 * shows up under the mode you left, `ExitPlanMode` under `plan`.
 *
 * Why it matters: the report used to publish ONE histogram plus the dominant
 * mode, and a session that switches modes — four of them in the one that
 * motivated this — collapsed into a single pile. Every claim about how the
 * harness behaves outside `auto` was unfalsifiable from the report.
 *
 * Main thread only. A subagent's transcript carries no `permission-mode` line,
 * and inferring its mode from the parent's position at spawn time would be a
 * guess dressed as a measurement.
 */
function countToolsByMode(lines: Rec[]): Record<string, Record<string, number>> {
  const byMode: Record<string, Record<string, number>> = {};
  let mode = MODE_UNDECLARED;
  for (const l of lines) {
    const type = str(l.type);
    if (type === "permission-mode") {
      mode = str(l.mode) ?? str(l.permissionMode) ?? mode;
      continue;
    }
    if (type !== "assistant") continue;
    for (const block of arr(path(l, "message", "content"))) {
      if (!isRec(block) || str(block.type) !== "tool_use") continue;
      const name = str(block.name);
      if (!name) continue;
      const bucket = (byMode[mode] ??= {});
      bucket[name] = (bucket[name] ?? 0) + 1;
    }
  }
  return byMode;
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
 * Skills TOUCHED, with how we learned about each.
 *
 * "Touched", not "used", and the distinction is not pedantry: an `auditor` in
 * the reference session opened eleven `SKILL.md` files one by one because it was
 * AUDITING them. Reading a skill to apply it and reading it to review it are the
 * same event in the transcript, so no criterion over content can separate them.
 * The provenance label is what keeps the report honest about that: it reports
 * how the skill was detected and lets the reader judge, instead of asserting a
 * use it cannot observe.
 *
 * The explicit `Skill` tool is the documented path but in practice barely used:
 * the reference session shows 0 `Skill` calls and 34 `SKILL.md` files opened
 * through Read/Bash. Counting only the tool would report "no skills" — false.
 */
function collectSkills(uses: Rec[]): {
  skills: SkillUse[];
  discarded: number;
} {
  /** slug → how we learned about it. `skill-tool` wins: an explicit invocation
   *  is stronger evidence than the file having been opened. */
  const found = new Map<string, SkillSource>();
  let discarded = 0;

  for (const u of uses) {
    const name = str(u.name);
    if (name === "Skill") {
      const s = str(path(u, "input", "skill"));
      if (s) found.set(s, "skill-tool");
      continue;
    }
    const haystack = str(path(u, "input", "command")) ?? str(path(u, "input", "file_path")) ?? "";

    // A command that ENUMERATES the skills directory is not using any skill —
    // it is looking at the shelf. The old criterion counted every slug such a
    // command printed, which is how one auditor was credited with eleven skills
    // for a single `ls`. Every match in this command is discarded, not just the
    // ambiguous ones: the distinguishing fact is the SHAPE OF THE COMMAND, not
    // the shape of each path it happens to contain.
    if (isDirectoryListing(haystack)) {
      for (const m of haystack.matchAll(SKILL_PATH_RE)) if ((m[1]?.length ?? 0) > 2) discarded++;
      continue;
    }

    for (const m of haystack.matchAll(SKILL_PATH_RE)) {
      const slug = m[1];
      // Skip 1-2 char segments: those are placeholders from documentation and
      // globs (`<id>/SKILL.md`, `*/SKILL.md`), never real skill slugs.
      // Skip 1-2 char segments AND the literal glob: `*/SKILL.md` does not
      // match `[\w-]+` anyway, which is why a `for f in .claude/skills/*/SKILL.md`
      // never inflated the count in the first place — verified against the
      // reference session before trusting it.
      if (!slug || slug.length <= 2) continue;
      if (!found.has(slug)) found.set(slug, "skill-md");
    }
  }

  const skills = [...found.entries()]
    .map(([slug, source]) => ({ slug, source }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return { skills, discarded };
}

/** Commands that ENUMERATE rather than read: `ls`, `find`, `tree`, `glob`. The
 *  test is on the leading verb, so `cat .claude/skills/x/SKILL.md` is untouched
 *  no matter what its path looks like. */
function isDirectoryListing(command: string): boolean {
  return /(^|[;&|]\s*)(ls|find|tree|du|stat)\s/.test(command);
}

/**
 * MCP calls grouped by server: `mcp__engram__mem_save` becomes
 * `{ engram: { mem_save: 1 } }`.
 *
 * The transcript records MCP tools as ordinary flat tool names, so the data was
 * always there — nothing grouped it, and "did this agent reach engram at all?"
 * had no answer short of eyeballing `toolCounts`.
 */
function collectMcpCalls(uses: Rec[]): Record<string, Record<string, number>> {
  const servers: Record<string, Record<string, number>> = {};
  for (const u of uses) {
    const name = str(u.name);
    const m = name?.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
    if (!m) continue;
    const [, server, op] = m;
    if (!server || !op) continue;
    servers[server] ??= {};
    servers[server][op] = (servers[server][op] ?? 0) + 1;
  }
  return servers;
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

  const skills = collectSkills(uses);
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
    skillsRead: skills.skills.map((sk) => sk.slug),
    skills: skills.skills,
    skillsDiscarded: skills.discarded,
    mcpCalls: collectMcpCalls(uses),
    // Filled by `buildReport`, which is where the harness catalog lives.
    mcpReach: {},
    mcpBarredTokens: {},
    // Filled by `attachHookEvents` once the session log has been read: the
    // events live in the harness's own log, not in the transcript.
    hookEvents: [],
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

  /**
   * How many human messages this session actually carried (#489).
   *
   * The session log only ever sees the first kind. A message typed WHILE the
   * agent is working is not a prompt to Claude Code: it is queued
   * (`type: "queue-operation"`, `operation: "enqueue"`) and delivered inside
   * the running turn as an attachment, so it never fires `UserPromptSubmit`
   * and the hook cannot record it. Measured on a real session: 11 typed vs 7
   * queued — the hook was missing well over a third of what the human said,
   * with nothing in the report hinting at the gap.
   *
   * The transcript has both, so the count is recovered here rather than
   * chased in the hook, which structurally cannot see them.
   *
   * `enqueue` only: every queued message also emits a matching `remove` when
   * it is consumed, so counting both would double every figure.
   */
  const typedPrompts = lines.filter(
    (l) => str(l.type) === "user" && str(l.promptSource) === "typed",
  ).length;
  const queuedPrompts = lines.filter(
    (l) => str(l.type) === "queue-operation" && str(l.operation) === "enqueue",
  ).length;

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

  const skills = collectSkills(uses);
  return {
    sessionId,
    startedAt: first,
    endedAt: last,
    wallClockMs: durationMs(first, last),
    initialPrompt,
    prompts: { typed: typedPrompts, queued: queuedPrompts },
    gitBranch: str(lines.find((l) => str(l.gitBranch))?.gitBranch),
    cwd: str(lines.find((l) => str(l.cwd))?.cwd),
    ccVersions,
    permissionModes,
    prs,
    orchestrator: {
      tokens: sumTokens(lines),
      startupTokens: startupTokensOf(lines),
      toolCounts: countTools(uses),
      toolCountsByMode: countToolsByMode(lines),
      skillsRead: skills.skills.map((sk) => sk.slug),
      skills: skills.skills,
      skillsDiscarded: skills.discarded,
      mcpCalls: collectMcpCalls(uses),
      hookEvents: [],
      frictionEvents: countFriction(lines),
      repeatedCommands: repeatedCommands(uses),
    },
    agents,
    signals: [],
    // Filled by `attachHookEvents`: it lives in the session log, not here.
    hookLogFrom: null,
    parseErrors,
    linesRead,
  };
}

/**
 * Attach the hook executions the harness recorded to the runs they belong to.
 *
 * The transcript cannot answer this: a hook is only visible there when it BLOCKS
 * or INJECTS, so every hook that ran and let the action through left no trace.
 * The events come from the session's own append-only log instead (see the
 * `audit-log` partial).
 *
 * Attribution is by `agentId` when the payload carried one — exact, and the
 * whole reason the field exists. Only when it is absent does this fall back to
 * the time window, which with agents running in parallel is a guess: overlapping
 * windows make more than one run a candidate, and the event goes to the
 * orchestrator rather than to an arbitrary winner.
 */
export function attachHookEvents(session: SessionAudit, logFile: string): void {
  if (!existsSync(logFile)) return;

  const events: HookEvent[] = [];
  let raw: string;
  try {
    raw = readFileSync(logFile, "utf-8");
  } catch {
    return;
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: Rec;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRec(parsed)) continue;
      rec = parsed;
    } catch {
      // A malformed line is counted, never thrown on: the log is append-only
      // and a crashed session leaves a valid, merely shorter file.
      session.parseErrors++;
      continue;
    }
    if (str(rec.event) !== "hook") continue;

    const name = str(rec.name);
    const phase = str(rec.phase);
    const verdict = str(rec.verdict);
    // The four mandatory fields of the contract. An event missing one comes from
    // a newer (or broken) writer, so it is counted rather than half-read —
    // half-reading it would put a nameless hook in somebody's card.
    if (!name || !phase || !verdict || typeof rec.ms !== "number") {
      session.parseErrors++;
      continue;
    }

    const event: HookEvent = {
      ts: str(rec.ts) ?? "",
      name,
      phase,
      verdict,
      ms: rec.ms,
      source: str(rec.source) ?? "core",
    };
    const tool = str(rec.tool);
    if (tool) event.tool = tool;
    const reason = str(rec.reason);
    if (reason) event.reason = reason;
    const agentId = str(rec.agentId);
    if (agentId) event.agentId = agentId;
    events.push(event);
  }

  for (const event of events) {
    const owner = ownerOf(event, session);
    owner.push(event);
  }

  // The recorder's horizon. Taken as a MINIMUM rather than the first line
  // because the log is appended to by hooks of parallel agents, and two writes
  // racing on the same append leave the file ordered by arrival, not by `ts`.
  let earliest = Number.POSITIVE_INFINITY;
  for (const event of events) {
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at) || at >= earliest) continue;
    earliest = at;
    session.hookLogFrom = event.ts;
  }
}

/** Which run's card an event belongs on. */
/**
 * Hook phases that only ever fire in the process owning the session.
 *
 * A subagent cannot produce one: `SubagentStop` runs in the PARENT once a child
 * has already died, and the session-level phases bracket the whole run. Listing
 * them is what stops the time-window fallback below from placing an event
 * inside a card where it is structurally impossible — in the reference session
 * that mistake put `subagent-stop-handoff 21x` on a reviewer that never spawned
 * anything (every agent there had `spawnDepth: 1` and zero `Agent` calls).
 *
 * The payload's own `agent_id` does not rescue this, and #560 measured why: on
 * `SubagentStop` that field is a per-FIRING identifier, not an agent's. The same
 * session sent 112 distinct ids across 117 firings, 102 of which appear nowhere
 * under `~/.claude` — not as a transcript, not as a filename, not inside one —
 * while the identical payload field on the Bash-phase hooks of that same session
 * yielded 11 stable ids across 485 events. Only each agent's terminal firing
 * carried an id that resolves. The parent is the honest owner either way — it is
 * the process that ran the hook and paid its milliseconds — and the event keeps
 * its `agentId`, so nothing is lost by not guessing.
 */
const PARENT_ONLY_PHASES = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreCompact",
  "Stop",
  "SubagentStop",
  "Notification",
]);

function ownerOf(event: HookEvent, session: SessionAudit): HookEvent[] {
  if (PARENT_ONLY_PHASES.has(event.phase)) return session.orchestrator.hookEvents;

  if (event.agentId) {
    const byId = session.agents.find((a) => a.agentId === event.agentId);
    // An id naming nobody is INVALID data, not missing data, and the difference
    // decides the owner. The host states an identity on every event: for the
    // orchestrator it states the repo's `cwd`, which matches no agent by
    // construction. Falling through to the window then re-attributed those to
    // whichever agent happened to be alive — ~294 of the reference session's
    // events, on top of the 99 stray `SubagentStop`s. When the payload names
    // someone we cannot find, the one thing we know is that the window's answer
    // would be a different someone.
    return byId ? byId.hookEvents : session.orchestrator.hookEvents;
  }

  if (event.ts) {
    const at = Date.parse(event.ts);
    if (Number.isFinite(at)) {
      const inWindow = session.agents.filter((a) => {
        const from = Date.parse(a.startedAt);
        const to = Date.parse(a.endedAt);
        return Number.isFinite(from) && Number.isFinite(to) && at >= from && at <= to;
      });
      // EXACTLY one candidate, or none: with two overlapping agents the window
      // cannot decide, and inventing an owner is worse than saying "the
      // session". The orchestrator is the honest home for an unattributable
      // event, since it is the run that spans all of them.
      if (inWindow.length === 1 && inWindow[0]) return inWindow[0].hookEvents;
    }
  }
  return session.orchestrator.hookEvents;
}
