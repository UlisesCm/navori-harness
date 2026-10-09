import {
  correlateGateExecutions,
  type AgentRun,
  type AuditOutcomes,
  type DispatchOutcome,
  type DispatchSummary,
  type EpisodeGate,
  type EpisodeReceipts,
  type EpisodeReviews,
  type MetricEvidence,
  type Outcome,
  type OutcomeEpisode,
  type OutcomeSummary,
  type ReceiptOutcome,
  type ReviewOutcome,
  type SessionAudit,
  type TokenComponents,
  type TokenTotals,
} from "./model.ts";
import {
  efficiencyOf,
  lifecycleOf,
  summarizeEpisodes,
  type EpisodeFacts,
  type EpisodeRow,
  type IdleSource,
  type RunFacts,
} from "./task-metrics.ts";

/**
 * Pure join of `review-outcome` and `receipt-outcome` events (spec 0042 D5,
 * T9b). No git, no filesystem, no spawn: the report only reads what the
 * writers already logged, so it can never re-run a check. A feature is only
 * ever its `featureKey` (`sha256(repo + NUL + feature)`); the label derives
 * from it.
 *
 * Acceptance ("local technical acceptance") for a diff identity `fp` needs:
 *  - the LATEST correlated review round for that `fp` is `approved` (a later
 *    `changes-requested` on the same `fp` revokes it),
 *  - a `receipt` that is `ok`, `fresh` and `stable`, and
 *  - the same `(alg, fp, base, gate, inputs)` on both sides, with a configured
 *    gate (no gate is never a pass).
 * A `sign` receipt counts as fresh: it computes gate/inputs at the very moment
 * it records the content, and the identity tuple still has to match the review.
 * Order between review and receipt is not required; content decides, `head` is
 * provenance only.
 */

/** One logged outcome with the session it came from. */
interface Observation {
  sessionId: string;
  host: string;
  tsMs: number;
  outcome: Outcome;
}

/**
 * What the join reads of a session. Everything past the identity and the
 * events is optional: runs confirm dispatches (T10a) and carry the usage, gate
 * and active-time evidence the T10b metrics derive from.
 */
type JoinSession = Pick<SessionAudit, "sessionId" | "host" | "cliEvents"> &
  Partial<
    Pick<SessionAudit, "agents" | "orchestrator" | "sealed" | "availability" | "idleBetweenTurns">
  >;

/** Whether a session logged at least one valid review / receipt / dispatch outcome. */
export function outcomeKinds(session: Pick<SessionAudit, "cliEvents">): {
  review: boolean;
  receipt: boolean;
  dispatch: boolean;
} {
  const kinds = { review: false, receipt: false, dispatch: false };
  for (const event of session.cliEvents ?? []) {
    if (event.outcomePayload?.name === "review-outcome") kinds.review = true;
    if (event.outcomePayload?.name === "receipt-outcome") kinds.receipt = true;
    if (event.outcomePayload?.name === "dispatch-outcome") kinds.dispatch = true;
  }
  return kinds;
}

/** Public, non-reversible label of a feature, derived from its key. Passes the public label filter as is. */
export function featureLabel(featureKey: string): string {
  return `unknown-${featureKey.slice(0, 12)}`;
}

interface Provenance {
  sessions: Set<string>;
  hosts: Set<string>;
  events: number;
}

interface Round extends Provenance {
  key: string;
  outcome: ReviewOutcome;
  /** Same round observed as correlated with two different identities. */
  conflicting: boolean;
  /** Round time: when it was sealed, else when first logged. */
  time: number;
}

interface ReceiptObservation extends Provenance {
  outcome: ReceiptOutcome;
  time: number;
}

interface Item {
  time: number;
  /** Diff identity the item carries, when it carries one. */
  fp?: string;
  round?: Round;
  receipt?: ReceiptObservation;
  dispatch?: ConfirmedDispatch;
}

const touch = (into: Provenance, observation: Observation): void => {
  into.sessions.add(observation.sessionId);
  into.hosts.add(observation.host);
  into.events += 1;
};

/** A round is keyed by its nonce (re-reading the sidecar is not a new round); legacy rounds by sidecar hash. */
const roundKey = (outcome: ReviewOutcome): string =>
  outcome.nonce ? `n:${outcome.nonce}` : `s:${outcome.sidecar}`;

const isCorrelated = (round: Round): boolean =>
  round.outcome.correlation === "correlated" && !round.conflicting && !!round.outcome.fp;

/** The reason a round does not count as correlated evidence. */
const reasonOf = (round: Round): string =>
  round.conflicting ? "ambiguous" : round.outcome.correlation;

function addRound(rounds: Map<string, Round>, observation: Observation): void {
  const outcome = observation.outcome as ReviewOutcome;
  const key = roundKey(outcome);
  const time = outcome.sealedAtMs ?? observation.tsMs;
  const known = rounds.get(key);
  if (!known) {
    const round: Round = {
      key,
      outcome,
      conflicting: false,
      time,
      sessions: new Set(),
      hosts: new Set(),
      events: 0,
    };
    touch(round, observation);
    rounds.set(key, round);
    return;
  }
  touch(known, observation);
  const incomingCorrelated = outcome.correlation === "correlated" && !!outcome.fp;
  if (isCorrelated(known) && incomingCorrelated && known.outcome.fp !== outcome.fp) {
    known.conflicting = true;
  } else if (!isCorrelated(known) && incomingCorrelated) {
    // The correlated observation carries the identity; the others only add provenance.
    known.outcome = outcome;
    known.time = time;
  }
}

function addReceipt(receipts: Map<string, ReceiptObservation>, observation: Observation): void {
  const outcome = observation.outcome as ReceiptOutcome;
  // Full identity tuple (alg, fp, base, gate, inputs) plus head as provenance:
  // observations differing in any of them must stay distinct.
  const key = [
    outcome.action,
    outcome.receipt ?? "none",
    outcome.alg ?? "none",
    outcome.fp ?? "none",
    outcome.base ?? "none",
    outcome.head ?? "none",
    outcome.gate ?? "none",
    outcome.inputs ?? "none",
    outcome.verdict,
    outcome.freshness ?? "",
    outcome.stale ?? "",
    outcome.identity ?? "",
  ].join("|");
  const known = receipts.get(key);
  if (known) {
    touch(known, observation);
    return;
  }
  const receipt: ReceiptObservation = {
    outcome,
    time: observation.tsMs,
    sessions: new Set(),
    hosts: new Set(),
    events: 0,
  };
  touch(receipt, observation);
  receipts.set(key, receipt);
}

/** The receipt that confirms this round, if any: ok + fresh + stable with the identical identity tuple. */
const confirms = (round: Round, receipt: ReceiptObservation): boolean => {
  const review = round.outcome;
  const seen = receipt.outcome;
  return (
    seen.verdict === "ok" &&
    seen.freshness === "fresh" &&
    seen.identity === "stable" &&
    review.gate !== undefined &&
    review.base !== undefined &&
    seen.alg === review.alg &&
    seen.fp === review.fp &&
    seen.base === review.base &&
    seen.gate === review.gate &&
    seen.inputs === review.inputs
  );
};

/** Acceptance of an episode's items so far: its time and diff identity when accepted, else `undefined`. */
function acceptedAt(
  rounds: readonly Round[],
  receipts: readonly ReceiptObservation[],
): { at: number; fp: string } | undefined {
  const latest = new Map<string, Round>();
  for (const round of rounds) {
    if (!isCorrelated(round)) continue;
    const fp = round.outcome.fp as string;
    const current = latest.get(fp);
    if (!current || round.time >= current.time) latest.set(fp, round);
  }
  let best: { at: number; fp: string } | undefined;
  for (const round of latest.values()) {
    if (round.outcome.verdict !== "approved") continue;
    const times = receipts.filter((receipt) => confirms(round, receipt)).map((r) => r.time);
    if (times.length === 0) continue;
    const at = Math.max(round.time, Math.min(...times));
    if (best === undefined || at < best.at) best = { at, fp: round.outcome.fp as string };
  }
  return best;
}

interface Draft {
  items: Item[];
  fps: Set<string>;
  ambiguous: boolean;
}

/** A dispatch whose spawn a run of its own session links to, and that run(s). */
interface ConfirmedDispatch {
  tsMs: number;
  sessionId: string;
  runs: AgentRun[];
}

/** What the episodes of one feature are built against. */
interface JoinContext {
  sessions: ReadonlyMap<string, JoinSession>;
  /** Feature keys each session logged any outcome event for. */
  featuresBySession: ReadonlyMap<string, ReadonlySet<string>>;
  /** Dispatches of the feature on a host with no spawn-to-run link. */
  unlinkable: number;
  /** Runs assigned to an episode; the rest of the usage is unattributed. */
  assigned: Set<AgentRun>;
}

/** The fast gate of the pre-commit hook: the only gate with a terminal verdict event. */
const FAST_GATE = "quality-gate-pre-commit\u0000";
const COMPONENTS = ["input", "output", "cacheRead", "cacheCreation", "thinking"] as const;
const isMeasured = (evidence: MetricEvidence | undefined): boolean =>
  evidence?.state === "observed" || evidence?.state === "partial";

/** Fast-gate executions of a sealed session that ran and ended with one verdict, by owner run. */
function gateOf(session: JoinSession, agentId: string): EpisodeGate | null {
  if (!session.sealed || !session.orchestrator || !session.agents) return null;
  const gate: EpisodeGate = { executions: 0, failures: 0, notRun: 0, unverifiable: 0, deferred: 0 };
  for (const execution of correlateGateExecutions({
    sealed: session.sealed,
    orchestrator: session.orchestrator,
    agents: session.agents,
  })) {
    if (execution.ownerAgentId !== agentId || !execution.handle.startsWith(FAST_GATE)) continue;
    if (execution.outcome === "deferred") gate.deferred++;
    else if (execution.outcome !== "completed" || !execution.ownerExact) gate.unverifiable++;
    else if (execution.ran && execution.terminal) {
      gate.executions++;
      if (execution.terminal === "block") gate.failures++;
    } else if (execution.terminal === "block") gate.notRun++;
  }
  return gate;
}

/** One attributed run: tokens only per observed component, own active intervals, own gate attempts. */
function runFacts(run: AgentRun, session: JoinSession): RunFacts {
  const tokens = Object.fromEntries(
    COMPONENTS.map((key) => [
      key,
      run.availability?.[`tokens.${key}`]?.state === "observed" ? run.tokens[key] : null,
    ]),
  ) as TokenComponents;
  const states = COMPONENTS.map((key) => run.availability?.[`tokens.${key}`]?.state);
  return {
    tokens,
    tokenGap: states.includes("partial")
      ? "partial-usage"
      : states.every((state) => state === "observed")
        ? null
        : "ownership-unknown",
    active:
      session.availability?.activeMs?.state === "observed" ? (run.activeIntervals ?? null) : null,
    gate: gateOf(session, run.agentId),
  };
}

function factsOf(
  draft: Draft,
  at: { at: number; fp: string } | undefined,
  leftCensored: boolean,
  dispatches: readonly ConfirmedDispatch[],
  context: JoinContext,
): EpisodeFacts {
  const rounds = draft.items.flatMap((item) => (item.round ? [item.round] : []));
  const sessionIds = new Set([
    ...draft.items.flatMap((item) => [...((item.round ?? item.receipt)?.sessions ?? [])]),
    ...dispatches.map((dispatch) => dispatch.sessionId),
  ]);
  const runs = new Map<AgentRun, RunFacts>();
  for (const dispatch of dispatches)
    for (const run of dispatch.runs) {
      const session = context.sessions.get(dispatch.sessionId);
      if (!session || runs.has(run)) continue;
      context.assigned.add(run);
      runs.set(run, runFacts(run, session));
    }
  const byTime = [...rounds].sort((a, b) => a.time - b.time);
  const firstDispatch = dispatches.reduce<ConfirmedDispatch | undefined>(
    (first, dispatch) => (!first || dispatch.tsMs < first.tsMs ? dispatch : first),
    undefined,
  );
  const firstItem = draft.items[0];
  return {
    accepted: at !== undefined,
    ...(at === undefined ? {} : { acceptedAtMs: at.at, acceptedFp: at.fp }),
    leftCensored,
    ambiguous: draft.ambiguous,
    hosts: [
      ...new Set(draft.items.flatMap((item) => [...((item.round ?? item.receipt)?.hosts ?? [])])),
    ],
    firstItem: firstItem?.dispatch ? "dispatch" : firstItem?.round ? "round" : "receipt",
    firstRoundLinked: !!firstDispatch && !!byTime[0]?.sessions.has(firstDispatch.sessionId),
    rounds: rounds.map((round) => ({
      time: round.time,
      correlated: isCorrelated(round),
      verdict: round.outcome.verdict,
      ...(round.outcome.fp ? { fp: round.outcome.fp } : {}),
      ...(round.outcome.startedAtMs === undefined
        ? {}
        : { startedAtMs: round.outcome.startedAtMs }),
      ...(round.outcome.sealedAtMs === undefined ? {} : { sealedAtMs: round.outcome.sealedAtMs }),
    })),
    dispatches: dispatches.map((dispatch) => dispatch.tsMs),
    unlinkable: context.unlinkable,
    runs: [...runs.values()],
    idle: [...sessionIds].flatMap((id): IdleSource[] => {
      const session = context.sessions.get(id);
      if (!session) return [];
      const host = session.host ?? "claude";
      return [
        {
          host,
          gaps: host === "claude" ? (session.idleBetweenTurns ?? null) : null,
          shared: (context.featuresBySession.get(id)?.size ?? 0) > 1,
        },
      ];
    }),
  };
}

function summarize(
  draft: Draft,
  leftCensored: boolean,
  context: JoinContext,
): { episode: OutcomeEpisode; facts: EpisodeFacts } {
  const rounds = draft.items.flatMap((item) => (item.round ? [item.round] : []));
  const receipts = draft.items.flatMap((item) => (item.receipt ? [item.receipt] : []));
  const dispatches = draft.items.flatMap((item) => (item.dispatch ? [item.dispatch] : []));
  const reviews: EpisodeReviews = {
    rounds: rounds.length,
    approved: rounds.filter((round) => round.outcome.verdict === "approved").length,
    correlated: rounds.filter(isCorrelated).length,
    uncorrelatedByReason: {},
  };
  for (const round of rounds)
    if (!isCorrelated(round))
      reviews.uncorrelatedByReason[reasonOf(round)] =
        (reviews.uncorrelatedByReason[reasonOf(round)] ?? 0) + 1;
  const counts: EpisodeReceipts = {
    observations: receipts.length,
    ok: 0,
    fresh: 0,
    stale: 0,
    findings: 0,
    error: 0,
    unstable: 0,
  };
  for (const { outcome } of receipts) {
    counts[outcome.verdict] += 1;
    if (outcome.freshness === "fresh") counts.fresh += 1;
    if (outcome.freshness === "stale") counts.stale += 1;
    if (outcome.identity === "unstable") counts.unstable += 1;
  }
  const at = acceptedAt(rounds, receipts);
  const all: Provenance[] = [...rounds, ...receipts];
  const events = all.reduce((sum, row) => sum + row.events, 0);
  return {
    facts: factsOf(draft, at, leftCensored, dispatches, context),
    episode: {
      boundary: draft.ambiguous ? "ambiguous" : "known",
      leftCensored,
      reviews,
      receipts: counts,
      accepted: at !== undefined,
      ...(at === undefined ? {} : { acceptedAtMs: at.at }),
      provenance: {
        sessions: new Set(all.flatMap((row) => [...row.sessions])).size,
        hosts: new Set(all.flatMap((row) => [...row.hosts])).size,
        events,
        duplicates: events - all.length,
      },
    },
  };
}

/**
 * Episodes of one feature, in time order: acceptance closes one; a new identity
 * afterwards opens the next. A CONFIRMED dispatch after an acceptance also opens
 * the next one (a rework is a new attempt); unconfirmed ones never reach here.
 */
function episodesOf(
  rounds: readonly Round[],
  receipts: readonly ReceiptObservation[],
  dispatches: readonly ConfirmedDispatch[],
  rangeFromMs: number | null,
  context: JoinContext,
): Array<{ episode: OutcomeEpisode; facts: EpisodeFacts }> {
  const items: Item[] = [
    ...rounds.map((round) => ({
      time: round.time,
      round,
      ...(isCorrelated(round) ? { fp: round.outcome.fp as string } : {}),
    })),
    ...receipts.map((receipt) => ({
      time: receipt.time,
      receipt,
      ...(receipt.outcome.identity === "stable" && receipt.outcome.fp
        ? { fp: receipt.outcome.fp }
        : {}),
    })),
    ...dispatches.map((dispatch) => ({ time: dispatch.tsMs, dispatch })),
  ].sort((a, b) => a.time - b.time);

  const drafts: Draft[] = [];
  let current: Draft | undefined;
  for (const item of items) {
    if (
      current &&
      acceptedAt(
        current.items.flatMap((i) => (i.round ? [i.round] : [])),
        current.items.flatMap((i) => (i.receipt ? [i.receipt] : [])),
      ) !== undefined
    ) {
      if (item.dispatch) current = undefined;
      else if (item.fp === undefined) current.ambiguous = true;
      else if (!current.fps.has(item.fp)) current = undefined;
    }
    if (!current) {
      current = { items: [], fps: new Set(), ambiguous: false };
      drafts.push(current);
    }
    current.items.push(item);
    if (item.fp !== undefined) current.fps.add(item.fp);
  }
  return drafts.map((draft, index) => {
    const first = draft.items[0];
    const started = first?.dispatch ? first.dispatch.tsMs : first?.round?.outcome.startedAtMs;
    const provable = started !== undefined && (rangeFromMs === null || started >= rangeFromMs);
    return summarize(draft, index === 0 && !provable, context);
  });
}

/**
 * The `(session, spawn, feature)` dispatches a run of their own session links
 * to (B1), per feature. A spawn claimed by two features is ambiguous: no run is
 * attributed to either. Codex dispatches have no run link and are only counted.
 */
function confirmedDispatches(sessions: ReadonlyArray<JoinSession>): {
  confirmed: Map<string, ConfirmedDispatch[]>;
  unlinkable: Map<string, number>;
  ambiguousSpawns: number;
} {
  const confirmed = new Map<string, ConfirmedDispatch[]>();
  const unlinkable = new Map<string, number>();
  let ambiguousSpawns = 0;
  for (const session of sessions) {
    const payloads = (session.cliEvents ?? []).flatMap((event) =>
      event.outcomePayload?.name === "dispatch-outcome"
        ? [{ payload: event.outcomePayload, tsMs: event.tsMs }]
        : [],
    );
    const claims = new Map<string, Set<string>>();
    for (const { payload } of payloads)
      if (payload.spawn)
        claims.set(payload.spawn, (claims.get(payload.spawn) ?? new Set()).add(payload.featureKey));
    const seen = new Set<string>();
    for (const { payload, tsMs } of payloads) {
      const identity = `${payload.spawn ?? ""}\0${payload.featureKey}`;
      if (payload.spawn && seen.has(identity)) continue;
      seen.add(identity);
      if (session.host === "codex") {
        unlinkable.set(payload.featureKey, (unlinkable.get(payload.featureKey) ?? 0) + 1);
        continue;
      }
      const runs = (session.agents ?? []).filter(
        (run) => !!payload.spawn && run.spawnToolUseId === payload.spawn,
      );
      if (runs.length === 0) continue;
      if ((claims.get(payload.spawn as string)?.size ?? 0) > 1) {
        if (payload.featureKey === [...(claims.get(payload.spawn as string) ?? [])].sort()[0])
          ambiguousSpawns++;
        continue;
      }
      confirmed.set(payload.featureKey, [
        ...(confirmed.get(payload.featureKey) ?? []),
        { tsMs, sessionId: session.sessionId, runs },
      ]);
    }
  }
  return { confirmed, unlinkable, ambiguousSpawns };
}

/** Usage and fast-gate executions no episode claims: orchestrator, reviewer, scribe, nested, Codex. */
function unattributedOf(
  sessions: ReadonlyArray<JoinSession>,
  rows: readonly EpisodeRow[],
  assigned: ReadonlySet<AgentRun>,
  ambiguousSpawns: number,
): OutcomeSummary["unattributed"] {
  const tokens = Object.fromEntries(COMPONENTS.map((key) => [key, null])) as TokenComponents;
  // What the episodes report: a component whose episode sum is null (any run partial) attributes
  // nothing, so those tokens stay in the unattributed remainder and the totals reconcile.
  const attributed: Record<keyof TokenTotals, number> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    thinking: 0,
  };
  for (const row of rows)
    for (const key of COMPONENTS) attributed[key] += row.efficiency.tokens[key] ?? 0;
  let agents = 0;
  let executions = 0;
  for (const session of sessions) {
    const runs = [
      ...(session.orchestrator
        ? [{ run: session.orchestrator, evidence: session.availability, isAgent: false }]
        : []),
      ...(session.agents ?? []).map((run) => ({ run, evidence: run.availability, isAgent: true })),
    ];
    for (const { run, evidence, isAgent } of runs) {
      if (isAgent) agents++;
      for (const key of COMPONENTS) {
        const state = evidence?.[`tokens.${key}`];
        if (!isMeasured(state)) continue;
        tokens[key] = (tokens[key] ?? 0) + run.tokens[key];
      }
    }
    if (session.sealed && session.orchestrator && session.agents)
      executions += correlateGateExecutions({
        sealed: session.sealed,
        orchestrator: session.orchestrator,
        agents: session.agents,
      }).filter(
        (e) => e.handle.startsWith(FAST_GATE) && e.outcome === "completed" && e.ran && !!e.terminal,
      ).length;
  }
  for (const key of COMPONENTS) {
    const total = tokens[key];
    tokens[key] = total === null ? null : total - attributed[key];
  }
  const claimed = rows.reduce((sum, row) => sum + (row.efficiency.gate?.executions ?? 0), 0);
  return {
    tokens,
    attributedTokens: Object.fromEntries(
      COMPONENTS.map((key) => [key, tokens[key] === null ? null : attributed[key]]),
    ) as TokenComponents,
    runs: { attributed: assigned.size, unattributed: agents - assigned.size },
    ambiguousSpawns,
    gateExecutions: Math.max(0, executions - claimed),
  };
}

/**
 * Joins the outcome events of `sessions` per feature. `rangeFromMs` is the
 * start of the reported range (`null` when unknown): a first event that is not
 * a review round or a confirmed dispatch started inside it makes the first
 * episode left-censored. Efficiency and lifecycle (T10b) are derived per
 * episode from the same sessions, never from a time guess.
 */
export function joinOutcomes(
  sessions: ReadonlyArray<JoinSession>,
  rangeFromMs: number | null,
): AuditOutcomes | undefined {
  const byFeature = new Map<
    string,
    { rounds: Map<string, Round>; receipts: Map<string, ReceiptObservation> }
  >();
  const observations: Observation[] = [];
  const featuresBySession = new Map<string, Set<string>>();
  for (const session of sessions)
    for (const event of session.cliEvents ?? [])
      if (event.outcomePayload) {
        featuresBySession.set(
          session.sessionId,
          (featuresBySession.get(session.sessionId) ?? new Set()).add(
            event.outcomePayload.featureKey,
          ),
        );
        if (event.outcomePayload.name !== "dispatch-outcome")
          observations.push({
            sessionId: session.sessionId,
            host: session.host ?? "unknown",
            tsMs: event.tsMs,
            outcome: event.outcomePayload,
          });
      }
  observations.sort((a, b) => a.tsMs - b.tsMs);
  for (const observation of observations) {
    const key = observation.outcome.featureKey;
    const group = byFeature.get(key) ?? { rounds: new Map(), receipts: new Map() };
    byFeature.set(key, group);
    if (observation.outcome.name === "review-outcome") addRound(group.rounds, observation);
    else addReceipt(group.receipts, observation);
  }
  const dispatch = summarizeDispatch(sessions, new Set(byFeature.keys()));
  if (byFeature.size === 0 && !dispatch) return undefined;
  const { confirmed, unlinkable, ambiguousSpawns } = confirmedDispatches(sessions);
  const assigned = new Set<AgentRun>();
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const rows: EpisodeRow[] = [];
  const tasks = [...byFeature.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, group]) => ({
      feature: featureLabel(key),
      episodes: episodesOf(
        [...group.rounds.values()],
        [...group.receipts.values()],
        confirmed.get(key) ?? [],
        rangeFromMs,
        { sessions: byId, featuresBySession, unlinkable: unlinkable.get(key) ?? 0, assigned },
      ).map(({ episode, facts }) => {
        const efficiency = efficiencyOf(facts);
        const lifecycle = lifecycleOf(facts);
        rows.push({ facts, efficiency, lifecycle });
        return { ...episode, efficiency, lifecycle };
      }),
    }));
  const episodes = tasks.flatMap((task) => task.episodes);
  return {
    schemaVersion: 1,
    tasks,
    totals: {
      tasks: tasks.length,
      accepted: episodes.filter((episode) => episode.accepted).length,
      open: episodes.filter((episode) => !episode.accepted).length,
      ambiguous: episodes.filter((episode) => episode.boundary === "ambiguous").length,
    },
    ...(dispatch ? { dispatch } : {}),
    ...(rows.length
      ? {
          summary: summarizeEpisodes(
            rows,
            unattributedOf(sessions, rows, assigned, ambiguousSpawns),
          ),
        }
      : {}),
  };
}

/**
 * Relates `dispatch-outcome` events to the runs and rounds seen (spec 0042
 * T10a, B1). A dispatch is a gate claim, not a spawn: it is `confirmed` only
 * when a Claude run in the same session links to its `spawn`, and it never
 * opens an episode or moves a start. Codex has no spawn-to-run link, so its
 * dispatches are `unlinkable`, not unconfirmed and never zero. The same
 * `(session, spawn, feature)` is one dispatch.
 */
function summarizeDispatch(
  sessions: ReadonlyArray<JoinSession>,
  roundFeatures: ReadonlySet<string>,
): DispatchSummary | undefined {
  const seen = new Set<string>();
  const dispatched = new Set<string>();
  const summary: DispatchSummary = {
    events: 0,
    confirmed: 0,
    unconfirmed: 0,
    unlinkable: 0,
    nestedUnlinked: 0,
    dispatchWithoutRounds: 0,
    roundsWithoutDispatch: 0,
  };
  for (const session of sessions) {
    const payloads = (session.cliEvents ?? []).flatMap((event) =>
      event.outcomePayload?.name === "dispatch-outcome" ? [event.outcomePayload] : [],
    );
    if (payloads.length === 0) continue;
    const codex = session.host === "codex";
    const linked = new Set<string>();
    for (const run of session.agents ?? []) {
      if (run.spawnToolUseId) linked.add(run.spawnToolUseId);
      else if (!codex && run.spawnDepth > 1) summary.nestedUnlinked++;
    }
    for (const payload of payloads as DispatchOutcome[]) {
      const identity = `${session.sessionId}\0${payload.spawn ?? ""}\0${payload.featureKey}`;
      if (payload.spawn) {
        if (seen.has(identity)) continue;
        seen.add(identity);
      }
      dispatched.add(payload.featureKey);
      summary.events++;
      if (codex) summary.unlinkable++;
      else if (payload.spawn && linked.has(payload.spawn)) summary.confirmed++;
      else summary.unconfirmed++;
    }
  }
  if (summary.events === 0) return undefined;
  for (const key of dispatched) if (!roundFeatures.has(key)) summary.dispatchWithoutRounds++;
  for (const key of roundFeatures) if (!dispatched.has(key)) summary.roundsWithoutDispatch++;
  return summary;
}
