import { afterEach, describe, expect, it, vi } from "vitest";
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
import { contractDigest, deliveryDigest } from "../delivery-checks.ts";
import type { DeliveryParts } from "../delivery-schema.ts";
import {
  approveDeliveryBaseline,
  authorizeDeliveryQueue,
  captureDeliveryCriterion,
  revokeDeliveryQueue,
  effectiveDeliveryPart,
  deliveryLifecycle,
  presentDelivery,
  decideDelivery,
  publishDelivery,
  deliveryScopeIdentity,
  reviewedDeliveryIdentity,
} from "../delivery.ts";
import { recordDeliveryCriterion, deliveryPartProof, captureDeliveryReview } from "../part.ts";
import { fingerprintTree, readHead } from "../../plan/evidence.ts";
import { buildAcceptanceIndex } from "../../plan/acceptance-index.ts";
import { deliverySliceProjection, prepareDeliverySlice } from "../slice.ts";
import { computeSignal } from "../signal.ts";
import * as receiptApi from "../../diagnose/receipt.ts";
import { DeliveryReviewEnvelopeSchema } from "../delivery-schema.ts";
import { runMasterClose } from "../close.ts";
import { readMasterStatus } from "../status.ts";

vi.mock("../../../commands/render.ts", () => ({ runRender: vi.fn(() => ({ ok: true })) }));

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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

describe("delivery producer-time provenance", () => {
  // Covers: R7, R8, R9
  it("captures at index production and retains proof across only its lifecycle write", () => {
    const { cwd, stage } = authorized();
    const plan = humanPlan(cwd);
    savePlan(cwd, plan);
    const binding = captureDeliveryCriterion(cwd, plan.source!, "A1", "bun test");
    const dir = join(cwd, ".navori/state/handoffs");
    expect(buildAcceptanceIndex([dir])).toContain(JSON.stringify(binding));
    expect(() => recordDeliveryCriterion(cwd, "P1", "A1")).toThrow(/provenance/);
    writeFileSync(join(cwd, "review.txt"), "Explicit manual review artifact");
    const before = fingerprintTree(cwd, binding);
    if (!before.ok) throw new Error(before.reason);
    writeFileSync(
      join(dir, `workplan_${plan.feature}.evidence.jsonl`),
      JSON.stringify({
        ts: "2026-10-04T12:00:00Z",
        feature: plan.feature,
        id: "A1",
        command: "bun test",
        tree: cwd,
        cwd,
        head: readHead(cwd),
        worktreeTree: before.tree,
        dirty: true,
        deliveryBinding: binding,
      }) + "\n",
    );
    expect(recordDeliveryCriterion(cwd, "P1", "A1")).toEqual({ unchanged: false });
    expect(recordDeliveryCriterion(cwd, "P1", "A1")).toEqual({ unchanged: true });
    expect(() => recordDeliveryCriterion(cwd, "P1", "A2")).toThrow(/approved-by/);
    expect(recordDeliveryCriterion(cwd, "P1", "A2", "user")).toEqual({ unchanged: false });
    expect(deliveryPartProof(cwd, "P1").tree.worktreeTree).toBe(before.tree);
    expect(() => captureDeliveryReview(cwd, "P1", "review.txt", "review.json", "")).toThrow(
      /approved-by/,
    );
    const masterBytes = readFileSync(join(stage, "MASTER.md"), "utf8");
    writeFileSync(join(cwd, "code.ts"), "export const changed = true;\n");
    expect(() => deliveryPartProof(cwd, "P1")).toThrow(/changed|stale/);
    expect(readFileSync(join(stage, "MASTER.md"), "utf8")).toBe(masterBytes);
  });

  // Covers: R7, R8, R9
  it("does not capture missing, changed or historical queue authority", () => {
    const { cwd, stage } = authorized();
    const plan = humanPlan(cwd);
    savePlan(cwd, plan);
    expect(() =>
      captureDeliveryCriterion(
        cwd,
        { ...plan.source!, queueIdentity: "f".repeat(64) },
        "A1",
        "bun test",
      ),
    ).toThrow(/authority/);
    expect(() => captureDeliveryCriterion(cwd, plan.source!, "A1", "fake command")).toThrow(
      /criterion/,
    );
    const state = JSON.parse(readFileSync(join(stage, "state.json"), "utf8")) as {
      authorization?: unknown;
      authorizationHistory?: unknown[];
    };
    state.authorizationHistory = [state.authorization];
    delete state.authorization;
    writeFileSync(join(stage, "state.json"), JSON.stringify(state));
    expect(() => captureDeliveryCriterion(cwd, plan.source!, "A1", "bun test")).toThrow(
      /current authorized queue/,
    );
    expect(buildAcceptanceIndex([join(cwd, ".navori/state/handoffs")])).toBe("");
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
});

/** Disposable claims are operator-attested fixture data, not host-authenticated review or CLI-run QA. */
function technicalFixture(configure?: (parts: DeliveryParts, cwd: string) => void): ReturnType<
  typeof authorized
> & {
  dir: string;
  plan: Workplan;
  envelope: ReturnType<typeof DeliveryReviewEnvelopeSchema.parse>;
} {
  const context = fixture();
  configure?.(context.parts, context.cwd);
  context.parts.digest = contractDigest(context.parts);
  writeFileSync(join(context.stage, "parts.json"), JSON.stringify(context.parts));
  approveDeliveryBaseline(context.cwd, "user");
  authorizeDeliveryQueue(context.cwd, "E1", ["P1"], "user");
  const { cwd } = context;
  const plan = humanPlan(cwd);
  savePlan(cwd, plan);
  writeFileSync(join(cwd, "review.txt"), "Manual obligation report");
  writeFileSync(join(cwd, ".gitignore"), ".navori/state/\n");
  const configPath = join(cwd, "navori.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      harness: { ...(config.harness as Record<string, unknown>), masterPlan: true },
      qualityGate: { fast: "true", full: "true" },
      branchBase: "main",
      prTarget: "main",
    }),
  );
  for (const args of [
    ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "fixture"],
    ["add", "-A"],
    ["commit", "-qm", "fixture base"],
    ["branch", "main"],
    ["remote", "add", "origin", cwd],
  ])
    execFileSync("git", args, { cwd });
  const dir = join(cwd, ".navori/state/handoffs");
  const binding = captureDeliveryCriterion(cwd, plan.source!, "A1", "bun test");
  const fp = fingerprintTree(cwd, binding);
  if (!fp.ok) throw new Error(fp.reason);
  writeFileSync(
    join(dir, `workplan_${plan.feature}.evidence.jsonl`),
    JSON.stringify({
      ts: "2026-10-04T12:00:00Z",
      feature: plan.feature,
      id: "A1",
      command: "bun test",
      tree: cwd,
      cwd,
      head: readHead(cwd),
      worktreeTree: fp.tree,
      dirty: true,
      deliveryBinding: binding,
    }) + "\n",
  );
  recordDeliveryCriterion(cwd, "P1", "A1");
  recordDeliveryCriterion(cwd, "P1", "A2", "user");
  const proof = deliveryPartProof(cwd, "P1");
  const report = "Fixture technical report: reviewer labels are cooperative claims.\n";
  writeFileSync(join(dir, "technical-report.txt"), report);
  const envelope = DeliveryReviewEnvelopeSchema.parse({
    kind: "operator-attested-technical-review",
    feature: plan.feature,
    stageSlug: "demo",
    partId: "P1",
    baselineIdentity: plan.source!.baselineIdentity,
    authorityGeneration: plan.source!.authorityGeneration,
    queueIdentity: plan.source!.queueIdentity,
    criteriaIdentity: proof.criteriaIdentity,
    worktreeTree: proof.tree.worktreeTree,
    producerId: "fixture-producer",
    reviewerId: "fixture-reviewer",
    verdict: "APPROVED",
    reportDigest: deliveryDigest(report),
    gate: "true",
    exitCode: 0,
    executionReference: "disposable fixture claim, not real QA execution",
  });
  writeFileSync(join(dir, "technical-envelope.json"), JSON.stringify(envelope));
  expect(
    receiptApi.signReceipt({
      cwd,
      feature: plan.feature,
      target: "main",
      dir: ".navori/state/handoffs",
      gate: "true",
    }).exitCode,
  ).toBe(0);
  return { ...context, dir, plan, envelope };
}

/** Simulate a fresh host run and cooperative review only in a disposable fixture. */
function rerunTechnicalFixture(
  cwd: string,
  partId: string,
): { identity: string; unchanged: boolean } {
  const projection = deliverySliceProjection(cwd, partId);
  const plan: Workplan = {
    ...projection,
    solution: { path: "fixture-design.txt", verdict: "READY" },
    phases: [{ name: "reverification", acceptance: ["A1"] }],
    risks: [{ risk: "stale dependencies", rollback: "stop" }],
    progress: { A1: "pendiente" },
  };
  savePlan(cwd, plan);
  const command = plan.acceptance[0]!.command;
  const binding = captureDeliveryCriterion(cwd, plan.source!, "A1", command);
  const fingerprint = fingerprintTree(cwd, binding);
  if (!fingerprint.ok) throw new Error(fingerprint.reason);
  const dir = join(cwd, ".navori/state/handoffs");
  writeFileSync(
    join(dir, `workplan_${plan.feature}.evidence.jsonl`),
    JSON.stringify({
      ts: new Date().toISOString(),
      feature: plan.feature,
      id: "A1",
      command,
      tree: cwd,
      cwd,
      head: readHead(cwd),
      worktreeTree: fingerprint.tree,
      dirty: true,
      deliveryBinding: binding,
    }) + "\n",
  );
  recordDeliveryCriterion(cwd, partId, "A1");
  recordDeliveryCriterion(cwd, partId, "A2", "user");
  const proof = deliveryPartProof(cwd, partId);
  const report = "Disposable cooperative re-review fixture, not real execution.\n";
  writeFileSync(join(dir, "rerun-report.txt"), report);
  writeFileSync(
    join(dir, "rerun-envelope.json"),
    JSON.stringify(
      DeliveryReviewEnvelopeSchema.parse({
        kind: "operator-attested-technical-review",
        feature: plan.feature,
        stageSlug: "demo",
        partId,
        baselineIdentity: plan.source!.baselineIdentity,
        authorityGeneration: binding.authorityGeneration,
        queueIdentity: binding.queueIdentity,
        criteriaIdentity: proof.criteriaIdentity,
        worktreeTree: proof.tree.worktreeTree,
        producerId: "fixture-producer",
        reviewerId: "fixture-reviewer",
        verdict: "APPROVED",
        reportDigest: deliveryDigest(report),
        gate: "true",
        exitCode: 0,
        executionReference: "fixture-only attested execution claim",
      }),
    ),
  );
  expect(
    receiptApi.signReceipt({
      cwd,
      feature: plan.feature,
      target: "main",
      dir: ".navori/state/handoffs",
      gate: "true",
    }).exitCode,
  ).toBe(0);
  return captureDeliveryReview(cwd, partId, "rerun-report.txt", "rerun-envelope.json", "user");
}

/** Create two delivery generations of content without inventing historical dispatch. */
function twoDeliveryFixture(): ReturnType<typeof technicalFixture> {
  return technicalFixture((doc) => {
    doc.parts.push({
      ...doc.parts[0]!,
      id: "P2",
      deliveryId: "E2",
      title: "Next",
      objective: "Build next",
      dependsOn: ["P1"],
    });
    doc.deliveries.push({ ...doc.deliveries[0]!, id: "E2", partIds: ["P2"], dependsOn: ["E1"] });
  });
}

describe("cooperative technical snapshot and lifecycle", () => {
  // Covers: R7, R8, R9
  it.each(["changed", "deleted", "redirected"] as const)(
    "invalidates ignored manual artifact %s across historical proof and lifecycle consumers",
    (change) => {
      const artifactPath = ".navori/state/handoffs/manual-review.txt";
      const content = "Explicit manual obligation review\n";
      const { cwd, stage } = technicalFixture((parts, root) => {
        parts.parts[0]!.acceptance[1] = {
          id: "A2",
          method: "manual",
          description: "inspect",
          check: "Human review",
          artifact: artifactPath,
        };
        mkdirSync(join(root, ".navori/state/handoffs"), { recursive: true });
        writeFileSync(join(root, artifactPath), content);
      });
      const captured = captureDeliveryReview(
        cwd,
        "P1",
        "technical-report.txt",
        "technical-envelope.json",
        "user",
      );
      expect(effectiveDeliveryPart(cwd, "P1").identity).toBe(captured.identity);
      const presentation = presentDelivery(cwd, "E1");
      expect(reviewedDeliveryIdentity(cwd, "E1").identity).toBe(presentation.identity);
      decideDelivery(cwd, "E1", presentation.identity, "accepted", "user");
      expect(readMasterStatus(cwd).closable).toBe(true);
      const before = readFileSync(join(stage, "state.json"), "utf8");
      const tree = effectiveDeliveryPart(cwd, "P1").tree.worktreeTree;
      const artifact = join(cwd, artifactPath);
      if (change === "changed") writeFileSync(artifact, "Changed manual review\n");
      else {
        unlinkSync(artifact);
        if (change === "redirected") {
          const external = mkdtempSync(join(tmpdir(), "navori-manual-external-"));
          dirs.push(external);
          writeFileSync(join(external, "review.txt"), content);
          symlinkSync(join(external, "review.txt"), artifact);
        }
      }
      const fp = fingerprintTree(
        cwd,
        captureDeliveryCriterion(cwd, humanPlan(cwd).source!, "A1", "bun test"),
      );
      expect(fp.ok && fp.tree).toBe(tree);
      expect(() => effectiveDeliveryPart(cwd, "P1")).toThrow(/manual proof is stale/);
      expect(() => reviewedDeliveryIdentity(cwd, "E1")).toThrow(/manual proof is stale/);
      expect(() => presentDelivery(cwd, "E1")).toThrow(/manual proof is stale/);
      expect(() => decideDelivery(cwd, "E1", presentation.identity, "accepted", "user")).toThrow();
      expect(deliveryLifecycle(cwd).deliveries[0]!.decision).toBeNull();
      expect(readMasterStatus(cwd).closable).toBe(false);
      expect(() => runMasterClose(cwd)).toThrow();
      expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
    },
  );

  // Covers: R7, R8, R9
  it.each([1, 2, 3])(
    "closes accepted unpublished work and recovers after durable step %s",
    (step) => {
      const { cwd, stage } = technicalFixture();
      const master = readFileSync(join(stage, "MASTER.md"), "utf8");
      captureDeliveryReview(cwd, "P1", "technical-report.txt", "technical-envelope.json", "user");
      const presentation = presentDelivery(cwd, "E1");
      const before = readFileSync(join(stage, "state.json"), "utf8");
      expect(() => runMasterClose(cwd)).toThrow(/acceptance.*pending/);
      expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
      decideDelivery(cwd, "E1", presentation.identity, "accepted", "user");
      expect(readMasterStatus(cwd).closable).toBe(true);
      expect(() =>
        runMasterClose(cwd, {
          afterStep: (completed) => {
            if (completed === step) throw new Error("fixture interruption");
          },
        }),
      ).toThrow("fixture interruption");
      const committed = JSON.parse(readFileSync(join(stage, "state.json"), "utf8")) as {
        phase: string;
        closure: { pendingPublication: string[] };
      };
      expect(committed.phase).toBe("closed");
      expect(committed.closure.pendingPublication).toEqual(["E1"]);
      expect(runMasterClose(cwd).reconciled).toBe(true);
      expect(readMasterStatus(cwd).stage).toBeNull();
      expect(readFileSync(join(stage, "MASTER.md"), "utf8")).toBe(master);
      const closedBytes = readFileSync(join(stage, "state.json"), "utf8");
      expect(runMasterClose(cwd).reconciled).toBe(false);
      expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(closedBytes);
    },
  );

  // Covers: R7, R8, R9
  it("requires a reasoned exact-scope disposition and rejects redirected close output before state commit", () => {
    const { cwd, stage } = technicalFixture();
    const identity = deliveryScopeIdentity(cwd, "E1");
    expect(() => decideDelivery(cwd, "E1", identity, "deferred", "user")).toThrow(/reason/);
    decideDelivery(cwd, "E1", identity, "deferred", "user", "Explicit next-stage decision");
    expect(deliveryLifecycle(cwd).pendingPublication).toEqual([]);
    const before = readFileSync(join(stage, "state.json"), "utf8");
    const external = realpathSync(mkdtempSync(join(tmpdir(), "navori-d4-close-output-")));
    dirs.push(external);
    writeFileSync(join(external, "status.txt"), "untouched");
    symlinkSync(join(external, "status.txt"), join(stage, "STATUS.md"));
    expect(() => runMasterClose(cwd)).toThrow(/redirected|stage|symlink/);
    expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
    expect(readFileSync(join(external, "status.txt"), "utf8")).toBe("untouched");
    unlinkSync(join(stage, "STATUS.md"));
    expect(runMasterClose(cwd).outcome).toBe("entregada");
    expect(
      JSON.parse(readFileSync(join(stage, "state.json"), "utf8")).closure.pendingPublication,
    ).toEqual([]);
  });
  // Covers: R7, R8, R9
  it("foundation can run first; only reviewed foundation unlocks a queued product, never history dispatch", () => {
    const { cwd, parts } = technicalFixture((doc, root) => {
      for (const path of ["architecture.txt", "flow.txt", "system.txt"])
        writeFileSync(join(root, path), "Reviewed UI foundation");
      doc.design = {
        ui: "new",
        architecture: "architecture.txt",
        flow: "flow.txt",
        system: "system.txt",
        reviewedRevision: "fixture-design",
        foundationPartId: "P1",
      };
      doc.parts[0]!.foundation = true;
      doc.parts.push({
        ...doc.parts[0]!,
        id: "P2",
        title: "Product",
        objective: "Build product",
        foundation: false,
        dependsOn: ["P1"],
      });
      doc.deliveries[0]!.partIds.push("P2");
    });
    authorizeDeliveryQueue(cwd, "E1", ["P1", "P2"], "user", "continuation");
    expect(deliverySliceProjection(cwd, "P1").source!.partId).toBe("P1");
    expect(() => deliverySliceProjection(cwd, "P2")).toThrow(/technical review/);
    // Restore the current queue used by the already-written review envelope before capture.
    authorizeDeliveryQueue(cwd, "E1", ["P1"], "user", "continuation");
    expect(
      receiptApi.signReceipt({
        cwd,
        feature: "delivery-demo-p1",
        target: "main",
        dir: ".navori/state/handoffs",
        gate: "true",
      }).exitCode,
    ).toBe(0);
    captureDeliveryReview(cwd, "P1", "technical-report.txt", "technical-envelope.json", "user");
    const oldPlan = humanPlan(cwd);
    authorizeDeliveryQueue(cwd, "E1", ["P2"], "user", "continuation");
    expect(deliverySliceProjection(cwd, "P2").source!.partId).toBe("P2");
    expect(effectiveDeliveryPart(cwd, "P1").partId).toBe("P1");
    expect(() => captureDeliveryCriterion(cwd, oldPlan.source!, "A1", "bun test")).toThrow(
      /authorized queue/,
    );
    expect(
      evaluatePlanGate({
        cwd,
        tool_input: { subagent_type: "implementer", prompt: `workplan: ${oldPlan.feature}\nBuild` },
      }).decision,
    ).toBe("deny");
    expect(parts.parts[0]!.foundation).toBe(true);
  });

  // Covers: R7, R8, R9
  it("E2 code changes stale E1; explicit current E1 refresh is required before dependency-first forward readiness", () => {
    const { cwd, dir } = twoDeliveryFixture();
    captureDeliveryReview(cwd, "P1", "technical-report.txt", "technical-envelope.json", "user");
    const presented = presentDelivery(cwd, "E1");
    decideDelivery(cwd, "E1", presented.identity, "accepted", "user");
    authorizeDeliveryQueue(cwd, "E2", ["P2"], "user", "continuation");
    const p2 = deliverySliceProjection(cwd, "P2");
    savePlan(cwd, {
      ...p2,
      solution: { path: "reviewed-design.txt", verdict: "READY" },
      phases: [{ name: "build", acceptance: ["A1"] }],
      risks: [{ risk: "whole-tree drift", rollback: "stop" }],
    });
    expect(
      checkWorkplan(JSON.parse(readFileSync(join(dir, `workplan_${p2.feature}.json`), "utf8")), cwd)
        .ok,
    ).toBe(true);
    writeFileSync(join(cwd, "next-code.ts"), "export const next = true;\n");
    expect(() => effectiveDeliveryPart(cwd, "P1")).toThrow(/stale/);
    expect(() => deliverySliceProjection(cwd, "P2")).toThrow(/stale/);
    expect(deliveryLifecycle(cwd).deliveries[0]!.decision).toBeNull();
    authorizeDeliveryQueue(cwd, "E1", ["P1"], "user", "continuation");
    prepareDeliverySlice(cwd, "P1", true, "user");
    expect(buildAcceptanceIndex([dir])).toContain("delivery-demo-p1");
    expect(buildAcceptanceIndex([dir])).not.toContain("delivery-demo-p2");
    expect(() => authorizeDeliveryQueue(cwd, "E2", ["P2"], "user", "continuation")).toThrow(
      /stale/,
    );
    expect(() => presentDelivery(cwd, "E1")).toThrow(/stale/);
  });

  // Covers: R7, R8, R9
  it("reverifies current E1 after E2 code changes and rejects its stale presentation", () => {
    const { cwd } = twoDeliveryFixture();
    captureDeliveryReview(cwd, "P1", "technical-report.txt", "technical-envelope.json", "user");
    const presented = presentDelivery(cwd, "E1");
    decideDelivery(cwd, "E1", presented.identity, "accepted", "user");
    authorizeDeliveryQueue(cwd, "E2", ["P2"], "user", "continuation");
    writeFileSync(join(cwd, "next-code.ts"), "export const next = true;\n");
    authorizeDeliveryQueue(cwd, "E1", ["P1"], "user", "continuation");
    prepareDeliverySlice(cwd, "P1", true, "user");
    const rerun = rerunTechnicalFixture(cwd, "P1");
    expect(effectiveDeliveryPart(cwd, "P1").identity).toBe(rerun.identity);
    expect(() => decideDelivery(cwd, "E1", presented.identity, "accepted", "user")).toThrow();
    const updated = presentDelivery(cwd, "E1");
    expect(updated.identity).not.toBe(presented.identity);
    decideDelivery(cwd, "E1", updated.identity, "accepted", "user");
  });

  // Covers: R7, R8, R9
  it("settles current E2 without changing E1 proof on the same code fingerprint", () => {
    const { cwd } = twoDeliveryFixture();
    const current = captureDeliveryReview(
      cwd,
      "P1",
      "technical-report.txt",
      "technical-envelope.json",
      "user",
    );
    const presented = presentDelivery(cwd, "E1");
    decideDelivery(cwd, "E1", presented.identity, "accepted", "user");
    authorizeDeliveryQueue(cwd, "E2", ["P2"], "user", "continuation");
    const next = rerunTechnicalFixture(cwd, "P2");
    expect(effectiveDeliveryPart(cwd, "P1").identity).toBe(current.identity);
    expect(effectiveDeliveryPart(cwd, "P2").identity).toBe(next.identity);
    const nextPresentation = presentDelivery(cwd, "E2");
    expect(() => decideDelivery(cwd, "E2", presented.identity, "accepted", "user")).toThrow();
    decideDelivery(cwd, "E2", nextPresentation.identity, "accepted", "user");
    expect(deliveryLifecycle(cwd).blockers).toEqual([]);
    expect(deliveryLifecycle(cwd).pendingPublication).toEqual(["E1", "E2"]);
  });
  // Covers: R7, R8, R9
  it("requires consent and actual receipt, retains historical provenance, and keeps final QA distinct", () => {
    const { cwd, stage, plan } = technicalFixture();
    expect(() =>
      captureDeliveryReview(cwd, "P1", "technical-report.txt", "technical-envelope.json", ""),
    ).toThrow(/approved-by/);
    expect(() => presentDelivery(cwd, "E1")).toThrow(/technical review/);
    const captured = captureDeliveryReview(
      cwd,
      "P1",
      "technical-report.txt",
      "technical-envelope.json",
      "user",
    );
    const saved = JSON.parse(readFileSync(join(stage, "state.json"), "utf8")) as {
      verifiedParts: Array<{
        report: string;
        envelope: string;
        receipt: string;
        reviewDigest: string;
        envelopeDigest: string;
        receiptDigest: string;
        gate: string;
        gateIdentity: string;
        inputsIdentity: string;
      }>;
    };
    const retained = saved.verifiedParts[0];
    if (!retained) throw new Error("fixture technical record is missing");
    expect(retained.reviewDigest).toBe(deliveryDigest(retained.report));
    expect(retained.envelopeDigest).toBe(deliveryDigest(retained.envelope));
    expect(retained.receiptDigest).toBe(deliveryDigest(retained.receipt));
    expect(retained.gate).toBe("true");
    expect({ gate: retained.gateIdentity, inputs: retained.inputsIdentity }).toEqual(
      receiptApi.evidenceIdentity(cwd, "true"),
    );
    const record = effectiveDeliveryPart(cwd, "P1");
    expect(record.kind).toBe("operator-attested-technical-review");
    for (const field of ["independenceVerifiedByHost", "qaExecutedByCli", "receiptFresh"])
      expect(record).not.toHaveProperty(field);
    expect(
      receiptApi.checkReceipt({
        cwd,
        feature: plan.feature,
        target: "main",
        dir: ".navori/state/handoffs",
        gate: "true",
      }).result.status,
    ).toBe("findings");
    const presented = presentDelivery(cwd, "E1");
    expect(() => decideDelivery(cwd, "E1", presented.identity, "accepted", "")).toThrow(
      /approved-by/,
    );
    expect(() => decideDelivery(cwd, "E2", presented.identity, "accepted", "user")).toThrow();
    expect(decideDelivery(cwd, "E1", presented.identity, "accepted", "user")).toEqual({
      unchanged: false,
    });
    expect(decideDelivery(cwd, "E1", presented.identity, "accepted", "user")).toEqual({
      unchanged: true,
    });
    expect(deliveryLifecycle(cwd).pendingPublication).toEqual(["E1"]);
    expect(() =>
      publishDelivery(cwd, "E1", presented.identity, "merge" as "release", "PR merged", "user"),
    ).toThrow(/release|deploy/);
    expect(publishDelivery(cwd, "E1", presented.identity, "release", "fixture-v1", "user")).toEqual(
      { unchanged: false },
    );
    expect(deliveryLifecycle(cwd).pendingPublication).toEqual([]);
    expect(effectiveDeliveryPart(cwd, "P1").identity).toBe(captured.identity);
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["commit", "-qm", "metadata only"], { cwd });
    expect(readHead(cwd)).not.toBe(record.tree.head);
    expect(effectiveDeliveryPart(cwd, "P1").tree.head).toBe(record.tree.head);
    const before = readFileSync(join(stage, "state.json"), "utf8");
    writeFileSync(join(cwd, "code.ts"), "export const changed = true;\n");
    expect(() => effectiveDeliveryPart(cwd, "P1")).toThrow(/stale/);
    expect(deliveryLifecycle(cwd).deliveries[0]!.decision).toBeNull();
    expect(() =>
      publishDelivery(cwd, "E1", presented.identity, "release", "fixture-v2", "user"),
    ).toThrow();
    expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
  });

  // Covers: R7, R8, R9
  it.each([
    ["feature", "wrong"],
    ["partId", "P99"],
    ["queueIdentity", "f".repeat(64)],
    ["baselineIdentity", "f".repeat(64)],
    ["criteriaIdentity", "f".repeat(64)],
    ["worktreeTree", "wrong-tree"],
    ["authorityGeneration", 99],
    ["reviewerId", "fixture-producer"],
    ["exitCode", 1],
    ["executionReference", ""],
    ["gate", "false"],
    ["reportDigest", "f".repeat(64)],
  ])("rejects altered %s without writing state", (field: string, value: unknown) => {
    const { cwd, stage, dir, envelope } = technicalFixture();
    const before = readFileSync(join(stage, "state.json"), "utf8");
    writeFileSync(
      join(dir, "technical-envelope.json"),
      JSON.stringify({ ...envelope, [field]: value }),
    );
    expect(() =>
      captureDeliveryReview(cwd, "P1", "technical-report.txt", "technical-envelope.json", "user"),
    ).toThrow();
    expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
  });

  // Covers: R7, R8, R9
  it("rejects generic APPROVED, consumed-only receipts and missing or redirected artifacts", () => {
    const { cwd, stage, dir, envelope } = technicalFixture();
    const before = readFileSync(join(stage, "state.json"), "utf8");
    writeFileSync(join(dir, "technical-envelope.json"), JSON.stringify({ verdict: "APPROVED" }));
    expect(() =>
      captureDeliveryReview(cwd, "P1", "technical-report.txt", "technical-envelope.json", "user"),
    ).toThrow();
    writeFileSync(join(dir, "technical-envelope.json"), JSON.stringify(envelope));
    renameSync(join(dir, "receipt.txt"), join(dir, "receipt.consumed.txt"));
    expect(() =>
      captureDeliveryReview(cwd, "P1", "technical-report.txt", "technical-envelope.json", "user"),
    ).toThrow();
    renameSync(join(dir, "receipt.consumed.txt"), join(dir, "receipt.txt"));
    unlinkSync(join(dir, "technical-report.txt"));
    expect(() =>
      captureDeliveryReview(cwd, "P1", "technical-report.txt", "technical-envelope.json", "user"),
    ).toThrow();
    symlinkSync(join(cwd, "review.txt"), join(dir, "technical-report.txt"));
    expect(() =>
      captureDeliveryReview(cwd, "P1", "technical-report.txt", "technical-envelope.json", "user"),
    ).toThrow();
    expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
  });

  // Covers: R7, R8, R9
  it("rejects concurrent report replacement during actual receipt validation", () => {
    const { cwd, stage, dir } = technicalFixture();
    const before = readFileSync(join(stage, "state.json"), "utf8");
    const check = receiptApi.checkReceipt;
    let calls = 0;
    vi.spyOn(receiptApi, "checkReceipt").mockImplementation((options) => {
      const result = check(options);
      if (++calls === 2) writeFileSync(join(dir, "technical-report.txt"), "changed report");
      return result;
    });
    expect(() =>
      captureDeliveryReview(cwd, "P1", "technical-report.txt", "technical-envelope.json", "user"),
    ).toThrow(/changed/);
    expect(readFileSync(join(stage, "state.json"), "utf8")).toBe(before);
  });

  // Covers: R7, R8, R9
  it("only continuation preserves generation; amendment or revocation never resurrects old proof", () => {
    const { cwd, stage } = technicalFixture();
    captureDeliveryReview(cwd, "P1", "technical-report.txt", "technical-envelope.json", "user");
    const identity = effectiveDeliveryPart(cwd, "P1").identity;
    expect(authorizeDeliveryQueue(cwd, "E1", ["P1"], "user", "continuation").unchanged).toBe(true);
    expect(effectiveDeliveryPart(cwd, "P1").identity).toBe(identity);
    expect(authorizeDeliveryQueue(cwd, "E1", ["P1"], "user").unchanged).toBe(false);
    expect(() => effectiveDeliveryPart(cwd, "P1")).toThrow();
    revokeDeliveryQueue(cwd, "user");
    expect(() => authorizeDeliveryQueue(cwd, "E1", ["P1"], "user", "continuation")).toThrow(
      /continuation/,
    );
    authorizeDeliveryQueue(cwd, "E1", ["P1"], "user");
    expect(() => effectiveDeliveryPart(cwd, "P1")).toThrow();
    expect(() => prepareDeliverySlice(cwd, "P1")).toThrow(/diverged/);
    expect(() => prepareDeliverySlice(cwd, "P1", true)).toThrow(/approved-by/);
    expect(prepareDeliverySlice(cwd, "P1", true, "user").unchanged).toBe(false);
    const plan = JSON.parse(
      readFileSync(join(cwd, ".navori/state/handoffs/workplan_delivery-demo-p1.json"), "utf8"),
    ) as Workplan;
    expect(plan.progress).toEqual({ A1: "pendiente" });
    expect(plan.evidence).toEqual({});
    const state = JSON.parse(readFileSync(join(stage, "state.json"), "utf8")) as {
      authorityGeneration: number;
    };
    expect(plan.source!.authorityGeneration).toBe(state.authorityGeneration);
    expect(() =>
      decideDelivery(cwd, "E1", deliveryScopeIdentity(cwd, "E1"), "deferred", "user"),
    ).toThrow(/reason/);
  });
});

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
