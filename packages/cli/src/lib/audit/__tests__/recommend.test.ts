import { describe, expect, it } from "vitest";
import type { MetricEvidence, MetricPopulation, SessionAudit } from "../model.ts";
import { MIN_CALLS, MIN_SESSIONS, buildRecommendations } from "../recommend.ts";
import { agent, session } from "./lifecycle-fixtures.ts";

const observed: MetricEvidence = {
  state: "observed",
  reason: null,
  source: "transcript",
  adapter: "claude-transcript",
  sourceVersion: "fixture",
};
const population = (state: MetricPopulation["state"]): MetricPopulation => ({
  ...observed,
  state,
  eligible: 1,
  observed: 1,
  partial: 0,
  unavailable: 0,
  unsupported: 0,
  invalid: 0,
  contributors: 1,
});
const NO_METRICS = { rangeMetrics: {}, availability: {} };

/** A session with tools evidence whose orchestrator made `calls` tool calls, `bash` of them Bash. */
function withCalls(
  id: string,
  calls: number,
  over: (s: SessionAudit) => void = () => {},
): SessionAudit {
  const s = session({ sessionId: id });
  s.availability = { tools: observed };
  s.orchestrator.toolCounts = { Bash: Math.floor(calls / 2), Read: calls - Math.floor(calls / 2) };
  over(s);
  return s;
}
const fleet = (
  n: number,
  calls: number,
  over?: (s: SessionAudit, i: number) => void,
): SessionAudit[] =>
  Array.from({ length: n }, (_, i) => withCalls(`s${i}`, calls, (s) => over?.(s, i)));

describe("recommendations: observed causes ranked per unit (R20)", () => {
  // Covers: R20
  it("ranks facts only inside their own denominator group, with no score field", () => {
    const sessions = fleet(MIN_SESSIONS, MIN_CALLS, (s) => {
      s.orchestrator.toolErrors.shellFailure = 6;
      s.orchestrator.frictionEvents = 2;
      s.orchestrator.repeatedCommands = { "echo x": 20 };
    });
    const recs = buildRecommendations({ sessions, ...NO_METRICS });
    const by = Object.fromEntries(recs.map((r) => [r.cause, r]));
    // Same denominator (tool calls): errors 18/300 outrank friction 6/300.
    expect(by["tool-errors"]).toMatchObject({ group: "per-tool-call", status: "fact", rank: 1 });
    expect(by["friction"]).toMatchObject({ group: "per-tool-call", status: "fact", rank: 2 });
    expect(by["tool-errors"]?.impact).toMatchObject({ unit: "ratio", value: 0.06, n: 300 });
    // A different denominator ranks against nothing but itself: it starts at 1 too.
    expect(by["repeated-commands"]).toMatchObject({ group: "per-bash-call", rank: 1 });
    expect(by["repeated-commands"]?.impact.value).toBeCloseTo(60 / 150, 3);
    for (const r of recs) expect(r).not.toHaveProperty("score");
    expect(recs.map((r) => r.group)).toEqual(["per-tool-call", "per-tool-call", "per-bash-call"]);
  });

  // Covers: R20
  it("keeps a cause below the range floor as an unranked lead, last", () => {
    const small = fleet(MIN_SESSIONS, 30, (s) => {
      s.orchestrator.toolErrors.shellFailure = 5;
    });
    const [lead] = buildRecommendations({ sessions: small, ...NO_METRICS });
    expect(lead).toMatchObject({ cause: "tool-errors", status: "lead", rank: null });
    const fewSessions = fleet(MIN_SESSIONS - 1, 500, (s) => {
      s.orchestrator.toolErrors.shellFailure = 5;
    });
    expect(buildRecommendations({ sessions: fewSessions, ...NO_METRICS })[0]?.status).toBe("lead");
    const mixed = [
      ...fleet(MIN_SESSIONS, MIN_CALLS, (s) => {
        s.orchestrator.frictionEvents = 1;
      }),
    ];
    mixed[0]!.orchestrator.toolErrors.other = 1;
    const recs = buildRecommendations({ sessions: mixed, ...NO_METRICS });
    expect(recs.map((r) => r.status)).toEqual(["fact", "fact"]);
  });

  // Covers: R20
  it("puts sessions without observed tools outside the denominator and says how many", () => {
    const sessions = [
      ...fleet(MIN_SESSIONS, MIN_CALLS, (s) => {
        s.orchestrator.toolErrors.other = 3;
      }),
      session({ sessionId: "no-tools" }),
    ];
    sessions[sessions.length - 1]!.orchestrator.toolErrors.other = 99;
    sessions[sessions.length - 1]!.orchestrator.toolCounts = { Bash: 99 };
    const [rec] = buildRecommendations({ sessions, ...NO_METRICS });
    expect(rec?.scope).toEqual({ sessions: MIN_SESSIONS, eligibleSessions: MIN_SESSIONS });
    expect(rec?.impact.n).toBe(MIN_SESSIONS * MIN_CALLS);
  });

  // Covers: R20
  it("separates facts from hypotheses and publishes repetition as counts, never the command", () => {
    const sessions = fleet(MIN_SESSIONS, MIN_CALLS, (s) => {
      s.orchestrator.repeatedCommands = { "cat /home/me/secret-token": 5 };
    });
    const recs = buildRecommendations({ sessions, ...NO_METRICS });
    const rec = recs.find((r) => r.cause === "repeated-commands");
    expect(rec?.hypotheses).toEqual([
      { id: "repetition-not-proven-rework", nextProbe: "inspect-session-signal" },
    ]);
    expect(JSON.stringify(recs)).not.toContain("secret-token");
    // Facts carry no hypothesis text and hypotheses are closed ids.
    expect(Object.keys(rec!.impact).sort()).toEqual(["n", "state", "unit", "value"]);
    expect(rec?.evidence).toEqual({ metrics: [], signals: ["repeated-commands"] });
  });

  // Covers: R20
  it("measures review-cycle tokens only when every rejected run measured them", () => {
    const rejected = (id: string, measured: boolean) =>
      agent({
        agentId: id,
        verdict: "CHANGES_REQUESTED",
        tokens: { input: 0, output: 400, cacheRead: 0, cacheCreation: 0, thinking: 0 },
        availability: measured ? { "tokens.output": observed } : {},
      });
    const make = (measured: boolean): SessionAudit[] => [
      withCalls("r", 10, (s) => {
        s.agents = [rejected("a", true), rejected("b", measured)];
      }),
    ];
    const fact = buildRecommendations({ sessions: make(true), ...NO_METRICS })[0];
    expect(fact).toMatchObject({ group: "tokens", cause: "review-cycles", status: "fact" });
    expect(fact?.impact).toMatchObject({ unit: "tokens", value: 800, n: 2, state: "observed" });
    const lead = buildRecommendations({ sessions: make(false), ...NO_METRICS })[0];
    expect(lead).toMatchObject({ status: "lead", rank: null });
    expect(lead?.impact).toMatchObject({ value: null, state: "unavailable" });
  });

  // Covers: R20
  it("reports hook toll as blocking ms, partial when runs could not be grouped, hypothesis apart", () => {
    const rangeMetrics = {
      "hooks.tollMs": 5000,
      "hooks.tollEvents": 40,
      "hooks.ungroupedFires": 3,
      "hook.guard.ms": 4000,
      "hook.audit.ms": 900,
      "hook.idle.ms": 0,
    };
    const availability = { "hooks.tollMs": population("observed") };
    const sessions = fleet(1, 10);
    const [toll] = buildRecommendations({ sessions, rangeMetrics, availability });
    expect(toll).toMatchObject({
      group: "blocking-ms",
      cause: "hook-toll",
      status: "fact",
      rank: 1,
    });
    expect(toll?.impact).toEqual({ unit: "ms", value: 5000, n: 40, state: "partial" });
    expect(toll?.evidence.metrics).toEqual([
      "hooks.tollMs",
      "hooks.tollEvents",
      "hooks.ungroupedFires",
      "hook.guard.ms",
      "hook.audit.ms",
    ]);
    expect(toll?.hypotheses).toEqual([
      { id: "toll-share-by-hook", nextProbe: "parallel-group-ids" },
    ]);
    const few = buildRecommendations({
      sessions,
      rangeMetrics: { ...rangeMetrics, "hooks.tollEvents": 4, "hooks.ungroupedFires": 0 },
      availability,
    })[0];
    expect(few).toMatchObject({ status: "lead", rank: null });
    expect(few?.impact.state).toBe("observed");
    // No toll evidence, no cause.
    expect(
      buildRecommendations({
        sessions,
        rangeMetrics,
        availability: { "hooks.tollMs": population("unavailable") },
      }),
    ).toEqual([]);
    expect(buildRecommendations({ sessions: [], ...NO_METRICS })).toEqual([]);
  });

  // Covers: R20
  it("cannot take a comparison or snapshot: a difference of medians is never a cause", () => {
    // The signature pins it: one argument, closed to sessions and the range's own metrics.
    expect(buildRecommendations.length).toBe(1);
    const sessions = fleet(MIN_SESSIONS, MIN_CALLS, (s) => {
      s.orchestrator.toolErrors.shellFailure = 4;
    });
    const plain = buildRecommendations({ sessions, ...NO_METRICS });
    const input = {
      sessions,
      ...NO_METRICS,
      comparison: { rows: [{ key: "agent.implementer.cacheRead.p50", delta: -12 }] },
      snapshot: { metrics: {} },
    };
    // Extra keys are not read: the output is identical with and without them.
    expect(buildRecommendations(input)).toEqual(plain);
  });
});
