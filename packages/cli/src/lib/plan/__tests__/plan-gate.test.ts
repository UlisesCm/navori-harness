import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  utimesSync,
  readdirSync,
  statSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acknowledgePlanEscalation,
  applyPlanGate,
  claimDispatch,
  evaluatePlanGate,
  normalizeRole,
  UNREADABLE_PAYLOAD,
} from "../gate.ts";
import * as escalation from "../escalation.ts";
import { hasAuditTarget, outcomeFeatureKey } from "../../audit/cli-event.ts";
import { repoFromCwd, sessionLogPath } from "../../audit/paths.ts";
import type { Workplan } from "../schema.ts";
import { expandHookIncludes } from "../../render/hook-includes.ts";

/**
 * `navori plan gate` — the TypeScript half of the `PreToolUse(Agent)` hook
 * (spec 0032, #1011).
 *
 * Covers: R1, R2, R4, R16, R17, R19
 */

vi.mock(import("../../audit/cli-event.ts"), { spy: true });
vi.mock(import("../escalation.ts"), { spy: true });
const actualEscalation =
  await vi.importActual<typeof import("../escalation.ts")>("../escalation.ts");

let cwd: string;
/** A well-formed nivel-0 `verify:` clause (R28). */
const VERIFY = "| verify: `true` → exit 0";

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
  vi.mocked(escalation.consumeEscalation).mockImplementation(actualEscalation.consumeEscalation);
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-plan-gate-")));
  execFileSync("git", ["init", "-b", "main"], { cwd });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** Builds only disposable escalation state; no real acknowledgement is issued. */
function continuationFixture(spec: boolean): {
  feature: string;
  opening: string;
  currentSnapshot: string;
  predecessor: string;
} {
  writeConfig(true);
  const feature = spec ? "demo-e1" : "demo",
    opening = spec ? "spec: demo E1 M1" : "workplan: demo";
  writeWorkplan(feature, {
    ...VALID_LEVEL1,
    feature,
    level: spec ? 3 : 2,
    solution: { path: "solution_demo.md", verdict: "CONCERNS" },
    phases: [{ name: "one", acceptance: ["A1"] }],
    risks: [{ risk: "retry", rollback: "deny" }],
  });
  writeFileSync(
    join(progressDir(), `workplan_${feature}.gate.jsonl`),
    ["a", "b"]
      .map((letter) =>
        JSON.stringify({
          ts: "2026-10-14T00:00:00Z",
          reviewHash: letter.repeat(64),
          verdict: "CHANGES_REQUESTED",
        }),
      )
      .join("\n") + "\n",
  );
  if (spec) {
    mkdirSync(join(cwd, "specs/demo"), { recursive: true });
    writeFileSync(
      join(cwd, "specs/demo/tasks.md"),
      "## E1 — Delivery\n### M1 — Milestone\n### M2 — Another\n",
    );
  }
  acknowledgePlanEscalation(cwd, feature, opening, "fixture approval");
  expect(evaluatePlanGate(payload("implementer", opening)).decision).toBe("allow");
  appendFileSync(join(progressDir(), `workplan_${feature}.json`), "\n");
  const info = acknowledgePlanEscalation(cwd, feature, opening, "", { inspect: true });
  if (info.status !== "inspected") throw new Error("fixture inspection missing");
  return {
    feature,
    opening,
    currentSnapshot: info.currentSnapshot,
    predecessor: info.eligiblePredecessor!,
  };
}
function authorizeFixture(info: ReturnType<typeof continuationFixture>): void {
  acknowledgePlanEscalation(cwd, info.feature, info.opening, "fixture successor approval", {
    continuation: {
      continueAfter: info.predecessor,
      authorizationId: "fixture-successor",
      snapshot: info.currentSnapshot,
    },
  });
}

describe("normal continuation gate integration", () => {
  it.each(
    [false, true].flatMap((spec) =>
      ["claude", "codex", "encrypted"].map((engine) => ({ spec, engine })),
    ),
  )(
    "retains exact normal validation and one-use authority for $engine spec=$spec",
    ({ spec, engine }) => {
      const info = continuationFixture(spec);
      const planPath = join(progressDir(), `workplan_${info.feature}.json`);
      const plan = readFileSync(planPath, "utf8"),
        history = readFileSync(join(progressDir(), `workplan_${info.feature}.gate.jsonl`), "utf8");
      authorizeFixture(info);
      if (spec)
        expect(evaluatePlanGate(payload("implementer", "spec: demo E1 M2")).decision).toBe("deny");
      expect(
        evaluatePlanGate({
          cwd,
          tool_input: { agent_type: "implementer", message: "gAAAAABencrypted" },
        }).decision,
      ).toBe("deny");
      const raw =
        engine === "claude"
          ? payload("implementer", info.opening)
          : {
              cwd,
              tool_input: {
                agent_type: "implementer",
                message: engine === "encrypted" ? "gAAAAABencrypted" : info.opening,
              },
            };
      if (engine === "encrypted") {
        const neutral = join(cwd, ".navori/state/handoffs");
        mkdirSync(neutral, { recursive: true });
        writeFileSync(
          join(neutral, `dispatch_${info.feature}.json`),
          JSON.stringify({
            feature: info.feature,
            opening: info.opening,
            createdAt: new Date().toISOString(),
          }),
        );
      }
      expect(evaluatePlanGate(raw).decision).toBe("allow");
      expect(evaluatePlanGate(raw).decision).toBe("deny");
      expect(readFileSync(planPath, "utf8")).toBe(plan);
      expect(readFileSync(join(progressDir(), `workplan_${info.feature}.gate.jsonl`), "utf8")).toBe(
        history,
      );
    },
  );

  it("inspection is read-only and refuses a fresh unrecorded review rejection", () => {
    const info = continuationFixture(false);
    writeFileSync(
      join(progressDir(), "review_demo.md"),
      "**Final verdict:** CHANGES_REQUESTED\nnew fixture review\n",
    );
    const history = readFileSync(join(progressDir(), "workplan_demo.gate.jsonl"), "utf8");
    expect(() =>
      acknowledgePlanEscalation(cwd, info.feature, info.opening, "", { inspect: true }),
    ).toThrow("unrecorded");
    expect(readFileSync(join(progressDir(), "workplan_demo.gate.jsonl"), "utf8")).toBe(history);
  });

  it.each(["before-burn", "after-burn", "before-removal"])(
    "preserves a public replacement %s while consuming only the private claimed marker",
    (moment) => {
      const info = continuationFixture(false);
      authorizeFixture(info);
      const path = join(cwd, ".navori/state/handoffs/dispatch_demo.json");
      writeFileSync(
        path,
        JSON.stringify({
          feature: info.feature,
          opening: info.opening,
          createdAt: new Date().toISOString(),
        }),
      );
      const replacement = JSON.stringify({
        feature: info.feature,
        opening: info.opening,
        createdAt: new Date(Date.now() + 1).toISOString(),
        replacement: true,
      });
      vi.mocked(escalation.consumeEscalation).mockImplementation((binding, markerUnchanged) => {
        if (moment === "before-burn") writeFileSync(path, replacement);
        let checks = 0;
        actualEscalation.consumeEscalation(binding, () => {
          if (++checks === 3 && moment === "after-burn") writeFileSync(path, replacement);
          return markerUnchanged();
        });
        if (moment === "before-removal") writeFileSync(path, replacement);
      });
      const result = evaluatePlanGate({
        cwd,
        tool_input: { agent_type: "implementer", message: "gAAAAABencrypted" },
      });
      expect(result.decision).toBe("allow");
      expect(readFileSync(path, "utf8")).toBe(replacement);
      const status = acknowledgePlanEscalation(cwd, info.feature, info.opening, "", {
        inspect: true,
      });
      if (status.status !== "inspected") throw new Error("fixture inspection missing");
      expect(status.terminal.status).toBe("consumed");
    },
  );
});

describe("exclusive private dispatch claims", () => {
  // Covers: R7
  it("keeps same-PID/time nested claims distinct and cleans up only their owned paths (C1)", () => {
    const marker = join(cwd, "dispatch.json"),
      now = 1;
    writeFileSync(marker, "A");
    let first = "",
      second = "";
    expect(
      claimDispatch(marker, "A", now, (unchangedA) => {
        first = readdirSync(cwd).find((name) => name.includes(".claim-"))!;
        writeFileSync(marker, "B");
        expect(
          claimDispatch(marker, "B", now, (unchangedB) => {
            second = readdirSync(cwd).find((name) => name.includes(".claim-") && name !== first)!;
            expect(second).toBeTruthy();
            expect(second).not.toBe(first);
            expect(readFileSync(join(cwd, first), "utf8")).toBe("A");
            expect(unchangedA()).toBe(true);
            expect(unchangedB()).toBe(true);
            writeFileSync(marker, "C");
          }),
        ).toBeUndefined();
        expect(existsSync(join(cwd, second))).toBe(false);
        expect(readFileSync(join(cwd, first), "utf8")).toBe("A");
        expect(readFileSync(marker, "utf8")).toBe("C");
      }),
    ).toBeUndefined();
    expect(existsSync(join(cwd, first))).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("C");
  });

  // Covers: R7, R19
  it.each(["pre-burn", "post-burn"])("cleans only the owned claim after %s drift", (moment) => {
    const info = continuationFixture(false);
    authorizeFixture(info);
    const marker = join(cwd, ".navori/state/handoffs/dispatch_demo.json");
    mkdirSync(join(cwd, ".navori/state/handoffs"), { recursive: true });
    writeFileSync(
      marker,
      JSON.stringify({
        feature: info.feature,
        opening: info.opening,
        createdAt: new Date().toISOString(),
      }),
    );
    vi.mocked(escalation.consumeEscalation).mockImplementation((binding, unchanged) => {
      const name = readdirSync(join(cwd, ".navori/state/handoffs")).find((entry) =>
        entry.includes(".claim-"),
      )!;
      const claim = join(cwd, ".navori/state/handoffs", name);
      writeFileSync(marker, "replacement");
      if (moment === "pre-burn") writeFileSync(claim, "drift");
      actualEscalation.consumeEscalation(binding, unchanged);
      writeFileSync(claim, "post-burn drift");
    });
    expect(
      evaluatePlanGate({
        cwd,
        tool_input: { agent_type: "implementer", message: "gAAAAABencrypted" },
      }).decision,
    ).toBe("deny");
    expect(readFileSync(marker, "utf8")).toBe("replacement");
    // #1331: a claim whose bytes are not the selected marker's is never deleted; the
    // public name is taken, so it cannot be restored and stays as a private claim.
    const claims = readdirSync(join(cwd, ".navori/state/handoffs")).filter((name) =>
      name.includes(".claim-"),
    );
    expect(claims).toHaveLength(1);
    expect(readFileSync(join(cwd, ".navori/state/handoffs", claims[0]!), "utf8")).toBe(
      moment === "pre-burn" ? "drift" : "post-burn drift",
    );
    const status = acknowledgePlanEscalation(cwd, info.feature, info.opening, "", {
      inspect: true,
    });
    expect(status.status).toBe("inspected");
    if (status.status !== "inspected") throw new Error("missing inspection");
    expect(status.terminal.status).toBe(moment === "pre-burn" ? "unconsumed" : "consumed");
  });
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

describe("evaluatePlanGate — config and root (R1, R2)", () => {
  // Covers: R1
  it("configuración ilegible deniega nombrando el error y sin archivo deja pasar", () => {
    expect(evaluatePlanGate(payload("implementer", "do it")).decision).toBe("allow");
    writeFileSync(join(cwd, "navori.config.json"), "{ not json");
    const result = evaluatePlanGate(payload("implementer", "do it"));
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("Invalid JSON");
    expect(result.reason).toContain("update navori");
    // A non-implementer never reads the config.
    expect(evaluatePlanGate(payload("reviewer", "x")).decision).toBe("allow");
  });

  // Covers: R2
  it("cwd en subdirectorio recibe la misma decisión que la raíz", () => {
    writeConfig(true);
    const sub = join(cwd, "packages", "a");
    mkdirSync(sub, { recursive: true });
    const at = (dir: string) =>
      evaluatePlanGate({
        cwd: dir,
        tool_input: { subagent_type: "implementer", prompt: "no opening line" },
      });
    expect(at(cwd).decision).toBe("deny");
    expect(at(sub)).toEqual(at(cwd));
    writeFileSync(join(cwd, "navori.config.json"), "{ not json");
    expect(at(sub).decision).toBe("deny");
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
      tool_input: { subagent_type: "implementer", prompt: `nivel-0: README.md demo ${VERIFY}` },
    });
    expect(nonGitResult.decision).toBe("deny");
    const alias = join(cwd, "alias");
    symlinkSync(cwd, alias);
    writeConfig(true);
    const aliasResult = evaluatePlanGate({
      cwd: alias,
      tool_input: { subagent_type: "implementer", prompt: `nivel-0: README.md demo ${VERIFY}` },
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
      tool_input: { subagent_type: "implementer", prompt: `nivel-0: README.md demo ${VERIFY}` },
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

describe("evaluatePlanGate — shared check rules (R5)", () => {
  // Covers: R5
  it("workplan con feature ajeno, nivel bajo el recálculo o BLOCKED se deniega", () => {
    writeConfig(true);
    const open = () => evaluatePlanGate(payload("implementer", "workplan: demo\ndo A1"));

    writeWorkplan("demo", { ...VALID_LEVEL1, feature: "other" });
    let result = open();
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("feature-mismatch");

    writeWorkplan("demo", {
      ...VALID_LEVEL1,
      classification: { score: 0, level: 0, signals: ["floor:shared-contract"] },
    });
    result = open();
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("level-below-classification");

    writeWorkplan("demo", {
      ...VALID_LEVEL1,
      level: 2,
      classification: { score: 8, level: 2, signals: [] },
      solution: { path: "solution_demo", verdict: "BLOCKED" },
      phases: [{ name: "Core", acceptance: ["A1"] }],
      risks: [{ risk: "r", rollback: "r" }],
    });
    result = open();
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("solution-blocked");
  });
});

describe("evaluatePlanGate — the level-0 exemption (R16)", () => {
  it("allows nivel-0 when classify confirms level 0", () => {
    writeConfig(true);
    const result = evaluatePlanGate(
      payload("implementer", `nivel-0: README.md demo ${VERIFY}\nfix a typo`),
    );
    expect(result.decision).toBe("allow");
  });

  it("denies nivel-0 when classify computes a higher level (comma-separated file list)", () => {
    writeConfig(true);
    // `nivel-0` accepts a comma-separated list of paths (one token, no
    // spaces) — 8 non-trivial files crosses R4's "at most one" bound.
    const manyFiles = Array.from({ length: 8 }, (_, i) => `src/module-${i}/file.ts`).join(",");
    const result = evaluatePlanGate(
      payload("implementer", `nivel-0: ${manyFiles} demo ${VERIFY}\ntweak several modules`),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("not confirmed by classify");
  });

  // Covers: R28
  it("nivel-0 con y sin verify", () => {
    writeConfig(true);
    const open = (line: string) => evaluatePlanGate(payload("implementer", `${line}\nfix it`));
    const open0 = (clause: string) => open(`nivel-0: README.md demo${clause}`);

    // Accepted spellings: `->`, a longer code span, `|` and `→` inside the command.
    expect(open0(" | verify: `true` → exit 0").decision).toBe("allow");
    expect(open0(" | verify: `true` -> exit 0").decision).toBe("allow");
    expect(open0(" | verify: ``a | b → c`` → contains: x").decision).toBe("allow");

    // Missing, empty or malformed: denied with the full grammar in the reason.
    for (const clause of [
      "",
      " | verify:",
      " | verify: `` → exit 0",
      " | verify: `true`",
      " | verify: `true` →",
      " | verify: `true` →   ",
      " | verify: true → exit 0",
      " | check: `true` → exit 0",
    ]) {
      const result = open0(clause);
      expect(result.decision, clause).toBe("deny");
      expect(result.reason, clause).toContain("verify:");
      expect(result.reason, clause).toContain("<expected>");
    }
    // No feature and no verify keeps the feature message.
    expect(open("nivel-0: README.md | verify: `true` → exit 0").reason).toContain(
      "needs a feature",
    );
  });

  // Covers: R6
  it("nivel-0 deniega sin feature, con workplan existente, con ruta absoluta o .. y con ruta crítica", () => {
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "gate-demo",
        engines: ["claude"],
        preset: "custom",
        harness: { planTiers: true },
        project: { criticalPaths: ["src/payments/**"] },
      }),
    );
    const open = (line: string) =>
      evaluatePlanGate(payload("implementer", `${line} ${VERIFY}\nfix it`));

    // Without a feature: the new form is named; a stale doctrine asks for a render.
    let result = open("nivel-0: README.md");
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("nivel-0: <path>[,<path>] <feature>");
    expect(result.reason).not.toContain("navori render --apply");
    writeFileSync(join(cwd, "CLAUDE.md"), "encargo opens with `nivel-0: <path>`\n");
    result = open("nivel-0: README.md");
    expect(result.reason).toContain("navori render --apply");
    expect(open("nivel-0: README.md demo").decision).toBe("allow");

    // An existing workplan sends the opening to `workplan:`.
    writeWorkplan("demo", VALID_LEVEL1);
    result = open("nivel-0: README.md demo");
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("workplan: demo");
    rmSync(join(progressDir(), "workplan_demo.json"));

    // Absolute and `..` paths, even when only one of the list is unsafe.
    for (const path of ["/abs/x.ts", "a/../../x.ts", "README.md,../x.ts", "C:\\x.ts"]) {
      result = open(`nivel-0: ${path} demo`);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("absolute or climbs out");
    }

    // A critical path, however it is spelled.
    for (const path of ["src/payments/x.ts", "./src//payments/x.ts"]) {
      result = open(`nivel-0: ${path} demo`);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("critical path");
    }
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

  // Covers: R19 (#1286)
  it("counts an appended multi-milestone review by its LAST verdict only", () => {
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);
    const reviewPath = join(progressDir(), "review_demo.md");
    const logPath = join(progressDir(), "workplan_demo.gate.jsonl");
    const logLines = (): number => readFileSync(logPath, "utf-8").trim().split("\n").length;
    const dispatch = (): ReturnType<typeof evaluatePlanGate> =>
      evaluatePlanGate(payload("implementer", "workplan: demo\nfix A1"));

    writeChangesRequested("demo"); // M3 rejected
    expect(dispatch().decision).toBe("allow");
    expect(logLines()).toBe(1);

    // M4 APPROVED appended: the old rejection must not be re-registered.
    appendFileSync(reviewPath, "\n## M4\n\n**Final verdict:** APPROVED\n");
    expect(dispatch().decision).toBe("allow");
    expect(dispatch().decision).toBe("allow");
    expect(logLines()).toBe(1);

    // A real second rejection appended: counts as 2 (third dispatch is gated).
    appendFileSync(reviewPath, "\n## M5\n\n**Final verdict:** CHANGES_REQUESTED\n");
    const gated = dispatch();
    expect(logLines()).toBe(2);
    expect(gated.decision).toBe("deny");

    // Unchanged file re-evaluated: no duplicate log line.
    dispatch();
    expect(logLines()).toBe(2);
  });
});

describe("evaluatePlanGate — pairwise cap and reset (spec 0052 R8, R9)", () => {
  const LEVEL2: Workplan = {
    ...VALID_LEVEL1,
    level: 2,
    classification: { score: 8, level: 2, signals: [] },
    solution: { path: ".claude/progress/solution_demo.md", verdict: "READY" },
    phases: [{ name: "phase 1", acceptance: ["A1"] }],
    risks: [{ risk: "regression", rollback: "revert the commit" }],
  };
  const at = (day: number): Date => new Date(Date.UTC(2026, 0, day));
  const logPath = (): string => join(progressDir(), "workplan_demo.gate.jsonl");

  function writeLog(entries: object[]): void {
    mkdirSync(progressDir(), { recursive: true });
    writeFileSync(logPath(), entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  }
  const rejection = (day: number, hash: string): object => ({
    ts: at(day).toISOString(),
    reviewHash: createHash("sha256").update(hash).digest("hex"),
    verdict: "CHANGES_REQUESTED",
  });
  function touchSolutions(day: number): void {
    for (const name of ["solution_demo.md", "solution_review_demo.md"]) {
      const file = join(progressDir(), name);
      writeFileSync(file, "# x\n");
      utimesSync(file, at(day), at(day));
    }
  }
  const openNivel0 = (): ReturnType<typeof evaluatePlanGate> =>
    evaluatePlanGate(payload("implementer", `nivel-0: README.md demo ${VERIFY}\nfix it`));

  // Covers: R8
  it("tras dos, cuatro y seis rechazos exige solution nuevos y acepta los posteriores al último par", () => {
    writeConfig(true);
    writeLog([rejection(1, "h1"), rejection(2, "h2")]);

    // Two rejections, no solution at all (nivel-0 goes through the same count).
    expect(openNivel0().decision).toBe("deny");
    // Solutions older than the rejection that closed the pair do not count.
    touchSolutions(1);
    expect(openNivel0().decision).toBe("deny");
    touchSolutions(3);
    expect(openNivel0().decision).toBe("allow");

    // Four rejections: the day-3 solutions predate rejection #4 and no longer count.
    writeLog([rejection(1, "h1"), rejection(2, "h2"), rejection(4, "h3"), rejection(5, "h4")]);
    const stale = openNivel0();
    expect(stale.decision).toBe("deny");
    expect(stale.reason).toContain("NEW solution_demo.md");
    // A third rejection alone (odd count) keeps the pair-2 solutions valid.
    writeLog([rejection(1, "h1"), rejection(2, "h2"), rejection(4, "h3")]);
    expect(openNivel0().decision).toBe("allow");
    writeLog([rejection(1, "h1"), rejection(2, "h2"), rejection(4, "h3"), rejection(5, "h4")]);
    touchSolutions(6);
    expect(openNivel0().decision).toBe("allow");
    writeLog([
      rejection(1, "h1"),
      rejection(2, "h2"),
      rejection(4, "h3"),
      rejection(5, "h4"),
      rejection(7, "h5"),
      rejection(8, "h6"),
    ]);
    expect(openNivel0().decision).toBe("deny");
    touchSolutions(9);
    expect(openNivel0().decision).toBe("allow");
  });

  // Covers: R8, R9
  it("denies malformed nivel-0 history without throwing", () => {
    writeConfig(true);
    writeLog([{ kind: "reset", approvedBy: "agent" }]);
    expect(openNivel0().decision).toBe("deny");
  });

  // Covers: R9
  it("un reset reinicia la cuenta en nivel 2 sin recontar la misma revisión", () => {
    writeConfig(true);
    writeWorkplan("demo", LEVEL2);
    const review = (text: string): void =>
      writeFileSync(
        join(progressDir(), "review_demo.md"),
        `# Review\n\n**Final verdict:** CHANGES_REQUESTED\n\n${text}\n`,
      );
    const dispatch = (): ReturnType<typeof evaluatePlanGate> =>
      evaluatePlanGate(payload("implementer", "workplan: demo\nfix A1"));

    review("one");
    expect(dispatch().decision).toBe("allow"); // rejection 1
    review("two");
    const denied = dispatch(); // rejection 2
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("escalation-reset");
    expect(denied.reason).toContain("--approved-by user");

    appendFileSync(
      logPath(),
      `${JSON.stringify({ ts: new Date().toISOString(), kind: "reset", approvedBy: "user", reason: "r", rejectionsBefore: 2 })}\n`,
    );
    // Same review file: its hash predates the reset, so it is not recounted.
    expect(dispatch().decision).toBe("allow");
    expect(dispatch().decision).toBe("allow");
    // One new rejection after the reset counts as 1, not 3.
    review("three");
    expect(dispatch().decision).toBe("allow");
    review("four");
    expect(dispatch().decision).toBe("deny");
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

describe("evaluatePlanGate — SDD delivery dispatch (#1309)", () => {
  const FEATURE = "demo-e1";
  const OPENING = "spec: demo E1 M1";
  const TASKS =
    "## E1 — First\n### M1 — First milestone\n## E2 — Second\n### M2 — Second milestone\n";
  const PLAN: Workplan = {
    ...VALID_LEVEL1,
    feature: FEATURE,
    level: 3,
    solution: { path: "solution_demo.md", verdict: "READY" },
    phases: [{ name: "Delivery", acceptance: ["A1"] }],
    risks: [{ risk: "Invalid dispatch", rollback: "Revert gate extension" }],
  };
  const NOW = Date.parse("2026-10-03T12:00:00.000Z");
  const FERNET = "gAAAAABp_encrypted-token_0123456789abcdef==";

  function writeTasks(text: string = TASKS, specsDir: string = "specs"): string {
    const dir = join(cwd, specsDir, "demo");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "tasks.md");
    writeFileSync(file, text);
    return file;
  }

  function writeDispatch(feature: string = FEATURE, age: number = 60_000): string {
    const dir = join(cwd, ".navori/state/handoffs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `dispatch_${feature}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        feature,
        opening: OPENING,
        createdAt: new Date(NOW - age).toISOString(),
      }),
    );
    return file;
  }

  beforeEach(() => {
    writeConfig(true);
    writeTasks();
    writeWorkplan(FEATURE, PLAN);
    writeWorkplan("demo-e2", { ...PLAN, feature: "demo-e2" });
  });

  it.each(["claude", "codex", "encrypted", "absent"])(
    "allows %s with delivery metadata and consumes only fallback dispatch",
    (host) => {
      const file = host === "encrypted" || host === "absent" ? writeDispatch() : undefined;
      const tool_input =
        host === "claude"
          ? { subagent_type: "implementer", prompt: `${OPENING}\nbody` }
          : {
              agent_type: "implementer",
              message: host === "encrypted" ? FERNET : host === "absent" ? undefined : OPENING,
            };
      expect(
        evaluatePlanGate({ cwd, session_id: "session", tool_use_id: "spawn", tool_input }, NOW),
      ).toEqual({
        decision: "allow",
        dispatch: {
          feature: FEATURE,
          cwd,
          codex: host !== "claude",
          sessionId: "session",
          spawn: "spawn",
        },
      });
      if (file) {
        expect(existsSync(file)).toBe(false);
        expect(evaluatePlanGate({ cwd, tool_input }, NOW).decision).toBe("deny");
      }
    },
  );

  it("allows a later delivery with its exact plan", () => {
    writeWorkplan("demo-e2", { ...PLAN, feature: "demo-e2" });
    expect(evaluatePlanGate(payload("implementer", "spec: demo E2 M2")).dispatch?.feature).toBe(
      "demo-e2",
    );
  });

  it("uses configured specsDir", () => {
    const config = JSON.parse(readFileSync(join(cwd, "navori.config.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({ ...config, sdd: { specsDir: "plans" } }),
    );
    writeTasks(TASKS, "plans");
    rmSync(join(cwd, "specs"), { recursive: true });
    expect(evaluatePlanGate(payload("implementer", OPENING)).decision).toBe("allow");
  });

  it("resolves spec from checkout root and never accepts a nested cwd decoy", () => {
    const nested = join(cwd, "packages/cli");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, "navori.config.json"),
      readFileSync(join(cwd, "navori.config.json")),
    );
    writeTasks("## E1 — Decoy\n### M9 — Decoy\n", "packages/cli/specs");
    const raw = {
      cwd: nested,
      tool_input: { subagent_type: "implementer", prompt: OPENING },
    };
    expect(evaluatePlanGate(raw).decision).toBe("allow");
    writeTasks("## E1 — Root\n### M9 — Root\n");
    writeTasks(TASKS, "packages/cli/specs");
    expect(evaluatePlanGate(raw).decision).toBe("deny");
  });

  it.each([
    "spec: demo E1",
    "spec: demo M1 E1",
    "spec: demo E0 M1",
    "spec: demo E01 M1",
    "spec: demo E1 M0",
    "spec: demo E1 M01",
    "spec: demo E1 M1 suffix",
    "spec: ../demo E1 M1",
    "spec: /demo E1 M1",
    "spec: a/demo E1 M1",
    "spec: Demo E1 M1",
    "spec: de..mo E1 M1",
    "spec: demo E9 M1",
    "spec: demo E1 M2",
  ])("denies invalid or foreign opening %s", (opening) => {
    expect(evaluatePlanGate(payload("implementer", opening)).decision).toBe("deny");
  });

  it.each([
    "- [ ] legacy",
    "## E1 — First\n### M1 — First\n- [ ] malformed\n",
    "## E1 — First\n- [ ] **T1** orphan\n### M1 — First\n",
    "## E1 — First\n- **A1** orphan\n### M1 — First\n",
    `${TASKS}\n## E1 — Duplicate\n### M1 — Duplicate\n`,
    `${TASKS}\n## E2 — Duplicate\n### M1 — Foreign\n`,
    "## E1 — First\n### M1 — First\n### M1 — Duplicate\n",
    "## E1 — First\n```md\n### M1 — Fenced\n```\n",
  ])("denies malformed, orphan, ambiguous or fenced tasks: %s", (text) => {
    // Duplicate unrelated E2 does not affect the unique E1/M1 target.
    const opening = text.includes("## E2 — Duplicate") ? "spec: demo E2 M1" : OPENING;
    writeTasks(text);
    expect(evaluatePlanGate(payload("implementer", opening)).decision).toBe("deny");
  });

  it.each(["missing", "unreadable"])("denies %s tasks", (kind) => {
    const file = join(cwd, "specs/demo/tasks.md");
    rmSync(file);
    if (kind === "unreadable") mkdirSync(file);
    expect(evaluatePlanGate(payload("implementer", OPENING)).decision).toBe("deny");
  });

  it.each(["missing", "json", "unreadable", "check", "feature", "level0", "level1", "level2"])(
    "denies %s workplan and retains encrypted dispatch",
    (kind) => {
      const file = join(progressDir(), `workplan_${FEATURE}.json`);
      if (kind === "missing" || kind === "unreadable") rmSync(file);
      if (kind === "unreadable") mkdirSync(file);
      if (kind === "json") writeFileSync(file, "{bad");
      if (kind === "check") writeWorkplan(FEATURE, { ...PLAN, acceptance: [] });
      if (kind === "feature") writeWorkplan(FEATURE, { ...PLAN, feature: "foreign-e1" });
      if (kind.startsWith("level"))
        writeWorkplan(FEATURE, {
          ...PLAN,
          level: Number(kind.slice(-1)) as 0 | 1 | 2,
        });
      const dispatch = writeDispatch();
      expect(
        evaluatePlanGate({ cwd, tool_input: { agent_type: "implementer", message: FERNET } }, NOW)
          .decision,
      ).toBe("deny");
      expect(existsSync(dispatch)).toBe(true);
    },
  );

  it("denies a foreign encrypted dispatch identity without consuming it", () => {
    const file = writeDispatch("foreign-e1");
    const result = evaluatePlanGate(
      { cwd, tool_input: { agent_type: "implementer", message: FERNET } },
      NOW,
    );
    expect(result.reason).toContain("does not match spec delivery");
    expect(existsSync(file)).toBe(true);
  });

  it.each(["stale", "multiple"])("preserves %s dispatch denial", (kind) => {
    const file = writeDispatch(FEATURE, kind === "stale" ? 11 * 60_000 : 60_000);
    if (kind === "multiple") writeDispatch("foreign-e1");
    expect(
      evaluatePlanGate({ cwd, tool_input: { agent_type: "implementer", message: FERNET } }, NOW)
        .decision,
    ).toBe("deny");
    expect(existsSync(file)).toBe(true);
  });

  it("keeps rejection escalation scoped to the delivery feature", () => {
    const log = join(progressDir(), `workplan_${FEATURE}.gate.jsonl`);
    writeFileSync(
      log,
      `${JSON.stringify({ ts: new Date().toISOString(), reviewHash: "a".repeat(64), verdict: "CHANGES_REQUESTED" })}\n${JSON.stringify({ ts: new Date().toISOString(), reviewHash: "b".repeat(64), verdict: "CHANGES_REQUESTED" })}\n`,
    );
    const result = evaluatePlanGate(payload("implementer", OPENING));
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("escalate to the user");
    writeWorkplan("demo-e2", { ...PLAN, feature: "demo-e2" });
    expect(evaluatePlanGate(payload("implementer", "spec: demo E2 M2")).decision).toBe("allow");
  });
});

describe("evaluatePlanGate — Codex spawn_agent payloads (spec 0041 R9)", () => {
  const NOW = Date.parse("2026-10-03T12:00:00.000Z");
  const FERNET = "gAAAAABp_encrypted-token_0123456789abcdef==";
  const dispatchDir = (): string => join(cwd, ".navori/state/handoffs");

  function codex(agentType: string, message?: string): unknown {
    return {
      cwd,
      tool_input: { agent_type: agentType, task_name: "t", message },
    };
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
  it("V2: accepts the offset and fractional createdAt the Codex orchestrator writes (smoke S4d)", () => {
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);
    const file = writeDispatch("demo", {
      createdAt: "2026-10-03T20:27:54.004865+00:00",
    });
    const now = Date.parse("2026-10-03T20:28:30.000Z");
    expect(evaluatePlanGate(codex("implementer", FERNET), now).decision).toBe("allow");
    expect(existsSync(file)).toBe(false);
  });

  // Covers: R7
  it("el segundo spawn sobre el mismo despacho se deniega y un createdAt futuro en más de 60 s caduca", () => {
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);
    const file = writeDispatch("demo");
    expect(evaluatePlanGate(codex("implementer", FERNET), NOW).decision).toBe("allow");
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dispatchDir()).filter((n) => n.includes(".claim-"))).toEqual([]);
    expect(evaluatePlanGate(codex("implementer", FERNET), NOW).decision).toBe("deny");

    // Claim path: the file vanishes (a concurrent spawn won) or changes between read and claim.
    const raced = writeDispatch("demo");
    const raw = readFileSync(raced, "utf-8");
    rmSync(raced);
    expect(claimDispatch(raced, raw, NOW)).toContain("already claimed");
    writeFileSync(raced, raw + " ");
    expect(claimDispatch(raced, raw, NOW)).toContain("changed during evaluation");
    // #1331: bytes that were not the selected marker's are restored, never deleted.
    expect(readFileSync(raced, "utf-8")).toBe(raw + " ");
    rmSync(raced);

    // Within the 60 s skew a future createdAt is still fresh; beyond it, stale.
    for (const offset of [59_000, 60_000]) {
      writeDispatch("demo", { createdAt: new Date(NOW + offset).toISOString() });
      expect(evaluatePlanGate(codex("implementer", FERNET), NOW).decision).toBe("allow");
    }
    const future = writeDispatch("demo", { createdAt: new Date(NOW + 61_000).toISOString() });
    const result = evaluatePlanGate(codex("implementer", FERNET), NOW);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("stale");
    expect(existsSync(future)).toBe(true);
  });

  // Covers: R9
  it("V2: a dispatch with a non-ISO createdAt is still malformed", () => {
    writeConfig(true);
    writeDispatch("demo", { createdAt: "yesterday" });
    const result = evaluatePlanGate(codex("implementer", FERNET), NOW);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("malformed");
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
    writeDispatch("demo", {
      createdAt: new Date(NOW - 11 * 60_000).toISOString(),
    });
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

  // Covers: R4
  it("payload ilegible o sin tool_input deniega con planTiers y message nulo cae al despacho", () => {
    writeConfig(true);
    for (const bad of [UNREADABLE_PAYLOAD, "x", null, { cwd }, { cwd, tool_input: "x" }]) {
      const result = evaluatePlanGate(bad, NOW);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("unreadable");
    }
    expect(evaluatePlanGate(UNREADABLE_PAYLOAD, NOW).reason).toContain("not valid JSON");
    // With the gate off, the same payload is not our concern.
    writeConfig(false);
    expect(evaluatePlanGate({ cwd }, NOW).decision).toBe("allow");
    // A null message on a Codex spawn falls to the dispatch path, not a shape denial.
    writeConfig(true);
    const result = evaluatePlanGate(
      { cwd, tool_input: { agent_type: "implementer", message: null } },
      NOW,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("no dispatch file");
  });
});

describe("evaluatePlanGate — Codex dispatch scoped by session (#1331)", () => {
  const NOW = Date.parse("2026-10-03T12:00:00.000Z");
  const FERNET = "gAAAAABp_encrypted-token_0123456789abcdef==";
  const dir = (): string => join(cwd, ".navori/state/handoffs");

  function spawn(session?: string | null): unknown {
    return {
      cwd,
      ...(session === undefined ? {} : { session_id: session }),
      tool_input: { agent_type: "implementer", task_name: "t", message: FERNET },
    };
  }

  function marker(
    feature: string,
    sessionId: string | undefined,
    ageMs = 60_000,
    overrides: Record<string, unknown> = {},
  ): string {
    mkdirSync(dir(), { recursive: true });
    const file = join(dir(), `dispatch_${feature}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        feature,
        opening: `workplan: ${feature}`,
        createdAt: new Date(NOW - ageMs).toISOString(),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...overrides,
      }),
    );
    return file;
  }

  function plans(...features: string[]): void {
    writeConfig(true);
    for (const f of features) writeWorkplan(f, { ...VALID_LEVEL1, feature: f });
  }

  // Covers: #1331
  it("two sessions each consume only their own marker, which the other never touches", () => {
    plans("feat-a", "feat-b");
    const a = marker("feat-a", "sess-A");
    const b = marker("feat-b", "sess-B");
    const bBytes = readFileSync(b, "utf-8");
    const bMtime = statSync(b).mtimeMs;
    expect(evaluatePlanGate(spawn("sess-A"), NOW).decision).toBe("allow");
    expect(existsSync(a)).toBe(false);
    expect(readFileSync(b, "utf-8")).toBe(bBytes);
    expect(statSync(b).mtimeMs).toBe(bMtime);
    // A's second spawn finds no marker of its own and must not take B's.
    const denied = evaluatePlanGate(spawn("sess-A"), NOW);
    expect(denied.decision).toBe("deny");
    expect(readFileSync(b, "utf-8")).toBe(bBytes);
    expect(statSync(b).mtimeMs).toBe(bMtime);
    expect(evaluatePlanGate(spawn("sess-B"), NOW).decision).toBe("allow");
    expect(existsSync(b)).toBe(false);
  });

  // Covers: #1331
  it.each([
    [354_000, 48_000],
    [48_000, 354_000],
  ])("is independent of marker age order (A %i ms, B %i ms)", (ageA, ageB) => {
    plans("feat-a", "feat-b");
    marker("feat-a", "sess-A", ageA);
    marker("feat-b", "sess-B", ageB);
    expect(evaluatePlanGate(spawn("sess-B"), NOW).dispatch?.feature).toBe("feat-b");
    expect(evaluatePlanGate(spawn("sess-A"), NOW).dispatch?.feature).toBe("feat-a");
  });

  // Covers: #1331
  it("keeps the one-implementer limit inside a session (two own markers, none consumed)", () => {
    plans("feat-a", "feat-c");
    const a = marker("feat-a", "sess-A");
    const c = marker("feat-c", "sess-A");
    const result = evaluatePlanGate(spawn("sess-A"), NOW);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("will not guess");
    expect(existsSync(a) && existsSync(c)).toBe(true);
  });

  // Covers: #1331
  it("does not weaken TTL: own stale or future marker denies, other session's stale or future is ignored", () => {
    plans("feat-a", "feat-b");
    const own = marker("feat-a", "sess-A", 11 * 60_000);
    expect(evaluatePlanGate(spawn("sess-A"), NOW).reason).toContain("stale");
    rmSync(own);
    marker("feat-a", "sess-A", -61_000);
    expect(evaluatePlanGate(spawn("sess-A"), NOW).reason).toContain("stale");
    rmSync(join(dir(), "dispatch_feat-a.json"));
    marker("feat-a", "sess-A");
    marker("feat-b", "sess-B", 11 * 60_000);
    expect(evaluatePlanGate(spawn("sess-A"), NOW).decision).toBe("allow");
    marker("feat-a", "sess-A");
    marker("feat-b", "sess-B", -61_000);
    expect(evaluatePlanGate(spawn("sess-A"), NOW).decision).toBe("allow");
  });

  // Covers: #1331
  it("keeps the approval check: an own marker without an approved workplan is denied and retained", () => {
    plans("feat-b");
    const own = marker("feat-a", "sess-A");
    const other = marker("feat-b", "sess-B");
    const otherBytes = readFileSync(other, "utf-8");
    expect(evaluatePlanGate(spawn("sess-A"), NOW).decision).toBe("deny");
    expect(existsSync(own)).toBe(true);
    expect(readFileSync(other, "utf-8")).toBe(otherBytes);
  });

  // Covers: #1331
  it("transition: a lone unstamped marker is accepted; unstamped next to another session's fresh marker is not", () => {
    plans("feat-a", "feat-b");
    const lone = marker("feat-a", undefined);
    expect(evaluatePlanGate(spawn("sess-A"), NOW).decision).toBe("allow");
    expect(existsSync(lone)).toBe(false);
    const unstamped = marker("feat-a", undefined);
    marker("feat-b", "sess-B");
    const result = evaluatePlanGate(spawn("sess-A"), NOW);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("`sess-A`");
    expect(result.reason).toContain("dispatch_feat-b.json");
    expect(existsSync(unstamped)).toBe(true);
  });

  // Covers: #1331
  it("denies with the session id the gate expects and the skipped other-session marker names", () => {
    plans("feat-b");
    marker("feat-b", "sess-B");
    const result = evaluatePlanGate(spawn("sess-A"), NOW);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("this session's id is `sess-A`");
    expect(result.reason).toContain("`sessionId`");
    expect(result.reason).toContain("skipped other-session markers: dispatch_feat-b.json");
    expect(result.reason).not.toContain("sess-B");
  });

  // Covers: #1331
  it.each([undefined, "", "x".repeat(300), "bad id!"])(
    "payload session_id %j (absent or unbounded) falls to the legacy rule even with stamped markers",
    (session) => {
      plans("feat-a", "feat-b");
      marker("feat-a", "sess-A");
      marker("feat-b", "sess-B");
      const result = evaluatePlanGate(spawn(session), NOW);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("will not guess");
      expect(result.reason).not.toContain("this session's id is");
    },
  );

  // Covers: #1331
  it("a legacy payload with one stamped marker still allows it", () => {
    plans("feat-a");
    marker("feat-a", "sess-A");
    expect(evaluatePlanGate(spawn(), NOW).decision).toBe("allow");
  });

  // Covers: #1331
  it("malformed markers: attributable to another session are ignored, unattributable still deny", () => {
    plans("feat-a");
    marker("feat-a", "sess-A");
    writeFileSync(join(dir(), "dispatch_feat-b.json"), JSON.stringify({ sessionId: "sess-B" }));
    marker("feat-c", "sess-C", 60_000, { feature: "other-name" });
    expect(evaluatePlanGate(spawn("sess-A"), NOW).decision).toBe("allow");

    marker("feat-a", "sess-A");
    writeFileSync(join(dir(), "dispatch_feat-d.json"), "{truncated");
    const broken = evaluatePlanGate(spawn("sess-A"), NOW);
    expect(broken.decision).toBe("deny");
    expect(broken.reason).toContain("dispatch_feat-d.json is malformed");
    rmSync(join(dir(), "dispatch_feat-d.json"));

    // Own-session malformed marker denies; an invalid sessionId format is unattributable.
    writeFileSync(join(dir(), "dispatch_feat-e.json"), JSON.stringify({ sessionId: "sess-A" }));
    expect(evaluatePlanGate(spawn("sess-A"), NOW).reason).toContain("malformed");
    rmSync(join(dir(), "dispatch_feat-e.json"));
    marker("feat-f", "bad id!");
    expect(evaluatePlanGate(spawn("sess-A"), NOW).reason).toContain(
      "dispatch_feat-f.json is malformed",
    );
  });

  // Covers: #1331
  it("own stamped + unstamped: the stamped one is selected in either file order, unstamped is untouched", () => {
    for (const [stamped, unstamped] of [
      ["feat-a", "feat-z"],
      ["feat-z", "feat-a"],
    ] as const) {
      plans("feat-a", "feat-z");
      const s = marker(stamped, "sess-A");
      const u = marker(unstamped, undefined);
      expect(evaluatePlanGate(spawn("sess-A"), NOW).dispatch?.feature).toBe(stamped);
      expect(existsSync(s)).toBe(false);
      expect(existsSync(u)).toBe(true);
      rmSync(u);
    }
  });

  // Covers: #1331
  it("own stamped + unstamped, parallel spawns: residual is documented, the unstamped one is then accepted", () => {
    plans("feat-a", "feat-z");
    marker("feat-a", "sess-A");
    marker("feat-z", undefined);
    const first = evaluatePlanGate(spawn("sess-A"), NOW);
    const second = evaluatePlanGate(spawn("sess-A"), NOW);
    expect(first.dispatch?.feature).toBe("feat-a");
    // Residual (#1331, C4): mixed stamping relaxes "one at a time" once the stamped marker is gone.
    expect(second.dispatch?.feature).toBe("feat-z");
  });

  // Covers: #1331
  it("two sessions spawning in parallel are both allowed", () => {
    plans("feat-a", "feat-b");
    marker("feat-a", "sess-A");
    marker("feat-b", "sess-B");
    const results = [spawn("sess-B"), spawn("sess-A")].map((p) => evaluatePlanGate(p, NOW));
    expect(results.map((r) => r.decision)).toEqual(["allow", "allow"]);
  });

  // Covers: #1331
  it("claim restores a file whose bytes differ from the selected marker instead of deleting it", () => {
    mkdirSync(dir(), { recursive: true });
    const file = join(dir(), "dispatch_feat-a.json");
    const selected = '{"selected":true}';
    const rewritten = '{"another":"session"}';
    // Another session replaces the public name after readDispatch read `selected`.
    writeFileSync(file, rewritten);
    expect(claimDispatch(file, selected, NOW)).toContain("changed during evaluation");
    expect(readFileSync(file, "utf-8")).toBe(rewritten);
    expect(readdirSync(dir()).filter((n) => n.includes(".claim-"))).toEqual([]);
  });
});

describe("applyPlanGate — dispatch-outcome emission (spec 0042 T10a)", () => {
  const SESSION = "sess-dispatch";
  const AUDIT_KEYS = [
    "NAVORI_AUDITS_ROOT",
    "CLAUDE_CODE_SESSION_ID",
    "NAVORI_AUDIT_HOST",
    "NAVORI_AUDIT_SESSION_ID",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
  ];
  let saved: Record<string, string | undefined>;
  let auditRoot: string;

  /** Opts the session in the way `navori audit --start` does: a header-only log. */
  function startAudit(sessionId = SESSION): string {
    const log = sessionLogPath(repoFromCwd(cwd), sessionId);
    mkdirSync(join(log, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(
      log,
      `${JSON.stringify({ event: "start", host: "claude", sessionId, repo: repoFromCwd(cwd), cwd })}\n`,
      { mode: 0o600 },
    );
    return log;
  }
  const lines = (log: string): string[] => readFileSync(log, "utf-8").trim().split("\n");
  const spawnPayload = (prompt: string, extra: Record<string, unknown> = {}): unknown => ({
    cwd,
    session_id: SESSION,
    tool_use_id: "toolu_01Abc",
    tool_input: { subagent_type: "implementer", prompt },
    ...extra,
  });
  /** Runs the hook and returns everything observable: exit code, stdout and stderr. */
  function observe(raw: unknown): {
    exitCode: unknown;
    stdout: string;
    stderr: string;
  } {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      applyPlanGate(raw);
      return {
        exitCode: process.exitCode,
        stdout: out.join(""),
        stderr: err.join(""),
      };
    } finally {
      process.exitCode = before;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }

  beforeEach(() => {
    saved = Object.fromEntries(AUDIT_KEYS.map((key) => [key, process.env[key]]));
    for (const key of AUDIT_KEYS) delete process.env[key];
    auditRoot = join(cwd, "..", `${cwd.split("/").pop()}-audits`);
    process.env.NAVORI_AUDITS_ROOT = auditRoot;
    writeConfig(true);
    writeWorkplan("demo", VALID_LEVEL1);
  });

  afterEach(() => {
    vi.mocked(hasAuditTarget).mockRestore();
    vi.mocked(outcomeFeatureKey).mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(auditRoot, { recursive: true, force: true });
  });

  // Covers: R17
  it("logs one closed dispatch-outcome on allow, from the payload's session", () => {
    const log = startAudit();
    const seen = observe(spawnPayload("workplan: demo\ndo A1"));
    expect(seen).toEqual({ exitCode: undefined, stdout: "", stderr: "" });
    const [, record] = lines(log);
    const event = JSON.parse(record ?? "");
    expect(event).toMatchObject({
      event: "cli",
      name: "dispatch-outcome",
      verdict: "allow",
      schemaVersion: 1,
      stage: "implement",
      spawn: "toolu_01Abc",
    });
    expect(event.featureKey).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(event).sort()).toEqual(
      ["event", "featureKey", "name", "schemaVersion", "spawn", "stage", "tsMs", "verdict"].sort(),
    );
    expect(Buffer.byteLength(record ?? "")).toBeLessThanOrEqual(2048);
    expect(record).not.toContain("demo");
  });

  // Covers: R17
  it("omits a spawn id that is not a bounded id but still records the dispatch", () => {
    const log = startAudit();
    observe(spawnPayload("workplan: demo", { tool_use_id: "not a valid id" }));
    expect(JSON.parse(lines(log)[1] ?? "")).not.toHaveProperty("spawn");
  });

  // Covers: R17
  it.each([
    ["a throw while looking up the audit target", () => vi.mocked(hasAuditTarget)],
    ["a throw while computing the feature key", () => vi.mocked(outcomeFeatureKey)],
  ])("keeps the allow byte-identical when there is %s (B2)", (_label, target) => {
    startAudit();
    const baseline = observe({
      ...(spawnPayload("workplan: demo") as object),
      session_id: "none",
    });
    target().mockImplementation(() => {
      throw new Error("forced");
    });
    const forced = observe(spawnPayload("workplan: demo"));
    expect(target()).toHaveBeenCalled();
    expect(forced).toEqual(baseline);
    expect(forced).toEqual({ exitCode: undefined, stdout: "", stderr: "" });
  });

  // Covers: R17
  it("emits nothing on deny and leaves its exit code and stderr unchanged", () => {
    const log = startAudit();
    const seen = observe(spawnPayload("just do it"));
    expect(seen.exitCode).toBe(2);
    expect(seen.stderr).toContain("BLOCKED by plan-gate");
    expect(lines(log)).toHaveLength(1);
    expect(outcomeFeatureKey).not.toHaveBeenCalled();
  });

  // Covers: R17
  it("emits nothing for a nivel-0 allow", () => {
    const log = startAudit();
    expect(
      observe(spawnPayload(`nivel-0: README.md typo ${VERIFY}\nfix a typo`)).exitCode,
    ).toBeUndefined();
    expect(lines(log)).toHaveLength(1);
  });

  // Covers: R17
  it("computes nothing and writes nothing without an audit context", () => {
    const seen = observe(spawnPayload("workplan: demo", { session_id: undefined }));
    expect(seen).toEqual({ exitCode: undefined, stdout: "", stderr: "" });
    expect(outcomeFeatureKey).not.toHaveBeenCalled();
    const unlogged = observe(spawnPayload("workplan: demo", { session_id: "never-started" }));
    expect(unlogged.exitCode).toBeUndefined();
    expect(outcomeFeatureKey).not.toHaveBeenCalled();
  });

  // Covers: R17
  it("writes nothing when the payload session contradicts the ambient identity (R9)", () => {
    const log = startAudit();
    process.env.CLAUDE_CODE_SESSION_ID = "another-session";
    expect(observe(spawnPayload("workplan: demo")).exitCode).toBeUndefined();
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.NAVORI_AUDIT_HOST = "claude";
    process.env.NAVORI_AUDIT_SESSION_ID = "another-session";
    expect(observe(spawnPayload("workplan: demo")).exitCode).toBeUndefined();
    expect(lines(log)).toHaveLength(1);
    expect(outcomeFeatureKey).not.toHaveBeenCalled();
  });

  // Covers: R17
  it("writes through a payload session that matches the ambient one", () => {
    const log = startAudit();
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    observe(spawnPayload("workplan: demo"));
    expect(lines(log)).toHaveLength(2);
  });

  // Covers: R17
  it("still allows a Codex spawn whose source is unverified, writing nothing", () => {
    const log = startAudit();
    const seen = observe({
      cwd,
      session_id: SESSION,
      tool_input: {
        agent_type: "implementer",
        message: "workplan: demo\nbody",
      },
    });
    expect(seen).toEqual({ exitCode: undefined, stdout: "", stderr: "" });
    expect(lines(log)).toHaveLength(1);
  });
});

describe("evaluatePlanGate — implementer role recognition (spec 0052 R3)", () => {
  // Covers: R3
  it("Implementer con prefijo o espacios se gatea en Claude y Codex gatea default, worker y sin rol pero no los siete roles de la lista", () => {
    writeConfig(true);
    expect(normalizeRole(" Navori:Implementer ")).toBe("implementer");

    // Claude: prefix, case and spaces still gate; other types pass.
    for (const type of ["implementer", "navori:implementer", " Implementer ", "plug:IMPLEMENTER"]) {
      const result = evaluatePlanGate(payload(type, "just fix the bug"));
      expect(result.decision, type).toBe("deny");
      expect(result.reason).toContain("workplan: <feature>");
    }
    for (const type of ["general-purpose", "reviewer", "implementer-x"]) {
      expect(evaluatePlanGate(payload(type, "x")).decision, type).toBe("allow");
    }

    // Codex: fail-closed outside the list (agent_type present, or the engine env flag).
    const codex = (agentType?: string): unknown => ({
      cwd,
      tool_input: {
        ...(agentType === undefined ? {} : { agent_type: agentType }),
        message: "just do it",
      },
    });
    for (const type of ["default", "worker", "orchestrator", "implementer", "mystery", undefined]) {
      expect(
        evaluatePlanGate(codex(type), Date.now(), { codex: true }).decision,
        String(type),
      ).toBe("deny");
    }
    expect(evaluatePlanGate(codex("default")).decision).toBe("deny"); // heuristic fallback
    for (const type of [
      "scout",
      "architect",
      "auditor",
      "reviewer",
      "scribe",
      "publisher",
      "explorer",
    ]) {
      expect(evaluatePlanGate(codex(type), Date.now(), { codex: true }).decision, type).toBe(
        "allow",
      );
    }
    // Without the env flag and without agent_type this is a Claude spawn: general-purpose.
    expect(evaluatePlanGate(codex(undefined)).decision).toBe("allow");
  });
});

describe("plan-gate.sh — stale CLI hint on denial (R34)", () => {
  const SRC = join(import.meta.dirname, "../../../../../core/core-assets/hooks/plan-gate.sh");

  /**
   * Runs the real hook (includes expanded) with a fake `navori` whose `plan gate`
   * exits `gateExit`, whose `--version` prints `cliVersion` and appends to a marker file.
   */
  function runHook(
    gateExit: number,
    cliVersion: string,
    harnessVersion: string | undefined,
    relPath = "hook.sh",
  ): { status: number | null; stderr: string; versionCalls: number } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-plan-gate-sh-")));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const marker = join(dir, "version-calls");
      writeFileSync(
        join(bin, "navori"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo x >> '${marker}'; echo '${cliVersion}'; exit 0; fi
cat >/dev/null
[ ${gateExit} -eq 2 ] && echo '[navori] BLOCKED by plan-gate: some reason' >&2
exit ${gateExit}
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(dir, "navori.config.json"),
        JSON.stringify({ name: "x", ...(harnessVersion ? { harnessVersion } : {}) }),
      );
      const script = join(dir, relPath);
      mkdirSync(join(script, ".."), { recursive: true });
      writeFileSync(script, expandHookIncludes(readFileSync(SRC, "utf-8")), { mode: 0o755 });
      const r = spawnSync("bash", [script], {
        cwd: dir,
        input: JSON.stringify({ session_id: "s1", cwd: dir, tool_input: {} }),
        encoding: "utf8",
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          CLAUDE_PROJECT_DIR: dir,
          NAVORI_AUDITS_ROOT: join(dir, "audits"),
        },
      });
      return {
        status: r.status,
        stderr: r.stderr,
        versionCalls: existsSync(marker)
          ? readFileSync(marker, "utf8").trim().split("\n").length
          : 0,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Covers: R34
  it("negación con CLI más viejo que harnessVersion nombra ambas versiones y allow no consulta la versión", () => {
    const stale = runHook(2, "0.12.0", "0.12.1");
    expect(stale.status).toBe(2);
    expect(stale.stderr).toContain("BLOCKED by plan-gate: some reason");
    expect(stale.stderr).toContain("outdated");
    expect(stale.stderr).toContain("0.12.0");
    expect(stale.stderr).toContain("0.12.1");
    expect(stale.stderr).toContain("navori update");
    // The Codex copy takes the same path.
    expect(runHook(2, "0.12.0", "0.12.1", ".codex/hooks/plan-gate.sh").stderr).toContain(
      "outdated",
    );
    // Numeric, not lexical: 0.9.0 < 0.12.1; 0.100.0 is not older than 0.12.1.
    expect(runHook(2, "0.9.0", "0.12.1").stderr).toContain("outdated");
    expect(runHook(2, "0.100.0", "0.12.1").stderr).not.toContain("outdated");

    // Equal, newer, missing harnessVersion or garbage: the denial stays as is.
    for (const [cli, harness] of [
      ["0.12.1", "0.12.1"],
      ["1.0.0", "0.12.1"],
      ["0.12.0", undefined],
      ["not-a-version", "0.12.1"],
    ] as const) {
      const same = runHook(2, cli, harness);
      expect(same.status).toBe(2);
      expect(same.stderr).not.toContain("outdated");
      expect(same.stderr).toContain("BLOCKED by plan-gate");
    }

    // An allow never asks the CLI for its version.
    const allow = runHook(0, "0.12.0", "0.12.1");
    expect(allow.status).toBe(0);
    expect(allow.versionCalls).toBe(0);
    expect(allow.stderr).toBe("");
  });
});
