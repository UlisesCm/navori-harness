import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
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
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-plan-gate-")));
  execFileSync("git", ["init", "-b", "main"], { cwd });
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

describe("evaluatePlanGate — enabled checkout validation (R6)", () => {
  // Covers: R6
  it("denies nivel-0 from non-Git and symlinked cwd values when planTiers is enabled", () => {
    const nonGit = realpathSync(mkdtempSync(join(tmpdir(), "navori-plan-gate-nongit-")));
    writeFileSync(
      join(nonGit, "navori.config.json"),
      JSON.stringify({
        name: "gate-demo",
        engines: ["claude"],
        preset: "custom",
        harness: { planTiers: true },
      }),
    );
    const nonGitResult = evaluatePlanGate({
      cwd: nonGit,
      tool_input: { subagent_type: "implementer", prompt: "nivel-0: README.md" },
    });
    expect(nonGitResult.decision).toBe("deny");
    const alias = join(cwd, "alias");
    symlinkSync(cwd, alias);
    writeConfig(true);
    const aliasResult = evaluatePlanGate({
      cwd: alias,
      tool_input: { subagent_type: "implementer", prompt: "nivel-0: README.md" },
    });
    expect(aliasResult.decision).toBe("deny");
    rmSync(nonGit, { recursive: true, force: true });
  });

  // Covers: R6
  it("keeps nivel-0 allowed from a non-Git cwd when planTiers is disabled", () => {
    const nonGit = realpathSync(mkdtempSync(join(tmpdir(), "navori-plan-gate-off-")));
    writeFileSync(
      join(nonGit, "navori.config.json"),
      JSON.stringify({
        name: "gate-demo",
        engines: ["claude"],
        preset: "custom",
        harness: { planTiers: false },
      }),
    );
    const result = evaluatePlanGate({
      cwd: nonGit,
      tool_input: { subagent_type: "implementer", prompt: "nivel-0: README.md" },
    });
    expect(result.decision).toBe("allow");
    rmSync(nonGit, { recursive: true, force: true });
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

  // Covers: R1, R9
  it("records rejection history in the selected neutral feature root", () => {
    writeConfig(true);
    const neutral = join(cwd, ".navori/state/handoffs");
    mkdirSync(neutral, { recursive: true });
    writeFileSync(join(neutral, "workplan_demo.json"), JSON.stringify(VALID_LEVEL1));
    writeFileSync(
      join(neutral, "review_demo.md"),
      "# Review\n\n**Final verdict:** CHANGES_REQUESTED\n\nfix neutral\n",
    );
    expect(evaluatePlanGate(payload("implementer", "workplan: demo\nfix A1")).decision).toBe(
      "allow",
    );
    expect(existsSync(join(neutral, "workplan_demo.gate.jsonl"))).toBe(true);
    expect(existsSync(join(progressDir(), "workplan_demo.gate.jsonl"))).toBe(false);
  });

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

describe("evaluatePlanGate — cumplido without evidence (R11)", () => {
  // Covers: R11
  it("still allows a workplan whose cumplido criterion has no evidence", () => {
    writeConfig(true);
    writeWorkplan("demo", { ...VALID_LEVEL1, progress: { A1: "cumplido" } });
    const result = evaluatePlanGate(payload("implementer", "workplan: demo\nfix A1"));
    expect(result.decision).toBe("allow");
  });
});

describe("evaluatePlanGate — Codex spawn_agent payloads (spec 0041 R9)", () => {
  const NOW = Date.parse("2026-10-03T12:00:00.000Z");
  const FERNET = "gAAAAABp_encrypted-token_0123456789abcdef==";
  const dispatchDir = (): string => join(cwd, ".navori/state/handoffs");

  function codex(agentType: string, message?: string): unknown {
    return { cwd, tool_input: { agent_type: agentType, task_name: "t", message } };
  }

  function writeDispatch(feature: string, overrides: Record<string, unknown> = {}): string {
    mkdirSync(dispatchDir(), { recursive: true });
    const file = join(dispatchDir(), `dispatch_${feature}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        feature,
        opening: `workplan: ${feature}`,
        createdAt: new Date(NOW - 60_000).toISOString(),
        ...overrides,
      }),
    );
    return file;
  }

  // Covers: R9
  it("V1: reads the first line of a readable message, with a workplan", () => {
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);
    expect(evaluatePlanGate(codex("implementer", "workplan: demo\nbody"), NOW).decision).toBe(
      "allow",
    );
  });

  // Covers: R9
  it("V1: denies a readable message with no opening line", () => {
    writeConfig(true);
    const result = evaluatePlanGate(codex("implementer", "just do it"), NOW);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("workplan: <feature>");
  });

  // Covers: R9
  it("allows a non-implementer role without reading anything", () => {
    writeConfig(true);
    expect(evaluatePlanGate(codex("scout", FERNET), NOW).decision).toBe("allow");
  });

  // Covers: R9
  it("V2: an encrypted message with a valid dispatch file is gated by it and consumes it", () => {
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);
    const file = writeDispatch("demo");
    expect(evaluatePlanGate(codex("implementer", FERNET), NOW).decision).toBe("allow");
    expect(existsSync(file)).toBe(false);
  });

  // Covers: R9
  it("V2: a dispatch for a feature without a valid workplan is denied and kept", () => {
    writeConfig(true);
    const file = writeDispatch("demo");
    expect(evaluatePlanGate(codex("implementer", FERNET), NOW).decision).toBe("deny");
    expect(existsSync(file)).toBe(true);
  });

  // Covers: R9
  it("V2: denies naming the fix when no dispatch file exists", () => {
    writeConfig(true);
    const result = evaluatePlanGate(codex("implementer", FERNET), NOW);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("dispatch_<feature>.json");
  });

  // Covers: R9
  it("V2: a stale dispatch file is denied", () => {
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);
    writeDispatch("demo", { createdAt: new Date(NOW - 11 * 60_000).toISOString() });
    const result = evaluatePlanGate(codex("implementer", FERNET), NOW);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("stale");
  });

  // Covers: R9
  it("V2: a malformed dispatch file is denied", () => {
    writeConfig(true);
    mkdirSync(dispatchDir(), { recursive: true });
    writeFileSync(join(dispatchDir(), "dispatch_demo.json"), "{not json");
    const result = evaluatePlanGate(codex("implementer", FERNET), NOW);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("malformed");
  });

  // Covers: R9
  it("V2: two fresh dispatch files are never guessed between", () => {
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);
    writeDispatch("demo");
    writeDispatch("other");
    const result = evaluatePlanGate(codex("implementer", FERNET), NOW);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("will not guess");
  });

  // Covers: R9
  it("V2: a missing message is treated as unreadable", () => {
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);
    writeDispatch("demo");
    expect(evaluatePlanGate(codex("implementer"), NOW).decision).toBe("allow");
  });

  // Covers: R9
  it("an unknown payload shape is allowed, not a crash", () => {
    writeConfig(true);
    expect(evaluatePlanGate({ cwd, tool_input: { foo: 1 } }, NOW).decision).toBe("allow");
  });
});
