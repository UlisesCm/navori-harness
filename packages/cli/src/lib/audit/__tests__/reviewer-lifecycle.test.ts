import { describe, it, expect } from "vitest";
import type { HookEvent, SessionAudit } from "../model.ts";
import { correlateGateExecutions, gateHandle } from "../model.ts";
import { reviewerGateLifecycle } from "../signals.ts";
import { agent, session } from "./lifecycle-fixtures.ts";

// Covers: R53, R54

const started = (
  toolUseId: string | undefined = "toolu_1",
  name = "quality-gate-pre-commit",
): HookEvent => ({
  ts: "2026-09-14T10:00:00Z",
  name,
  phase: "PreToolUse",
  verdict: "gate-started",
  ms: 4,
  source: "core",
  toolUseId,
});

const terminal = (
  toolUseId: string | undefined = "toolu_1",
  verdict: "allow" | "block" = "allow",
  name = "quality-gate-pre-commit",
): HookEvent => ({
  ...started(toolUseId, name),
  ts: "2026-09-14T10:02:00Z",
  verdict,
  ms: 120_000,
});

const killed = (
  toolUseId: string | undefined = "toolu_1",
  name = "quality-gate-pre-commit",
): HookEvent => ({
  ...started(toolUseId, name),
  verdict: "gate-killed",
  ms: 3003,
  reason: "cancelado por SIGTERM",
});

describe("correlateGateExecutions — terminal states and handle/diff correlation", () => {
  it("resolves a single terminal event as completed, with duration from the hook's own ms", () => {
    const reviewer = agent({ hookEvents: [started(), terminal()] });
    const s = session({ agents: [reviewer] });
    const [exec] = correlateGateExecutions(s);
    expect(exec).toMatchObject({
      handle: gateHandle({ name: "quality-gate-pre-commit", toolUseId: "toolu_1" }),
      outcome: "completed",
      durationMs: 120_000,
    });
  });

  it("correlates the execution's owner to the reviewer AgentRun whose hookEvents carried it", () => {
    const reviewer = agent({ agentId: "reviewer-7", hookEvents: [started(), terminal()] });
    const s = session({ agents: [reviewer] });
    const [exec] = correlateGateExecutions(s);
    expect(exec?.ownerAgentId).toBe("reviewer-7");
    expect(exec?.ownerAgentType).toBe("reviewer");
  });

  it("attributes an orchestrator-owned gate with a null agentId, never a guessed one", () => {
    const s = session({
      orchestrator: { ...session().orchestrator, hookEvents: [started(), terminal()] },
    });
    const [exec] = correlateGateExecutions(s);
    expect(exec?.ownerAgentId).toBeNull();
    expect(exec?.ownerAgentType).toBe("orchestrator");
  });

  it("does not infer a timeout before the session is sealed", () => {
    const reviewer = agent({ hookEvents: [started()] });
    const s = session({ sealed: false, agents: [reviewer] });
    expect(correlateGateExecutions(s)).toEqual([]);
  });

  it("classifies a sealed gate-started with no terminal record as timeout", () => {
    const reviewer = agent({ hookEvents: [started()] });
    const s = session({ sealed: true, agents: [reviewer] });
    const [exec] = correlateGateExecutions(s);
    expect(exec?.outcome).toBe("timeout");
    expect(exec?.durationMs).toBeNull();
  });

  it("classifies a recorded gate-killed cancellation as timeout too", () => {
    const reviewer = agent({ hookEvents: [killed()] });
    const s = session({ sealed: true, agents: [reviewer] });
    const [exec] = correlateGateExecutions(s);
    expect(exec?.outcome).toBe("timeout");
  });
});

describe("correlateGateExecutions — duplicate, unknown, missing data", () => {
  it("reports a repeated handle with two terminal verdicts as duplicate, not silently merged", () => {
    const reviewer = agent({
      hookEvents: [started(), terminal("toolu_1", "allow"), terminal("toolu_1", "block")],
    });
    const s = session({ agents: [reviewer] });
    const [exec] = correlateGateExecutions(s);
    expect(exec?.outcome).toBe("duplicate");
    expect(exec?.durationMs).toBeNull();
  });

  it("reports a tool_use_id-less event as unknown instead of dropping it", () => {
    // Object-spread overriding `toolUseId` to `undefined`, not passing
    // `undefined` as the helper's argument — a default parameter treats an
    // explicit `undefined` argument as "not provided" and would silently
    // restore "toolu_1", masking the exact case this test exists to cover.
    const legacyEvent = { ...started(), toolUseId: undefined };
    const reviewer = agent({ hookEvents: [legacyEvent] });
    const s = session({ agents: [reviewer] });
    const [exec] = correlateGateExecutions(s);
    expect(exec?.outcome).toBe("unknown");
    expect(exec?.ownerAgentId).toBeNull();
  });

  it("does not correlate hooks outside GATE_HOOK_NAMES", () => {
    const reviewer = agent({
      hookEvents: [{ ...started("toolu_x", "some-other-hook"), verdict: "allow", ms: 10 }],
    });
    const s = session({ agents: [reviewer] });
    expect(correlateGateExecutions(s)).toEqual([]);
  });
});

describe("reviewerGateLifecycle — reporting, not preventing", () => {
  it("flags overlapping reviewer runs as a possible single-owner violation", () => {
    const r1 = agent({ agentId: "r1", overlapsWith: ["r2"] });
    const r2 = agent({ agentId: "r2", overlapsWith: ["r1"] });
    const s = session({ agents: [r1, r2] });
    const found = reviewerGateLifecycle([s], "en").find(
      (sig) => sig.kind === "reviewer-gate-overlap",
    );
    expect(found?.severity).toBe("high");
    expect(found?.evidence).toContain("r1");
    expect(found?.evidence).toContain("r2");
  });

  it("reports duplicates and unknown handles without claiming to prevent the tool call", () => {
    const reviewer = agent({
      hookEvents: [started(), terminal("toolu_1", "allow"), terminal("toolu_1", "block")],
    });
    const s = session({ agents: [reviewer] });
    const signals = reviewerGateLifecycle([s], "en");
    const dup = signals.find((sig) => sig.kind === "reviewer-gate-duplicate");
    expect(dup).toBeDefined();
    // The wording must EXPLICITLY disclaim prevention — an audit reads the
    // transcript after the fact and cannot have blocked anything in it, and
    // R54 requires the report to say so rather than let it be assumed.
    expect(dup?.evidence.toLowerCase()).toMatch(/report/);
    expect(dup?.evidence.toLowerCase()).toMatch(/no detector.*blocks or prevents/);
  });

  it("reports a timeout without treating it as success", () => {
    const reviewer = agent({ hookEvents: [started()] });
    const s = session({ agents: [reviewer] });
    const found = reviewerGateLifecycle([s], "en").find(
      (sig) => sig.kind === "reviewer-gate-timeout",
    );
    expect(found?.evidence).toMatch(/never equals success/);
  });

  it("marks a below-floor sample as inconclusive, never as zero", () => {
    const reviewer = agent({ hookEvents: [started(), terminal()] });
    const s = session({ agents: [reviewer] });
    const found = reviewerGateLifecycle([s], "en").find(
      (sig) => sig.kind === "reviewer-gate-duration",
    );
    expect(found?.summary).toMatch(/Not enough data/);
    expect(found?.evidence).toMatch(/not as zero/);
  });

  it("stays silent when there is no reviewer or gate activity at all", () => {
    const s = session({ agents: [agent({ agentType: "implementer", hookEvents: [] })] });
    expect(reviewerGateLifecycle([s], "en")).toEqual([]);
  });

  it("draws a duration/wait conclusion once >=10 completed gates span >=3 sessions", () => {
    const sessions: SessionAudit[] = [];
    for (let i = 0; i < 3; i++) {
      const reviewers = [0, 1, 2, 3].map((j) =>
        agent({
          agentId: `s${i}-r${j}`,
          hookEvents: [started(`tool-${i}-${j}`), terminal(`tool-${i}-${j}`)],
        }),
      );
      sessions.push(session({ sessionId: `s${i}`, agents: reviewers }));
    }
    // 3 sessions x 4 reviewer runs each = 12 completed gates over 3 sessions.
    const found = reviewerGateLifecycle(sessions, "en").find(
      (sig) => sig.kind === "reviewer-gate-duration",
    );
    expect(found?.summary).toMatch(/12 completed gates over 3 session/);
    expect(found?.summary).not.toMatch(/Not enough data/);
  });
});
