import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as delivery from "../delivery.ts";
import * as part from "../part.ts";
import { contractDigest, deliveryDigest } from "../delivery-checks.ts";
import type { DeliveryParts, DeliveryState } from "../delivery-schema.ts";
import type { Workplan } from "../../plan/schema.ts";
import { fingerprintTree, readHead } from "../../plan/evidence.ts";
import { createCommitHelper, createGitHelper } from "./test-utils.ts";

export interface DeliveryRepo {
  cwd: string;
  commit: (message: string) => void;
  master: (...args: string[]) => string;
}

/** Runs the source entry point without inheriting fixture authority or the host's audit session. */
export function cli(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const key of [
    "NAVORI_AUDIT_HOST",
    "NAVORI_AUDIT_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
  ])
    delete env[key];
  const result = spawnSync(
    "bun",
    [fileURLToPath(new URL("../../../index.ts", import.meta.url)), ...args, "--cwd", cwd],
    { cwd, encoding: "utf8", timeout: 30_000, env },
  );
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`CLI terminated: ${result.signal}`);
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Runs the CLI and returns stdout; throws with stderr on a non-zero exit. */
export function cliOk(cwd: string, ...args: string[]): string {
  const result = cli(cwd, ...args);
  if (result.code !== 0) throw new Error(`${args.join(" ")}: ${result.err}`);
  return result.out;
}

/** Git repo on `feat/one` with a `main` branch, a self remote and a minimal config. */
export function initDeliveryRepo(): DeliveryRepo {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-delivery-flow-")));
  const git = createGitHelper(cwd);
  const commit = createCommitHelper(git);
  git(["init", "-q"]);
  git(["switch", "-q", "-c", "feat/one"]);
  writeFileSync(
    join(cwd, "navori.config.json"),
    JSON.stringify({
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      sdd: { enabled: true },
      qualityGate: { full: "true", fast: "true" },
      branchBase: "main",
      prTarget: "main",
    }),
  );
  writeFileSync(join(cwd, ".gitignore"), ".navori/state/\n");
  commit("initial");
  git(["branch", "main"]);
  git(["remote", "add", "origin", cwd]);
  return { cwd, commit, master: (...args) => cliOk(cwd, "master", ...args) };
}

/** Writes source, manual artifact, MASTER and a valid one-delivery `parts.json` into `stage`. */
export function writeDeliveryParts(cwd: string, stage: string): void {
  const source = "RN-1\n";
  writeFileSync(join(cwd, "source.txt"), source);
  writeFileSync(join(cwd, "review.txt"), "Cooperative manual fixture inspection\n");
  writeFileSync(join(stage, "MASTER.md"), "# Reviewed delivery\nRN-1\n");
  const parts: DeliveryParts = {
    version: 2,
    workflow: "deliveries",
    revision: 1,
    digest: "0".repeat(64),
    sources: [
      {
        id: "source",
        path: "source.txt",
        digest: createHash("sha256").update(source).digest("hex"),
        locator: "RN-1",
        requirements: ["RN-1"],
        uiBearing: false,
      },
    ],
    requirements: [{ id: "RN-1", sourceId: "source", disposition: "in-scope", reason: null }],
    design: { ui: "none", reason: "CLI only" },
    deliveries: [
      {
        id: "E1",
        title: "One",
        outcome: "Observed",
        partIds: ["P1"],
        dependsOn: [],
        git: { branch: "feat/one", base: "main", integrationTarget: "main", prTarget: "main" },
      },
    ],
    parts: [
      {
        id: "P1",
        deliveryId: "E1",
        title: "One",
        objective: "Check CLI",
        scope: ["source.txt"],
        outOfScope: [],
        dependsOn: [],
        sourceIds: ["source"],
        requirementIds: ["RN-1"],
        spec: null,
        foundation: false,
        acceptance: [
          {
            id: "A1",
            method: "command",
            description: "Success",
            command: "true",
            expected: "exit 0",
          },
          {
            id: "A2",
            method: "manual",
            description: "Inspect",
            check: "Review fixture",
            artifact: "review.txt",
          },
        ],
        questions: [],
      },
    ],
  };
  parts.digest = contractDigest(parts);
  writeFileSync(join(stage, "parts.json"), JSON.stringify(parts));
}

export interface PresentedDelivery extends DeliveryRepo {
  stage: string;
  /** Identity returned by `delivery-present` for E1. */
  identity: string;
}

/**
 * From `delivery-slice` through `delivery-present` for P1 of E1, driven through the CLI.
 * Cooperative fixture only: it proves lifecycle plumbing, not human attestation.
 */
export function presentFromSlice(repo: DeliveryRepo, stage: string): string {
  const { cwd, commit, master } = repo;
  master("delivery-slice", "--part", "P1");
  const dir = join(cwd, ".navori/state/handoffs");
  const feature = "delivery-delivery-p1";
  const planPath = join(dir, `workplan_${feature}.json`);
  const projection = JSON.parse(readFileSync(planPath, "utf8")) as Workplan;
  const plan: Workplan = {
    ...projection,
    solution: { path: "fixture-design.txt", verdict: "READY" },
    phases: [{ name: "fixture", acceptance: ["A1"] }],
    risks: [{ risk: "drift", rollback: "stop" }],
    progress: { A1: "pendiente" },
  };
  writeFileSync(planPath, JSON.stringify(plan));
  commit("delivery contract");
  const binding = delivery.captureDeliveryCriterion(cwd, plan.source!, "A1", "true");
  const tree = fingerprintTree(cwd, binding);
  if (!tree.ok) throw new Error(tree.reason);
  writeFileSync(
    join(dir, `workplan_${feature}.evidence.jsonl`),
    JSON.stringify({
      ts: new Date().toISOString(),
      feature,
      id: "A1",
      command: "true",
      tree: cwd,
      cwd,
      head: readHead(cwd),
      worktreeTree: tree.tree,
      fp: 2,
      dirty: true,
      deliveryBinding: binding,
    }) + "\n",
  );
  master("delivery-criterion", "--part", "P1", "--criterion", "A1");
  master("delivery-criterion", "--part", "P1", "--criterion", "A2", "--approved-by", "user");
  const proof = part.deliveryPartProof(cwd, "P1");
  const state = JSON.parse(readFileSync(join(stage, "state.json"), "utf8")) as DeliveryState;
  const report = "Disposable cooperative technical report\n";
  writeFileSync(join(dir, "technical-report.txt"), report);
  writeFileSync(
    join(dir, "technical-envelope.json"),
    JSON.stringify({
      kind: "operator-attested-technical-review",
      feature,
      stageSlug: "delivery",
      partId: "P1",
      baselineIdentity: plan.source!.baselineIdentity,
      authorityGeneration: state.authorityGeneration,
      queueIdentity: state.authorization!.identity,
      criteriaIdentity: proof.criteriaIdentity,
      worktreeTree: proof.tree.worktreeTree,
      producerId: "fixture-producer",
      reviewerId: "fixture-reviewer",
      verdict: "APPROVED",
      reportDigest: deliveryDigest(report),
      gate: "true",
      exitCode: 0,
      executionReference: "Disposable fixture command ran; no real project QA or human attestation",
    }),
  );
  cliOk(cwd, "receipt", "sign", "--feature", feature);
  master(
    "delivery-review",
    "--part",
    "P1",
    "--report",
    "technical-report.txt",
    "--envelope",
    "technical-envelope.json",
    "--approved-by",
    "user",
  );
  const presented = JSON.parse(master("delivery-present", "--delivery", "E1")) as {
    identity: string;
  };
  return presented.identity;
}

/** Whole flow in a fresh repo: stage, parts, baseline, queue, slice, review and present. */
export function presentedDeliveryFixture(): PresentedDelivery {
  const repo = initDeliveryRepo();
  repo.master("init", "delivery", "--workflow", "deliveries");
  const stage = join(repo.cwd, "specs/_master/01-delivery");
  repo.master("init");
  writeDeliveryParts(repo.cwd, stage);
  repo.master("delivery-baseline", "--approved-by", "user");
  repo.master("delivery-queue", "--delivery", "E1", "--parts", "P1", "--approved-by", "user");
  return { ...repo, stage, identity: presentFromSlice(repo, stage) };
}
