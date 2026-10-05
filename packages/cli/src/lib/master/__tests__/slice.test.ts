import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { runCommand } from "citty";
import { planCommand } from "../../../commands/plan.ts";
import { masterCommand } from "../../../commands/master.ts";
import type { Workplan } from "../../plan/schema.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkplan } from "../../plan/check.ts";
import { evaluatePlanGate } from "../../plan/gate.ts";
import { contractDigest } from "../delivery-checks.ts";
import type { DeliveryParts } from "../delivery-schema.ts";
import { approveDeliveryBaseline, authorizeDeliveryQueue } from "../delivery.ts";
import { deliverySliceProjection, prepareDeliverySlice } from "../slice.ts";
import { computeSignal } from "../signal.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Derive projection membership and coverage from one source and one slice. */
function fixture(): { cwd: string; stage: string; parts: DeliveryParts } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-d3-slice-")));
  dirs.push(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["switch", "-q", "-c", "feat/one"], { cwd });
  const entry = {
    number: 1,
    slug: "demo",
    dir: "01-demo",
    state: "activa",
    openedAt: "2026-01-01",
    closedAt: null,
    spec: null,
    workflow: "deliveries",
  };
  const stage = join(cwd, "specs", "_master", entry.dir);
  mkdirSync(stage, { recursive: true });
  const put = (path: string, value: unknown): void => {
    writeFileSync(join(cwd, path), JSON.stringify(value));
  };
  put("navori.config.json", {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    harness: { planTiers: true },
    sdd: { enabled: true },
  });
  const workflow = { version: 2 as const, workflow: "deliveries" as const };
  put("specs/_master/index.json", { version: workflow.version, stages: [entry] });
  put(`specs/_master/${entry.dir}/state.json`, {
    ...workflow,
    phase: "context",
    mode: null,
    signal: computeSignal(cwd),
    history: [],
  });
  const source: DeliveryParts["sources"][number] = {
    id: "source",
    path: "source.txt",
    requirements: ["RN-1"],
    locator: "RN-1",
    uiBearing: false,
    digest: "",
  };
  const text = `${source.requirements.join("\n")}\n`;
  source.digest = createHash("sha256").update(text).digest("hex");
  writeFileSync(join(cwd, source.path), text);
  writeFileSync(join(stage, "MASTER.md"), `# Operator\n${text}`);
  const slice: DeliveryParts["parts"][number] = {
    id: "P1",
    deliveryId: "E1",
    title: "Part",
    objective: "Build",
    scope: ["src/part.ts"],
    outOfScope: [],
    dependsOn: [],
    sourceIds: [source.id],
    requirementIds: [...source.requirements],
    spec: null,
    foundation: false,
    acceptance: [
      {
        id: "A1",
        method: "command",
        description: "check",
        command: "bun test",
        expected: "exit 0",
      },
      {
        id: "A2",
        method: "manual",
        description: "inspect",
        check: "Human review",
        artifact: "review.txt",
      },
    ],
    questions: [],
  };
  const parts: DeliveryParts = {
    ...workflow,
    revision: 1,
    digest: "0".repeat(64),
    sources: [source],
    parts: [slice],
    requirements: source.requirements.map((id) => ({
      id,
      sourceId: source.id,
      disposition: "in-scope",
      reason: null,
    })),
    design: { ui: "none", reason: "CLI only" },
    deliveries: [
      {
        id: slice.deliveryId,
        partIds: [slice.id],
        title: "One",
        outcome: "Done",
        dependsOn: [],
        git: { branch: "feat/one", base: "main", integrationTarget: "dev", prTarget: "dev" },
      },
    ],
  };
  parts.digest = contractDigest(parts);
  writeFileSync(join(stage, "parts.json"), JSON.stringify(parts));
  return { cwd, stage, parts };
}

describe("delivery slice projection", () => {
  it("requires current authority and branch before any plan write", () => {
    const { cwd } = fixture();
    expect(() => prepareDeliverySlice(cwd, "P1")).toThrow(/baseline/);
    approveDeliveryBaseline(cwd, "user");
    expect(() => prepareDeliverySlice(cwd, "P1")).toThrow(/authorized queue/);
    authorizeDeliveryQueue(cwd, "E1", ["P1"], "user");
    execFileSync("git", ["switch", "-q", "-c", "wrong"], { cwd });
    expect(() => prepareDeliverySlice(cwd, "P1")).toThrow(/branch/);
  });

  it("projects executable criteria only, preserves level-2 floor and refuses diverged replay", () => {
    const { cwd } = fixture();
    approveDeliveryBaseline(cwd, "user");
    authorizeDeliveryQueue(cwd, "E1", ["P1"], "user");
    expect(prepareDeliverySlice(cwd, "P1")).toEqual({
      feature: "delivery-demo-p1",
      unchanged: false,
    });
    const plan = deliverySliceProjection(cwd, "P1");
    expect(plan.source?.criterionMap).toEqual({ A1: "P1.A1" });
    expect(plan.acceptance).toHaveLength(1);
    expect(plan.level).toBe(2);
    expect(() => prepareDeliverySlice(cwd, "P1")).toThrow(/human planning metadata/);
    const path = join(cwd, ".navori", "state", "handoffs", "workplan_delivery-demo-p1.json");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("Build", "Human edit"));
    expect(() => prepareDeliverySlice(cwd, "P1")).toThrow(/diverged/);
  });

  it("fails source/scope drift in plan check and manual-only dispatch", () => {
    const { cwd, stage, parts } = fixture();
    approveDeliveryBaseline(cwd, "user");
    authorizeDeliveryQueue(cwd, "E1", ["P1"], "user");
    const plan = deliverySliceProjection(cwd, "P1");
    expect(
      checkWorkplan(plan, cwd).findings.some((finding) => finding.rule === "delivery-source"),
    ).toBe(false);
    expect(
      checkWorkplan({ ...plan, objective: "changed" }, cwd).findings.some(
        (finding) => finding.rule === "delivery-source",
      ),
    ).toBe(true);
    parts.parts[0]!.acceptance[0] = {
      id: "A1",
      method: "manual",
      description: "inspect",
      check: "Human review",
      artifact: "review.txt",
    };
    parts.parts[0]!.acceptance = [parts.parts[0]!.acceptance[0]!];
    parts.digest = contractDigest(parts);
    writeFileSync(join(stage, "parts.json"), JSON.stringify(parts));
    expect(() => prepareDeliverySlice(cwd, "P1")).toThrow(/baseline|manual-only/);
  });

  it("rejects stale source at the dispatch gate, even with level-2 artifacts", () => {
    const { cwd, stage, parts } = fixture();
    approveDeliveryBaseline(cwd, "user");
    authorizeDeliveryQueue(cwd, "E1", ["P1"], "user");
    const plan = deliverySliceProjection(cwd, "P1");
    const complete = {
      ...plan,
      solution: { path: "solution.md", verdict: "READY" as const },
      phases: [{ name: "implementation", acceptance: ["A1"] }],
      risks: [{ risk: "drift", rollback: "stop" }],
    };
    const path = join(cwd, ".navori", "state", "handoffs", `workplan_${plan.feature}.json`);
    mkdirSync(join(cwd, ".navori", "state", "handoffs"), { recursive: true });
    writeFileSync(path, JSON.stringify(complete));
    const payload = {
      cwd,
      tool_input: { subagent_type: "implementer", prompt: `workplan: ${plan.feature}\nImplement` },
    };
    expect(evaluatePlanGate(payload).decision).toBe("allow");
    parts.parts[0]!.scope.push("src/new.ts");
    parts.digest = contractDigest(parts);
    writeFileSync(join(stage, "parts.json"), JSON.stringify(parts));
    const verdict = evaluatePlanGate(payload);
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toMatch(/delivery-source/);
  });
});

/** Supply human planning artifacts, not delivery authorization. */
function humanPlan(cwd: string): Workplan {
  return {
    ...deliverySliceProjection(cwd, "P1"),
    solution: { path: "solution.txt", verdict: "READY" },
    phases: [{ name: "implementation", acceptance: ["A1"] }],
    risks: [{ risk: "drift", rollback: "stop" }],
    decisions: [{ text: "Reviewed", date: "2026-01-01" }],
    progress: { A1: "pendiente" },
  };
}

/** Build an authorized disposable fixture without attesting real project progress. */
function authorized(): ReturnType<typeof fixture> {
  const context = fixture();
  approveDeliveryBaseline(context.cwd, "user");
  authorizeDeliveryQueue(context.cwd, "E1", ["P1"], "user");
  return context;
}

/** Persist fixture workplan bytes for read-only replay assertions. */
function savePlan(cwd: string, plan: Workplan): string {
  const dir = join(cwd, ".navori", "state", "handoffs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `workplan_${plan.feature}.json`);
  writeFileSync(path, JSON.stringify(plan, null, 4));
  return path;
}

describe("source-owned projection and human planning", () => {
  it("keeps manual-only obligations out of implementer dispatch", () => {
    const { cwd, stage, parts } = fixture();
    parts.parts[0]!.acceptance = [parts.parts[0]!.acceptance[1]!];
    parts.digest = contractDigest(parts);
    writeFileSync(join(stage, "parts.json"), JSON.stringify(parts));
    approveDeliveryBaseline(cwd, "user");
    authorizeDeliveryQueue(cwd, "E1", ["P1"], "user");
    expect(() => prepareDeliverySlice(cwd, "P1")).toThrow(/manual-only/);
    expect(existsSync(join(cwd, ".navori", "state", "handoffs"))).toBe(false);
  });

  it("rejects stage escapes before output and lexical source traversal", () => {
    const { cwd, stage, parts } = authorized();
    parts.sources[0]!.path = "../source.txt";
    writeFileSync(join(stage, "parts.json"), JSON.stringify(parts));
    expect(() => prepareDeliverySlice(cwd, "P1")).toThrow();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "navori-d3-stage-")));
    dirs.push(outside);
    const target = join(outside, "stage");
    renameSync(stage, target);
    symlinkSync(target, stage);
    expect(() => prepareDeliverySlice(cwd, "P1")).toThrow(/outside repository/);
    expect(existsSync(join(cwd, ".navori", "state", "handoffs"))).toBe(false);
  });

  it("binds design bytes and rejects design symlink escape", () => {
    const { cwd, stage, parts } = fixture();
    writeFileSync(join(cwd, "design.txt"), "Reviewed design");
    parts.design = {
      ui: "reuse",
      architecture: "design.txt",
      flow: "design.txt",
      system: "design.txt",
      reviewedRevision: "one",
    };
    parts.digest = contractDigest(parts);
    writeFileSync(join(stage, "parts.json"), JSON.stringify(parts));
    approveDeliveryBaseline(cwd, "user");
    authorizeDeliveryQueue(cwd, "E1", ["P1"], "user");
    const plan = humanPlan(cwd);
    writeFileSync(join(cwd, "design.txt"), "Changed design");
    expect(checkWorkplan(plan, cwd).ok).toBe(false);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "navori-d3-design-")));
    dirs.push(outside);
    writeFileSync(join(outside, "design.txt"), "Reviewed design");
    unlinkSync(join(cwd, "design.txt"));
    symlinkSync(join(outside, "design.txt"), join(cwd, "design.txt"));
    expect(() => prepareDeliverySlice(cwd, "P1")).toThrow(/design/);
  });

  it("preserves human metadata and raised level byte-for-byte on replay", () => {
    const { cwd } = authorized();
    const plan = { ...humanPlan(cwd), level: 3 as const };
    const path = savePlan(cwd, plan);
    const bytes = readFileSync(path, "utf8");
    expect(checkWorkplan(plan, cwd).ok).toBe(true);
    expect(prepareDeliverySlice(cwd, "P1").unchanged).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it.each(["acceptance", "files", "outOfScope", "source", "classification"] as const)(
    "rejects changed %s without rewriting",
    (field) => {
      const { cwd } = authorized();
      const plan = humanPlan(cwd);
      if (field === "acceptance") plan.acceptance[0]!.command = "changed";
      if (field === "files") plan.files.push({ path: "extra.ts", new: true });
      if (field === "outOfScope") plan.outOfScope.push("changed");
      if (field === "source") plan.source!.queueIdentity = "0".repeat(64);
      if (field === "classification") plan.classification.signals = [];
      const path = savePlan(cwd, plan);
      const bytes = readFileSync(path, "utf8");
      expect(checkWorkplan(plan, cwd).ok).toBe(false);
      expect(() => prepareDeliverySlice(cwd, "P1")).toThrow(/diverged/);
      expect(readFileSync(path, "utf8")).toBe(bytes);
    },
  );

  it("does not bypass invalid level-2 metadata or context requirements", () => {
    const { cwd } = authorized();
    const plan = deliverySliceProjection(cwd, "P1");
    savePlan(cwd, plan);
    expect(checkWorkplan(plan, cwd).ok).toBe(false);
    expect(checkWorkplan(humanPlan(cwd)).findings).toContainEqual(
      expect.objectContaining({ rule: "delivery-source" }),
    );
    expect(() => prepareDeliverySlice(cwd, "P1")).toThrow(/human planning metadata/);
    expect(
      evaluatePlanGate({
        cwd,
        tool_input: {
          subagent_type: "implementer",
          prompt: `workplan: ${plan.feature}\nImplement`,
        },
      }).decision,
    ).toBe("deny");
  });

  it.each(["MASTER", "missingMASTER", "source", "queue", "baseline"])(
    "blocks %s drift in check, gate and replay without writes",
    (kind) => {
      const { cwd, stage } = authorized();
      const plan = humanPlan(cwd);
      const path = savePlan(cwd, plan);
      const bytes = readFileSync(path, "utf8");
      if (kind === "MASTER") writeFileSync(join(stage, "MASTER.md"), "Changed RN-1");
      if (kind === "missingMASTER") unlinkSync(join(stage, "MASTER.md"));
      if (kind === "source") writeFileSync(join(cwd, "source.txt"), "Changed RN-1");
      if (kind === "queue" || kind === "baseline") {
        const state = JSON.parse(readFileSync(join(stage, "state.json"), "utf8")) as {
          authorization: { identity: string };
          baseline: { identity: string };
        };
        (kind === "queue" ? state.authorization : state.baseline).identity = "0".repeat(64);
        writeFileSync(join(stage, "state.json"), JSON.stringify(state));
      }
      expect(checkWorkplan(plan, cwd).ok).toBe(false);
      expect(
        evaluatePlanGate({
          cwd,
          tool_input: {
            subagent_type: "implementer",
            prompt: `workplan: ${plan.feature}\nImplement`,
          },
        }).decision,
      ).toBe("deny");
      expect(() => prepareDeliverySlice(cwd, "P1")).toThrow();
      expect(readFileSync(path, "utf8")).toBe(bytes);
    },
  );

  it.each(["parts.json", "state.json", "MASTER.md", "source.txt", "output"])(
    "rejects physical %s escape",
    (target) => {
      const { cwd, stage } = authorized();
      const external = realpathSync(mkdtempSync(join(tmpdir(), "navori-d3-external-")));
      dirs.push(external);
      if (target === "output") {
        mkdirSync(join(cwd, ".navori", "state"), { recursive: true });
        symlinkSync(external, join(cwd, ".navori", "state", "handoffs"));
      } else {
        const path = target === "source.txt" ? join(cwd, target) : join(stage, target);
        const outside = join(external, target);
        writeFileSync(outside, readFileSync(path));
        unlinkSync(path);
        symlinkSync(outside, path);
      }
      expect(() => prepareDeliverySlice(cwd, "P1")).toThrow();
      expect(existsSync(join(external, "workplan_delivery-demo-p1.json"))).toBe(false);
    },
  );

  it("uses explicit CLI checkout for projection and stale plan validation", async () => {
    const { cwd, stage } = authorized();
    const oldCode = process.exitCode;
    const stdout = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await runCommand(masterCommand, {
        rawArgs: ["delivery-slice", "--part", "P1", "--cwd", cwd],
      });
      const plan = humanPlan(cwd);
      const path = savePlan(cwd, plan);
      const bytes = readFileSync(path, "utf8");
      await runCommand(planCommand, { rawArgs: ["check", plan.feature, "--cwd", cwd, "--json"] });
      expect(process.exitCode).toBe(0);
      writeFileSync(join(stage, "MASTER.md"), "Changed RN-1");
      await runCommand(planCommand, { rawArgs: ["check", plan.feature, "--cwd", cwd, "--json"] });
      expect(process.exitCode).toBe(2);
      expect(readFileSync(path, "utf8")).toBe(bytes);
    } finally {
      process.exitCode = oldCode;
      process.stdout.write = stdout;
    }
  });
});
