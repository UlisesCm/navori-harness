import { describe, expect, it } from "vitest";
import { benchmarkByEngine, controlOf, renderEngineBenchmark } from "../engine-benchmark.ts";
import { agent, session } from "./lifecycle-fixtures.ts";
import {
  closedAgentResult,
  observeCompaction,
  PiCompactionTracker,
} from "../engine-observations.ts";
import type { PublicationEvidence } from "../publications.ts";
import type { SessionAudit } from "../model.ts";

function sources(): SessionAudit[] {
  return (["claude", "pi"] as const).map((host): SessionAudit => {
    const value = session({
      sessionId: host,
      host,
      compactionRecovery: { total: 2, contextRestored: 1, pending: 1 },
      agents: [
        agent({
          agentType: "implementer",
          agentId: "impl",
          nativeOutcome: "completed",
          piOutcome: "completed",
          handoffBlocked: true,
        }),
        agent({
          agentId: "rev",
          agentType: "reviewer",
          nativeOutcome: "failed",
          piOutcome: "failed",
        }),
      ],
    });
    value.orchestrator.hookEvents = [
      "implementer-no-markdown",
      "plan-gate",
      "guard-destructive",
    ].map((name: string) => ({
      ts: value.startedAt,
      name,
      phase: "PreToolUse",
      verdict: "block",
      ms: 1,
      source: "core",
    }));
    if (host === "pi") {
      value.orchestrator.hookEvents = value.orchestrator.hookEvents.filter(
        (event): boolean => event.name !== "plan-gate",
      );
      value.piExtensionDenials = { "plan-gate": 1 };
    }
    return value;
  });
}
const evidence: PublicationEvidence = {
  state: "observed",
  publications: [
    { sessionId: "claude", correlatedApproval: true },
    { sessionId: "pi", correlatedApproval: true },
  ],
  commits: [{ sessionId: "pi", greenGate: true }],
};

describe("engine benchmark", () => {
  // Covers: R1 (0053)
  it("does not count an empty Pi marker as restored context", (): void => {
    const tracker = new PiCompactionTracker();
    tracker.observe({ type: "compaction", id: "c", parentId: null });
    tracker.observe({
      type: "custom_message",
      id: "empty",
      parentId: "c",
      customType: "navori-context",
      content: "",
    });
    expect(tracker.summary).toEqual({ total: 1, contextRestored: 0, pending: 1 });
    tracker.observe({
      type: "custom_message",
      id: "restored",
      parentId: "empty",
      customType: "navori-context",
      content: [{ type: "text", text: "context" }],
    });
    expect(tracker.summary).toEqual({ total: 1, contextRestored: 1, pending: 0 });
  });
  // Covers: R1 (0053)
  it("counts a failed gate recovered only by the next green of its exact owner", (): void => {
    const data = sources();
    const own = data[1]!;
    const start = Date.parse(own.startedAt);
    own.orchestrator.hookEvents.push(
      ...["gate-started", "block", "gate-started", "allow"].map((verdict: string, i: number) => ({
        ts: new Date(start + i * 1000).toISOString(),
        name: "quality-gate-pre-commit",
        phase: "PreToolUse",
        verdict,
        ms: 1,
        source: "core",
        agentId: "orchestrator",
        toolUseId: i < 2 ? "red" : "green",
      })),
    );
    expect(benchmarkByEngine(data, evidence).engines[1]?.gates).toMatchObject({
      failed: 1,
      recovered: 1,
    });
    own.orchestrator.hookEvents.at(-1)!.agentId = "impl";
    expect(benchmarkByEngine(data, evidence).engines[1]?.gates.recovered).toBe(0);
  });
  // Covers: R1 (0053)
  it("keeps oversized final statuses unknown instead of claiming no BLOCKED handoff", (): void => {
    expect(closedAgentResult([{ text: "BLOCKED\n" + "x".repeat(70000) }])).toEqual({
      verdict: null,
      handoffBlocked: undefined,
    });
  });
  // Covers: R1, R2 (0053)
  it("retains unclassified roles without exposing their names or claiming complete coverage", (): void => {
    const data = sources();
    data[0]!.agents.push(agent({ agentType: "PRIVATE_ROLE", nativeOutcome: "completed" }));
    const report = benchmarkByEngine(data, evidence);
    expect(report.engines[0]?.dispatches.unknown.completed).toBe(1);
    expect(report.result).toBe("inconclusive");
    expect(JSON.stringify(report)).not.toContain("PRIVATE_ROLE");
  });
  // Covers: R1, R2 (0053)
  it("keeps missing commit provenance distinct from zero commits without gates", (): void => {
    const report = benchmarkByEngine(sources(), { ...evidence, unavailableCommitSessions: ["pi"] });
    expect(report.engines[1]?.publications.state).toBe("observed");
    expect(report.engines[1]?.gates).toMatchObject({
      state: "unavailable",
      commitsWithoutGreenGate: null,
    });
    expect(report.result).toBe("inconclusive");
  });
  // Covers: R1, R2 (0053)
  it("never turns unavailable Git metrics into measured zeroes or pass", (): void => {
    const report = benchmarkByEngine(sources());
    expect(report.result).toBe("inconclusive");
    expect(report.engines[1]?.publications).toMatchObject({
      state: "unavailable",
      total: null,
      withoutApproval: null,
    });
    expect(report.engines[1]?.gates.commitsWithoutGreenGate).toBeNull();
    expect(renderEngineBenchmark(report)).toContain("unavailable (not-requested)");
  });
  // Covers: R1, R2 (0053)
  it("counts completed and failed children without filtering out Pi children with no tools", (): void => {
    const report = benchmarkByEngine(sources(), evidence);
    expect(report.result).toBe("pass");
    expect(report.engines[1]?.dispatches.reviewer.failed).toBe(1);
    expect(report.engines[0]?.blockedHandoffs).toBe(1);
    expect(report.engines[1]?.compactions).toEqual({
      state: "observed",
      total: 2,
      contextRestored: 1,
      pending: 1,
    });
    expect(renderEngineBenchmark(report)).toContain("| Metric | Claude | Pi |");
  });
  // Covers: R2 (0053)
  it.each(["publications", "denials"])(
    "requires the directed minimum for %s",
    (metric: string): void => {
      const data = sources();
      if (metric === "denials") data[1]!.orchestrator.hookEvents = [];
      const input = metric === "publications" ? { ...evidence, publications: [] } : evidence;
      expect(benchmarkByEngine(data, input).result).toBe("inconclusive");
    },
  );
  // Covers: R2 (0053)
  it("fails on observed unsafe Pi publications or commits even if another source is missing", (): void => {
    expect(
      benchmarkByEngine(sources(), {
        state: "observed",
        publications: [{ sessionId: "pi", correlatedApproval: false }],
        commits: [],
      }).result,
    ).toBe("fail");
    expect(
      benchmarkByEngine(sources(), {
        ...evidence,
        commits: [{ sessionId: "pi", greenGate: false }],
      }).result,
    ).toBe("fail");
  });
  // Covers: R1 (0053)
  it("keeps native controls separate and never publishes arbitrary text", (): void => {
    const data = sources();
    data[1]!.piExtensionDenials = { "plan-gate": 2 };
    data[0]!.orchestrator.hookEvents.push({
      ts: data[0]!.startedAt,
      name: "PRIVATE_SECRET",
      phase: "PreToolUse",
      verdict: "block",
      ms: 1,
      source: "core",
    });
    const report = benchmarkByEngine(data, evidence);
    expect(report.engines[1]?.denials.engineSpecific["plan-gate"]).toBe(2);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_SECRET");
    expect(controlOf({ name: "guard-destructive.sh" })).toBe("guard-destructive");
  });
  // Covers: R1 (0053)
  it("retains only closed final verdicts and does not restore earlier pending boundaries", (): void => {
    expect(
      closedAgentResult([{ text: "APPROVED" }, { text: "CHANGES_REQUESTED\nPRIVATE" }]),
    ).toEqual({ verdict: "CHANGES_REQUESTED", handoffBlocked: false });
    const summary = { total: 0, contextRestored: 0, pending: 0 };
    let pending = observeCompaction(summary, "boundary", false);
    pending = observeCompaction(summary, "boundary", pending);
    pending = observeCompaction(summary, "context", pending);
    observeCompaction(summary, "context", pending);
    expect(summary).toEqual({ total: 2, contextRestored: 1, pending: 1 });
  });
});
