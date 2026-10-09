import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { featureLabel, joinOutcomes, outcomeKinds } from "../outcomes.ts";
import type {
  AgentRun,
  CliEvent,
  DispatchOutcome,
  HookEvent,
  MetricEvidence,
  Outcome,
  ReceiptOutcome,
  ReviewOutcome,
} from "../model.ts";

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
/** A `dispatch-outcome` of FEATURE; `spawn` undefined models a payload without a spawn id. */
function dispatch(spawn: string | undefined, over: Partial<DispatchOutcome> = {}): DispatchOutcome {
  return {
    name: "dispatch-outcome",
    verdict: "allow",
    schemaVersion: 1,
    featureKey: FEATURE,
    stage: "implement",
    ...(spawn ? { spawn } : {}),
    ...over,
  };
}
/** Only what the join reads of a subagent run. */
function run(over: Partial<AgentRun> = {}): AgentRun {
  return { agentId: "a1", spawnDepth: 1, ...over } as AgentRun;
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
      dispatch: false,
    });
    expect(outcomeKinds(session("s2", []))).toEqual({
      review: false,
      receipt: false,
      dispatch: false,
    });
    expect(outcomeKinds(session("s3", [event(dispatch("t1"), 1)])).dispatch).toBe(true);
  });

  // Covers: R16
  it("is pure: the module imports no filesystem, process or git primitive", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "outcomes.ts"),
      "utf8",
    );
    const imports = source.match(/^import[^;]*;/gm) ?? [];
    expect(imports.every((line) => /from "\.\/(?:model|task-metrics)\.ts"/.test(line))).toBe(true);
  });
});

describe("dispatch confirmation (spec 0042 T10a)", () => {
  const withRuns = (
    events: CliEvent[],
    agents: AgentRun[],
    host: "claude" | "codex" = "claude",
  ) => [{ ...session("s1", events, host), agents }];

  // Covers: R17
  it("confirms a dispatch only when a run in its session links to its spawn", () => {
    const sessions = withRuns(
      [event(dispatch("toolu_a"), 1000), event(dispatch("toolu_b"), 2000)],
      [run({ spawnToolUseId: "toolu_a" })],
    );
    expect(joinOutcomes(sessions, 0)?.dispatch).toMatchObject({
      events: 2,
      confirmed: 1,
      unconfirmed: 1,
    });
  });

  // Covers: R17
  it("never opens a task, episode or boundary from a dispatch alone (B1)", () => {
    const sessions = withRuns(
      [event(dispatch("toolu_a"), 1000)],
      [run({ spawnToolUseId: "toolu_a" })],
    );
    const outcomes = joinOutcomes(sessions, 0);
    expect(outcomes?.tasks).toEqual([]);
    expect(outcomes?.totals).toEqual({ tasks: 0, accepted: 0, open: 0, ambiguous: 0 });
    expect(outcomes?.dispatch).toMatchObject({
      dispatchWithoutRounds: 1,
      roundsWithoutDispatch: 0,
    });
  });

  // Covers: R17
  it("leaves episodes exactly as without the dispatch, even after an acceptance", () => {
    const base = solo(review(), receipt());
    const withDispatch = [
      session("s1", [
        event(review(), 30_000),
        event(receipt(), 31_000),
        event(dispatch("toolu_late"), 40_000),
      ]),
    ];
    expect(joinOutcomes(withDispatch, 0)?.tasks).toEqual(joinOutcomes(base, 0)?.tasks);
    expect(joinOutcomes(withDispatch, 0)?.dispatch).toMatchObject({
      unconfirmed: 1,
      dispatchWithoutRounds: 0,
      roundsWithoutDispatch: 0,
    });
  });

  // Covers: R17
  it("counts a retried spawn id once and a payload without spawn as unconfirmed", () => {
    const sessions = withRuns(
      [event(dispatch("toolu_a"), 1), event(dispatch("toolu_a"), 2), event(dispatch(undefined), 3)],
      [run({ spawnToolUseId: "toolu_a" })],
    );
    expect(joinOutcomes(sessions, 0)?.dispatch).toMatchObject({
      events: 2,
      confirmed: 1,
      unconfirmed: 1,
    });
  });

  // Covers: R17
  it("does not link a spawn to a run of another session", () => {
    const sessions = [
      { ...session("s1", [event(dispatch("toolu_a"), 1)]), agents: [] as AgentRun[] },
      { ...session("s2", []), agents: [run({ spawnToolUseId: "toolu_a" })] },
    ];
    expect(joinOutcomes(sessions, 0)?.dispatch).toMatchObject({ confirmed: 0, unconfirmed: 1 });
  });

  // Covers: R17
  it("counts nested runs without a spawn link and keeps Codex dispatches unlinkable", () => {
    const nested = withRuns(
      [event(dispatch("toolu_a"), 1)],
      [run({ spawnToolUseId: "toolu_a" }), run({ agentId: "n1", spawnDepth: 2 })],
    );
    expect(joinOutcomes(nested, 0)?.dispatch).toMatchObject({ confirmed: 1, nestedUnlinked: 1 });
    const codex = withRuns([event(dispatch("c1"), 1)], [], "codex");
    expect(joinOutcomes(codex, 0)?.dispatch).toMatchObject({
      events: 1,
      unlinkable: 1,
      confirmed: 0,
      unconfirmed: 0,
    });
  });

  // Covers: R17
  it("counts rounds without any dispatch per feature", () => {
    const sessions = solo(review(), dispatch("toolu_a", { featureKey: hex("9") }));
    expect(joinOutcomes(sessions, 0)?.dispatch).toMatchObject({
      dispatchWithoutRounds: 1,
      roundsWithoutDispatch: 1,
    });
  });
});

describe("task efficiency and lifecycle (spec 0042 T10b)", () => {
  const obs: MetricEvidence = {
    state: "observed",
    reason: null,
    source: "transcript",
    adapter: "claude-transcript",
    sourceVersion: null,
  };
  const COMPONENTS = ["input", "output", "cacheRead", "cacheCreation", "thinking"];
  const usage = (state: MetricEvidence["state"] = "observed") =>
    Object.fromEntries(COMPONENTS.map((key) => [`tokens.${key}`, { ...obs, state }]));
  const TOKENS = { input: 10, output: 20, cacheRead: 30, cacheCreation: 40, thinking: 5 };
  /** An implementer run linked to `toolu_1`, active 21-30 s by its own tool pairs. */
  const impl = (over: Partial<AgentRun> = {}): AgentRun =>
    run({
      agentId: "a1",
      spawnToolUseId: "toolu_1",
      tokens: TOKENS,
      availability: usage(),
      activeIntervals: [[21_000, 30_000]],
      hookEvents: [],
      // A window far wider than the active time: it must never be what counts.
      startedAt: "1970-01-01T00:00:20.000Z",
      endedAt: "1970-01-01T00:00:44.000Z",
      ...over,
    });
  const ORCH = { tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, thinking: 0 } };
  /** A fully observed sealed Claude session. */
  function full(id: string, events: CliEvent[], agents: AgentRun[], extra: object = {}) {
    return {
      ...session(id, events),
      agents,
      orchestrator: { ...ORCH, hookEvents: [] as HookEvent[] },
      sealed: true,
      availability: { activeMs: obs, ...usage() },
      idleBetweenTurns: [[31_000, 39_000]] as Array<[number, number]>,
      ...extra,
    } as unknown as ReturnType<typeof session>;
  }
  const hook = (verdict: string, toolUseId: string, agentId?: string): HookEvent => ({
    ts: "1970-01-01T00:00:01Z",
    tsMs: 1000,
    name: "quality-gate-pre-commit",
    phase: "PreToolUse",
    verdict,
    ms: 5,
    source: "core",
    toolUseId,
    ...(agentId ? { agentId } : {}),
  });
  /** dispatch at 20 s, review 40-45 s, receipt at 46 s: accepted at 46 s. */
  const timeline = (featureKey = FEATURE, spawn = "toolu_1") => [
    event(dispatch(spawn, { featureKey }), 20_000),
    event(review({ featureKey, startedAtMs: 40_000, sealedAtMs: 45_000 }), 45_000),
    event(receipt({ featureKey }), 46_000),
  ];
  const summaryOf = (sessions: ReturnType<typeof session>[]) => joinOutcomes(sessions, 0)?.summary;
  const firstEpisode = (sessions: ReturnType<typeof session>[]) =>
    joinOutcomes(sessions, 0)?.tasks[0]?.episodes[0];

  // Covers: R17, R18
  it("measures a locally accepted task from its confirmed dispatch, with active time from tool pairs", () => {
    const episode = firstEpisode([full("s1", timeline(), [impl()])]);
    expect(episode?.accepted).toBe(true);
    expect(episode?.efficiency).toMatchObject({
      tokenScope: "implementer-dispatch",
      attributedRuns: 1,
      tokens: TOKENS,
      rounds: 1,
      firstApproval: true,
    });
    expect(episode?.lifecycle).toMatchObject({
      start: "dispatch",
      elapsedMs: 26_000,
      reviewElapsedMs: 6_000,
      // 9 s of the run's own pairs + the 5 s review, not the 24 s run window.
      active: { value: 14_000, state: "observed" },
      idleBetweenTurns: { value: 8_000, state: "observed" },
      unclassified: { value: 4_000 },
      idleHost: "claude",
    });
  });

  // Covers: R17
  it("leaves a task open when the receipt is of another diff: censored, outside the accepted figures", () => {
    const events = [
      event(dispatch("toolu_1"), 20_000),
      event(review({ startedAtMs: 40_000, sealedAtMs: 45_000 }), 45_000),
      event(receipt({ fp: hex("9") }), 46_000),
    ];
    const sessions = [full("s1", events, [impl()])];
    expect(firstEpisode(sessions)?.accepted).toBe(false);
    const summary = summaryOf(sessions);
    expect(summary?.r17.tokensPerAcceptedTask.output).toMatchObject({
      n: 0,
      eligible: 0,
      censored: 1,
      p50: null,
      state: "unavailable",
    });
    // Abandoning expensive work does not cheapen the accepted figure: all tasks are shown too.
    expect(summary?.r17.tokensAllTasks.output).toMatchObject({ n: 1, eligible: 1, p50: 20 });
    expect(summary?.r18.timeToAcceptance).toMatchObject({ n: 0, p50: null, state: "unavailable" });
    expect(firstEpisode(sessions)?.lifecycle).toMatchObject({
      censored: true,
      elapsedMs: null,
      active: { value: null, reason: "censored" },
    });
  });

  // Covers: R17
  it("makes first approval null when the first round is uncorrelated or earlier rounds are unobserved (M2)", () => {
    const bad = review({
      correlation: "missing",
      verdict: "unknown",
      startedAtMs: 21_000,
      sealedAtMs: 22_000,
    });
    const events = [event(dispatch("toolu_1"), 20_000), event(bad, 22_000), ...timeline().slice(1)];
    expect(firstEpisode([full("s1", events, [impl()])])?.efficiency?.firstApprovalReason).toBe(
      "incomplete-round",
    );
    // Rounds only: nothing proves an earlier round was not run without audit.
    const roundsOnly = timeline().slice(1);
    expect(firstEpisode([full("s1", roundsOnly, [])])?.efficiency).toMatchObject({
      firstApproval: null,
      firstApprovalReason: "unobserved-history",
    });
    // Left-censored: the first review began before the reported range.
    const censored = joinOutcomes([full("s1", roundsOnly, [])], 100_000);
    expect(censored?.tasks[0]?.episodes[0]).toMatchObject({ leftCensored: true });
    expect(censored?.summary?.r17.reviewRoundsToAcceptance).toMatchObject({
      n: 0,
      eligible: 1,
      reason: "left-censored",
    });
  });

  // Covers: R17
  it("opens a new episode on a confirmed dispatch after acceptance, never on an unconfirmed one", () => {
    const rework = [...timeline(), event(dispatch("toolu_2"), 60_000)];
    const confirmed = joinOutcomes(
      [full("s1", rework, [impl(), impl({ agentId: "a2", spawnToolUseId: "toolu_2" })])],
      0,
    );
    expect(confirmed?.tasks[0]?.episodes.map((e) => e.accepted)).toEqual([true, false]);
    const phantom = joinOutcomes([full("s1", rework, [impl()])], 0);
    expect(phantom?.tasks[0]?.episodes).toHaveLength(1);
    expect(phantom?.tasks[0]?.episodes[0]?.boundary).toBe("known");
  });

  // Covers: R17
  it("attributes each implementer to its own feature and leaves the rest unattributed, without shares", () => {
    const other = hex("a");
    const events = [
      ...timeline(FEATURE, "toolu_1"),
      ...timeline(other, "toolu_2").map((e, i) => ({ ...e, tsMs: e.tsMs + 100 + i })),
    ];
    const agents = [
      impl(),
      impl({ agentId: "a2", spawnToolUseId: "toolu_2", tokens: { ...TOKENS, output: 200 } }),
      impl({ agentId: "rev", spawnToolUseId: undefined, tokens: { ...TOKENS, output: 7 } }),
    ];
    const outcomes = joinOutcomes([full("s1", events, agents)], 0);
    const outputs = outcomes?.tasks.flatMap((t) =>
      t.episodes.map((e) => e.efficiency?.tokens.output),
    );
    expect(outputs?.sort()).toEqual([20, 200]);
    // Orchestrator (2) + the unlinked run (7): exposed, not split by percentage.
    expect(outcomes?.summary?.unattributed).toMatchObject({
      tokens: { output: 9, input: 11 },
      runs: { attributed: 2, unattributed: 1 },
    });
    // M4: one session holds two features; a typed-prompt gap belongs to neither.
    for (const task of outcomes?.tasks ?? [])
      expect(task.episodes[0]?.lifecycle?.idleBetweenTurns).toEqual({
        value: null,
        state: "partial",
        reason: "shared-session",
      });
  });

  // Covers: R17
  it("keeps tokens of an episode with a partial run unattributed so the totals reconcile", () => {
    const agents = [
      impl(),
      impl({ agentId: "a1b", availability: usage("partial"), tokens: { ...TOKENS, output: 5 } }),
    ];
    const outcomes = joinOutcomes([full("s1", timeline(FEATURE, "toolu_1"), agents)], 0);
    const summary = outcomes?.summary;
    // The episode sum is null (one run partial): nothing of it counts as attributed.
    expect(summary?.r17.tokensAllTasks.output.n).toBe(0);
    expect(summary?.unattributed.attributedTokens.output).toBe(0);
    // Measured total = orchestrator 2 + run 20 + partial run 5.
    expect(summary?.unattributed.tokens.output).toBe(27);
  });

  // Covers: R17
  it("attributes nothing when one spawn is claimed by two features", () => {
    const events = [
      event(dispatch("toolu_1"), 20_000),
      event(dispatch("toolu_1", { featureKey: hex("a") }), 21_000),
      ...timeline().slice(1),
    ];
    const outcomes = joinOutcomes([full("s1", events, [impl()])], 0);
    expect(outcomes?.summary?.unattributed).toMatchObject({
      ambiguousSpawns: 1,
      runs: { attributed: 0, unattributed: 1 },
    });
    expect(outcomes?.tasks[0]?.episodes[0]?.efficiency?.tokens.output).toBeNull();
  });

  // Covers: R17
  it("reports null with a reason, never zero, without ownership: no dispatch, no run, partial usage or Codex", () => {
    const tokenOf = (sessions: ReturnType<typeof session>[]) => firstEpisode(sessions)?.efficiency;
    expect(tokenOf([full("s1", timeline().slice(1), [])])).toMatchObject({
      tokens: { output: null },
      tokensReason: "no-dispatch-event",
    });
    expect(tokenOf([full("s1", timeline(), [])])).toMatchObject({
      tokens: { output: null },
      attributedRuns: 0,
    });
    expect(
      tokenOf([full("s1", timeline(), [impl({ availability: usage("partial") })])]),
    ).toMatchObject({ tokens: { output: null }, tokensReason: "partial-usage" });
    const codex = tokenOf([
      { ...full("s1", timeline(), []), host: "codex" } as ReturnType<typeof session>,
    ]);
    expect(codex).toMatchObject({ tokens: { output: null }, tokensReason: "ownership-unknown" });
    const summary = summaryOf([full("s1", timeline().slice(1), [])]);
    expect(summary?.r17.tokenCoverage).toEqual({
      episodes: 1,
      withDispatch: 0,
      withoutDispatch: 1,
    });
    expect(summary?.r17.tokensPerAcceptedTask.output).toMatchObject({
      n: 0,
      eligible: 1,
      reason: "no-dispatch-event",
    });
  });

  // Covers: R18
  it("keeps idle between turns Claude-only, stratified by host", () => {
    const codexEvents = [
      event(review({ featureKey: hex("c"), startedAtMs: 40_000, sealedAtMs: 45_000 }), 45_000),
      event(receipt({ featureKey: hex("c") }), 46_000),
    ];
    const codex = { ...full("c1", codexEvents, []), host: "codex" } as ReturnType<typeof session>;
    const summary = summaryOf([full("s1", timeline(), [impl()]), codex]);
    expect(summary?.r18.idleBetweenTurns.claude).toMatchObject({ n: 1, eligible: 1, p50: 8_000 });
    expect(summary?.r18.idleBetweenTurns.codex).toMatchObject({
      n: 0,
      eligible: 1,
      state: "unavailable",
      reason: "no-source",
    });
  });

  // Covers: R18
  it("does not count an abandoned review begin as active time (M5)", () => {
    const events = [
      event(dispatch("toolu_1"), 20_000),
      event(review({ startedAtMs: 40_000, sealedAtMs: 40_000 + 3 * 60 * 60 * 1000 }), 3 * 3600_000),
      event(receipt(), 3 * 3600_000 + 1),
    ];
    const episode = firstEpisode([full("s1", events, [impl()])]);
    expect(episode?.accepted).toBe(true);
    expect(episode?.lifecycle?.active).toEqual({
      value: null,
      state: "partial",
      reason: "review-span-cap",
    });
    expect(episode?.lifecycle?.unclassified.value).toBeNull();
  });

  // Covers: R18
  it("makes active time partial when the run's tool pairs were not observed", () => {
    const episode = firstEpisode([
      full("s1", timeline(), [impl()], {
        availability: { ...usage(), activeMs: { ...obs, state: "partial" } },
      }),
    ]);
    expect(episode?.lifecycle?.active).toMatchObject({ value: null, state: "partial" });
  });

  describe("gate failures", () => {
    const gateOf = (hookEvents: HookEvent[], extra: object = {}) =>
      firstEpisode([full("s1", timeline(), [impl({ hookEvents })], extra)])?.efficiency?.gate;

    // Covers: R17
    it("counts a failure only from gate-started plus a terminal block of the run's own handle", () => {
      expect(
        gateOf([
          hook("gate-started", "t1", "a1"),
          hook("block", "t1", "a1"),
          hook("gate-started", "t2", "a1"),
          hook("allow", "t2", "a1"),
        ]),
      ).toEqual({ executions: 2, failures: 1, notRun: 0, unverifiable: 0, deferred: 0 });
    });

    // Covers: R17
    it("treats a block without gate-started as not run, and an unstarted allow as no execution", () => {
      expect(gateOf([hook("block", "t1", "a1"), hook("allow", "t2", "a1")])).toEqual({
        executions: 0,
        failures: 0,
        notRun: 1,
        unverifiable: 0,
        deferred: 0,
      });
    });

    // Covers: R17
    it("marks an owner placed by the time-window fallback, a timeout or an unsealed session as unverifiable", () => {
      expect(gateOf([hook("gate-started", "t1"), hook("block", "t1")])).toMatchObject({
        failures: 0,
        unverifiable: 1,
      });
      expect(gateOf([hook("gate-started", "t1", "a1")])).toMatchObject({
        failures: 0,
        unverifiable: 1,
      });
      expect(
        gateOf([hook("gate-started", "t1", "a1"), hook("block", "t1", "a1")], { sealed: false }),
      ).toBeNull();
    });

    // Covers: R17
    it("never reads the absence of a receipt as a gate failure", () => {
      const events = [event(dispatch("toolu_1"), 20_000), event(review(), 45_000)];
      const episode = firstEpisode([full("s1", events, [impl()])]);
      expect(episode?.accepted).toBe(false);
      expect(episode?.efficiency?.gate).toEqual({
        executions: 0,
        failures: 0,
        notRun: 0,
        unverifiable: 0,
        deferred: 0,
      });
      expect(summaryOf([full("s1", events, [impl()])])?.r17.gate.failures).toBe(0);
    });
  });

  // Covers: R2
  describe("skip native-hook", () => {
    const skip = (toolUseId: string, agentId: string): HookEvent => ({
      ...hook("skip", toolUseId, agentId),
      reason: "native-hook",
    });
    const episodeOf = (hookEvents: HookEvent[]) =>
      firstEpisode([full("s1", timeline(), [impl({ hookEvents })])]);

    it("reports the gate as not observed with its reason instead of zero executions", () => {
      const episode = episodeOf([skip("t1", "a1")]);
      expect(episode?.efficiency?.gate).toBeNull();
      expect(episode?.efficiency?.gateReason).toBe("native-hook");
      const gate = summaryOf([full("s1", timeline(), [impl({ hookEvents: [skip("t1", "a1")] })])])
        ?.r17.gate;
      expect(gate).toMatchObject({ state: "unavailable", reason: "native-hook", executions: 0 });
    });

    it("keeps a run that ran the gate observed and counts a mixed run's deferred skips", () => {
      const ran = [hook("gate-started", "t1", "a1"), hook("allow", "t1", "a1")];
      expect(episodeOf([...ran, skip("t2", "a1")])?.efficiency?.gate).toEqual({
        executions: 1,
        failures: 0,
        notRun: 0,
        unverifiable: 0,
        deferred: 1,
      });
    });

    it("does not treat another skip reason as deferred, nor count it as an execution", () => {
      const other: HookEvent = { ...hook("skip", "t1", "a1"), reason: "unspecified" };
      expect(episodeOf([other])?.efficiency?.gate).toMatchObject({ executions: 0, deferred: 0 });
    });
  });

  // Covers: R17, R18
  it("adds no summary for a session without episodes and never leaks private join keys", () => {
    expect(
      joinOutcomes([full("s1", [event(dispatch("toolu_1"), 1)], [impl()])], 0)?.summary,
    ).toBeUndefined();
    const text = JSON.stringify(joinOutcomes([full("s1", timeline(), [impl()])], 0));
    expect(text).not.toMatch(/toolu_|spawnToolUseId|activeIntervals|idleBetweenTurns":\[/);
  });
});
