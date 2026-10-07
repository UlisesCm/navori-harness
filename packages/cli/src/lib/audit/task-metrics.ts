import type {
  EpisodeEfficiency,
  EpisodeGate,
  EpisodeLifecycle,
  OutcomeSummary,
  TaskMetric,
  TaskValue,
  TokenComponents,
  TokenTotals,
} from "./model.ts";

/**
 * Pure per-task efficiency and lifecycle metrics (spec 0042 T10b, R17/R18).
 * Everything here works on plain facts the join extracted: no filesystem, no
 * clock, no git. An unknown figure is `null` with a reason, never zero, and no
 * metric is combined into a score: less output is not better quality.
 */

/** Epoch-ms `[from, to]`. */
export type Interval = readonly [number, number];

/**
 * Longest review begin-to-seal span counted as active time. A `begin` stamped
 * and sealed after a crash or a resume can span hours of nobody working; above
 * the ceiling the interval is not active, the episode is `partial` (M5).
 */
export const REVIEW_SPAN_CAP_MS = 2 * 60 * 60 * 1000;

const COMPONENTS = ["input", "output", "cacheRead", "cacheCreation", "thinking"] as const;

/** Nearest-rank quantile; `null` for no data — unavailable, never zero. */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? null;
}

/** Disjoint, ordered union of the intervals; empty or inverted ones are dropped. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** The parts of `intervals` inside `[from, to]`. */
export function clipIntervals(
  intervals: readonly Interval[],
  from: number,
  to: number,
): Interval[] {
  return intervals.map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as const);
}

/** `from` without the parts covered by `minus`. */
export function subtractIntervals(
  from: readonly Interval[],
  minus: readonly Interval[],
): Interval[] {
  const holes = mergeIntervals(minus);
  const out: Interval[] = [];
  for (const [start, end] of mergeIntervals(from)) {
    let cursor = start;
    for (const [a, b] of holes) {
      if (b <= cursor || a >= end) continue;
      if (a > cursor) out.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < end) out.push([cursor, end]);
  }
  return out;
}

/** Total length of the union (parallel work is counted once). */
export function unionLength(intervals: readonly Interval[]): number {
  return mergeIntervals(intervals).reduce((sum, [from, to]) => sum + (to - from), 0);
}

/** The most frequent reason, ties broken alphabetically; `null` for none. */
function topReason(reasons: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))[0]?.[0] ?? null;
}

/**
 * `{p50, p90, n, eligible, censored, state, reason}` of one metric. `observed`
 * only when every eligible task contributed; `unavailable` when none did.
 */
export function aggregate(
  values: number[],
  eligible: number,
  censored: number,
  excluded: readonly string[] = [],
): TaskMetric {
  const n = values.length;
  const state = n === 0 ? "unavailable" : n === eligible ? "observed" : "partial";
  return {
    p50: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    n,
    eligible,
    censored,
    state,
    reason: state === "observed" ? null : (topReason(excluded) ?? "no-eligible-tasks"),
  };
}

const unknown = (reason: string, state: TaskValue["state"] = "unavailable"): TaskValue => ({
  value: null,
  state,
  reason,
});

/** One review round of an episode. */
export interface RoundFacts {
  time: number;
  startedAtMs?: number;
  sealedAtMs?: number;
  correlated: boolean;
  verdict: string;
  fp?: string;
}

/** One implementer run attributed to an episode through a confirmed dispatch. */
export interface RunFacts {
  /** Per component; `null` unless the run measured it as `observed`. */
  tokens: TokenComponents;
  /** Why some component is `null`: a `partial` measurement or none at all. */
  tokenGap: "partial-usage" | "ownership-unknown" | null;
  /** Own tool-pair intervals; `null` when the audit log was not observed. */
  active: readonly Interval[] | null;
  /** Gate attempts of the run; `null` when its session was not sealed. */
  gate: EpisodeGate | null;
}

/** What one session says about idle time inside an episode. */
export interface IdleSource {
  host: string;
  /** `null`: no transcript timestamps for this session. */
  gaps: readonly Interval[] | null;
  /** The session also holds other features: a gap cannot be assigned to one. */
  shared: boolean;
}

/** Everything the metrics need of one episode. */
export interface EpisodeFacts {
  accepted: boolean;
  acceptedAtMs?: number;
  acceptedFp?: string;
  leftCensored: boolean;
  ambiguous: boolean;
  hosts: readonly string[];
  /** Kind of the earliest item of the episode. */
  firstItem: "dispatch" | "round" | "receipt";
  /** The first round was observed in a session that also holds the first dispatch. */
  firstRoundLinked: boolean;
  rounds: readonly RoundFacts[];
  /** Confirmed dispatches, by event time. */
  dispatches: readonly number[];
  /** Dispatches of this feature on a host with no spawn-to-run link. */
  unlinkable: number;
  runs: readonly RunFacts[];
  idle: readonly IdleSource[];
}

const nullTokens = (): TokenComponents => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheCreation: null,
  thinking: null,
});

/** Components all runs measured; any gap makes the component `null`, never a partial sum. */
function sumTokens(runs: readonly RunFacts[]): TokenComponents {
  const out = nullTokens();
  for (const key of COMPONENTS) {
    const values = runs.map((run) => run.tokens[key]);
    if (values.length > 0 && values.every((value): value is number => value !== null))
      out[key] = values.reduce((sum, value) => sum + value, 0);
  }
  return out;
}

function firstApprovalOf(facts: EpisodeFacts): { value: boolean | null; reason: string | null } {
  const rounds = [...facts.rounds].sort((a, b) => a.time - b.time);
  const first = rounds[0];
  if (!first) return { value: null, reason: "no-review-round" };
  if (facts.leftCensored) return { value: null, reason: "left-censored" };
  // M2: only a confirmed dispatch proves the history before the first round was observed.
  if (facts.firstItem !== "dispatch" || !facts.firstRoundLinked)
    return { value: null, reason: "unobserved-history" };
  if (!first.correlated) return { value: null, reason: "incomplete-round" };
  if (first.verdict === "changes-requested") return { value: false, reason: null };
  if (first.verdict !== "approved") return { value: null, reason: "incomplete-round" };
  if (!facts.accepted) return { value: null, reason: "pending" };
  return { value: first.fp === facts.acceptedFp, reason: null };
}

/** R17 figures of one episode. */
export function efficiencyOf(facts: EpisodeFacts): EpisodeEfficiency {
  const rounds = facts.rounds.filter(
    (round) => facts.acceptedAtMs === undefined || round.time <= facts.acceptedAtMs,
  ).length;
  const approval = firstApprovalOf(facts);
  const base = {
    tokenScope: "implementer-dispatch" as const,
    rounds,
    firstApproval: approval.value,
    firstApprovalReason: approval.reason,
  };
  if (facts.dispatches.length === 0 || facts.runs.length === 0)
    return {
      ...base,
      tokens: nullTokens(),
      tokensReason: facts.hosts.includes("codex") ? "ownership-unknown" : "no-dispatch-event",
      attributedRuns: 0,
      gate: null,
      gateReason: "no-dispatch-event",
    };
  const tokens = sumTokens(facts.runs);
  const gaps = facts.runs.flatMap((run) => (run.tokenGap ? [run.tokenGap] : []));
  const gates = facts.runs.map((run) => run.gate);
  const known = gates.flatMap((gate) => (gate ? [gate] : []));
  return {
    ...base,
    tokens,
    tokensReason:
      facts.unlinkable > 0
        ? "ownership-unknown"
        : gaps.includes("partial-usage")
          ? "partial-usage"
          : (gaps[0] ?? null),
    attributedRuns: facts.runs.length,
    gate:
      known.length === gates.length
        ? known.reduce(
            (sum, gate) => ({
              executions: sum.executions + gate.executions,
              failures: sum.failures + gate.failures,
              notRun: sum.notRun + gate.notRun,
              unverifiable: sum.unverifiable + gate.unverifiable,
            }),
            { executions: 0, failures: 0, notRun: 0, unverifiable: 0 },
          )
        : null,
    gateReason: known.length === gates.length ? null : "unsealed",
  };
}

/** Why an episode has no elapsed time at all. */
function censorReason(facts: EpisodeFacts): string | null {
  if (!facts.accepted) return "censored";
  if (facts.leftCensored) return "left-censored";
  return facts.ambiguous ? "ambiguous-boundary" : null;
}

/** `claude` or `codex` when every session of the episode is of that host, else `mixed`. */
function idleHostOf(facts: EpisodeFacts): EpisodeLifecycle["idleHost"] {
  const hosts = new Set(facts.idle.map((source) => source.host));
  return hosts.size === 1 && hosts.has("claude")
    ? "claude"
    : hosts.size === 1 && hosts.has("codex")
      ? "codex"
      : "mixed";
}

/** Idle gaps of the episode's sessions inside `[from, to]`; Claude-only, never in shared sessions. */
function idleOf(
  facts: EpisodeFacts,
  from: number,
  to: number,
): { value: TaskValue; host: EpisodeLifecycle["idleHost"]; intervals: Interval[] } {
  const host = idleHostOf(facts);
  const none = (value: TaskValue) => ({ value, host, intervals: [] as Interval[] });
  if (facts.idle.length === 0 || host !== "claude")
    return none(
      unknown("no-source", host === "mixed" && facts.idle.length > 0 ? "partial" : "unavailable"),
    );
  if (facts.idle.some((source) => source.shared)) return none(unknown("shared-session", "partial"));
  if (facts.idle.some((source) => source.gaps === null)) return none(unknown("no-source"));
  const intervals = mergeIntervals(
    clipIntervals(
      facts.idle.flatMap((source) => source.gaps ?? []),
      from,
      to,
    ),
  );
  return {
    value: { value: unionLength(intervals), state: "observed", reason: null },
    host,
    intervals,
  };
}

/** R18 figures of one episode. Active/idle/unclassified need a confirmed dispatch as the start. */
export function lifecycleOf(facts: EpisodeFacts): EpisodeLifecycle {
  const reason = censorReason(facts);
  const dispatchStart = facts.dispatches.length ? Math.min(...facts.dispatches) : undefined;
  const reviewBegins = facts.rounds.flatMap((round) =>
    round.startedAtMs === undefined ? [] : [round.startedAtMs],
  );
  const reviewStart = reviewBegins.length ? Math.min(...reviewBegins) : undefined;
  const at = facts.acceptedAtMs;
  const span = (start: number | undefined): number | null =>
    reason === null && start !== undefined && at !== undefined && at >= start ? at - start : null;
  const elapsedMs = span(dispatchStart);
  const censored = reason !== null;
  const base = {
    start:
      dispatchStart !== undefined
        ? ("dispatch" as const)
        : reviewStart !== undefined
          ? ("review-begin" as const)
          : null,
    censored,
    elapsedMs,
    reviewElapsedMs: span(reviewStart),
  };
  if (elapsedMs === null || dispatchStart === undefined || at === undefined) {
    const why = reason ?? "no-dispatch-event";
    return {
      ...base,
      active: unknown(why),
      idleBetweenTurns: unknown(idleHostOf(facts) === "claude" ? why : "no-source"),
      idleHost: idleHostOf(facts),
      unclassified: unknown(why),
      includesUnidentifiedWaits: true,
    };
  }

  // Active = union of the attributed runs' own tool pairs plus bounded review intervals.
  const reviews = facts.rounds.filter((round) => round.time <= at);
  let gap: string | null = null;
  const intervals: Interval[] = [];
  if (facts.runs.length === 0) gap = "ownership-unknown";
  for (const run of facts.runs) {
    if (run.active === null || run.active.length === 0) gap ??= "partial-source";
    else intervals.push(...run.active);
  }
  for (const round of reviews) {
    if (round.startedAtMs === undefined || round.sealedAtMs === undefined)
      gap ??= "incomplete-round";
    else if (
      round.sealedAtMs < round.startedAtMs ||
      round.sealedAtMs - round.startedAtMs > REVIEW_SPAN_CAP_MS
    )
      gap ??= "review-span-cap";
    else intervals.push([round.startedAtMs, round.sealedAtMs]);
  }
  const active = mergeIntervals(clipIntervals(intervals, dispatchStart, at));
  const idle = idleOf(facts, dispatchStart, at);
  const activeValue: TaskValue =
    gap === null
      ? { value: unionLength(active), state: "observed", reason: null }
      : unknown(gap, "partial");
  return {
    ...base,
    active: activeValue,
    idleBetweenTurns: idle.value,
    idleHost: idle.host,
    unclassified:
      gap === null
        ? {
            value: elapsedMs - unionLength([...active, ...idle.intervals]),
            state: "observed",
            reason: null,
          }
        : unknown(gap, "partial"),
    includesUnidentifiedWaits: idle.value.state !== "observed" || facts.idle.length > 1,
  };
}

/** An episode with its derived figures. */
export interface EpisodeRow {
  facts: EpisodeFacts;
  efficiency: EpisodeEfficiency;
  lifecycle: EpisodeLifecycle;
}

/** One metric over the accepted rows; `censored` open rows stay out of p50/p90. */
function over(
  rows: readonly EpisodeRow[],
  censored: number,
  pick: (row: EpisodeRow) => { value: number | null; reason: string | null },
): TaskMetric {
  const picked = rows.map(pick);
  return aggregate(
    picked.flatMap((p) => (p.value === null ? [] : [p.value])),
    rows.length,
    censored,
    picked.flatMap((p) => (p.value === null ? [p.reason ?? "not-observed"] : [])),
  );
}

const tokenMetrics = (
  rows: readonly EpisodeRow[],
  censored: number,
): Record<keyof TokenTotals, TaskMetric> =>
  Object.fromEntries(
    COMPONENTS.map((key) => [
      key,
      over(rows, censored, (row) => ({
        value: row.efficiency.tokens[key],
        reason: row.efficiency.tokensReason,
      })),
    ]),
  ) as Record<keyof TokenTotals, TaskMetric>;

/** Value and reason of a lifecycle time, with the censoring reasons first. */
const timeOf =
  (pick: (row: EpisodeRow) => number | null, missing: string) =>
  (row: EpisodeRow): { value: number | null; reason: string | null } => ({
    value: pick(row),
    reason: censorReason(row.facts) ?? missing,
  });

/** The R17/R18 summary of a range. `unattributed` is what no confirmed dispatch claims. */
export function summarizeEpisodes(
  rows: readonly EpisodeRow[],
  unattributed: OutcomeSummary["unattributed"],
): OutcomeSummary {
  const accepted = rows.filter((row) => row.facts.accepted);
  const open = rows.filter((row) => !row.facts.accepted);
  const openObserved = open.filter((row) => !row.facts.leftCensored).length;
  const withRounds = rows.filter((row) => row.facts.rounds.length > 0);
  const approvals = withRounds.map((row) => row.efficiency);
  const yes = approvals.filter((e) => e.firstApproval === true).length;
  const no = approvals.filter((e) => e.firstApproval === false).length;
  const undetermined = approvals.length - yes - no;
  // Failures are counted over every episode, open ones included: a task still failing its gate is
  // exactly the signal an accepted-only total would drop.
  const gated = rows.flatMap((row) => (row.efficiency.gate ? [row.efficiency.gate] : []));
  const gatedAccepted = accepted.flatMap((row) =>
    row.efficiency.gate ? [row.efficiency.gate] : [],
  );
  const sum = (key: keyof EpisodeGate, from: readonly EpisodeGate[] = gated): number =>
    from.reduce((n, gate) => n + gate[key], 0);
  const stratum = (host: EpisodeLifecycle["idleHost"]): TaskMetric =>
    over(
      accepted.filter((row) => row.lifecycle.idleHost === host),
      open.filter((row) => row.lifecycle.idleHost === host).length,
      (row) => ({
        value: row.lifecycle.idleBetweenTurns.value,
        reason: row.lifecycle.idleBetweenTurns.reason,
      }),
    );
  const dispatched = rows.filter((row) => row.efficiency.attributedRuns > 0).length;
  const gateEpisodes = gated.length;
  return {
    r17: {
      tokenScope: "implementer-dispatch",
      tokenCoverage: {
        episodes: rows.length,
        withDispatch: dispatched,
        withoutDispatch: rows.length - dispatched,
      },
      tokensPerAcceptedTask: tokenMetrics(accepted, open.length),
      tokensAllTasks: tokenMetrics(rows, 0),
      reviewRoundsToAcceptance: over(accepted, open.length, (row) => ({
        value: censorReason(row.facts) === null ? row.efficiency.rounds : null,
        reason: censorReason(row.facts),
      })),
      firstApproval: {
        yes,
        no,
        undetermined,
        eligible: approvals.length,
        state:
          approvals.length === 0 || yes + no === 0
            ? "unavailable"
            : undetermined === 0
              ? "observed"
              : "partial",
        reason:
          undetermined === 0
            ? null
            : topReason(
                approvals.flatMap((e) =>
                  e.firstApproval === null ? [e.firstApprovalReason ?? "incomplete-round"] : [],
                ),
              ),
      },
      gate: {
        executions: sum("executions"),
        failures: sum("failures"),
        notRun: sum("notRun"),
        unverifiable: sum("unverifiable"),
        episodes: gateEpisodes,
        eligible: rows.length,
        withoutGateExecution: gated.filter((gate) => gate.executions === 0).length,
        acceptedOnly: {
          executions: sum("executions", gatedAccepted),
          failures: sum("failures", gatedAccepted),
          episodes: gatedAccepted.length,
          eligible: accepted.length,
        },
        state:
          gateEpisodes === 0
            ? "unavailable"
            : gateEpisodes === rows.length
              ? "observed"
              : "partial",
        reason:
          gateEpisodes === rows.length
            ? null
            : topReason(
                rows.flatMap((row) =>
                  row.efficiency.gate ? [] : [row.efficiency.gateReason ?? "no-dispatch-event"],
                ),
              ),
      },
    },
    r18: {
      timeToAcceptance: over(
        accepted,
        openObserved,
        timeOf((row) => row.lifecycle.elapsedMs, "no-dispatch-event"),
      ),
      reviewToAcceptance: over(
        accepted,
        openObserved,
        timeOf((row) => row.lifecycle.reviewElapsedMs, "no-review-round"),
      ),
      activeTime: over(accepted, openObserved, (row) => row.lifecycle.active),
      idleBetweenTurns: {
        claude: stratum("claude"),
        codex: stratum("codex"),
        mixed: stratum("mixed"),
      },
      unclassified: over(accepted, openObserved, (row) => row.lifecycle.unclassified),
      reviewSpanCapMs: REVIEW_SPAN_CAP_MS,
    },
    unattributed,
  };
}
