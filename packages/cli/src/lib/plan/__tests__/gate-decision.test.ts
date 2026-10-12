import { describe, expect, it } from "vitest";
import { decideWorkplanGate } from "../gate-decision.ts";

function plan(
  phases: { name: string; acceptance: string[] }[] | undefined,
  progress: Record<string, string>,
): unknown {
  return {
    feature: "f",
    level: 2,
    classification: { score: 5, level: 2, signals: [] },
    objective: "o",
    acceptance: ["A1", "A2", "A3"].map((id) => ({
      id,
      description: "d",
      command: "true",
      expected: "exit 0",
    })),
    progress,
    phases,
  };
}
const PHASES = [
  { name: "one", acceptance: ["A1"] },
  { name: "two", acceptance: ["A2"] },
  { name: "three", acceptance: ["A3"] },
];

describe("decideWorkplanGate", () => {
  // Covers: R10, R11
  it("razones y fail closed", () => {
    const done = { A1: "cumplido" };
    expect(decideWorkplanGate(plan(PHASES, done), "one")).toMatchObject({
      gateKind: "scoped",
      reason: "pending-later-work",
      unit: "f",
      closingMilestone: null,
      closingPhase: "three",
      pendingLater: ["A2", "A3"],
    });
    // 1-based index and implicit phase (last fully cumplido) agree
    expect(decideWorkplanGate(plan(PHASES, done), "1").gateKind).toBe("scoped");
    expect(decideWorkplanGate(plan(PHASES, done)).gateKind).toBe("scoped");
    // an unmarked later criterion keeps it scoped, a marked one does not
    expect(
      decideWorkplanGate(plan(PHASES, { ...done, A2: "cumplido" }), "one").pendingLater,
    ).toEqual(["A3"]);
    const all = { A1: "cumplido", A2: "cumplido", A3: "cumplido" };
    expect(decideWorkplanGate(plan(PHASES, all), "two")).toMatchObject({
      gateKind: "full",
      reason: "unit-complete",
    });
    expect(decideWorkplanGate(plan(PHASES, all), "three").reason).toBe("closing-phase");
    expect(decideWorkplanGate(plan(PHASES, all)).reason).toBe("closing-phase");
    expect(decideWorkplanGate(plan(PHASES, {}), "nope").reason).toBe("unknown-phase");
    expect(decideWorkplanGate(plan(PHASES, {})).reason).toBe("no-completed-phase");
    expect(decideWorkplanGate(plan(undefined, {}), "one").reason).toBe("no-phases");
    expect(decideWorkplanGate(plan([], {}), "one").reason).toBe("no-phases");
    // Covers: R11
    for (const bad of [undefined, null, "x", {}, { feature: "f" }]) {
      expect(decideWorkplanGate(bad, "one")).toMatchObject({
        gateKind: "full",
        reason: "workplan-unreadable",
        unit: null,
      });
    }
  });
});
