import type { MetricPopulation, Recommendation, SessionAudit } from "./model.ts";

/**
 * Observed causes of friction, errors, repetition and hook toll, ranked per
 * denominator (spec 0042 R20, D6).
 *
 * PURE, and on purpose blind to any snapshot or comparison: its input is the
 * range's own sessions and metrics, so a difference of medians can never become
 * a cause. A test pins the signature.
 *
 * No composite score and no mixed denominator. Each cause belongs to one
 * `group` (its unit of denominator) and is ranked only against the causes of
 * the SAME group; the group order is a fixed presentation policy, not a
 * priority.
 *
 * Evidence floors live at range level and are declared engineering choices,
 * NOT pre-registered ones (the per-session floors of `signals.ts` decide a
 * session's severity and say nothing about a range): below a floor a cause is
 * an unranked `lead`; above it, a `fact` means "observed at this rate", never a
 * causal claim. Hypotheses sit apart, as closed ids with their next probe.
 */

/** Pooled calls under which one event still moves a rate by a full percentage point. */
export const MIN_CALLS = 100;
/** Sessions under which a single one can be the whole ranking. */
export const MIN_SESSIONS = 3;
/** Toll phases under which the toll is anecdote. */
export const MIN_TOLL_EVENTS = 10;

type Hypothesis = Recommendation["hypotheses"][number];

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
const cards = (
  s: SessionAudit,
): Array<SessionAudit["orchestrator"] | SessionAudit["agents"][number]> => [
  s.orchestrator,
  ...s.agents,
];
const calls = (s: SessionAudit): number =>
  sum(cards(s).map((c) => sum(Object.values(c.toolCounts))));
const bashCalls = (s: SessionAudit): number => sum(cards(s).map((c) => c.toolCounts.Bash ?? 0));
const errors = (s: SessionAudit): number =>
  sum(
    cards(s).map(
      (c) =>
        c.toolErrors.shellFailure +
        c.toolErrors.toolUnavailable +
        c.toolErrors.editMiss +
        c.toolErrors.other,
    ),
  );
const friction = (s: SessionAudit): number => sum(cards(s).map((c) => c.frictionEvents));
const repeated = (s: SessionAudit): number =>
  sum(cards(s).map((c) => sum(Object.values(c.repeatedCommands))));

function rate(
  eligible: readonly SessionAudit[],
  cause: Recommendation["cause"],
  group: Recommendation["group"],
  count: (s: SessionAudit) => number,
  denominator: (s: SessionAudit) => number,
  hypotheses: Hypothesis[],
): Recommendation | null {
  const events = sum(eligible.map(count));
  if (events === 0) return null;
  const n = sum(eligible.map(denominator));
  return {
    group,
    cause,
    status: n >= MIN_CALLS && eligible.length >= MIN_SESSIONS ? "fact" : "lead",
    rank: null,
    impact: {
      unit: "ratio",
      value: n > 0 ? Math.round((events / n) * 10_000) / 10_000 : null,
      n,
      state: "observed",
    },
    scope: {
      sessions: eligible.filter((s) => count(s) > 0).length,
      eligibleSessions: eligible.length,
    },
    evidence: { metrics: [], signals: [cause] },
    hypotheses,
  };
}

function reviewCycles(eligible: readonly SessionAudit[]): Recommendation | null {
  const sessions = eligible.filter(
    (s) => s.agents.filter((a) => a.verdict === "CHANGES_REQUESTED").length >= 2,
  );
  const runs = sessions.flatMap((s) => s.agents.filter((a) => a.verdict === "CHANGES_REQUESTED"));
  if (runs.length === 0) return null;
  const measured = runs.every((a) => {
    const state = a.availability?.["tokens.output"]?.state;
    return state === "observed" || state === "partial";
  });
  return {
    group: "tokens",
    cause: "review-cycles",
    status: measured ? "fact" : "lead",
    rank: null,
    impact: {
      unit: "tokens",
      value: measured ? sum(runs.map((a) => a.tokens.output)) : null,
      n: runs.length,
      state: measured ? "observed" : "unavailable",
    },
    scope: { sessions: sessions.length, eligibleSessions: eligible.length },
    evidence: { metrics: [], signals: ["review-cycles"] },
    hypotheses: [],
  };
}

function hookToll(
  eligible: readonly SessionAudit[],
  metrics: Record<string, number | null>,
  availability: Record<string, MetricPopulation>,
): Recommendation | null {
  const toll = metrics["hooks.tollMs"];
  const events = metrics["hooks.tollEvents"] ?? 0;
  const state = availability["hooks.tollMs"]?.state;
  if (typeof toll !== "number" || toll <= 0 || (state !== "observed" && state !== "partial"))
    return null;
  const hooks = Object.entries(metrics)
    .filter(([key, value]) => /^hook\..+\.ms$/.test(key) && typeof value === "number" && value > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 3)
    .map(([key]) => key);
  return {
    group: "blocking-ms",
    cause: "hook-toll",
    status: events >= MIN_TOLL_EVENTS ? "fact" : "lead",
    rank: null,
    impact: {
      unit: "ms",
      value: toll,
      n: events,
      // Hook runs with no tool-use id cannot be grouped: the toll is a lower bound.
      state:
        state === "partial" || (metrics["hooks.ungroupedFires"] ?? 0) > 0 ? "partial" : "observed",
    },
    scope: { sessions: eligible.length, eligibleSessions: eligible.length },
    evidence: {
      metrics: ["hooks.tollMs", "hooks.tollEvents", "hooks.ungroupedFires", ...hooks],
      signals: [],
    },
    hypotheses: [{ id: "toll-share-by-hook", nextProbe: "parallel-group-ids" }],
  };
}

/** Fixed presentation order of the groups; it carries no priority between units. */
const GROUP_ORDER: Array<Recommendation["group"]> = [
  "per-tool-call",
  "per-bash-call",
  "tokens",
  "blocking-ms",
];

/**
 * Observed causes, facts first. Each fact is ranked 1..n inside its own group by
 * impact value; leads carry no rank.
 */
export function buildRecommendations(input: {
  sessions: readonly SessionAudit[];
  rangeMetrics: Record<string, number | null>;
  availability: Record<string, MetricPopulation>;
}): Recommendation[] {
  const eligible = input.sessions.filter((s) => s.availability?.tools?.state === "observed");
  const all = [
    rate(eligible, "tool-errors", "per-tool-call", errors, calls, [
      { id: "errors-cost-context", nextProbe: "tokens-after-error" },
    ]),
    rate(eligible, "friction", "per-tool-call", friction, calls, [
      { id: "blocks-cost-context", nextProbe: "tokens-after-block" },
      { id: "manual-approval-invisible", nextProbe: null },
    ]),
    rate(eligible, "repeated-commands", "per-bash-call", repeated, bashCalls, [
      { id: "repetition-not-proven-rework", nextProbe: "inspect-session-signal" },
    ]),
    reviewCycles(eligible),
    hookToll(eligible, input.rangeMetrics, input.availability),
  ].filter((r): r is Recommendation => r !== null);
  const ordered: Recommendation[] = [];
  for (const group of GROUP_ORDER) {
    const facts = all
      .filter((r) => r.group === group && r.status === "fact")
      .sort(
        (a, b) =>
          (b.impact.value ?? 0) - (a.impact.value ?? 0) || b.scope.sessions - a.scope.sessions,
      );
    facts.forEach((r, i) => ordered.push({ ...r, rank: i + 1 }));
  }
  return [...ordered, ...all.filter((r) => r.status === "lead")];
}
