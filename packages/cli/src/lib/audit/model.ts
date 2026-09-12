/**
 * Domain model for `navori audit`.
 *
 * Two sources feed it, and neither can replace the other:
 *  - the session's append-only event log (what the harness did), and
 *  - Claude Code's transcript JSONL (the ONLY place token usage exists —
 *    no hook payload carries tokens or cost).
 */

/** The four usage counters plus thinking, as reported per assistant message. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  thinking: number;
}

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 };
}

export function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    thinking: a.thinking + b.thinking,
  };
}

/** Every token that entered or left the model, for one subagent run. */
export interface AgentRun {
  agentId: string;
  /** From `agent-<id>.meta.json`; falls back to the parent's `subagent_type`. */
  agentType: string;
  model: string | null;
  description: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  spawnDepth: number;
  tokens: TokenTotals;
  /**
   * `cache_creation_input_tokens` of the agent's FIRST assistant message: the
   * price of merely existing (system prompt + CLAUDE.md hierarchy + agent
   * definition + git status), before any work happens. Measured 22-28k here.
   *
   * The transcript records its SIZE but not its CONTENT — the initial context
   * is never persisted. Attributing it to specific CLAUDE.md sections requires
   * reading the repo's own harness, which is what `harness.ts` does.
   */
  startupTokens: number;
  /** Agent ids whose [startedAt, endedAt] window overlaps this one. */
  overlapsWith: string[];
  /** tool name → call count. */
  toolCounts: Record<string, number>;
  /** Skill paths read, however they were read (tool `Skill` or `cat` via Bash).
   *  Kept as the flat list the older report shape consumed; `skills` below is
   *  the one that says HOW each was detected. */
  skillsRead: string[];
  /** Skills with their provenance, so a report can stop conflating "invoked"
   *  with "walked past" (#538-era `skillsRead` listed eleven skills for an agent
   *  that had merely listed the index directory). */
  skills: SkillUse[];
  /** Skill files seen through a directory listing or a glob, and therefore NOT
   *  counted as used. Reported so the discard is visible instead of silent. */
  skillsDiscarded: number;
  /**
   * `assistant` records that carried an `attributionSkill` at all.
   *
   * Recorded because ZERO of them and "no skill was used" are different facts
   * and would otherwise print the same. The field is undocumented, and the
   * host's own docs say the transcript format "is internal to Claude Code and
   * changes between versions", so a release that renames or drops it would
   * silently turn every session into "skills unused" — the exact shape of
   * misreading #673 and #674 already cost. A reader that sees 0 here knows the
   * instrument was blind, not that the harness was idle.
   */
  skillAttributionRecords: number;
  /** MCP server → the operations called on it, with counts. The transcript
   *  records these as flat `mcp__<server>__<op>` tool names; grouping is what
   *  turns them into "did this agent reach engram at all?". */
  mcpCalls: Record<string, Record<string, number>>;
  /** MCP server → whether this agent's declared `tools:` let it reach the
   *  server at all. Resolved when the report is built (that is where the
   *  harness catalog lives) and PERSISTED, so the JSON answers "was it barred
   *  or merely unused?" without re-reading the agent definitions. */
  mcpReach: Record<string, boolean>;
  /** MCP server → tokens of `CLAUDE.md` sections requiring it that this agent
   *  paid for in its startup WITHOUT being able to reach it (R20). A label says
   *  the reach is barred; this says what the bar costs. */
  mcpBarredTokens: Record<string, number>;
  /** Hook executions recorded by the harness itself, in order. The transcript
   *  only ever sees a hook that blocked or injected, so this is the sole
   *  evidence that a hook ran and let the action through. */
  hookEvents: HookEvent[];
  /** Hook blocks and permission denials that reached this agent's context.
   *  DERIVED from `toolErrors` (`harnessBlock + permissionDenied`) so the number
   *  keeps the meaning it has always had while the breakdown carries the rest. */
  frictionEvents: number;
  /** The same errors in full, by cause — including the classes the old count
   *  visited and threw away (#686). */
  toolErrors: ToolErrors;
  /** Normalized Bash commands run 3+ times, and how often. Repetition = rework. */
  repeatedCommands: Record<string, number>;
  /** Verdict string found in the run's output, when the agent emits one. */
  verdict: "APPROVED" | "CHANGES_REQUESTED" | null;
}

/**
 * Every `is_error` tool result that reached the model's context, by cause.
 *
 * The parser already had to visit each of these to find the four literals it
 * kept, so the classification costs nothing new — and what it used to discard
 * was most of the file: 117 of 168 error blocks across this repo's transcripts
 * (70%), of which 89 were shell commands that failed (#686).
 *
 * Classified by PREFIX, never by parsing a tool's free-form message: `Exit
 * code`, `<tool_use_error>` and the guard's own literal are stable, and a
 * heuristic over arbitrary tool prose ages badly.
 */
export interface ToolErrors {
  /** A navori hook refused the action (the guard's block, or a hook error). */
  harnessBlock: number;
  /** The permission layer or the user refused it. */
  permissionDenied: number;
  /** A shell command came back non-zero. The largest class, and the one that
   *  used to be worth nothing: an agent failing commands is doing rework. */
  shellFailure: number;
  /** The agent called a tool its own `tools:` does not grant. */
  toolUnavailable: number;
  /** An `Edit` whose target string was not in the file. */
  editMiss: number;
  /** Everything else that came back `is_error`. */
  other: number;
}

export function emptyToolErrors(): ToolErrors {
  return {
    harnessBlock: 0,
    permissionDenied: 0,
    shellFailure: 0,
    toolUnavailable: 0,
    editMiss: 0,
    other: 0,
  };
}

/** How a skill was detected, which is not the same as how much it is worth.
 *  `skill-tool` is an explicit invocation; `skill-md` is the file being opened,
 *  which is how skills are used in practice but also how a stray `cat` looks.
 *
 *  `host` is not an inference: Claude Code states it on the `api_request` event
 *  (`skill.name`), so it wins over the rest (#0021, R13).
 *
 *  `attribution` is not an inference either, and it answers a question no other
 *  source can (#725). While a skill is active the host stamps
 *  `attributionSkill` on each `assistant` record, so it marks the SPAN the
 *  skill was worked under rather than the moment it was invoked — and it is
 *  INHERITED BY SUBAGENTS, which is where the other sources go blind: measured
 *  on this repo, 249 subagent records worked under `solution-design` with only
 *  two `Skill` tool calls to show for it. Each attributed record carries its own
 *  `message.usage`, so it is also the only source that can price a skill.
 *
 *  It ranks BELOW `skill-tool` on purpose: an invocation in this transcript is
 *  direct evidence that this run reached for the skill, while an inherited span
 *  says the parent did. Both are stronger than a file having been opened. A
 *  session with no attributed record is read exactly as it always was. */
export type SkillSource = "host" | "skill-tool" | "attribution" | "skill-md";

export interface SkillUse {
  slug: string;
  source: SkillSource;
  /** `assistant` records the host stamped with this skill. Absent when the
   *  skill was not detected through attribution. */
  attributedRecords?: number;
  /** Output tokens produced while those records were attributed to this skill —
   *  what working under it actually cost. Same absence rule. */
  attributedOutputTokens?: number;
}

/**
 * Permission decisions the HOST resolved, grouped by who resolved them.
 *
 * This is the blind spot the third source exists for. `parse.ts` states it in
 * its own comment: a granted prompt is indistinguishable from a pre-approved
 * tool in the transcript, so the report could count REFUSALS
 * (`ToolErrors.permissionDenied`) and nothing about the grants. The host's
 * `tool_decision` event carries `source`, which says exactly that.
 *
 * `human` vs `automatic` is the split that answers the question the harness is
 * tuned against: how often the configuration got out of the operator's way,
 * versus how often it stopped to ask. `bySource` keeps the raw grouping —
 * including any value this version does not classify — because a total that
 * silently drops an unknown source is one nobody can audit.
 */
export interface PermissionDecisions {
  /** Every `source` seen → how many decisions it resolved. */
  bySource: Record<string, number>;
  /** `user_permanent`, `user_temporary`, `user_reject`, `user_abort`. */
  human: number;
  /** `config`, `hook`. */
  automatic: number;
  /** Every decision counted, classified or not. */
  total: number;
}

/** The `source` values a person produced by answering a prompt. */
export const HUMAN_PERMISSION_SOURCES = [
  "user_permanent",
  "user_temporary",
  "user_reject",
  "user_abort",
];

/** The `source` values resolved with nobody watching. */
export const AUTOMATIC_PERMISSION_SOURCES = ["config", "hook"];

/**
 * Epoch milliseconds → the second-resolution ISO the audit log speaks.
 *
 * ONE definition, because three writers reach for it: the OTel receiver stamps
 * it, the reader derives it for hook records that no longer carry one (#696),
 * and anything that formats an instant for this store has to agree with the
 * `date -u +%Y-%m-%dT%H:%M:%SZ` that shell hooks stamped for years — otherwise
 * two records of the same session sort by a string that means two things.
 */
export function isoSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

export function emptyPermissionDecisions(): PermissionDecisions {
  return { bySource: {}, human: 0, automatic: 0, total: 0 };
}

/** One hook execution, as the hook itself recorded it (see the `audit-log`
 *  partial). `ms` is measured inside the hook, never derived from the gap
 *  between consecutive events — those can belong to different hooks. */
export interface HookEvent {
  ts: string;
  /**
   * The same instant as `ts`, in epoch milliseconds — the one that can order
   * events (#685).
   *
   * `ts` is stamped by `date` at second resolution, and 9,085 of the 10,769
   * events measured in this repo's own store (84%) share their second with at
   * least one other, up to 11 in a single second. File order does not rescue
   * that either: parallel agents append to one file, so it is arrival order,
   * not chronological.
   *
   * Optional because logs written before the field existed only carry `ts`, and
   * those stay readable — `eventAt()` in `parse.ts` owns the fallback.
   */
  tsMs?: number;
  name: string;
  phase: string;
  verdict: string;
  ms: number;
  /** `core` or `plugin:<id>`: disabling a plugin changes which hooks run. */
  source: string;
  tool?: string;
  reason?: string;
  /** Present when the payload stated one; the reason attribution does not have
   *  to fall back to overlapping time windows. */
  agentId?: string;
}

/** One audited session: the orchestrator plus every subagent it spawned. */
export interface SessionAudit {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  wallClockMs: number;
  /** First human-typed prompt (`promptSource: "typed"`), not an injected one. */
  initialPrompt: string;
  /**
   * Human messages by delivery path (#489). `typed` starts a turn and fires
   * `UserPromptSubmit`, so the session log sees it; `queued` is written while
   * the agent works, is delivered inside the running turn, and fires nothing
   * — invisible to the hook, recovered here from the transcript. Reported so
   * the log's coverage is stated instead of assumed to be total.
   *
   * `queuedSystem` is the rest of that same queue: the host enqueues its own
   * notifications through the identical record, so counting every `enqueue` as
   * a human message put 424 machine messages against ~127 real ones in this
   * project's transcripts. Counted rather than dropped, like `skillsDiscarded`
   * — a filter that shrinks a number silently is one nobody can audit.
   */
  prompts: { typed: number; queued: number; queuedSystem: number };
  gitBranch: string | null;
  cwd: string | null;
  /** Claude Code versions seen; the basis of the format-drift warning. */
  ccVersions: string[];
  /**
   * The navori versions in play WHEN THE SESSION RAN, stamped by `--start` and
   * read back from the session log — never re-derived at report time.
   *
   * The report's own header states the version that GENERATED it, which is a
   * different number and was for a while the only one recorded: a report built
   * today over a session from three releases ago stamped today's version on it,
   * so a reader comparing sessions across an upgrade — the exact question the
   * audit exists to answer — was reading the wrong axis.
   *
   * `rendered` is the harness that shaped the session (the recorder's own marker,
   * see `renderedHarnessVersion`); `cli` is the binary that marked it. The two
   * diverge whenever the CLI was updated without a `render` — itself a finding.
   * Both are null for sessions marked before this field existed.
   */
  navori: { rendered: string | null; cli: string | null };
  /**
   * The same two versions re-read when the session was SEALED, and only when
   * one of them moved.
   *
   * `start` stamps once, which describes a session whose harness held still. A
   * rollout merged mid-session breaks that: `3f9cf38a` began under rendered
   * `0.7.0`, the rollout PR landed 26 minutes later, and the rest of the run
   * worked under `0.7.5` while the report credited the whole thing to `0.7.0`.
   * Null when nothing moved — or when there was no second reading to take at
   * all: a session that was never sealed, and equally one sealed by the
   * `SessionEnd` hook, whose `session-end` record carries no versions. So a
   * sealed session with null here is the normal case, not a contradiction.
   */
  navoriAtStop: { rendered: string | null; cli: string | null } | null;
  /**
   * Whether this session's log was sealed — by `audit --stop` or by the
   * session ending on its own.
   *
   * An unsealed session is still being written to, so every figure in its
   * report is a snapshot rather than a total: the same session audited three
   * hours apart reported 154 vs 184 Bash calls, 1h13m vs 1h24m, 2 vs 4 PRs —
   * both times presented as final. The `stop` record has been written since
   * audit-mode shipped; nothing read it.
   *
   * TWO records seal, and reading only the first was itself the bug: an
   * explicit `audit --stop` writes `stop`, while a session that just ends gets
   * `session-end` from the `SessionEnd` hook, which is how sessions normally
   * finish. Both can land in one log, and both set this to true.
   */
  sealed: boolean;
  /**
   * Why the session ended, as the `SessionEnd` payload stated it: `clear`,
   * `logout`, `other`, or the matcher that fired. Null when the log carries no
   * `session-end` — an explicit `--stop`, or a run that never closed.
   *
   * Recorded because `sealed` alone cannot tell a clean exit from a crash, and
   * the two mean opposite things about the figures above: a sealed-on-`logout`
   * session is complete, while a session with no seal at all may simply have
   * died with its log mid-write. The hook has always written this reason; it
   * was parsed and thrown away.
   */
  endReason: string | null;
  /**
   * permission-mode → occurrences. Load-bearing, not decorative: `auto` steers
   * the model toward Bash over Read/Grep, so without this the tool histogram
   * reads as a harness defect when it is just the permission mode.
   */
  permissionModes: Record<string, number>;
  prs: number[];
  orchestrator: {
    tokens: TokenTotals;
    startupTokens: number;
    /**
     * model id → assistant messages served by it.
     *
     * Load-bearing for the token totals, not decorative: the orchestrator is
     * where most of a session's spend happens — `bd0e5268` billed 433k tokens
     * with zero subagents — and the same count means a different bill on Opus
     * than on Sonnet. A subagent's card has named its model since day one; the
     * thread that dominates the total did not.
     *
     * A map rather than one id because `/model` mid-session is legal: a single
     * winner would describe neither half. Empty for a transcript whose lines
     * declare no model.
     */
    models: Record<string, number>;
    /**
     * Bash calls whose leading binary reads or searches files — the work a
     * native `Read`/`Grep`/`Glob` would have done.
     *
     * Split out because the plain share of Bash cannot answer the question
     * `tool-mix` asks. `Edit`/`Write` count as native tools but are WRITES, the
     * ground the host concedes in auto mode; leaving them in the denominator
     * let a session with 175 shell reads and zero native reads sit at 83% Bash,
     * under the threshold. Approximate by construction — the leading binary,
     * not a parse of the command — and the report says so.
     */
    shellReads: number;
    toolCounts: Record<string, number>;
    /**
     * The same calls, split by the permission mode in force when each ran
     * (#584). Main thread only: a subagent's transcript declares no mode.
     *
     * Load-bearing because the modes are not interchangeable — `auto` tells the
     * model to work through the shell, `plan` forbids writing — so one merged
     * histogram over a session that switched modes describes no moment of it.
     */
    toolCountsByMode: Record<string, Record<string, number>>;
    skillsRead: string[];
    skills: SkillUse[];
    skillsDiscarded: number;
    /**
     * `assistant` records that carried an `attributionSkill` at all.
     *
     * Recorded because ZERO of them and "no skill was used" are different facts
     * and would otherwise print the same. The field is undocumented, and the
     * host's own docs say the transcript format "is internal to Claude Code and
     * changes between versions", so a release that renames or drops it would
     * silently turn every session into "skills unused" — the exact shape of
     * misreading #673 and #674 already cost. A reader that sees 0 here knows the
     * instrument was blind, not that the harness was idle.
     */
    skillAttributionRecords: number;
    mcpCalls: Record<string, Record<string, number>>;
    hookEvents: HookEvent[];
    frictionEvents: number;
    toolErrors: ToolErrors;
    repeatedCommands: Record<string, number>;
  };
  agents: AgentRun[];
  signals: Signal[];
  /**
   * First hook execution the session log recorded, or `null` when it recorded
   * none. It is the recorder's horizon, not the session's: a harness rendered
   * or updated MID-SESSION starts recording an hour into the run, and every
   * agent that finished before this instant has hooks that ran and left no
   * trace. Without it "no hooks" and "no record" render identically, and the
   * report claims something it cannot know.
   */
  hookLogFrom: string | null;
  /**
   * When the OTel receiver started writing into THIS session's log, from the
   * `otel-start` record it appends on its first write (#0021, R4).
   *
   * Null means the third source was not there — which is not the same
   * statement as "no manual approvals happened", and the report must not
   * render them alike. Same reason `hookLogFrom` exists one line up.
   */
  otelFrom: string | null;
  /**
   * Permission decisions read from this session's `tool_decision` events.
   * All zeros when `otelFrom` is null: nobody was listening, so nothing was
   * counted — read it together with that field, never on its own.
   */
  permissions: PermissionDecisions;
  /**
   * Skills the HOST declared for this session, over all of its agents.
   *
   * Kept at session level as well as on the cards because attribution can be
   * ambiguous — two runs of the same `agentType` are one name on the event —
   * and a skill that cannot be placed on a card must still be reported. The
   * alternative is a filter that shrinks the list in silence.
   */
  hostSkills: SkillUse[];
  /** Unparseable or unknown lines, counted instead of thrown. */
  parseErrors: number;
  /** Total lines seen, so `parseErrors` can be read as a ratio. */
  linesRead: number;
}

/**
 * What the hook recorder observed, when it did not observe the whole session.
 *
 * The recorder is inlined into the managed hooks, so it exists only from the
 * moment the harness carrying it is on disk: render or update the harness
 * mid-run and every hook that fired earlier is missing, not zero. That makes
 * every count drawn from the log a PARTIAL count, and a partial count printed
 * without saying so reads as a total (#559).
 *
 * Null when there is nothing to declare: no recorded hook at all, unusable
 * timestamps, or a recorder that was already running when the session started.
 */
export interface RecorderWindow {
  /** ISO instant of the first recorded hook — the recorder's horizon. */
  from: string;
  /** Minutes of the session that ran before it. */
  blindMinutes: number;
  /** Share of the session's wall clock the recorder did observe, 0-100. */
  coveredPercent: number;
}

export function recorderWindow(session: SessionAudit): RecorderWindow | null {
  if (!session.hookLogFrom) return null;
  const from = Date.parse(session.hookLogFrom);
  const started = Date.parse(session.startedAt);
  if (!Number.isFinite(from) || !Number.isFinite(started) || from <= started) return null;

  const blindMs = from - started;
  const total = session.wallClockMs;
  // A blind stretch longer than the session itself is broken input, never
  // negative coverage: clamp instead of printing a number that cannot be true.
  const covered = total > 0 ? Math.round(((total - blindMs) / total) * 100) : 0;
  return {
    from: session.hookLogFrom,
    blindMinutes: Math.round(blindMs / 60000),
    coveredPercent: Math.max(0, Math.min(100, covered)),
  };
}

export type Severity = "info" | "warn" | "high";

export interface Signal {
  kind: string;
  severity: Severity;
  /** One line, already in the report's language. */
  summary: string;
  /** Where it was observed — session, agent ids, timestamps, counts. */
  evidence: string;
  /** Tokens attributable to this finding, when it is quantifiable. */
  tokens?: number;
}

/** Aggregate across the audited range. */
export interface AuditReport {
  /** Bumped to 2 by spec 0013: reports now carry per-agent cards (skills with
   *  provenance, MCP by server, recorded hook executions). Bumped to 3 when
   *  sessions gained `navori` — the versions in force WHEN THE SESSION RAN, as
   *  opposed to `generatedBy`, which describes this file. Bumped to 4 with
   *  `generatedAt`, the orchestrator's `models`, and each session's `sealed` /
   *  `navoriAtStop`. Bumped to 5 with each session's `endReason` and
   *  `prompts.queuedSystem` — the same family of field as the bump to 4, and
   *  published by `renderJson`, which serializes whole sessions.
   *  Bumped to 6 with `orphanSessions` (#675): logs that were marked and whose
   *  transcript no longer resolves. They were already printed to the human and
   *  invisible to `--json`, which is the half a CI or an agent reads.
   *  A reader can tell the shapes apart by this number alone. */
  schemaVersion: 6;
  generatedBy: string;
  /**
   * When this report was built, ISO-8601.
   *
   * `generatedBy` said which navori wrote the file and never when. The gap
   * matters for an unsealed session: comparing this against its `endedAt` is
   * what separates "the run is still going, these figures will move" from "it
   * ended days ago and nobody sealed the log" — two states that render
   * identically without a clock.
   */
  generatedAt: string;
  repo: string;
  range: { from: string; to: string };
  ccVersions: string[];
  sessions: SessionAudit[];
  totals: {
    sessions: number;
    agents: number;
    tokens: TokenTotals;
    startupTokens: number;
    byAgentType: Record<string, { count: number; tokens: TokenTotals }>;
    byModel: Record<string, number>;
    /** Sum of every subagent's own duration. */
    agentDurationMs: number;
    /** Wall-clock the subagents actually occupied, merging overlapping windows:
     *  five agents of 20 minutes running in parallel cost 30 minutes of clock,
     *  not 100. Reporting only the sum reads as time nobody spent. */
    agentWallClockMs: number;
  };
  signals: Signal[];
  /**
   * Marked sessions whose transcript could not be located, by short id.
   *
   * Not an error and not empty-by-default noise: a log with no transcript is
   * either a typo'd `--start` (the defect in #675, where a one-letter id made a
   * repo count as audited on two lines of nothing) or a transcript that was
   * pruned. Either way it produces no report, so a reader counting audited
   * sessions has to be able to subtract them.
   */
  orphanSessions: string[];
}
