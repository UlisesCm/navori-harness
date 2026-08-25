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
  /** Skill paths read, however they were read (tool `Skill` or `cat` via Bash). */
  skillsRead: string[];
  /** Hook blocks and permission denials that reached this agent's context. */
  frictionEvents: number;
  /** Normalized Bash commands run 3+ times, and how often. Repetition = rework. */
  repeatedCommands: Record<string, number>;
  /** Verdict string found in the run's output, when the agent emits one. */
  verdict: "APPROVED" | "CHANGES_REQUESTED" | null;
}

/** One audited session: the orchestrator plus every subagent it spawned. */
export interface SessionAudit {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  wallClockMs: number;
  /** First human-typed prompt (`promptSource: "typed"`), not an injected one. */
  initialPrompt: string;
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
    frictionEvents: number;
    repeatedCommands: Record<string, number>;
  };
  agents: AgentRun[];
  signals: Signal[];
  /** Unparseable or unknown lines, counted instead of thrown. */
  parseErrors: number;
  /** Total lines seen, so `parseErrors` can be read as a ratio. */
  linesRead: number;
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
  schemaVersion: 1;
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
  };
  signals: Signal[];
}
