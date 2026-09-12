import { readFileSync, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type AgentRun,
  type HookEvent,
  type PermissionDecisions,
  type SessionAudit,
  type SkillSource,
  type SkillUse,
  type TokenTotals,
  type ToolErrors,
  AUTOMATIC_PERMISSION_SOURCES,
  HUMAN_PERMISSION_SOURCES,
  addTokens,
  emptyPermissionDecisions,
  emptyTokens,
  emptyToolErrors,
  isoSeconds,
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
 * refused. Successful manual approvals are NOT detectable HERE — in the
 * transcript a granted prompt is indistinguishable from a pre-approved tool.
 *
 * That is a limit of this source, not of the report: since #0021 the session
 * log can carry the host's own `tool_decision` events, whose `source` says
 * which one it was, and `permissionsBlock` in `report.ts` counts them when the
 * `otel-start` mark is there. When it is not, the sentence above still holds
 * in full and the report says so rather than implying coverage it lacks.
 *
 * `<tool_use_error>Blocked:` is here because it was MISSING: the guard emits
 * that spelling and the list only knew `BLOCKED by guard`, so two real blocks
 * in this repo's transcripts went uncounted. A false negative in a list whose
 * output is a single integer is invisible by construction (#686).
 */
const HARNESS_BLOCK_PATTERNS = ["BLOCKED by guard", "<tool_use_error>Blocked:", "hook error"];

const PERMISSION_DENIED_PATTERNS = [
  "Permission for this action was denied",
  "The user doesn't want to proceed",
];

/**
 * Openings that mark a queued message as the HOST's, not the human's.
 *
 * The queue carries both through the identical record
 * (`queue-operation` / `enqueue`), so counting them all as "what the human
 * said" is what `prompts.queued` did: of 551 enqueues across this project's
 * transcripts, 415 opened with `<task-notification>` and 9 with
 * `<cross-session-message`, against roughly 127 real messages. The counter was
 * not skewed — it was mostly machine traffic.
 *
 * An explicit list, deliberately, and NOT "starts with `<`": that heuristic
 * would delete a human asking about `<div>`. The trade is stated on purpose —
 * a prefix the host adds later is over-counted as human until it is added
 * here, which errs toward crediting the human, never toward erasing them.
 *
 * `<cross-session-message` has no closing bracket because the real tag carries
 * attributes (`from="uds:/tmp/cc-socks/54464.sock" …`).
 */
const HOST_ENQUEUE_PREFIXES = ["<task-notification>", "<cross-session-message"];

/** Whether a queued message was written by the host rather than by the human. */
function isHostEnqueue(content: string | null): boolean {
  if (content === null) return false;
  const head = content.trimStart();
  return HOST_ENQUEUE_PREFIXES.some((prefix) => head.startsWith(prefix));
}

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

/**
 * Shell binaries whose job is to read or search files — the ones with a native
 * equivalent (`Read`, `Grep`, `Glob`) that costs no classifier round-trip and
 * no permission prompt.
 *
 * Deliberately excludes everything else a session runs through the shell —
 * `git`, `gh`, package managers, `docker` — because those have no native lane
 * to switch to, and counting them would measure how much shell work the task
 * needed rather than which lane the reader chose.
 *
 * `git grep` is the exception, and the rationale above is exactly why (#720):
 * its native lane IS `Grep`. Excluding it with the rest of `git` left the one
 * shell search that no layer could see — the guard anchored four verbs, the
 * miner scored the same four, and this set excluded the whole binary — so after
 * the guard shipped it was the minimum-friction way to keep the habit and drop
 * out of every measurement at once. The rest of `git` stays out.
 */
const READ_LANE_BINARIES = new Set([
  "cat",
  "head",
  "tail",
  "nl",
  "less",
  "more",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "find",
  "ls",
  "tree",
  "wc",
  "awk",
  "cut",
]);

/**
 * The leading executable of a command: the one that decides what it IS.
 *
 * Skips a leading `cd <dir> &&` (a prefix, not the work) and env assignments.
 * Only the FIRST segment is read: `grep foo | head` is a search, `git log |
 * grep x` is not — the pipeline is named by what produces the data.
 */
function leadingBinary(command: string): string {
  const withoutCd = command.trim().replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/, "");
  for (const part of withoutCd.split(/&&|\|\||;|\|/)) {
    for (const token of part.trim().split(/\s+/)) {
      if (!token) continue;
      // `FOO=bar cmd` — the assignments prefix the real command, so skip them
      // WITHIN the segment. Skipping to the next segment instead read
      // `LC_ALL=C grep foo` as having no command at all.
      if (token.includes("=") && !token.startsWith("/")) continue;
      return token.split("/").pop() ?? "";
    }
  }
  return "";
}

/**
 * Is this Bash call doing a file read or search?
 *
 * `sed` only counts with `-n`, which is the print-a-span form. Plain `sed` is
 * a stream editor — `sed -i` writes — and calling that a read would credit the
 * lane for an edit.
 */
export function isReadLaneCommand(command: string): boolean {
  const bin = leadingBinary(command);
  if (bin === "sed") return /\bsed\s+-n\b/.test(command);
  // The `git(… -opt …)*` middle is the shape the guards use for `git -C … commit`:
  // a global option may carry its value glued with `=` or as the next token.
  if (bin === "git")
    return /^\s*git(\s+-[a-zA-Z-]+(=\S+)?(\s+[^-]\S*)?)*\s+grep(\s|$)/.test(command);
  return READ_LANE_BINARIES.has(bin);
}

/**
 * Is this Bash call WRITING a file? (#722)
 *
 * The three forms are not invented here: they are the ones `guard-destructive`
 * rule 6 already recognizes, and its table states each exclusion as
 * load-bearing — `>>` appends after the blocks and invalidates no hash, `tee -a`
 * is an append too. Mirroring that list instead of writing a fourth definition
 * is the same choice #699 made for "source file": one definition, several
 * consumers, or they drift and the gap is exactly what nobody measures.
 *
 * What this is FOR is the half nobody could size. Rule 6 only blocks writes to
 * MANAGED targets, and `signals.ts` keeps writes out of the read-lane ratio on
 * purpose, so a `sed -i` over `src/foo.ts` touched no layer and entered no
 * number. The lane where 84.9% of the calls live had no instrument at all.
 *
 * Approximate by construction, and in the safe direction: it reads the command
 * text, so a write hidden behind `sh -c` or a variable does not count. An
 * undercount of a habit is a floor; inventing writes would be worse.
 */
export function isWriteLaneCommand(command: string): boolean {
  // `>>` and `>|` differ by one character and mean opposite things, so the
  // redirect test runs on the raw text rather than through the binary.
  if (/(^|[^>\d])>(?![>])\|?\s*[^\s|&;]/.test(command)) return true;
  if (/\bsed\s+(-[A-Za-z]*\s+)*-[A-Za-z]*i\b/.test(command)) return true;
  // `tee -a` appends; bare `tee` overwrites.
  if (/\btee\b(?![^|&;]*\s-a\b)/.test(command)) return true;
  return false;
}

/** How many of these Bash calls wrote a file (#722). */
function countShellWrites(uses: Rec[]): number {
  let n = 0;
  for (const u of uses) {
    if (str(u.name) !== "Bash") continue;
    const cmd = str(path(u, "input", "command"));
    if (cmd && isWriteLaneCommand(cmd)) n++;
  }
  return n;
}

/** How many of these Bash calls read or searched files. */
function countShellReads(uses: Rec[]): number {
  let n = 0;
  for (const u of uses) {
    if (str(u.name) !== "Bash") continue;
    const cmd = str(path(u, "input", "command"));
    if (cmd && isReadLaneCommand(cmd)) n++;
  }
  return n;
}

/**
 * model id → assistant messages it served, for the main thread.
 *
 * Counted rather than picked: `agentRun` takes the FIRST model it sees because
 * a subagent runs on one, but the orchestrator can switch with `/model` and a
 * single winner would describe neither half of such a session.
 */
function countModels(lines: Rec[]): Record<string, number> {
  const models: Record<string, number> = {};
  for (const l of lines) {
    if (str(l.type) !== "assistant") continue;
    const model = str(path(l, "message", "model"));
    if (model) models[model] = (models[model] ?? 0) + 1;
  }
  return models;
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
function collectSkills(
  uses: Rec[],
  lines: Rec[] = [],
): {
  skills: SkillUse[];
  discarded: number;
  attributionRecords: number;
} {
  /** slug → how we learned about it. Stronger sources overwrite weaker ones,
   *  in the order `SkillSource` documents. */
  const found = new Map<string, SkillSource>();
  let discarded = 0;

  /**
   * The span the host attributed to a skill (#725).
   *
   * Read from the RECORDS, not the tool uses: `attributionSkill` is a top-level
   * field of each `assistant` record while a skill is active, so it is the only
   * source that survives a subagent — which inherits the attribution without
   * ever calling the `Skill` tool itself.
   *
   * Defensive on every access, like the rest of this parser: the field is
   * undocumented and the host's docs say the format changes between versions.
   * `attributionRecords` comes back so the caller can tell "the host marked
   * nothing" apart from "no skill was worked under".
   */
  const attributed = new Map<string, { records: number; outputTokens: number }>();
  for (const line of lines) {
    if (str(line.type) !== "assistant") continue;
    const slug = str(line.attributionSkill);
    if (slug === null || slug === "") continue;
    const entry = attributed.get(slug) ?? { records: 0, outputTokens: 0 };
    entry.records += 1;
    entry.outputTokens += num(path(line, "message", "usage", "output_tokens"));
    attributed.set(slug, entry);
  }

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

  // Attribution outranks a file having been opened, and is outranked by an
  // explicit invocation in THIS transcript — see `SkillSource`.
  for (const slug of attributed.keys()) {
    if (found.get(slug) !== "skill-tool") found.set(slug, "attribution");
  }

  const skills = [...found.entries()]
    .map(([slug, source]) => {
      const span = attributed.get(slug);
      return span
        ? {
            slug,
            source,
            attributedRecords: span.records,
            attributedOutputTokens: span.outputTokens,
          }
        : { slug, source };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const attributionRecords = [...attributed.values()].reduce((sum, e) => sum + e.records, 0);
  return { skills, discarded, attributionRecords };
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

/**
 * What caused ONE error result, by the only part of it that is stable.
 *
 * Order matters where a message could satisfy two rules: a guard block is
 * reported as a block, not as the `<tool_use_error>` it happens to arrive in.
 */
function classifyToolError(text: string): keyof ToolErrors {
  if (HARNESS_BLOCK_PATTERNS.some((p) => text.includes(p))) return "harnessBlock";
  if (PERMISSION_DENIED_PATTERNS.some((p) => text.includes(p))) return "permissionDenied";
  if (text.includes("No such tool available")) return "toolUnavailable";
  if (text.includes("String to replace not found")) return "editMiss";
  // The shell's own failures arrive as the tool result's first line, so the
  // prefix is the test — `includes` would also match a command that merely
  // PRINTED the words while succeeding at something else.
  if (text.trimStart().startsWith("Exit code ")) return "shellFailure";
  return "other";
}

/**
 * Every error result that reached the model's context (and so cost tokens),
 * grouped by cause.
 *
 * This loop already visited each of these blocks; until #686 it returned a
 * single integer and dropped 70% of what it had read.
 */
function countToolErrors(lines: Rec[]): ToolErrors {
  const errors = emptyToolErrors();
  for (const l of lines) {
    if (str(l.type) !== "user") continue;
    for (const block of arr(path(l, "message", "content"))) {
      if (!isRec(block) || block.is_error !== true) continue;
      const text =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      errors[classifyToolError(text)]++;
    }
  }
  return errors;
}

/**
 * Blocks and denials, which is what `frictionEvents` has always meant.
 *
 * Deriving it keeps the existing signal and the published JSON on the same axis
 * they were on — the breakdown widens what is RECORDED, not what this number
 * counts. It does move by the two blocks the pattern list used to miss, and
 * that difference is the bug being fixed.
 */
function frictionOf(errors: ToolErrors): number {
  return errors.harnessBlock + errors.permissionDenied;
}

/** Both error fields of a card, from a single pass over the transcript. */
function errorFields(lines: Rec[]): { frictionEvents: number; toolErrors: ToolErrors } {
  const toolErrors = countToolErrors(lines);
  return { frictionEvents: frictionOf(toolErrors), toolErrors };
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

  const skills = collectSkills(uses, lines);
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
    skillAttributionRecords: skills.attributionRecords,
    mcpCalls: collectMcpCalls(uses),
    // Filled by `buildReport`, which is where the harness catalog lives.
    mcpReach: {},
    mcpBarredTokens: {},
    // Filled by `attachHookEvents` once the session log has been read: the
    // events live in the harness's own log, not in the transcript.
    hookEvents: [],
    ...errorFields(lines),
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
   * `enqueue` only: a queued message leaves a SECOND record when the turn is
   * done with it — `dequeue` where it was consumed, `remove` where it was
   * dropped (551 / 331 / 219 across this project's transcripts) — so counting
   * anything but the enqueue would inflate every figure.
   */
  const typedPrompts = lines.filter(
    (l) => str(l.type) === "user" && str(l.promptSource) === "typed",
  ).length;
  const enqueued = lines.filter(
    (l) => str(l.type) === "queue-operation" && str(l.operation) === "enqueue",
  );
  const queuedPrompts = enqueued.filter((l) => !isHostEnqueue(str(l.content))).length;
  const queuedSystemPrompts = enqueued.length - queuedPrompts;

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

  const skills = collectSkills(uses, lines);
  return {
    sessionId,
    startedAt: first,
    endedAt: last,
    wallClockMs: durationMs(first, last),
    initialPrompt,
    prompts: {
      typed: typedPrompts,
      queued: queuedPrompts,
      queuedSystem: queuedSystemPrompts,
    },
    gitBranch: str(lines.find((l) => str(l.gitBranch))?.gitBranch),
    cwd: str(lines.find((l) => str(l.cwd))?.cwd),
    ccVersions,
    // Filled by `attachHookEvents` from the log's `start` record: the transcript
    // never names navori, only the host.
    navori: { rendered: null, cli: null },
    navoriAtStop: null,
    sealed: false,
    endReason: null,
    permissionModes,
    prs,
    orchestrator: {
      tokens: sumTokens(lines),
      startupTokens: startupTokensOf(lines),
      models: countModels(lines),
      shellReads: countShellReads(uses),
      shellWrites: countShellWrites(uses),
      toolCounts: countTools(uses),
      toolCountsByMode: countToolsByMode(lines),
      skillsRead: skills.skills.map((sk) => sk.slug),
      skills: skills.skills,
      skillsDiscarded: skills.discarded,
      skillAttributionRecords: skills.attributionRecords,
      mcpCalls: collectMcpCalls(uses),
      hookEvents: [],
      ...errorFields(lines),
      repeatedCommands: repeatedCommands(uses),
    },
    agents,
    signals: [],
    // Filled by `attachHookEvents`: they live in the session log, not here.
    hookLogFrom: null,
    otelFrom: null,
    permissions: emptyPermissionDecisions(),
    hostSkills: [],
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
  /** `api_request` skills, held until the loop ends: attribution needs the cards. */
  const hostSkills: Array<{ skill: string; agent: string | null }> = [];
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
    // The `start` record is written once, by `audit --start`, before any hook
    // has run. It carries the only statement of which navori marked and shaped
    // this session; a log from before the field existed simply leaves it null.
    if (str(rec.event) === "start") {
      session.navori = {
        rendered: str(rec.navoriRendered),
        cli: str(rec.navoriCli),
      };
      continue;
    }
    // `stop` — written by an explicit `audit --stop` — seals the log. It also
    // carries a SECOND reading of the versions, kept only when one moved: a
    // harness updated mid-session is a fact about the run, and the `start`
    // stamp alone cannot express it. Older logs wrote the record without the
    // fields, which reads as "nothing moved" — the same conclusion the reader
    // would draw from their absence.
    if (str(rec.event) === "stop") {
      session.sealed = true;
      const rendered = str(rec.navoriRendered);
      const cli = str(rec.navoriCli);
      if (rendered !== session.navori.rendered || cli !== session.navori.cli) {
        if (rendered !== null || cli !== null) session.navoriAtStop = { rendered, cli };
      }
      continue;
    }
    // `session-end` seals it too, and is how sessions normally finish: the
    // `SessionEnd` hook appends it when the run ends on its own, without anyone
    // typing `audit --stop`. Reading only `stop` is why `sealed` was false on
    // sessions that were plainly over — 4 of 25 logs here were marked sealed —
    // and a report that calls a finished run a snapshot mistrusts its own
    // figures.
    //
    // It leaves `navoriAtStop` alone: that field is a SECOND READING of the
    // versions, and this record carries none. Null there keeps meaning "nothing
    // moved, or nobody looked again", never "the versions were blanked".
    // Both records can land in one log, in either order; the seal is a latch,
    // so taking both is idempotent.
    if (str(rec.event) === "session-end") {
      session.sealed = true;
      session.endReason = str(rec.reason);
      continue;
    }
    // The third source (#0021). These three records are written by the OTel
    // receiver into this same log, which is why no ingestion module exists:
    // they arrive with everything else, already flat, already carrying `tsMs`.
    //
    // `otel-start` is its horizon, and the reason it is a RECORD and not a
    // boolean computed at report time: the answer to "was anybody listening"
    // has to survive the run that asked.
    if (str(rec.event) === "otel-start") {
      session.otelFrom = str(rec.ts);
      continue;
    }
    // The permission blind spot, closed: the transcript can see a refusal but
    // never a grant, because a granted prompt and a pre-approved tool leave
    // the identical result. `source` is the host saying which one it was.
    if (str(rec.event) === "tool_decision") {
      countPermissionDecision(session.permissions, str(rec.source));
      continue;
    }
    // The skills blind spot: `skill` here is DECLARED, not inferred from
    // whoever opened a `SKILL.md`. Attribution happens after the loop, once
    // every card is known.
    if (str(rec.event) === "api_request") {
      const skill = str(rec.skill);
      if (skill) hostSkills.push({ skill, agent: str(rec.agent) });
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

    const tsMs = typeof rec.tsMs === "number" && Number.isFinite(rec.tsMs) ? rec.tsMs : null;
    const event: HookEvent = {
      // Derived when the writer sent none (#696): the hook stopped forking
      // `date` for a string `tsMs` already contains. Records written before
      // that still carry their own `ts`, and it wins — reading an old log must
      // not depend on this.
      ts: str(rec.ts) ?? (tsMs === null ? "" : isoSeconds(tsMs)),
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
    if (tsMs !== null) event.tsMs = tsMs;
    events.push(event);
  }

  for (const event of chronological(events)) {
    const owner = ownerOf(event, session);
    owner.push(event);
  }

  // The recorder's horizon. Taken as a MINIMUM rather than the first line
  // because the log is appended to by hooks of parallel agents, and two writes
  // racing on the same append leave the file ordered by arrival, not by `ts`.
  // Still a minimum over the UNSORTED events, not `chronological(events)[0]`:
  // a log written before `tsMs` existed can only be ordered as well as its
  // second-resolution `ts` allows, and the minimum does not depend on that.
  let earliest = Number.POSITIVE_INFINITY;
  for (const event of events) {
    const at = eventAt(event);
    if (!Number.isFinite(at) || at >= earliest) continue;
    earliest = at;
    session.hookLogFrom = event.ts;
  }

  applyHostSkills(session, hostSkills);
}

/** Counts one `tool_decision` into the session's tally (#0021, R12). */
function countPermissionDecision(into: PermissionDecisions, source: string | null): void {
  // A decision whose source the host did not send still happened: it is
  // counted under its own key rather than dropped, so `total` never disagrees
  // with the sum of `bySource`.
  const key = source ?? UNKNOWN_PERMISSION_SOURCE;
  into.bySource[key] = (into.bySource[key] ?? 0) + 1;
  into.total++;
  if (HUMAN_PERMISSION_SOURCES.includes(key)) into.human++;
  else if (AUTOMATIC_PERMISSION_SOURCES.includes(key)) into.automatic++;
}

/** What a `tool_decision` with no `source` is filed under. */
const UNKNOWN_PERMISSION_SOURCE = "(unknown)";

/**
 * Places the host-declared skills on the cards, and on the session (#0021, R13).
 *
 * `host` OVERWRITES whatever the transcript heuristics concluded for the same
 * slug: it is the only one of the three that is a statement rather than an
 * inference.
 *
 * Attribution is by `agent.name`, and only when that name resolves to ONE run.
 * Two `researcher`s in a session are the same name on the event, and putting
 * the skill on either card would be a claim the data does not support — so it
 * stays at session level, where `hostSkills` reports it without inventing an
 * owner. A run-less event (no `agent`) belongs to the orchestrator, which is
 * the one card that is always exactly one.
 */
function applyHostSkills(
  session: SessionAudit,
  declared: Array<{ skill: string; agent: string | null }>,
): void {
  if (declared.length === 0) return;

  const bySlug = new Map<string, SkillUse>();
  for (const { skill, agent } of declared) {
    bySlug.set(skill, { slug: skill, source: "host" });

    const target = agent === null ? session.orchestrator : onlyRunOfType(session.agents, agent);
    if (!target) continue;
    const existing = target.skills.findIndex((s) => s.slug === skill);
    if (existing >= 0) target.skills[existing] = { slug: skill, source: "host" };
    else target.skills.push({ slug: skill, source: "host" });
    if (!target.skillsRead.includes(skill)) target.skillsRead.push(skill);
    target.skills.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  session.hostSkills = [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The single run of `agentType`, or null when zero or several match. */
function onlyRunOfType(agents: AgentRun[], agentType: string): AgentRun | null {
  const matches = agents.filter((a) => a.agentType === agentType);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * When an event happened, in epoch milliseconds.
 *
 * `tsMs` wins whenever the writer recorded it (#685). `ts` is stamped by `date`
 * at second resolution and TRUNCATES, so it reads up to 999 ms early — always
 * in the same direction, which is what makes it unsafe at a window boundary.
 * The `ts` fallback is what keeps logs written before the field parseable.
 */
function eventAt(event: HookEvent): number {
  if (event.tsMs !== undefined) return event.tsMs;
  return Date.parse(event.ts);
}

/**
 * The events in the order they actually happened.
 *
 * File order is ARRIVAL order — parallel agents append to one log — so it was
 * never the chronology, and `ts` alone could not repair it: 84% of a measured
 * session's events share their second with another. `tsMs` can, so a card now
 * lists its hooks in the order they ran.
 *
 * An event whose time cannot be read inherits the last known one instead of
 * becoming `NaN`. That keeps the comparator total (a `NaN` makes `sort`
 * order-dependent and its result meaningless) and leaves such events exactly
 * where the file put them, which is the only information left about them.
 */
function chronological(events: HookEvent[]): HookEvent[] {
  let last = 0;
  return events
    .map((event, index) => {
      const at = eventAt(event);
      if (Number.isFinite(at)) last = at;
      return { event, index, at: last };
    })
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((keyed) => keyed.event);
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

/**
 * What the `audit-log` partial writes as the owner when the hook fired on the
 * main thread rather than inside a subagent (#709).
 *
 * It is a literal shared with a shell script that cannot import it, so
 * `audit-log-owner.test.ts` pins the pairing — the same drift a generated
 * partial closes elsewhere, guarded here by a test because it is one word.
 */
export const ORCHESTRATOR_OWNER = "orchestrator";

function ownerOf(event: HookEvent, session: SessionAudit): HookEvent[] {
  if (PARENT_ONLY_PHASES.has(event.phase)) return session.orchestrator.hookEvents;

  if (event.agentId) {
    // The main thread says so outright. Before #709 the recorder emitted the
    // repo's `cwd` here — not because the host sends it (it sends nothing at
    // all off a subagent) but because of a shell bug in the `audit-log`
    // partial, which is why 79% of the park's recorded owners are a path. Both
    // spellings resolve the same way below; this branch only makes the intent
    // legible instead of leaving it to the "names nobody" fallback.
    if (event.agentId === ORCHESTRATOR_OWNER) return session.orchestrator.hookEvents;

    const byId = session.agents.find((a) => a.agentId === event.agentId);
    // An id naming nobody is INVALID data, not missing data, and the difference
    // decides the owner. Falling through to the window re-attributed those to
    // whichever agent happened to be alive — ~294 of the reference session's
    // events, on top of the 99 stray `SubagentStop`s. When the payload names
    // someone we cannot find, the one thing we know is that the window's answer
    // would be a different someone. This is also what keeps logs written BEFORE
    // #709 reading correctly: a `cwd` matches no agent, so it lands here.
    return byId ? byId.hookEvents : session.orchestrator.hookEvents;
  }

  if (event.tsMs !== undefined || event.ts) {
    // `eventAt` prefers `tsMs`, and the window is exactly where that matters:
    // the transcript states an agent's bounds in milliseconds, so a `ts`
    // truncated to the second can fall short of a start it actually followed.
    const at = eventAt(event);
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
