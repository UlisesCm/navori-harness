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
  /** Hook blocks and permission denials that reached this agent's context. */
  frictionEvents: number;
  /** Normalized Bash commands run 3+ times, and how often. Repetition = rework. */
  repeatedCommands: Record<string, number>;
  /** Verdict string found in the run's output, when the agent emits one. */
  verdict: "APPROVED" | "CHANGES_REQUESTED" | null;
}

/** How a skill was detected, which is not the same as how much it is worth.
 *  `skill-tool` is an explicit invocation; `skill-md` is the file being opened,
 *  which is how skills are used in practice but also how a stray `cat` looks. */
export type SkillSource = "skill-tool" | "skill-md";

export interface SkillUse {
  slug: string;
  source: SkillSource;
}

/** One hook execution, as the hook itself recorded it (see the `audit-log`
 *  partial). `ms` is measured inside the hook, never derived from the gap
 *  between consecutive events — those can belong to different hooks. */
export interface HookEvent {
  ts: string;
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
   */
  prompts: { typed: number; queued: number };
  gitBranch: string | null;
  cwd: string | null;
  /** Claude Code versions seen; the basis of the format-drift warning. */
  ccVersions: string[];
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
    toolCounts: Record<string, number>;
    skillsRead: string[];
    skills: SkillUse[];
    skillsDiscarded: number;
    mcpCalls: Record<string, Record<string, number>>;
    hookEvents: HookEvent[];
    frictionEvents: number;
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
   *  provenance, MCP by server, recorded hook executions). A reader can tell the
   *  two shapes apart by this number alone. */
  schemaVersion: 2;
  generatedBy: string;
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
}
