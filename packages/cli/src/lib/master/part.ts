import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { readConfig } from "../config/config.ts";
import { writeFileAtomic } from "../primitives/atomic.ts";
import { MasterStateSchema, PartsSchema, type PartState } from "./schema.ts";
import { activeStage, masterDirPath, readMasterIndex } from "./stages.ts";
import { checkWorkplan } from "../plan/check.ts";
import { WorkplanSchema } from "../plan/schema.ts";
import { validateEvidence } from "../plan/evidence.ts";
import { resolveStateRoot, stateArtifactPath } from "../primitives/state-root.ts";
import { checkReceipt, evidenceIdentity } from "../diagnose/receipt.ts";
import { containedFile, deliveryDigest } from "./delivery-checks.ts";
import {
  captureDeliveryCriterion,
  deliveryPartAuthority,
  deliveryProofTree,
  writeDeliveryState,
} from "./delivery.ts";
import {
  DeliveryReviewEnvelopeSchema,
  DeliveryStateSchema,
  type DeliveryState,
} from "./delivery-schema.ts";

export interface PartChange {
  state?: string;
  reason?: string;
  spec?: string;
  issue?: string;
  accept?: string;
  command?: string;
  result?: string;
  approvedBy?: string;
}

/** Record current host provenance or an explicitly attested manual obligation. */
export function recordDeliveryCriterion(
  cwd: string,
  partId: string,
  criterionId: string,
  approvedBy?: string,
): { unchanged: boolean } {
  const context = deliveryPartAuthority(cwd, partId);
  const criterion = context.part.acceptance.find((entry) => entry.id === criterionId);
  if (!criterion) throw new Error("unknown delivery criterion");
  const qualifiedId = `${partId}.${criterionId}`;
  const base = {
    qualifiedId,
    baselineIdentity: context.identity,
    criterionIdentity: deliveryDigest(criterion),
    recordedAt: new Date().toISOString(),
  };
  let proof: NonNullable<DeliveryState["criteria"]>[number]["proof"];
  if (criterion.method === "manual") {
    if (approvedBy !== "user") throw new Error("manual criterion requires --approved-by user");
    const artifact = containedFile(cwd, criterion.artifact);
    if (!artifact) throw new Error("manual review artifact is missing or outside repository");
    proof = {
      kind: "operator-attestation",
      approvedBy: "user",
      artifactDigest: deliveryDigest(readFileSync(artifact, "utf8")),
      tree: deliveryProofTree(cwd, context.stagePath),
      authorityGeneration: context.state.authorityGeneration!,
      queueIdentity: context.state.authorization!.identity,
    };
  } else {
    if (approvedBy !== undefined)
      throw new Error("operator approval cannot replace executable provenance");
    const snapshot = activeStage(
      readMasterIndex(cwd, readConfig(join(cwd, "navori.config.json")).sdd?.specsDir ?? "specs"),
    )!;
    const feature = `delivery-${snapshot.slug}-${partId.toLowerCase()}`;
    const root = resolveStateRoot({ cwd, feature });
    const plan = WorkplanSchema.parse(
      JSON.parse(
        readFileSync(stateArtifactPath(root, `workplan_${feature}.json`), "utf8"),
      ) as unknown,
    );
    if (!plan.source || !checkWorkplan(plan, root.cwd).ok)
      throw new Error("source-backed plan requires current approved planning metadata");
    const id = Object.entries(plan.source.criterionMap).find(
      ([, value]) => value === qualifiedId,
    )?.[0];
    if (!id) throw new Error("qualified criterion is not in the projected plan");
    const binding = captureDeliveryCriterion(root.cwd, plan.source, id, criterion.command);
    const result = validateEvidence({
      root,
      feature,
      id,
      command: criterion.command,
      deliveryBinding: binding,
    });
    if (!result.ok) throw new Error(`current host provenance required: ${result.why}`);
    proof = {
      kind: "recorded",
      feature,
      criterionId: id,
      binding,
      source: plan.source,
      evidence: result.evidence,
    };
  }
  const existing = context.state.criteria?.find((entry) => entry.qualifiedId === qualifiedId);
  const entry = DeliveryStateSchema.shape.criteria.unwrap().element.parse({ ...base, proof });
  if (
    existing &&
    deliveryDigest({ ...existing, recordedAt: "" }) === deliveryDigest({ ...entry, recordedAt: "" })
  )
    return { unchanged: true };
  // Re-read immediately before committing: another writer cannot silently replace authority.
  const current = deliveryPartAuthority(cwd, partId);
  if (deliveryDigest(current.state) !== deliveryDigest(context.state))
    throw new Error("delivery state changed before criterion write");
  if (criterion.method === "manual") {
    const artifact = containedFile(cwd, criterion.artifact);
    if (
      proof.kind !== "operator-attestation" ||
      !artifact ||
      proof.artifactDigest !== deliveryDigest(readFileSync(artifact, "utf8")) ||
      proof.tree.worktreeTree !== deliveryProofTree(cwd, current.stagePath).worktreeTree
    )
      throw new Error("manual proof changed before criterion write");
  } else {
    if (proof.kind !== "recorded") throw new Error("recorded provenance required");
    const root = resolveStateRoot({ cwd, feature: proof.feature });
    const result = validateEvidence({
      root,
      feature: proof.feature,
      id: proof.criterionId,
      command: criterion.command,
      deliveryBinding: proof.binding,
    });
    if (!result.ok || deliveryDigest(result.evidence) !== deliveryDigest(proof.evidence))
      throw new Error("host provenance changed before criterion write");
  }
  current.state.criteria = [
    ...(current.state.criteria ?? []).filter((item) => item.qualifiedId !== qualifiedId),
    entry,
  ];
  writeDeliveryState(cwd, current.stagePath, current.state);
  return { unchanged: false };
}

/** Revalidate every criterion against its original producer identity and current bytes. */
export function deliveryPartProof(
  cwd: string,
  partId: string,
): { criteriaIdentity: string; tree: { head: string; worktreeTree: string } } {
  const context = deliveryPartAuthority(cwd, partId);
  const tree = deliveryProofTree(cwd, context.stagePath);
  const identities: string[] = [];
  for (const criterion of context.part.acceptance) {
    const qualifiedId = `${partId}.${criterion.id}`;
    const record = context.state.criteria?.find((entry) => entry.qualifiedId === qualifiedId);
    if (
      !record ||
      record.baselineIdentity !== context.identity ||
      record.criterionIdentity !== deliveryDigest(criterion)
    )
      throw new Error(`${qualifiedId}: current criterion proof is missing`);
    if (criterion.method === "manual") {
      const artifact = containedFile(cwd, criterion.artifact);
      if (
        record.proof.kind !== "operator-attestation" ||
        record.proof.authorityGeneration !== context.state.authorityGeneration ||
        !artifact ||
        record.proof.artifactDigest !== deliveryDigest(readFileSync(artifact, "utf8")) ||
        record.proof.tree.worktreeTree !== tree.worktreeTree
      )
        throw new Error(`${qualifiedId}: manual attestation is stale`);
    } else {
      if (record.proof.kind !== "recorded")
        throw new Error(`${qualifiedId}: executable provenance required`);
      const root = resolveStateRoot({ cwd, feature: record.proof.feature });
      const plan = WorkplanSchema.parse(
        JSON.parse(
          readFileSync(stateArtifactPath(root, `workplan_${record.proof.feature}.json`), "utf8"),
        ) as unknown,
      );
      if (!plan.source || !checkWorkplan(plan, root.cwd).ok)
        throw new Error("source-backed plan is stale or unapproved");
      const binding = captureDeliveryCriterion(
        root.cwd,
        plan.source,
        record.proof.criterionId,
        criterion.command,
      );
      if (deliveryDigest(binding) !== deliveryDigest(record.proof.binding))
        throw new Error(`${qualifiedId}: producer authority changed`);
      const result = validateEvidence({
        root,
        feature: record.proof.feature,
        id: record.proof.criterionId,
        command: criterion.command,
        deliveryBinding: binding,
      });
      if (!result.ok) throw new Error(`${qualifiedId}: ${result.why}`);
      if (deliveryDigest(result.evidence) !== deliveryDigest(record.proof.evidence))
        throw new Error(`${qualifiedId}: producer run changed; record the new run explicitly`);
    }
    identities.push(deliveryDigest(record));
  }
  return { criteriaIdentity: deliveryDigest(identities), tree };
}

/** Capture a cooperative operator attestation, never claim host-authenticated review or CLI-run QA. */
export function captureDeliveryReview(
  cwd: string,
  partId: string,
  reportName: string,
  envelopeName: string,
  approvedBy: string,
): { identity: string; unchanged: boolean } {
  if (approvedBy !== "user")
    throw new Error("technical review capture requires --approved-by user");
  const snapshot = (): NonNullable<DeliveryState["verifiedParts"]>[number] => {
    const context = deliveryPartAuthority(cwd, partId);
    const proof = deliveryPartProof(cwd, partId);
    const stage = activeStage(
      readMasterIndex(cwd, readConfig(join(cwd, "navori.config.json")).sdd?.specsDir ?? "specs"),
    )!;
    const feature = `delivery-${stage.slug}-${partId.toLowerCase()}`;
    const root = resolveStateRoot({ cwd, feature });
    const reportPath = stateArtifactPath(root, reportName);
    const envelopePath = stateArtifactPath(root, envelopeName);
    const receiptPath = stateArtifactPath(root, "receipt.txt");
    const report = readFileSync(reportPath, "utf8");
    const envelopeBytes = readFileSync(envelopePath, "utf8");
    const envelope = DeliveryReviewEnvelopeSchema.parse(JSON.parse(envelopeBytes) as unknown);
    const config = readConfig(join(cwd, "navori.config.json"));
    const gate = config.qualityGate?.full ?? "";
    const queue = context.state.authorization!;
    if (
      !report.trim() ||
      envelope.feature !== feature ||
      envelope.stageSlug !== stage.slug ||
      envelope.partId !== partId ||
      envelope.baselineIdentity !== context.identity ||
      envelope.authorityGeneration !== context.state.authorityGeneration ||
      envelope.queueIdentity !== queue.identity ||
      envelope.criteriaIdentity !== proof.criteriaIdentity ||
      envelope.worktreeTree !== proof.tree.worktreeTree ||
      envelope.reportDigest !== deliveryDigest(report) ||
      envelope.gate !== gate
    )
      throw new Error("technical review envelope does not bind the current snapshot");
    const receiptBytes = readFileSync(receiptPath, "utf8");
    const receipt = checkReceipt({
      cwd: root.cwd,
      feature,
      target: config.prTarget ?? config.branchBase,
      dir: root.dir,
      gate,
      includeConsumed: false,
    });
    if (
      receipt.exitCode !== 0 ||
      receipt.result.status !== "ok" ||
      !receipt.result.fresh ||
      receipt.result.consumed
    )
      throw new Error("technical capture requires the actual current unconsumed canonical receipt");
    if (
      readFileSync(receiptPath, "utf8") !== receiptBytes ||
      readFileSync(reportPath, "utf8") !== report ||
      readFileSync(envelopePath, "utf8") !== envelopeBytes
    )
      throw new Error("technical artifacts changed during capture");
    const inputs = evidenceIdentity(cwd, gate);
    const reviewDigest = deliveryDigest(report),
      envelopeDigest = deliveryDigest(envelopeBytes),
      receiptDigest = deliveryDigest(receiptBytes);
    const identity = deliveryDigest([
      partId,
      context.identity,
      proof,
      reviewDigest,
      envelopeDigest,
      receiptDigest,
    ]);
    return {
      partId,
      identity,
      baselineIdentity: context.identity,
      ...proof,
      reviewDigest,
      feature,
      verifiedAt: new Date().toISOString(),
      authorityGeneration: envelope.authorityGeneration,
      kind: "operator-attested-technical-review",
      approvedBy: "user",
      producerId: envelope.producerId,
      reviewerId: envelope.reviewerId,
      report,
      envelope: envelopeBytes,
      receipt: receiptBytes,
      receiptDigest,
      envelopeDigest,
      gate,
      gateIdentity: inputs.gate,
      inputsIdentity: inputs.inputs,
    };
  };
  const context = deliveryPartAuthority(cwd, partId);
  const first = snapshot();
  const second = snapshot();
  const current = deliveryPartAuthority(cwd, partId);
  if (
    first.identity !== second.identity ||
    deliveryDigest(context.state) !== deliveryDigest(current.state) ||
    deliveryDigest(deliveryPartProof(cwd, partId)) !==
      deliveryDigest({ criteriaIdentity: second.criteriaIdentity, tree: second.tree })
  )
    throw new Error("technical snapshot changed before state commit");
  if (
    current.state.verifiedParts?.some(
      (entry) => entry.partId === partId && entry.identity === second.identity,
    )
  )
    return { identity: second.identity, unchanged: true };
  current.state.verifiedParts = [
    ...(current.state.verifiedParts ?? []).filter((entry) => entry.partId !== partId),
    second,
  ];
  writeDeliveryState(cwd, current.stagePath, current.state);
  return { identity: second.identity, unchanged: false };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function containedSpec(cwd: string, specsDir: string, input: string): string {
  if (!input.trim() || input !== input.trim() || isAbsolute(input))
    throw new Error("--spec requires a repository-relative path without edge whitespace");
  const root = resolve(cwd, specsDir);
  const path = resolve(cwd, input);
  if (
    path === root ||
    !path.startsWith(`${root}${sep}`) ||
    !existsSync(path) ||
    !statSync(path).isDirectory()
  )
    throw new Error(`--spec must name an existing directory beneath ${specsDir}/`);
  const realRoot = realpathSync(root);
  const real = realpathSync(path);
  if (!real.startsWith(`${realRoot}${sep}`)) throw new Error("--spec resolves outside specsDir");
  return input;
}

function cleanOutsideSpecs(cwd: string, specsDir: string): boolean {
  const output = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  const prefix = `${specsDir.replace(/\\/g, "/").replace(/\/$/, "")}/`;
  const entries = output.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const path = entry.slice(3).replace(/\\/g, "/");
    if (!path.startsWith(prefix)) return false;
    // Rename/copy records include an additional original path.
    if (entry.slice(0, 2).includes("R") || entry.slice(0, 2).includes("C")) {
      const prior = entries[++i];
      if (!prior?.replace(/\\/g, "/").startsWith(prefix)) return false;
    }
  }
  return true;
}

/** Validate every requested mutation before writing parts.json. */
export function changeMasterPart(cwd: string, id: string, change: PartChange): void {
  if (!/^P[1-9]\d*$/.test(id)) throw new Error(`invalid part id: ${id}`);
  const config = readConfig(join(cwd, "navori.config.json"));
  if (!config.harness?.masterPlan)
    throw new Error("harness.masterPlan is disabled; run navori master init");
  const specsDir = config.sdd?.specsDir ?? "specs";
  const stage = activeStage(readMasterIndex(cwd, specsDir));
  if (!stage) throw new Error("no active stage; run navori master init");
  if (stage.workflow === "deliveries")
    throw new Error(`${stage.dir}: deliveries workflow is not supported by legacy part operations`);
  const stagePath = join(masterDirPath(cwd, specsDir), stage.dir);
  const state = MasterStateSchema.parse(
    JSON.parse(readFileSync(join(stagePath, "state.json"), "utf8")) as unknown,
  );
  if (state.phase === "closed") throw new Error("closed stage is read-only");
  const path = join(stagePath, "parts.json");
  const repoRoot = realpathSync(cwd);
  if (
    !realpathSync(stagePath).startsWith(`${repoRoot}${sep}`) ||
    !realpathSync(path).startsWith(`${repoRoot}${sep}`)
  )
    throw new Error("refusing to write parts.json outside repository");
  const document = PartsSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  const part = document.parts.find((item) => item.id === id);
  if (!part) throw new Error(`part ${id} not found`);
  const updated = structuredClone(document);
  const target = updated.parts.find((item) => item.id === id)!;
  if (change.accept !== undefined) {
    if (
      change.state !== undefined ||
      change.reason !== undefined ||
      change.spec !== undefined ||
      change.issue !== undefined
    )
      throw new Error("--accept cannot be combined with other part mutations");
    if (part.state === "descartada" || part.state === "diferida")
      throw new Error(`${id} is ${part.state}`);
    const criterion = target.acceptance.find((item) => item.id === change.accept);
    if (!criterion) throw new Error(`criterion ${id}.${change.accept} not found`);
    const date = new Date().toISOString().slice(0, 10);
    if (criterion.method === "manual") {
      if (
        change.approvedBy !== "user" ||
        change.command !== undefined ||
        change.result !== undefined
      )
        throw new Error("manual acceptance requires only --approved-by user");
      criterion.evidence = { kind: "approval", approvedBy: "user", date };
    } else {
      if (change.approvedBy !== undefined || !change.command?.trim() || !change.result?.trim())
        throw new Error("run acceptance requires --command and --result, without --approved-by");
      if (criterion.method === "test") {
        const file = resolve(cwd, criterion.test.file);
        const repo = realpathSync(cwd);
        if (
          !file.startsWith(`${resolve(cwd)}${sep}`) ||
          !existsSync(file) ||
          !realpathSync(file).startsWith(`${repo}${sep}`) ||
          !change.command.includes(criterion.test.file)
        )
          throw new Error(`test command must reference existing ${criterion.test.file}`);
      } else if (change.command.trim() !== criterion.command.run.trim()) {
        throw new Error(`command must equal declared run: ${criterion.command.run}`);
      }
      if (!cleanOutsideSpecs(cwd, specsDir))
        throw new Error("working tree is dirty outside specsDir; commit tested code first");
      criterion.evidence = {
        kind: "run",
        command: change.command.trim(),
        result: change.result.trim(),
        commit: git(cwd, ["rev-parse", "HEAD"]),
        date,
      };
    }
  } else {
    if (
      change.command !== undefined ||
      change.result !== undefined ||
      change.approvedBy !== undefined
    )
      throw new Error("--command, --result and --approved-by require --accept");
    if (
      change.state === undefined &&
      change.reason === undefined &&
      change.spec === undefined &&
      change.issue === undefined
    )
      throw new Error("part requires a mutation");
    if (change.state !== undefined) {
      if (!["pendiente", "parcial", "hecho", "descartada", "diferida"].includes(change.state))
        throw new Error(`invalid state ${change.state}`);
      if (
        change.reason !== undefined &&
        change.state !== "descartada" &&
        change.state !== "diferida"
      )
        throw new Error("--reason is only valid with --state descartada or diferida");
      target.state = change.state as PartState;
      target.reason =
        change.state === "descartada" || change.state === "diferida"
          ? change.reason?.trim() || null
          : null;
      if ((target.state === "descartada" || target.state === "diferida") && !target.reason)
        throw new Error(`--state ${target.state} requires --reason`);
    } else if (change.reason !== undefined) throw new Error("--reason requires --state");
    if (change.spec !== undefined) target.spec = containedSpec(cwd, specsDir, change.spec);
    if (change.issue !== undefined) {
      if (target.issue !== null) throw new Error(`${id} already has issue ${target.issue}`);
      if (!/^[1-9]\d*$/.test(change.issue) || !Number.isSafeInteger(Number(change.issue)))
        throw new Error("--issue requires a positive integer");
      target.issue = Number(change.issue);
    }
  }
  const parsed = PartsSchema.parse(updated);
  writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
}
