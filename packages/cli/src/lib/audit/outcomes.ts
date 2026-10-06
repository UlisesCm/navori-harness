import type {
  AuditOutcomes,
  EpisodeReceipts,
  EpisodeReviews,
  Outcome,
  OutcomeEpisode,
  ReceiptOutcome,
  ReviewOutcome,
  SessionAudit,
} from "./model.ts";

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

/** Whether a session logged at least one valid review / receipt outcome. */
export function outcomeKinds(session: Pick<SessionAudit, "cliEvents">): {
  review: boolean;
  receipt: boolean;
} {
  const kinds = { review: false, receipt: false };
  for (const event of session.cliEvents ?? []) {
    if (event.outcomePayload?.name === "review-outcome") kinds.review = true;
    if (event.outcomePayload?.name === "receipt-outcome") kinds.receipt = true;
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

/** Acceptance of an episode's items so far: `acceptedAtMs` when accepted, else `undefined`. */
function acceptedAt(
  rounds: readonly Round[],
  receipts: readonly ReceiptObservation[],
): number | undefined {
  const latest = new Map<string, Round>();
  for (const round of rounds) {
    if (!isCorrelated(round)) continue;
    const fp = round.outcome.fp as string;
    const current = latest.get(fp);
    if (!current || round.time >= current.time) latest.set(fp, round);
  }
  let best: number | undefined;
  for (const round of latest.values()) {
    if (round.outcome.verdict !== "approved") continue;
    const times = receipts.filter((receipt) => confirms(round, receipt)).map((r) => r.time);
    if (times.length === 0) continue;
    const at = Math.max(round.time, Math.min(...times));
    if (best === undefined || at < best) best = at;
  }
  return best;
}

interface Draft {
  items: Item[];
  fps: Set<string>;
  ambiguous: boolean;
}

function summarize(draft: Draft, leftCensored: boolean): OutcomeEpisode {
  const rounds = draft.items.flatMap((item) => (item.round ? [item.round] : []));
  const receipts = draft.items.flatMap((item) => (item.receipt ? [item.receipt] : []));
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
    boundary: draft.ambiguous ? "ambiguous" : "known",
    leftCensored,
    reviews,
    receipts: counts,
    accepted: at !== undefined,
    ...(at === undefined ? {} : { acceptedAtMs: at }),
    provenance: {
      sessions: new Set(all.flatMap((row) => [...row.sessions])).size,
      hosts: new Set(all.flatMap((row) => [...row.hosts])).size,
      events,
      duplicates: events - all.length,
    },
  };
}

/** Episodes of one feature, in time order: acceptance closes one; a new identity afterwards opens the next. */
function episodesOf(
  rounds: readonly Round[],
  receipts: readonly ReceiptObservation[],
  rangeFromMs: number | null,
): OutcomeEpisode[] {
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
      if (item.fp === undefined) current.ambiguous = true;
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
    const started = first?.round?.outcome.startedAtMs;
    const provable = started !== undefined && (rangeFromMs === null || started >= rangeFromMs);
    return summarize(draft, index === 0 && !provable);
  });
}

/**
 * Joins the outcome events of `sessions` per feature. `rangeFromMs` is the
 * start of the reported range (`null` when unknown): a first event that is not
 * a review round started inside it makes the first episode left-censored.
 */
export function joinOutcomes(
  sessions: ReadonlyArray<Pick<SessionAudit, "sessionId" | "host" | "cliEvents">>,
  rangeFromMs: number | null,
): AuditOutcomes | undefined {
  const byFeature = new Map<
    string,
    { rounds: Map<string, Round>; receipts: Map<string, ReceiptObservation> }
  >();
  const observations: Observation[] = [];
  for (const session of sessions)
    for (const event of session.cliEvents ?? [])
      if (event.outcomePayload)
        observations.push({
          sessionId: session.sessionId,
          host: session.host ?? "unknown",
          tsMs: event.tsMs,
          outcome: event.outcomePayload,
        });
  observations.sort((a, b) => a.tsMs - b.tsMs);
  for (const observation of observations) {
    const key = observation.outcome.featureKey;
    const group = byFeature.get(key) ?? { rounds: new Map(), receipts: new Map() };
    byFeature.set(key, group);
    if (observation.outcome.name === "review-outcome") addRound(group.rounds, observation);
    else addReceipt(group.receipts, observation);
  }
  if (byFeature.size === 0) return undefined;
  const tasks = [...byFeature.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, group]) => ({
      feature: featureLabel(key),
      episodes: episodesOf([...group.rounds.values()], [...group.receipts.values()], rangeFromMs),
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
  };
}
