import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePlanGate } from "../gate.ts";
import type { Workplan } from "../schema.ts";

/**
 * `navori plan gate` — the TypeScript half of the `PreToolUse(Agent)` hook
 * (spec 0032, #1011).
 *
 * Covers: R16, R17, R19
 */

let cwd: string;

function writeConfig(planTiers: boolean): void {
  writeFileSync(
    join(cwd, "navori.config.json"),
    JSON.stringify({
      name: "gate-demo",
      engines: ["claude"],
      preset: "custom",
      harness: { planTiers },
    }),
  );
}

function progressDir(): string {
  return join(cwd, ".claude/progress");
}

const VALID_LEVEL1: Workplan = {
  feature: "demo",
  level: 1,
  classification: { score: 2, level: 1, signals: [] },
  objective: "Ship the gate.",
  acceptance: [
    {
      id: "A1",
      description: "gate works",
      command: "bun test plan-gate.test.ts",
      expected: "pass",
    },
  ],
  outOfScope: [],
  files: [],
  progress: { A1: "pendiente" },
  decisions: [],
};

function writeWorkplan(feature: string, plan: Workplan): void {
  mkdirSync(progressDir(), { recursive: true });
  writeFileSync(join(progressDir(), `workplan_${feature}.json`), JSON.stringify(plan));
}

function payload(subagentType: string, prompt: string): unknown {
  return { cwd, tool_input: { subagent_type: subagentType, prompt } };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-plan-gate-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("evaluatePlanGate — off switch and scope", () => {
  it("allows when harness.planTiers is false (default) — R30", () => {
    writeConfig(false);
    const result = evaluatePlanGate(payload("implementer", "do the thing"));
    expect(result.decision).toBe("allow");
  });

  it("allows a subagent_type other than implementer, even with planTiers on", () => {
    writeConfig(true);
    const result = evaluatePlanGate(payload("reviewer", "review the diff"));
    expect(result.decision).toBe("allow");
  });

  it("allows when there is no navori.config.json to read planTiers from", () => {
    const result = evaluatePlanGate(payload("implementer", "do the thing"));
    expect(result.decision).toBe("allow");
  });
});

describe("evaluatePlanGate — the opening line (R16)", () => {
  it("denies an encargo with no workplan/nivel-0 opening line", () => {
    writeConfig(true);
    const result = evaluatePlanGate(payload("implementer", "just fix the bug"));
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("workplan: <feature>");
    expect(result.reason).toContain("plan-simple");
  });

  it("denies a workplan opening line with no workplan file on disk", () => {
    writeConfig(true);
    const result = evaluatePlanGate(payload("implementer", "workplan: demo\ndo A1"));
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("navori plan render demo");
  });

  it("allows a valid workplan that passes `plan check`", () => {
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);
    const result = evaluatePlanGate(payload("implementer", "workplan: demo\ndo A1"));
    expect(result.decision).toBe("allow");
  });

  it("denies a workplan that fails `plan check` (missing acceptance command)", () => {
    writeConfig(true);
    writeWorkplan("demo", {
      ...VALID_LEVEL1,
      acceptance: [{ ...VALID_LEVEL1.acceptance[0]!, command: "" }],
    });
    const result = evaluatePlanGate(payload("implementer", "workplan: demo\ndo A1"));
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("navori plan check demo");
  });
});

describe("evaluatePlanGate — the level-0 exemption (R16)", () => {
  it("allows nivel-0 when classify confirms level 0", () => {
    writeConfig(true);
    const result = evaluatePlanGate(payload("implementer", "nivel-0: README.md\nfix a typo"));
    expect(result.decision).toBe("allow");
  });

  it("denies nivel-0 when classify computes a higher level (comma-separated file list)", () => {
    writeConfig(true);
    // `nivel-0` accepts a comma-separated list of paths (one token, no
    // spaces) — 8 non-trivial files crosses R4's "at most one" bound.
    const manyFiles = Array.from({ length: 8 }, (_, i) => `src/module-${i}/file.ts`).join(",");
    const result = evaluatePlanGate(
      payload("implementer", `nivel-0: ${manyFiles}\ntweak several modules`),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("not confirmed by classify");
  });
});

describe("evaluatePlanGate — escalation after two rejections (R19)", () => {
  function writeChangesRequested(feature: string): void {
    mkdirSync(progressDir(), { recursive: true });
    writeFileSync(
      join(progressDir(), `review_${feature}.md`),
      `# Review\n\n**Final verdict:** CHANGES_REQUESTED\n\nfix the thing\n`,
    );
  }

  it("allows the first and second dispatch even with a CHANGES_REQUESTED on record", () => {
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);
    writeChangesRequested("demo");
    const result = evaluatePlanGate(payload("implementer", "workplan: demo\nfix A1"));
    expect(result.decision).toBe("allow");
  });

  it("requires level-2 artifacts on the third dispatch after two distinct rejections", () => {
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);

    writeChangesRequested("demo");
    evaluatePlanGate(payload("implementer", "workplan: demo\nfix A1")); // records rejection #1

    writeFileSync(
      join(progressDir(), `review_demo.md`),
      `# Review\n\n**Final verdict:** CHANGES_REQUESTED\n\nstill wrong\n`,
    );
    const result = evaluatePlanGate(payload("implementer", "workplan: demo\nfix A1 again"));
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("solution_demo.md");

    // Once the level-2 artifacts exist, the third dispatch is allowed again.
    writeFileSync(join(progressDir(), "solution_demo.md"), "# Solution\n");
    writeFileSync(join(progressDir(), "solution_review_demo.md"), "# Challenge\n");
    const allowed = evaluatePlanGate(payload("implementer", "workplan: demo\nfix A1 again"));
    expect(allowed.decision).toBe("allow");
  });

  it("escalates to the user instead of a third dispatch at level 2", () => {
    writeConfig(true);
    const level2Plan: Workplan = {
      ...VALID_LEVEL1,
      level: 2,
      classification: { score: 8, level: 2, signals: [] },
      solution: { path: ".claude/progress/solution_demo.md", verdict: "READY" },
      phases: [{ name: "phase 1", acceptance: ["A1"] }],
      risks: [{ risk: "regression", rollback: "revert the commit" }],
    };
    writeWorkplan("demo", level2Plan);

    writeChangesRequested("demo");
    evaluatePlanGate(payload("implementer", "workplan: demo\nfix A1"));
    writeFileSync(
      join(progressDir(), `review_demo.md`),
      `# Review\n\n**Final verdict:** CHANGES_REQUESTED\n\nstill wrong, take 2\n`,
    );
    const result = evaluatePlanGate(payload("implementer", "workplan: demo\nfix A1 again"));
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("escalate to the user");
  });

  it("only counts DISTINCT review contents once (R19 — review_<feature>.md is overwritten each cycle)", () => {
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);
    writeChangesRequested("demo");
    evaluatePlanGate(payload("implementer", "workplan: demo\nfix A1"));
    // Same content, re-dispatched without a new review cycle — must not double-count.
    const result = evaluatePlanGate(payload("implementer", "workplan: demo\nfix A1 once more"));
    expect(result.decision).toBe("allow");
    const logPath = join(progressDir(), "workplan_demo.gate.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});
