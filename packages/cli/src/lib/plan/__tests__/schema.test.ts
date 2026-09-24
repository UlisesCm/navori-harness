import { describe, expect, it } from "vitest";
import { WorkplanSchema } from "../schema.ts";

/** Covers: R10, R13, R14 */
describe("WorkplanSchema", () => {
  const level1Plan = {
    feature: "0032-planificacion-por-niveles",
    level: 1,
    classification: { score: 2, level: 1, signals: ["non-trivial-files:3(+2)"] },
    objective: "Add the plan classifier and CLI commands.",
    acceptance: [
      {
        id: "A1",
        description: "classify computes a level from signals",
        command: "bun test src/lib/plan/__tests__/classify.test.ts",
        expected: "all tests pass",
      },
    ],
    outOfScope: ["Wiring the PreToolUse gate (lote 2)"],
    files: [{ path: "packages/cli/src/lib/plan/classify.ts", new: true }],
    progress: { A1: "cumplido" },
    decisions: [
      { text: "Reuse source-classify instead of duplicating its rules", date: "2026-09-23" },
    ],
  };

  it("accepts a valid level-1 workplan (R10, R13)", () => {
    const result = WorkplanSchema.safeParse(level1Plan);
    expect(result.success).toBe(true);
  });

  it("accepts a valid level-2 workplan with solution/phases/risks (R14)", () => {
    const level2Plan = {
      ...level1Plan,
      level: 2,
      classification: { score: 8, level: 2, signals: ["floor:shared-contract"] },
      solution: { path: ".claude/progress/solution_0032.md", verdict: "READY" },
      phases: [{ name: "Core", acceptance: ["A1"] }],
      risks: [{ risk: "Weights miscalibrated", rollback: "Revert to prose planning" }],
    };
    const result = WorkplanSchema.safeParse(level2Plan);
    expect(result.success).toBe(true);
  });

  it("defaults optional arrays/records so a minimal level-0-adjacent draft still parses", () => {
    const minimal = {
      feature: "x",
      level: 1,
      classification: { score: 0, level: 0, signals: [] },
      objective: "obj",
      acceptance: [{ id: "A1", description: "d", command: "c", expected: "e" }],
    };
    const result = WorkplanSchema.parse(minimal);
    expect(result.outOfScope).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.progress).toEqual({});
    expect(result.decisions).toEqual([]);
  });

  it("rejects a criterion without a command (R13's 'comando + salida esperada')", () => {
    const invalid = {
      ...level1Plan,
      acceptance: [{ id: "A1", description: "d", command: "", expected: "e" }],
    };
    expect(WorkplanSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects an acceptance id that does not look like A<n>", () => {
    const invalid = {
      ...level1Plan,
      acceptance: [{ id: "criterion-1", description: "d", command: "c", expected: "e" }],
    };
    expect(WorkplanSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects an out-of-range level", () => {
    const invalid = { ...level1Plan, level: 4 };
    expect(WorkplanSchema.safeParse(invalid).success).toBe(false);
  });

  it("does not require solution/phases/risks at the schema layer — check.ts enforces per level", () => {
    const level2WithoutExtras = { ...level1Plan, level: 2 };
    expect(WorkplanSchema.safeParse(level2WithoutExtras).success).toBe(true);
  });
});
