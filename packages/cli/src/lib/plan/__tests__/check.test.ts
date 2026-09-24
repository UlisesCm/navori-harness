import { describe, expect, it } from "vitest";
import { checkWorkplan, formatCheckResult } from "../check.ts";
import type { Workplan } from "../schema.ts";

const validLevel1: Workplan = {
  feature: "demo",
  level: 1,
  classification: { score: 2, level: 1, signals: [] },
  objective: "Ship the plan classifier.",
  acceptance: [
    {
      id: "A1",
      description: "classify works",
      command: "bun test classify.test.ts",
      expected: "pass",
    },
  ],
  outOfScope: [],
  files: [],
  progress: { A1: "pendiente" },
  decisions: [],
};

/** Covers: R15 */
describe("checkWorkplan", () => {
  it("passes with exit-worthy ok:true on a valid level-1 plan", () => {
    const result = checkWorkplan(validLevel1);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(formatCheckResult(result)).toBe("OK");
  });

  it("fails on a JSON that does not match the schema", () => {
    const result = checkWorkplan({ feature: "demo" });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.rule === "schema")).toBe(true);
  });

  it("fails when an acceptance criterion's command is blank (R13's rule)", () => {
    // `z.string().min(1)` alone lets a whitespace-only command through the
    // schema; `checkStructural`'s `.trim()` is what actually enforces R13.
    const raw = {
      ...validLevel1,
      acceptance: [{ id: "A1", description: "d", command: "   ", expected: "e" }],
    };
    const result = checkWorkplan(raw);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.rule === "acceptance-command")).toBe(true);
  });

  it("fails when progress references an id absent from acceptance", () => {
    const raw = { ...validLevel1, progress: { A1: "pendiente", A2: "cumplido" } };
    const result = checkWorkplan(raw);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.rule === "progress-unknown-id")).toBe(true);
  });

  it("fails a level-2 plan missing solution/phases/risks", () => {
    const raw = { ...validLevel1, level: 2, classification: { score: 8, level: 2, signals: [] } };
    const result = checkWorkplan(raw);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.rule)).toEqual(
      expect.arrayContaining(["level2-solution", "level2-phases", "level2-risks"]),
    );
  });

  it("passes a level-2 plan with all required sections", () => {
    const raw = {
      ...validLevel1,
      level: 2,
      classification: { score: 8, level: 2, signals: ["floor:shared-contract"] },
      solution: { path: ".claude/progress/solution_demo.md", verdict: "READY" },
      phases: [{ name: "Core", acceptance: ["A1"] }],
      risks: [{ risk: "Scope creep", rollback: "Revert" }],
    };
    expect(checkWorkplan(raw).ok).toBe(true);
  });

  it("fails when the declared level is below what classify computed", () => {
    const raw = { ...validLevel1, level: 0, classification: { score: 5, level: 1, signals: [] } };
    const result = checkWorkplan(raw);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.rule === "level-below-classification")).toBe(true);
  });

  it("fails when a phase references an unknown acceptance id", () => {
    const raw = {
      ...validLevel1,
      level: 2,
      classification: { score: 8, level: 2, signals: [] },
      solution: { path: "x", verdict: "READY" },
      phases: [{ name: "Core", acceptance: ["A9"] }],
      risks: [{ risk: "r", rollback: "r" }],
    };
    const result = checkWorkplan(raw);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.rule === "phase-unknown-id")).toBe(true);
  });
});
