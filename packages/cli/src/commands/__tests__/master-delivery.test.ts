import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runCommand } from "citty";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { masterCommand } from "../master.ts";
import * as delivery from "../../lib/master/delivery.ts";
import * as part from "../../lib/master/part.ts";
import { DeliveryStateSchema } from "../../lib/master/delivery-schema.ts";
import type { DeliveryParts, DeliveryState } from "../../lib/master/delivery-schema.ts";
import type { Workplan } from "../../lib/plan/schema.ts";
import { contractDigest, deliveryDigest } from "../../lib/master/delivery-checks.ts";
import { fingerprintTree, readHead } from "../../lib/plan/evidence.ts";
import { createCommitHelper, createGitHelper } from "../../lib/master/__tests__/test-utils.ts";

/** Runs the source entry point without inheriting fixture authority or the host's audit session. */
function cli(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
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
    [fileURLToPath(new URL("../../index.ts", import.meta.url)), ...args, "--cwd", cwd],
    { cwd, encoding: "utf8", timeout: 30_000, env },
  );
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`CLI terminated: ${result.signal}`);
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Asserts subprocess success before reading any emitted JSON. */
function cliOk(cwd: string, ...args: string[]): string {
  const result = cli(cwd, ...args);
  expect(result.code, `${args.join(" ")}: ${result.err}`).toBe(0);
  return result.out;
}

// Covers: R15
it("smoke integrated: first stage, close, second stage, conversion and full deliveries lifecycle", (): void => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-integrated-master-")));
  dirs.push(cwd);
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
  const json = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const master = (...args: string[]): string => cliOk(cwd, "master", ...args);
  expect(JSON.parse(master("status", "--json"))).toMatchObject({ stage: null, lastClosed: null });
  master("init", "first");
  master("mode", "template");
  const first = join(cwd, "specs/_master/01-first");
  // Seed authored plan output; transitions and dispositions still use the real CLI.
  writeFileSync(
    join(first, "parts.json"),
    JSON.stringify({
      version: 1,
      parts: [
        {
          id: "P1",
          title: "One",
          objective: "Review",
          scope: [],
          outOfScope: [],
          dependsOn: [],
          seedRequirements: [],
          inheritedFrom: null,
          state: "pendiente",
          reason: null,
          spec: null,
          issue: null,
          acceptance: [
            {
              id: "A1",
              description: "Inspect",
              method: "manual",
              manual: { check: "Inspect", how: "Read" },
              evidence: null,
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    join(first, "state.json"),
    JSON.stringify({ ...json(join(first, "state.json")), phase: "executing" }),
  );
  commit("first plan");
  master("part", "P1", "--accept", "A1", "--approved-by", "user");
  master("part", "P1", "--state", "hecho");
  expect(JSON.parse(master("status", "--json"))).toMatchObject({ closable: true });
  master("close");
  expect(json(join(first, "state.json"))).toMatchObject({ outcome: "entregada" });
  master("init", "second");
  const second = join(cwd, "specs/_master/02-second");
  expect(json(join(second, "state.json"))).toMatchObject({ mode: "en-curso" });
  expect(cli(cwd, "master", "mode", "template").code).toBe(1);
  master("close", "--convert", "specs/converted", "--reason", "Single delivery");
  expect(json(join(second, "state.json"))).toMatchObject({ outcome: "convertida" });
  expect(JSON.parse(master("status", "--json"))).toMatchObject({
    stage: null,
  });
  master("init", "delivery", "--workflow", "deliveries");
  const stage = join(cwd, "specs/_master/03-delivery");
  master("init");
  expect(JSON.parse(master("status", "--json"))).toMatchObject({
    workflow: "deliveries",
    closable: false,
  });
  const statePath = join(stage, "state.json");
  const before = readFileSync(statePath, "utf8");
  expect(cli(cwd, "master", "advance").code).toBe(1);
  expect(readFileSync(statePath, "utf8")).toBe(before);
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
  expect(JSON.parse(master("delivery-check"))).toMatchObject({ ready: true });
  expect(cli(cwd, "master", "delivery-baseline").code).toBe(1);
  master("delivery-baseline", "--approved-by", "user");
  expect(cli(cwd, "master", "delivery-queue", "--delivery", "E1", "--parts", "P1").code).toBe(1);
  master("delivery-queue", "--delivery", "E1", "--parts", "P1", "--approved-by", "user");
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
  // Cooperative host/review artifacts are disposable inputs, never authentication claims.
  const run = spawnSync("true", [], { cwd });
  expect(run.status).toBe(0);
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
      dirty: true,
      deliveryBinding: binding,
    }) + "\n",
  );
  master("delivery-criterion", "--part", "P1", "--criterion", "A1");
  master("delivery-criterion", "--part", "P1", "--criterion", "A2", "--approved-by", "user");
  const proof = part.deliveryPartProof(cwd, "P1");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as DeliveryState;
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
  master(
    "delivery-decision",
    "--delivery",
    "E1",
    "--identity",
    presented.identity,
    "--decision",
    "accepted",
    "--approved-by",
    "user",
  );
  expect(cli(cwd, "master", "close").code).toBe(1);
  master(
    "delivery-publication",
    "--delivery",
    "E1",
    "--identity",
    presented.identity,
    "--kind",
    "release",
    "--reference",
    "fixture-v1",
    "--approved-by",
    "user",
  );
  expect(JSON.parse(master("status", "--json"))).toMatchObject({ closable: true });
  master("close");
  expect(json(statePath)).toMatchObject({ phase: "closed" });
  expect(JSON.parse(master("status", "--json"))).toMatchObject({
    stage: null,
    lastClosed: { slug: "delivery", state: "cerrada" },
  });
}, 120_000);

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function invoke(
  cwd: string,
  ...args: string[]
): Promise<{ code: number | undefined; output: string }> {
  const oldCode = process.exitCode;
  const oldErr = process.stderr.write;
  let output = "";
  process.exitCode = undefined;
  process.stderr.write = ((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    await runCommand(masterCommand, { rawArgs: [...args, "--cwd", cwd] });
    return { code: process.exitCode, output };
  } finally {
    process.exitCode = oldCode;
    process.stderr.write = oldErr;
  }
}

describe("delivery CLI", () => {
  const identity = "a".repeat(64);
  const decisionSchema = DeliveryStateSchema.shape.decisions.unwrap().element;

  /** Adapter-only fixture: validates persisted schema, not human/reviewer attestation. */
  function mockDecisionPersistence(): MockInstance<typeof delivery.decideDelivery> {
    let previous = "";
    return vi
      .spyOn(delivery, "decideDelivery")
      .mockImplementation(
        (_cwd, deliveryId, reviewedIdentity, decision, approvedBy, reason, reference) => {
          const record = decisionSchema.parse({
            kind: "operator-attestation",
            deliveryId,
            reviewedIdentity,
            decision,
            approvedBy,
            ...(reason !== undefined ? { reason } : {}),
            ...(reference !== undefined ? { reference } : {}),
            recordedAt: "2026-10-04T00:00:00.000Z",
          });
          const current = JSON.stringify(record);
          const unchanged = previous === current;
          previous = current;
          return { unchanged };
        },
      );
  }

  it.each(
    (["accepted", "declined", "deferred", "discarded"] as const).flatMap((decision) =>
      [undefined, "client-record-42"].map((reference) => ({ decision, reference })),
    ),
  )(
    "preserves reference $reference for $decision and fixture replay",
    async ({ decision, reference }) => {
      const persistence = mockDecisionPersistence();
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const args = [
        "delivery-decision",
        "--delivery",
        "E1",
        "--identity",
        identity,
        "--decision",
        decision,
        "--approved-by",
        "user",
        ...(reference === undefined ? [] : ["--reference", reference]),
        ...(decision === "accepted" ? [] : ["--reason", "Client fixture reason"]),
      ];
      expect((await invoke(tmpdir(), ...args)).code).toBeUndefined();
      expect(persistence).toHaveBeenLastCalledWith(
        tmpdir(),
        "E1",
        identity,
        decision,
        "user",
        decision === "accepted" ? undefined : "Client fixture reason",
        reference,
      );
      expect(stdout).toHaveBeenLastCalledWith('{"unchanged":false}\n');
      expect((await invoke(tmpdir(), ...args)).code).toBeUndefined();
      expect(stdout).toHaveBeenLastCalledWith('{"unchanged":true}\n');
    },
  );

  it("keeps explicit empty references invalid under the real strict schema", async () => {
    mockDecisionPersistence();
    const result = await invoke(
      tmpdir(),
      "delivery-decision",
      "--delivery",
      "E1",
      "--identity",
      identity,
      "--decision",
      "accepted",
      "--approved-by",
      "user",
      "--reference",
      "",
    );
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/reference/);
  });

  it("does not infer operator consent when approved-by is omitted", async () => {
    const result = await invoke(
      tmpdir(),
      "delivery-decision",
      "--delivery",
      "E1",
      "--identity",
      identity,
      "--decision",
      "accepted",
    );
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/requires --approved-by user/);
  });

  describe("operator mutation adapters", () => {
    const quietStdout = (): MockInstance<typeof process.stdout.write> =>
      vi.spyOn(process.stdout, "write").mockReturnValue(true);

    it("passes delivery-revoke consent through and refuses it when omitted", async () => {
      const revoke = vi.spyOn(delivery, "revokeDeliveryQueue").mockReturnValue({ generation: 3 });
      const stdout = quietStdout();
      expect(
        (await invoke(tmpdir(), "delivery-revoke", "--approved-by", "user")).code,
      ).toBeUndefined();
      expect(revoke).toHaveBeenLastCalledWith(tmpdir(), "user");
      expect(stdout).toHaveBeenLastCalledWith('{"generation":3}\n');
      vi.restoreAllMocks();
      const refused = await invoke(tmpdir(), "delivery-revoke");
      expect(refused.code).toBe(1);
      expect(refused.output).toMatch(/requires --approved-by user/);
    });

    it("passes delivery-review artifacts and consent to the technical capture", async () => {
      const capture = vi
        .spyOn(part, "captureDeliveryReview")
        .mockReturnValue({ identity, unchanged: false });
      const stdout = quietStdout();
      const args = ["delivery-review", "--part", "P1", "--report", "r.txt", "--envelope", "e.json"];
      expect((await invoke(tmpdir(), ...args, "--approved-by", "user")).code).toBeUndefined();
      expect(capture).toHaveBeenLastCalledWith(tmpdir(), "P1", "r.txt", "e.json", "user");
      expect(stdout).toHaveBeenLastCalledWith(`{"identity":"${identity}","unchanged":false}\n`);
      vi.restoreAllMocks();
      const refused = await invoke(tmpdir(), ...args);
      expect(refused.code).toBe(1);
      expect(refused.output).toMatch(/requires --approved-by user/);
    });

    it("passes delivery-present the delivery id only", async () => {
      const present = vi
        .spyOn(delivery, "presentDelivery")
        .mockReturnValue({ identity, unchanged: false });
      const stdout = quietStdout();
      expect((await invoke(tmpdir(), "delivery-present", "--delivery", "E1")).code).toBeUndefined();
      expect(present).toHaveBeenLastCalledWith(tmpdir(), "E1");
      expect(stdout).toHaveBeenLastCalledWith(`{"identity":"${identity}","unchanged":false}\n`);
    });

    it("passes delivery-criterion approval only when the operator supplies it", async () => {
      const record = vi
        .spyOn(part, "recordDeliveryCriterion")
        .mockReturnValue({ unchanged: false });
      quietStdout();
      const args = ["delivery-criterion", "--part", "P1", "--criterion", "A1"];
      expect((await invoke(tmpdir(), ...args)).code).toBeUndefined();
      expect(record).toHaveBeenLastCalledWith(tmpdir(), "P1", "A1", undefined);
      expect((await invoke(tmpdir(), ...args, "--approved-by", "user")).code).toBeUndefined();
      expect(record).toHaveBeenLastCalledWith(tmpdir(), "P1", "A1", "user");
    });

    it("passes delivery-publication its attested reference and rejects a merge kind", async () => {
      const publish = vi.spyOn(delivery, "publishDelivery").mockReturnValue({ unchanged: false });
      const stdout = quietStdout();
      const args = ["delivery-publication", "--delivery", "E1", "--identity", identity];
      const approved = ["--reference", "v1.2.0", "--approved-by", "user"];
      expect(
        (await invoke(tmpdir(), ...args, "--kind", "deploy", ...approved)).code,
      ).toBeUndefined();
      expect(publish).toHaveBeenLastCalledWith(
        tmpdir(),
        "E1",
        identity,
        "deploy",
        "v1.2.0",
        "user",
      );
      expect(stdout).toHaveBeenLastCalledWith('{"unchanged":false}\n');
      publish.mockClear();
      const merge = await invoke(tmpdir(), ...args, "--kind", "merge", ...approved);
      expect(merge.code).toBe(1);
      expect(merge.output).toMatch(/publication kind must be release or deploy/);
      expect(publish).not.toHaveBeenCalled();
    });

    it("rejects an unknown delivery-queue transition before any authorization", async () => {
      const authorize = vi
        .spyOn(delivery, "authorizeDeliveryQueue")
        .mockReturnValue({ identity, unchanged: false });
      quietStdout();
      const args = [
        "delivery-queue",
        "--delivery",
        "E1",
        "--parts",
        "P1,P2",
        "--approved-by",
        "user",
      ];
      const invalid = await invoke(tmpdir(), ...args, "--transition", "swap");
      expect(invalid.code).toBe(1);
      expect(invalid.output).toMatch(/invalid authority transition/);
      expect(authorize).not.toHaveBeenCalled();
      expect(
        (await invoke(tmpdir(), ...args, "--transition", "continuation")).code,
      ).toBeUndefined();
      expect(authorize).toHaveBeenLastCalledWith(
        tmpdir(),
        "E1",
        ["P1", "P2"],
        "user",
        "continuation",
      );
    });
  });

  it("does not turn a general implementation request into baseline or queue authority", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-d2-cli-"));
    dirs.push(cwd);
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        sdd: { enabled: true },
      }),
    );
    expect((await invoke(cwd, "delivery-baseline")).code).toBe(1);
    expect((await invoke(cwd, "delivery-queue", "--delivery", "E1", "--parts", "P1")).code).toBe(1);
    expect((await invoke(cwd, "delivery-check")).output).toMatch(/no active deliveries stage/);
  });
});
