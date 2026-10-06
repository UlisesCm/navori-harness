import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { featureLabel, joinOutcomes, outcomeKinds } from "../outcomes.ts";
import type { CliEvent, Outcome, ReceiptOutcome, ReviewOutcome } from "../model.ts";

const hex = (c: string): string => c.repeat(64);
const FEATURE = hex("f");
const FP = hex("1");
const IDENTITY = {
  alg: "navori-content/v1",
  fp: FP,
  base: "b".repeat(40),
  gate: hex("2"),
  inputs: hex("3"),
};

let seq = 0;
/** A correlated review round for FP unless overridden. */
function review(over: Partial<ReviewOutcome> = {}): ReviewOutcome {
  seq += 1;
  return {
    name: "review-outcome",
    verdict: "approved",
    schemaVersion: 1,
    featureKey: FEATURE,
    sidecar: hex(String(seq % 10)) + "",
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    correlation: "correlated",
    nonce: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    head: "c".repeat(40),
    startedAtMs: 10_000,
    sealedAtMs: 20_000,
    ...IDENTITY,
    ...over,
  };
}
/** An ok/fresh/stable `check` receipt of the same identity unless overridden. */
function receipt(over: Partial<ReceiptOutcome> = {}): ReceiptOutcome {
  return {
    name: "receipt-outcome",
    verdict: "ok",
    schemaVersion: 1,
    featureKey: FEATURE,
    action: "check",
    freshness: "fresh",
    identity: "stable",
    receipt: hex("4"),
    head: "c".repeat(40),
    ...IDENTITY,
    ...over,
  };
}
function event(outcome: Outcome, tsMs: number): CliEvent {
  return {
    tsMs,
    event: "cli",
    name: outcome.name,
    verdict: outcome.verdict,
    outcomePayload: outcome,
  };
}
function session(id: string, events: CliEvent[], host: "claude" | "codex" = "claude") {
  return { sessionId: id, host, cliEvents: events };
}
/** One session holding the events, in order, 1 s apart from 30 s on. */
function solo(...outcomes: Outcome[]) {
  return [
    session(
      "s1",
      outcomes.map((o, i) => event(o, 30_000 + i * 1000)),
    ),
  ];
}
const episodes = (sessions: ReturnType<typeof solo>, from: number | null = 0) =>
  joinOutcomes(sessions, from)?.tasks.flatMap((task) => task.episodes) ?? [];

describe("accepted join", () => {
  // Covers: R16
  it("accepts a correlated approved round plus an ok/fresh/stable receipt of the same identity", () => {
    const [episode] = episodes(solo(review(), receipt()));
    expect(episode).toMatchObject({ accepted: true, boundary: "known", leftCensored: false });
    expect(episode?.acceptedAtMs).toBe(30_000 + 1000);
    expect(episode?.reviews).toMatchObject({ rounds: 1, approved: 1, correlated: 1 });
  });

  // Covers: R16
  it("allows the receipt to precede the review", () => {
    const sessions = [
      session("s1", [event(receipt(), 5_000)]),
      session("s2", [event(review(), 30_000)]),
    ];
    expect(episodes(sessions)[0]?.accepted).toBe(true);
  });

  // Covers: R16
  it("counts a sign receipt as fresh when its identity matches", () => {
    expect(episodes(solo(review(), receipt({ action: "sign" })))[0]?.accepted).toBe(true);
  });

  // Covers: R16
  it("labels the feature from its key, never from a slug", () => {
    const outcomes = joinOutcomes(solo(review(), receipt()), 0);
    expect(outcomes?.tasks[0]?.feature).toBe(featureLabel(FEATURE));
    expect(outcomes?.tasks[0]?.feature).toMatch(/^unknown-[a-f0-9]{12}$/);
  });
});

describe("never accepted", () => {
  // Covers: R16
  it.each([
    ["receipt fp differs (diff change)", { fp: hex("9") }],
    ["receipt base differs", { base: "d".repeat(40) }],
    ["receipt gate differs", { gate: hex("8") }],
    ["receipt inputs differ", { inputs: hex("7") }],
    ["receipt is stale", { freshness: "stale", stale: "gate" }],
    ["receipt has findings", { verdict: "findings" }],
    ["receipt errored", { verdict: "error" }],
    ["receipt identity unstable", { identity: "unstable", fp: undefined, alg: undefined }],
    ["receipt identity unavailable", { identity: "unavailable", fp: undefined, alg: undefined }],
  ] as Array<[string, Partial<ReceiptOutcome>]>)("%s", (_name, over) => {
    const [episode] = episodes(solo(review(), receipt(over)));
    expect(episode?.accepted).toBe(false);
  });

  // Covers: R16
  it("never accepts without a configured gate (no gate is not a pass)", () => {
    const [episode] = episodes(solo(review({ gate: undefined }), receipt({ gate: undefined })));
    expect(episode?.accepted).toBe(false);
  });

  // Covers: R16
  it("never accepts a review that is not approved", () => {
    expect(episodes(solo(review({ verdict: "changes-requested" }), receipt()))[0]?.accepted).toBe(
      false,
    );
    expect(episodes(solo(review({ verdict: "unknown" }), receipt()))[0]?.accepted).toBe(false);
  });

  // Covers: R16
  it.each([
    "missing",
    "invalid",
    "unknown-algorithm",
    "changed-after-review",
    "changed-during-review",
    "unavailable",
  ] as const)("a %s review is counted by reason and never accepts", (correlation) => {
    const [episode] = episodes(
      solo(
        review({
          correlation,
          fp: undefined,
          alg: undefined,
          base: undefined,
          gate: undefined,
          inputs: undefined,
          head: undefined,
        }),
        receipt(),
      ),
    );
    expect(episode?.accepted).toBe(false);
    expect(episode?.reviews.correlated).toBe(0);
    expect(episode?.reviews.uncorrelatedByReason).toEqual({ [correlation]: 1 });
  });

  // Covers: R16
  it("an open episode is censored: neither accepted nor failed", () => {
    const outcomes = joinOutcomes(solo(review()), 0);
    expect(outcomes?.totals).toEqual({ tasks: 1, accepted: 0, open: 1, ambiguous: 0 });
  });
});

describe("receipt observation identity", () => {
  const observations = (...receipts: ReceiptOutcome[]) =>
    episodes(solo(review(), ...receipts))[0]?.receipts.observations;

  // Covers: R16
  it("keeps observations that differ only in base distinct", () => {
    expect(observations(receipt(), receipt({ base: "d".repeat(40) }))).toBe(2);
  });

  // Covers: R16
  it("keeps observations that differ only in gate distinct", () => {
    expect(observations(receipt(), receipt({ gate: hex("8") }))).toBe(2);
  });

  // Covers: R16
  it("keeps head as provenance and still merges identical observations", () => {
    expect(observations(receipt(), receipt({ head: "e".repeat(40) }))).toBe(2);
    expect(observations(receipt(), receipt())).toBe(1);
  });

  // Covers: R16
  it("accepts only on full tuple equality, whatever receipt came first", () => {
    const other = receipt({ base: "d".repeat(40) });
    expect(episodes(solo(review(), other, receipt()))[0]?.accepted).toBe(true);
    expect(episodes(solo(review(), other, receipt({ gate: hex("8") })))[0]?.accepted).toBe(false);
  });
});

describe("rounds and revocation", () => {
  // Covers: R16
  it("dedups one round by nonce across sessions and keeps provenance", () => {
    const round = review();
    const sessions = [
      session("s1", [event(round, 30_000), event(round, 31_000)]),
      session("s2", [event({ ...round, sidecar: hex("5") }, 40_000)], "codex"),
    ];
    const [episode] = episodes(sessions);
    expect(episode?.reviews.rounds).toBe(1);
    expect(episode?.provenance).toEqual({ sessions: 2, hosts: 2, events: 3, duplicates: 2 });
  });

  // Covers: R16
  it("dedups legacy rounds without a nonce by sidecar hash", () => {
    const legacy = review({ nonce: undefined, correlation: "missing", fp: undefined });
    const [episode] = episodes(solo(legacy, legacy));
    expect(episode?.reviews.rounds).toBe(1);
    expect(episode?.provenance.duplicates).toBe(1);
  });

  // Covers: R16
  it("lets a later changes-requested on the same fp revoke an approval", () => {
    const approved = review({ sealedAtMs: 20_000 });
    const revoked = review({ verdict: "changes-requested", sealedAtMs: 25_000 });
    expect(episodes(solo(approved, revoked, receipt()))[0]?.accepted).toBe(false);
    // The approval wins only when it is the latest correlated round.
    const earlier = review({ verdict: "changes-requested", sealedAtMs: 15_000 });
    expect(episodes(solo(earlier, approved, receipt()))[0]?.accepted).toBe(true);
  });

  // Covers: R16
  it("marks a round observed as correlated with two identities as ambiguous", () => {
    const round = review();
    const [episode] = episodes(solo(round, { ...round, fp: hex("9") }, receipt()));
    expect(episode?.accepted).toBe(false);
    expect(episode?.reviews.uncorrelatedByReason).toEqual({ ambiguous: 1 });
  });

  // Covers: R16
  it("prefers the correlated observation of the same round", () => {
    const round = review();
    const late = { ...round, correlation: "changed-after-review" as const, fp: undefined };
    const [episode] = episodes(solo(late, round, receipt()));
    expect(episode?.reviews.correlated).toBe(1);
    expect(episode?.accepted).toBe(true);
  });
});

describe("episodes and censoring", () => {
  // Covers: R16
  it("keeps features of one session apart", () => {
    const other = hex("e");
    const sessions = solo(review(), review({ featureKey: other }), receipt());
    const outcomes = joinOutcomes(sessions, 0);
    expect(outcomes?.totals.tasks).toBe(2);
    const byLabel = Object.fromEntries(outcomes?.tasks.map((t) => [t.feature, t.episodes]) ?? []);
    expect(byLabel[featureLabel(FEATURE)]?.[0]?.accepted).toBe(true);
    expect(byLabel[featureLabel(other)]?.[0]?.accepted).toBe(false);
  });

  // Covers: R16
  it("opens episode 2 when a slug is reused with a new fp after acceptance", () => {
    const next = hex("6");
    const sessions = solo(
      review(),
      receipt(),
      review({ fp: next, sealedAtMs: 90_000, startedAtMs: 80_000 }),
    );
    const list = episodes(sessions);
    expect(list).toHaveLength(2);
    expect(list[0]?.accepted).toBe(true);
    expect(list[1]).toMatchObject({ accepted: false, leftCensored: false, boundary: "known" });
  });

  // Covers: R16
  it("keeps a new fp inside the same episode while nothing was accepted yet", () => {
    const list = episodes(solo(review({ verdict: "changes-requested" }), review({ fp: hex("6") })));
    expect(list).toHaveLength(1);
  });

  // Covers: R16
  it("flags a boundary as ambiguous when an event without identity follows acceptance", () => {
    const stray = review({
      sealedAtMs: 50_000,
      correlation: "changed-after-review",
      fp: undefined,
      alg: undefined,
      gate: undefined,
      inputs: undefined,
      base: undefined,
      head: undefined,
    });
    const outcomes = joinOutcomes(solo(review(), receipt(), stray), 0);
    expect(outcomes?.tasks[0]?.episodes[0]).toMatchObject({
      accepted: true,
      boundary: "ambiguous",
    });
    expect(outcomes?.totals.ambiguous).toBe(1);
  });

  // Covers: R16
  it("left-censors a first event that is not a review round started inside the range", () => {
    // Round started before the range.
    expect(episodes(solo(review({ startedAtMs: 10_000 })), 50_000)[0]?.leftCensored).toBe(true);
    // Round started inside it.
    expect(episodes(solo(review({ startedAtMs: 60_000 })), 50_000)[0]?.leftCensored).toBe(false);
    // The first event is a receipt.
    expect(episodes(solo(receipt(), review({ sealedAtMs: 90_000 })))[0]?.leftCensored).toBe(true);
    // A legacy round has no startedAtMs to prove it.
    expect(
      episodes(
        solo(review({ nonce: undefined, startedAtMs: undefined, correlation: "missing" })),
      )[0]?.leftCensored,
    ).toBe(true);
  });

  // Covers: R16
  it("returns nothing when no session logged an outcome", () => {
    expect(joinOutcomes([session("s1", [])], 0)).toBeUndefined();
    expect(joinOutcomes([{ sessionId: "s1", host: "claude" }], 0)).toBeUndefined();
  });
});

describe("availability kinds and purity", () => {
  // Covers: R16
  it("tells which outcome kinds a session logged", () => {
    expect(outcomeKinds(session("s1", [event(review(), 1)]))).toEqual({
      review: true,
      receipt: false,
    });
    expect(outcomeKinds(session("s2", []))).toEqual({ review: false, receipt: false });
  });

  // Covers: R16
  it("is pure: the module imports no filesystem, process or git primitive", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "outcomes.ts"),
      "utf8",
    );
    const imports = source.match(/^import[^;]*;/gm) ?? [];
    expect(imports.every((line) => /from "\.\/model\.ts"/.test(line))).toBe(true);
  });
});
