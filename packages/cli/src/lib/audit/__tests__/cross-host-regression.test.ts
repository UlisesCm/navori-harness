import { describe, it, expect } from "vitest";
import { buildReport, publishReport } from "../report.ts";
import { buildSnapshot, compareSnapshots } from "../snapshot.ts";
import type { HarnessCatalog } from "../harness.ts";
import {
  type CliEvent,
  type CodexRunFacts,
  type MetricEvidence,
  type ReviewOutcome,
  type SessionAudit,
  emptyToolErrors,
} from "../model.ts";
import { agent, session } from "./lifecycle-fixtures.ts";

/**
 * Spec 0042 T12 — one range holding a Claude session and a Codex session goes
 * through the real report pipeline. Everything is synthetic: no transcript, no
 * rollout, no log of a real host is read.
 */

const CATALOG: HarnessCatalog = {
  agents: [{ name: "implementer", tools: null, hasMcp: false }],
  skills: [],
  managedSkills: [],
  sections: [],
  claudeMdTokens: 0,
  mcpFamilies: [],
};

const hex = (c: string): string => c.repeat(64);
const RANGE = { from: "2026-09-14", to: "2026-09-15" };
const OTHER_RANGE = { from: "2026-09-21", to: "2026-09-22" };

const evidence = (adapter: "claude-transcript" | "codex-rollout"): MetricEvidence => ({
  state: "observed",
  reason: null,
  source: adapter === "codex-rollout" ? "rollout" : "transcript",
  adapter,
  sourceVersion: "1",
});

const CLAUDE_KEYS = [
  "tools",
  "startupTokens",
  "hooks",
  "wallClockMs",
  "tokens.input",
  "tokens.output",
  "tokens.cacheRead",
  "tokens.cacheCreation",
  "tokens.thinking",
];

const review = (featureKey: string): CliEvent => {
  const outcome: ReviewOutcome = {
    name: "review-outcome",
    verdict: "approved",
    schemaVersion: 1,
    featureKey,
    sidecar: hex("5"),
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    correlation: "correlated",
    nonce: "00000000-0000-4000-8000-000000000001",
    startedAtMs: Date.parse("2026-09-14T10:00:00Z"),
    sealedAtMs: Date.parse("2026-09-14T10:30:00Z"),
    head: "c".repeat(40),
    alg: "navori-content/v1",
    fp: hex("1"),
    base: "b".repeat(40),
    gate: hex("2"),
    inputs: hex("3"),
  };
  return {
    tsMs: Date.parse("2026-09-14T10:30:00Z"),
    event: "cli",
    name: outcome.name,
    verdict: outcome.verdict,
    outcomePayload: outcome,
  };
};

function claudeSession(n = 1): SessionAudit {
  return session({
    sessionId: `claude-${n}`,
    cliEvents: n === 1 ? [review(hex("a"))] : [],
    availability: Object.fromEntries(CLAUDE_KEYS.map((k) => [k, evidence("claude-transcript")])),
    agents: [
      agent({
        agentId: "c1",
        agentType: "implementer",
        tokens: { input: 10, output: 200, cacheRead: 3000, cacheCreation: 400, thinking: 0 },
        toolCounts: { Bash: 40, Read: 40 },
        frictionEvents: 2,
        toolErrors: { ...emptyToolErrors(), shellFailure: 6 },
        repeatedCommands: { "git status": 3 },
        availability: Object.fromEntries(
          CLAUDE_KEYS.map((k) => [k, evidence("claude-transcript")]),
        ),
      }),
    ],
  });
}

function codexSession(): SessionAudit {
  const values: CodexRunFacts["usage"] = {
    inputTotal: 100,
    ordinaryInput: 70,
    cacheRead: 20,
    cacheWrite: 10,
    output: 40,
    reasoning: 15,
    totalTokens: 140,
  };
  const ev = evidence("codex-rollout");
  const usageAvailability = Object.fromEntries(
    Object.keys(values).map((k) => [k, ev]),
  ) as CodexRunFacts["usageAvailability"];
  const facts: CodexRunFacts = {
    threadId: "child",
    rootSessionId: "codex-1",
    parentThreadId: "codex-1",
    sourceVersion: "0.160.0",
    capturedAt: "2026-09-14T12:00:00Z",
    source: ev,
    responses: [
      {
        threadId: "child",
        rootSessionId: "codex-1",
        turnId: "t1",
        responseId: "r1",
        at: null,
        model: null,
        values,
        evidence: usageAvailability,
      },
    ],
    activity: [],
    usage: values,
    usageAvailability,
  };
  const s = session({
    sessionId: "codex-1",
    host: "codex",
    unavailable: "transcript",
    availability: {},
    cliEvents: [review(hex("b"))],
    agents: [agent({ agentId: "child", agentType: "codex-child", codex: facts, availability: {} })],
  });
  s.orchestrator.codex = {
    ...facts,
    threadId: "codex-1",
    parentThreadId: null,
    responses: [],
    capturedAt: null,
  };
  return s;
}

const build = (sessions: SessionAudit[], range = RANGE) =>
  buildReport(sessions, {
    repo: "synthetic",
    version: "0.1.0",
    catalog: CATALOG,
    requestedRange: range,
  });
const snap = (sessions: SessionAudit[], range: { from: string; to: string }) =>
  buildSnapshot(build(sessions, range), {
    scope: "repo",
    rootCommit: "a".repeat(40),
    auditMode: "opt-in",
  });

describe("one range, two hosts (spec 0042 T12)", () => {
  const claude = [claudeSession(1), claudeSession(2), claudeSession(3)];
  const mixed = build([...claude, codexSession()]);
  const claudeOnly = build(claude);

  // Covers: R4, R6
  it("reports Codex usage numerically and never turns an unavailable metric into 0", () => {
    expect(mixed.totals.byAgentType["codex-child"]?.tokens.output).toBe(40);
    expect(mixed.totals.byAgentType["implementer"]?.tokens.output).toBe(600);
    const a = publishReport(mixed).availability;
    // Codex has no transcript tools/hooks/startup: unknown by design, never 0-observed.
    // `tools` counts sessions and runs (Codex has both); hooks/wall clock count sessions.
    expect(a["tools"]).toMatchObject({ state: "partial", observed: 6, unavailable: 2 });
    for (const key of ["hooks", "wallClockMs"])
      expect(a[key], key).toMatchObject({ state: "partial", observed: 3, unavailable: 1 });
    // Its token usage comes from the rollout, so it is observed (3 Claude sessions, 3 agents, 1 Codex child).
    expect(a["tokens.output"]).toMatchObject({ state: "partial", observed: 7, unavailable: 1 });
    for (const [key, pop] of Object.entries(a))
      if (pop.state === "unavailable") expect(mixed.rangeMetrics[key], key).not.toBe(0);
    expect(mixed.rangeMetrics["codex.execWrappers"]).toBeNull();
  });

  // Covers: R16, R17
  it("joins outcomes per featureKey across hosts, with availability per kind", () => {
    const published = publishReport(mixed);
    expect(published.outcomes?.totals.tasks).toBe(2);
    expect(published.availability["outcomes.review"]).toMatchObject({
      state: "partial",
      eligible: 4,
      observed: 2,
      unavailable: 2,
    });
    expect(published.availability["outcomes.dispatch"]).toMatchObject({
      state: "unavailable",
      observed: 0,
    });
  });

  // Covers: R8, R20
  it("keeps recommendations to the Claude denominator and grouped per unit", () => {
    const recs = mixed.recommendations ?? [];
    expect(recs).toEqual(claudeOnly.recommendations);
    expect(recs.length).toBeGreaterThan(0);
    const groups = new Set(recs.map((r) => r.group));
    expect(groups).toEqual(new Set(["per-tool-call", "per-bash-call"]));
    for (const g of groups) {
      const ranks = recs.filter((r) => r.group === g && r.status === "fact").map((r) => r.rank);
      expect(ranks).toEqual(ranks.map((_, i) => i + 1));
    }
    // Codex is not in the denominator: 3 eligible sessions, not 4.
    expect(recs[0]?.scope.eligibleSessions).toBe(3);
  });

  // Covers: R8, R19
  it("leaves the Claude-host figures identical to a Claude-only range", () => {
    const only = publishReport(claudeOnly);
    const both = publishReport(mixed);
    expect(both.totals.byAgentType["implementer"]).toEqual(only.totals.byAgentType["implementer"]);
    for (const s of claudeOnly.sessions)
      expect(mixed.sessions.find((m) => m.sessionId === s.sessionId)).toEqual(s);
    for (const key of [
      "tool.Bash.calls",
      "session.cacheRead.p50",
      "agent.implementer.cacheRead.p50",
    ])
      expect(mixed.rangeMetrics[key], key).toBe(claudeOnly.rangeMetrics[key]);
    expect(snap(claude, RANGE).cohorts.all?.host).toEqual({ claude: 3 });
    expect(snap([...claude, codexSession()], RANGE).cohorts.all?.host).toEqual({
      claude: 3,
      codex: 1,
    });
  });

  // Covers: R19
  it("compares a mixed-host range only descriptively, never as matched", () => {
    const base = snap([...claude, codexSession()], RANGE);
    const current = snap([...claude, codexSession()], OTHER_RANGE);
    const cmp = compareSnapshots(base, current);
    const hostRows = cmp.rows.filter((r) => r.reasons.includes("cohort-mixed:host"));
    expect(hostRows.length).toBeGreaterThan(0);
    for (const row of hostRows) expect(row.outcome).not.toBe("matched");
    expect(cmp.rows.some((r) => r.outcome === "matched")).toBe(false);
  });
});
