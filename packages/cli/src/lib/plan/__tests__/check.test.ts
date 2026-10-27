import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // Covers: R17 (0045)
  it("rejects invalid structured syntax without treating it as legacy prose", (): void => {
    const result = checkWorkplan({
      ...validLevel1,
      acceptance: [{ ...validLevel1.acceptance[0], expected: "matches: /[/" }],
    });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ rule: "acceptance-expected-invalid" }),
    ]);
  });

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

// Covers: R11
describe("checkWorkplan — evidence warnings", () => {
  const done = { ...validLevel1, progress: { A1: "cumplido" as const } };

  it("warns without changing ok for cumplido with no evidence", () => {
    const result = checkWorkplan(done);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.rule)).toEqual(["progress-unevidenced"]);
    expect(formatCheckResult(result)).toContain("warning progress-unevidenced");
  });

  it("warns on unevidenced-accepted and stale, none on recorded", () => {
    expect(
      checkWorkplan({
        ...done,
        evidence: { A1: { kind: "unevidenced", reason: "engine-without-signal" } },
      }).warnings.map((w) => w.rule),
    ).toEqual(["progress-unevidenced-accepted"]);
    const recorded = (command: string) => ({
      kind: "recorded" as const,
      command,
      ranAt: "t",
      tree: "/t",
      head: "abc",
      worktreeTree: "w",
      dirty: false,
    });
    expect(
      checkWorkplan({ ...done, evidence: { A1: recorded("other") } }).warnings.map((w) => w.rule),
    ).toEqual(["progress-evidence-stale"]);
    expect(
      checkWorkplan({ ...done, evidence: { A1: recorded("bun test classify.test.ts") } }).warnings,
    ).toEqual([]);
  });

  it("does not warn for a pendiente criterion", () => {
    expect(checkWorkplan(validLevel1).warnings).toEqual([]);
  });
});

// Covers: R20
describe("checkWorkplan — evidence findings", () => {
  const done: Workplan = { ...validLevel1, progress: { A1: "cumplido" } };
  const recorded = (command: string): Workplan["evidence"] => ({
    A1: {
      kind: "recorded",
      command,
      ranAt: "t",
      tree: "/t",
      head: "abc",
      worktreeTree: "w",
      dirty: false,
    },
  });

  it("rejects missing and stale evidence only in finding mode", (): void => {
    const cases: Array<{ evidence: Workplan["evidence"]; rule: string }> = [
      { evidence: undefined, rule: "progress-unevidenced" },
      { evidence: recorded("other command"), rule: "progress-evidence-stale" },
    ];
    for (const { evidence, rule } of cases) {
      const plan = { ...done, evidence };
      const structural = checkWorkplan(plan);
      expect(structural.ok).toBe(true);
      expect(structural.warnings).toEqual([expect.objectContaining({ rule })]);
      const strict = checkWorkplan(plan, { evidence: "finding" });
      expect(strict.ok).toBe(false);
      expect(strict.findings).toEqual([expect.objectContaining({ rule })]);
      expect(strict.warnings).toEqual([]);
      expect(formatCheckResult(strict)).not.toContain("OK");
    }
  });

  it("accepts matching evidence and leaves pending criteria eligible", (): void => {
    expect(
      checkWorkplan(
        { ...done, evidence: recorded(done.acceptance[0]!.command) },
        {
          evidence: "finding",
        },
      ),
    ).toEqual({ ok: true, findings: [], warnings: [] });
    expect(checkWorkplan(validLevel1, { evidence: "finding" })).toEqual({
      ok: true,
      findings: [],
      warnings: [],
    });
  });

  it("keeps explicit engine-without-signal acceptance as a warning in both modes", (): void => {
    const plan: Workplan = {
      ...done,
      evidence: { A1: { kind: "unevidenced", reason: "engine-without-signal" } },
    };
    for (const evidence of ["warning", "finding"] as const) {
      expect(checkWorkplan(plan, { evidence })).toMatchObject({
        ok: true,
        findings: [],
        warnings: [{ rule: "progress-unevidenced-accepted" }],
      });
    }
  });
});

describe("checkWorkplan — R15 rules shared with the gate", () => {
  // Covers: R15
  it("check reporta ids duplicados, feature ajeno, nivel bajo el recálculo y BLOCKED", () => {
    const criterion = validLevel1.acceptance[0]!;
    const dup = checkWorkplan({ ...validLevel1, acceptance: [criterion, criterion] });
    expect(dup.findings.map((f) => f.rule)).toContain("acceptance-duplicate-id");

    expect(checkWorkplan(validLevel1, { feature: "demo" }).ok).toBe(true);
    const foreign = checkWorkplan(validLevel1, { feature: "other" });
    expect(foreign.findings.map((f) => f.rule)).toEqual(["feature-mismatch"]);
    // Without `feature` the rule does not apply.
    expect(checkWorkplan(validLevel1).findings).toEqual([]);

    // The embedded classification says level 0, but its declared signals
    // recompute to a floor level above the declared level 1.
    const low = checkWorkplan({
      ...validLevel1,
      classification: { score: 0, level: 0, signals: ["floor:shared-contract"] },
    });
    const lowFinding = low.findings.find((f) => f.rule === "level-below-classification");
    expect(lowFinding?.message).toContain("recomputed level 2");

    const blocked = checkWorkplan({
      ...validLevel1,
      level: 2,
      classification: { score: 8, level: 2, signals: [] },
      solution: { path: "solution_demo", verdict: "BLOCKED" },
      phases: [{ name: "Core", acceptance: ["A1"] }],
      risks: [{ risk: "r", rollback: "r" }],
    });
    expect(blocked.findings.map((f) => f.rule)).toEqual(["solution-blocked"]);
  });

  // Covers: R15
  it("recomputes the level from the files, with criticalPaths only when a cwd is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "navori-check-"));
    try {
      writeFileSync(
        join(dir, "navori.config.json"),
        JSON.stringify({
          name: "check-demo",
          engines: ["claude"],
          preset: "custom",
          project: { criticalPaths: ["secure/**"] },
        }),
      );
      const plan = {
        ...validLevel1,
        level: 0,
        // Bug signal (+2) alone stays level 0; with the critical path (+3) it is 5.
        classification: { score: 2, level: 0, signals: ["bug-without-root-cause(+2)"] },
        files: [{ path: "secure/a.ts", new: false }],
      };
      expect(checkWorkplan(plan).ok).toBe(true);
      const withContext = checkWorkplan(plan, { cwd: dir });
      expect(withContext.findings.map((f) => f.rule)).toEqual(["level-below-classification"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
