import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVIEW_SPAN_CAP_MS,
  aggregate,
  clipIntervals,
  efficiencyOf,
  lifecycleOf,
  mergeIntervals,
  quantile,
  subtractIntervals,
  summarizeEpisodes,
  unionLength,
  type EpisodeFacts,
  type EpisodeRow,
  type RunFacts,
} from "../task-metrics.ts";
import type { TokenComponents } from "../model.ts";

const tokens = (over: Partial<TokenComponents> = {}): TokenComponents => ({
  input: 10,
  output: 20,
  cacheRead: 30,
  cacheCreation: 40,
  thinking: 5,
  ...over,
});
const run = (over: Partial<RunFacts> = {}): RunFacts => ({
  tokens: tokens(),
  tokenGap: null,
  active: [[1_000, 5_000]],
  gate: { executions: 2, failures: 1, notRun: 0, unverifiable: 0 },
  ...over,
});
/** An accepted, fully observed episode: dispatch at 1 s, review 6-7 s, acceptance at 10 s. */
function facts(over: Partial<EpisodeFacts> = {}): EpisodeFacts {
  return {
    accepted: true,
    acceptedAtMs: 10_000,
    acceptedFp: "fp",
    leftCensored: false,
    ambiguous: false,
    hosts: ["claude"],
    firstItem: "dispatch",
    firstRoundLinked: true,
    rounds: [
      {
        time: 7_000,
        startedAtMs: 6_000,
        sealedAtMs: 7_000,
        correlated: true,
        verdict: "approved",
        fp: "fp",
      },
    ],
    dispatches: [1_000],
    unlinkable: 0,
    runs: [run()],
    idle: [{ host: "claude", gaps: [[8_000, 9_000]], shared: false }],
    ...over,
  };
}
const row = (over: Partial<EpisodeFacts> = {}): EpisodeRow => {
  const f = facts(over);
  return { facts: f, efficiency: efficiencyOf(f), lifecycle: lifecycleOf(f) };
};
const NO_UNATTRIBUTED = {
  tokens: tokens(),
  attributedTokens: tokens(),
  runs: { attributed: 0, unattributed: 0 },
  ambiguousSpawns: 0,
  gateExecutions: 0,
};

describe("interval helpers", () => {
  // Covers: R18
  it("unions overlapping and touching intervals once and drops empty ones", () => {
    expect(
      mergeIntervals([
        [5, 8],
        [1, 3],
        [3, 4],
        [7, 7],
        [6, 9],
      ]),
    ).toEqual([
      [1, 4],
      [5, 9],
    ]);
    expect(
      unionLength([
        [0, 10],
        [5, 15],
      ]),
    ).toBe(15);
    expect(unionLength([])).toBe(0);
  });

  // Covers: R18
  it("clips to a window and subtracts holes", () => {
    expect(unionLength(clipIntervals([[0, 100]], 10, 30))).toBe(20);
    expect(
      subtractIntervals(
        [[0, 10]],
        [
          [2, 4],
          [8, 20],
        ],
      ),
    ).toEqual([
      [0, 2],
      [4, 8],
    ]);
  });
});

describe("quantile and aggregate", () => {
  // Covers: R17
  it("is nearest-rank and never zero for no data", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(quantile([4, 1, 3, 2], 0.9)).toBe(4);
  });

  // Covers: R17, R18
  it("states observed, partial or unavailable by how many eligible tasks contributed", () => {
    expect(aggregate([1, 2], 2, 0)).toMatchObject({ n: 2, eligible: 2, state: "observed" });
    expect(aggregate([1], 3, 1, ["left-censored", "left-censored", "x"])).toMatchObject({
      n: 1,
      eligible: 3,
      censored: 1,
      state: "partial",
      reason: "left-censored",
    });
    expect(aggregate([], 2, 0, ["no-dispatch-event"])).toMatchObject({
      p50: null,
      p90: null,
      state: "unavailable",
      reason: "no-dispatch-event",
    });
    expect(aggregate([], 0, 0)).toMatchObject({
      state: "unavailable",
      reason: "no-eligible-tasks",
    });
  });

  // Covers: R17
  it("is the only quantile implementation: report.ts imports it instead of redefining it", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const report = readFileSync(join(dir, "..", "report.ts"), "utf8");
    expect(report).toContain('import { quantile } from "./task-metrics.ts"');
    expect(report).not.toMatch(/function quantile\(/);
  });
});

describe("efficiencyOf", () => {
  // Covers: R17
  it("sums the attributed runs' tokens and labels the scope", () => {
    const e = efficiencyOf(facts({ runs: [run(), run({ tokens: tokens({ output: 1 }) })] }));
    expect(e).toMatchObject({
      tokenScope: "implementer-dispatch",
      attributedRuns: 2,
      tokens: { input: 20, output: 21 },
      tokensReason: null,
    });
  });

  // Covers: R17
  it("is null with a reason, never zero, without a dispatch, with a partial run or an unlinkable host", () => {
    expect(efficiencyOf(facts({ dispatches: [], runs: [] }))).toMatchObject({
      tokens: { output: null },
      tokensReason: "no-dispatch-event",
      attributedRuns: 0,
      gate: null,
    });
    expect(efficiencyOf(facts({ dispatches: [], runs: [], hosts: ["codex"] })).tokensReason).toBe(
      "ownership-unknown",
    );
    const partial = efficiencyOf(
      facts({ runs: [run({ tokens: tokens({ output: null }), tokenGap: "partial-usage" })] }),
    );
    expect(partial.tokens.output).toBeNull();
    expect(partial.tokens.input).toBe(10);
    expect(partial.tokensReason).toBe("partial-usage");
    expect(efficiencyOf(facts({ unlinkable: 1 })).tokensReason).toBe("ownership-unknown");
  });

  // Covers: R17
  it("counts rounds up to acceptance only", () => {
    const rounds = [
      { time: 3_000, correlated: true, verdict: "changes-requested", fp: "a" },
      { time: 7_000, correlated: true, verdict: "approved", fp: "fp" },
      { time: 20_000, correlated: true, verdict: "approved", fp: "fp" },
    ];
    expect(efficiencyOf(facts({ rounds })).rounds).toBe(2);
  });

  // Covers: R17
  it("keeps a gate with an unsealed session unknown, not a clean gate", () => {
    const e = efficiencyOf(facts({ runs: [run({ gate: null })] }));
    expect(e.gate).toBeNull();
    expect(e.gateReason).toBe("unsealed");
  });
});

describe("first approval (M2)", () => {
  const approval = (over: Partial<EpisodeFacts>) => efficiencyOf(facts(over));

  // Covers: R17
  it("is true only when a confirmed dispatch precedes a first correlated approval of the accepted fp", () => {
    expect(approval({}).firstApproval).toBe(true);
  });

  // Covers: R17
  it("is null when earlier rounds may be unobserved: no dispatch first, or the round is in another session", () => {
    expect(approval({ firstItem: "round" })).toMatchObject({
      firstApproval: null,
      firstApprovalReason: "unobserved-history",
    });
    expect(approval({ firstRoundLinked: false }).firstApprovalReason).toBe("unobserved-history");
    expect(approval({ leftCensored: true }).firstApprovalReason).toBe("left-censored");
  });

  // Covers: R17
  it("is null for an uncorrelated first round or a pending approval, false after changes requested", () => {
    const first = (over: object) => [
      { time: 7_000, correlated: true, verdict: "approved", fp: "fp", ...over },
    ];
    expect(approval({ rounds: first({ correlated: false }) }).firstApprovalReason).toBe(
      "incomplete-round",
    );
    expect(approval({ accepted: false, rounds: first({}) }).firstApprovalReason).toBe("pending");
    expect(approval({ rounds: first({ verdict: "changes-requested" }) }).firstApproval).toBe(false);
    expect(approval({ rounds: first({ fp: "other" }) }).firstApproval).toBe(false);
    expect(approval({ rounds: [] })).toMatchObject({
      firstApproval: null,
      firstApprovalReason: "no-review-round",
    });
  });
});

describe("lifecycleOf", () => {
  // Covers: R18
  it("separates elapsed from dispatch and from review begin, and splits active, idle and the rest", () => {
    const l = lifecycleOf(facts());
    expect(l).toMatchObject({
      start: "dispatch",
      censored: false,
      elapsedMs: 9_000,
      reviewElapsedMs: 4_000,
      idleHost: "claude",
    });
    // Active = run 1-5 s + review 6-7 s; idle 8-9 s; the rest is 5-6, 7-8, 9-10.
    expect(l.active).toEqual({ value: 5_000, state: "observed", reason: null });
    expect(l.idleBetweenTurns.value).toBe(1_000);
    expect(l.unclassified.value).toBe(3_000);
    expect(l.includesUnidentifiedWaits).toBe(false);
  });

  // Covers: R18
  it("counts parallel work once (M1: own tool pairs, not the run window)", () => {
    const l = lifecycleOf(
      facts({
        runs: [run({ active: [[1_000, 3_000]] }), run({ active: [[2_000, 4_000]] })],
        rounds: [],
        idle: [],
      }),
    );
    expect(l.active.value).toBe(3_000);
    // A resumed agent's idle gap lies outside its pairs and is not active.
    expect(
      lifecycleOf(
        facts({
          runs: [
            run({
              active: [
                [1_000, 2_000],
                [8_000, 9_000],
              ],
            }),
          ],
          rounds: [],
        }),
      ).active.value,
    ).toBe(2_000);
  });

  // Covers: R18
  it("never reports a censored, open or left-censored episode as fast", () => {
    for (const [over, reason] of [
      [{ accepted: false, acceptedAtMs: undefined }, "censored"],
      [{ leftCensored: true }, "left-censored"],
      [{ ambiguous: true }, "ambiguous-boundary"],
    ] as const) {
      const l = lifecycleOf(facts(over));
      expect(l).toMatchObject({ censored: true, elapsedMs: null, reviewElapsedMs: null });
      expect(l.active).toEqual({ value: null, state: "unavailable", reason });
      expect(l.unclassified.value).toBeNull();
    }
  });

  // Covers: R18
  it("is unavailable without a confirmed dispatch: no implement time is invented", () => {
    const l = lifecycleOf(facts({ dispatches: [], runs: [], firstItem: "round" }));
    expect(l).toMatchObject({ start: "review-begin", elapsedMs: null, reviewElapsedMs: 4_000 });
    expect(l.active).toMatchObject({ value: null, reason: "no-dispatch-event" });
  });

  // Covers: R18
  it("makes active time partial (null) for an unobserved run, an unsealed round or a run-away review (M5)", () => {
    expect(lifecycleOf(facts({ runs: [run({ active: null })] })).active).toMatchObject({
      value: null,
      state: "partial",
      reason: "partial-source",
    });
    const round = (over: object) => [
      { time: 7_000, correlated: true, verdict: "approved", fp: "fp", ...over },
    ];
    expect(lifecycleOf(facts({ rounds: round({ startedAtMs: 6_000 }) })).active.reason).toBe(
      "incomplete-round",
    );
    const abandoned = lifecycleOf(
      facts({ rounds: round({ startedAtMs: 0, sealedAtMs: REVIEW_SPAN_CAP_MS + 1 }) }),
    );
    expect(abandoned.active).toMatchObject({
      value: null,
      state: "partial",
      reason: "review-span-cap",
    });
    expect(abandoned.unclassified.value).toBeNull();
  });

  // Covers: R18
  it("keeps idle between turns Claude-only, unavailable for Codex and partial when shared (M4)", () => {
    expect(
      lifecycleOf(facts({ idle: [{ host: "codex", gaps: null, shared: false }] })),
    ).toMatchObject({
      idleHost: "codex",
      idleBetweenTurns: { value: null, state: "unavailable", reason: "no-source" },
      includesUnidentifiedWaits: true,
    });
    expect(
      lifecycleOf(
        facts({
          idle: [
            { host: "claude", gaps: [], shared: false },
            { host: "codex", gaps: null, shared: false },
          ],
        }),
      ),
    ).toMatchObject({ idleHost: "mixed", idleBetweenTurns: { value: null, state: "partial" } });
    const shared = lifecycleOf(
      facts({ idle: [{ host: "claude", gaps: [[8_000, 9_000]], shared: true }] }),
    );
    expect(shared.idleBetweenTurns).toEqual({
      value: null,
      state: "partial",
      reason: "shared-session",
    });
    expect(shared.includesUnidentifiedWaits).toBe(true);
    // A transcript-less Claude session is a missing source, not zero idle.
    expect(
      lifecycleOf(facts({ idle: [{ host: "claude", gaps: null, shared: false }] }))
        .idleBetweenTurns,
    ).toMatchObject({ value: null, reason: "no-source" });
  });
});

describe("summarizeEpisodes", () => {
  // Covers: R17
  it("publishes accepted-task tokens beside all-task tokens, coverage and scope", () => {
    const rows = [
      row(),
      row({ runs: [run({ tokens: tokens({ output: 100 }) })] }),
      row({
        accepted: false,
        acceptedAtMs: undefined,
        runs: [run({ tokens: tokens({ output: 1_000 }) })],
      }),
      row({ dispatches: [], runs: [], firstItem: "round" }),
    ];
    const { r17 } = summarizeEpisodes(rows, NO_UNATTRIBUTED);
    expect(r17.tokenScope).toBe("implementer-dispatch");
    expect(r17.tokenCoverage).toEqual({ episodes: 4, withDispatch: 3, withoutDispatch: 1 });
    expect(r17.tokensPerAcceptedTask.output).toMatchObject({
      n: 2,
      eligible: 3,
      censored: 1,
      state: "partial",
      reason: "no-dispatch-event",
      p50: 20,
      p90: 100,
    });
    expect(r17.tokensAllTasks.output).toMatchObject({ n: 3, eligible: 4, censored: 0, p90: 1_000 });
  });

  // Covers: R17
  it("excludes left-censored episodes from rounds to acceptance and publishes a first-approval lower bound", () => {
    const { r17 } = summarizeEpisodes([row(), row({ leftCensored: true })], NO_UNATTRIBUTED);
    expect(r17.reviewRoundsToAcceptance).toMatchObject({
      n: 1,
      eligible: 2,
      reason: "left-censored",
    });
    expect(r17.firstApproval).toMatchObject({
      yes: 1,
      no: 0,
      undetermined: 1,
      eligible: 2,
      state: "partial",
      reason: "left-censored",
    });
  });

  // Covers: R17
  it("sums gate attempts and keeps an episode without executions out of the denominator", () => {
    const { r17 } = summarizeEpisodes(
      [
        row(),
        row({ runs: [run({ gate: { executions: 0, failures: 0, notRun: 1, unverifiable: 2 } })] }),
        row({ runs: [run({ gate: null })] }),
      ],
      NO_UNATTRIBUTED,
    );
    expect(r17.gate).toMatchObject({
      executions: 2,
      failures: 1,
      notRun: 1,
      unverifiable: 2,
      episodes: 2,
      eligible: 3,
      withoutGateExecution: 1,
      state: "partial",
      reason: "unsealed",
    });
  });

  // Covers: R17
  it("counts gate failures of open episodes and keeps the accepted-only figure labeled", () => {
    const { r17 } = summarizeEpisodes(
      [
        row(),
        row({
          accepted: false,
          acceptedAtMs: undefined,
          runs: [run({ gate: { executions: 3, failures: 3, notRun: 0, unverifiable: 0 } })],
        }),
      ],
      NO_UNATTRIBUTED,
    );
    expect(r17.gate).toMatchObject({
      executions: 5,
      failures: 4,
      episodes: 2,
      eligible: 2,
      state: "observed",
      acceptedOnly: { executions: 2, failures: 1, episodes: 1, eligible: 1 },
    });
  });

  // Covers: R17
  it("reports an open episode without a verifiable gate as partial over all episodes", () => {
    const { r17 } = summarizeEpisodes(
      [row(), row({ accepted: false, acceptedAtMs: undefined, runs: [run({ gate: null })] })],
      NO_UNATTRIBUTED,
    );
    expect(r17.gate).toMatchObject({
      episodes: 1,
      eligible: 2,
      state: "partial",
      reason: "unsealed",
    });
  });

  // Covers: R18
  it("keeps open tasks out of the percentiles but counts them censored, and stratifies idle by host", () => {
    const open = row({ accepted: false, acceptedAtMs: undefined });
    const codex = row({ idle: [{ host: "codex", gaps: null, shared: false }] });
    const { r18 } = summarizeEpisodes([row(), open, codex], NO_UNATTRIBUTED);
    expect(r18.timeToAcceptance).toMatchObject({ n: 2, eligible: 2, censored: 1, p50: 9_000 });
    expect(r18.reviewToAcceptance).toMatchObject({ p50: 4_000 });
    expect(r18.activeTime).toMatchObject({ n: 2, p50: 5_000 });
    expect(r18.idleBetweenTurns.claude).toMatchObject({
      n: 1,
      eligible: 1,
      censored: 1,
      p50: 1_000,
    });
    expect(r18.idleBetweenTurns.codex).toMatchObject({
      n: 0,
      eligible: 1,
      p50: null,
      state: "unavailable",
      reason: "no-source",
    });
    expect(r18.reviewSpanCapMs).toBe(REVIEW_SPAN_CAP_MS);
  });

  // Covers: R17, R18
  it("has no composite score, ranking or cross-range comparison key", () => {
    const text = JSON.stringify(summarizeEpisodes([row()], NO_UNATTRIBUTED));
    expect(text).not.toMatch(/score|rank|improv|better|delta/i);
  });
});

describe("purity", () => {
  // Covers: R17
  it("imports only the model", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(dir, "..", "task-metrics.ts"), "utf8");
    const imports = source.match(/^import[^;]*;/gm) ?? [];
    expect(imports.every((line) => /from "\.\/model\.ts"/.test(line))).toBe(true);
  });
});
