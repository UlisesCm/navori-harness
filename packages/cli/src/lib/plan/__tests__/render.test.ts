import { describe, expect, it } from "vitest";
import { applyWorkplanUpdate, renderWorkplan } from "../render.ts";
import type { Workplan } from "../schema.ts";

const level1: Workplan = {
  feature: "demo",
  level: 1,
  classification: { score: 2, level: 1, signals: ["non-trivial-files:3(+2)"] },
  objective: "Ship the plan classifier.",
  acceptance: [
    {
      id: "A1",
      description: "classify works",
      command: "bun test classify.test.ts",
      expected: "pass",
    },
  ],
  outOfScope: ["The gate hook"],
  files: [{ path: "lib/plan/classify.ts", new: true }],
  progress: { A1: "pendiente" },
  decisions: [],
};

const level2: Workplan = {
  ...level1,
  level: 2,
  classification: { score: 8, level: 2, signals: ["floor:shared-contract"] },
  solution: { path: ".claude/progress/solution_demo.md", verdict: "READY" },
  phases: [{ name: "Core", acceptance: ["A1"] }],
  risks: [{ risk: "Scope creep", rollback: "Revert to the level-1 plan" }],
};

/** Covers: R11, R12 */
describe("renderWorkplan", () => {
  it("renders the same bytes twice for the same input (R11)", () => {
    expect(renderWorkplan(level1)).toBe(renderWorkplan(level1));
    expect(renderWorkplan(level2)).toBe(renderWorkplan(level2));
  });

  it("includes only level-1 sections for a level-1 plan", () => {
    const output = renderWorkplan(level1);
    expect(output).toContain("## Criterios");
    expect(output).not.toContain("## Solución");
    expect(output).not.toContain("## Fases");
  });

  it("adds Solución/Fases/Riesgos for level 2 (R14)", () => {
    const output = renderWorkplan(level2);
    expect(output).toContain("## Solución");
    expect(output).toContain(".claude/progress/solution_demo.md");
    expect(output).toContain("## Fases");
    expect(output).toContain("Core");
    expect(output).toContain("## Riesgos y rollback");
    expect(output).toContain("Scope creep");
  });

  it("shows each acceptance criterion's command and expected output", () => {
    const output = renderWorkplan(level1);
    expect(output).toContain("bun test classify.test.ts");
    expect(output).toContain("expected: pass");
  });
});

describe("applyWorkplanUpdate", () => {
  it("changes an acceptance criterion's progress status (R12)", () => {
    const updated = applyWorkplanUpdate(level1, { kind: "progress", id: "A1", status: "cumplido" });
    expect(updated.progress.A1).toBe("cumplido");
    // Pure: the original is untouched.
    expect(level1.progress.A1).toBe("pendiente");
  });

  it("appends a decision without mutating existing ones (R12)", () => {
    const updated = applyWorkplanUpdate(level1, {
      kind: "decision",
      text: "Escalated to level 2 after two rejections",
      date: "2026-09-24",
    });
    expect(updated.decisions).toHaveLength(1);
    expect(level1.decisions).toHaveLength(0);
  });

  it("rejects a progress update for an unknown acceptance id", () => {
    expect(() =>
      applyWorkplanUpdate(level1, { kind: "progress", id: "A9", status: "cumplido" }),
    ).toThrow(/unknown acceptance id/);
  });

  it("re-renders deterministically after an update", () => {
    const updated = applyWorkplanUpdate(level1, {
      kind: "progress",
      id: "A1",
      status: "bloqueado",
    });
    const rendered = renderWorkplan(updated);
    expect(rendered).toContain("**A1** (bloqueado)");
    expect(renderWorkplan(updated)).toBe(rendered);
  });
});

// Covers: R11
describe("renderWorkplan — evidence cases (0038 D4)", () => {
  const done: Workplan = { ...level1, progress: { A1: "cumplido" } };

  it("shows head and time for recorded evidence of the current command", () => {
    const md = renderWorkplan({
      ...done,
      evidence: {
        A1: {
          kind: "recorded",
          command: "bun test classify.test.ts",
          ranAt: "2026-09-30T10:00:00Z",
          tree: "/t",
          head: "abcdef1234567",
          worktreeTree: "w",
          dirty: false,
        },
      },
    });
    expect(md).toContain("**A1** (cumplido · abcdef1 · 2026-09-30T10:00:00Z)");
  });

  it("distinguishes unevidenced-accepted, none and stale", () => {
    expect(
      renderWorkplan({
        ...done,
        evidence: { A1: { kind: "unevidenced", reason: "engine-without-signal" } },
      }),
    ).toContain("(cumplido, sin evidencia: engine sin señal)");
    expect(renderWorkplan(done)).toContain("(cumplido, sin evidencia)");
    expect(
      renderWorkplan({
        ...done,
        evidence: {
          A1: {
            kind: "recorded",
            command: "other",
            ranAt: "t",
            tree: "/t",
            head: "abc",
            worktreeTree: "w",
            dirty: false,
          },
        },
      }),
    ).toContain("(cumplido, evidencia de otro comando)");
  });
});
