/** Source-backed, fail-closed projection of an authorized delivery slice. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../config/config.ts";
import { checkWorkplan } from "../plan/check.ts";
import { classify } from "../plan/classify.ts";
import { WorkplanSchema, type Workplan } from "../plan/schema.ts";
import { writeFileAtomic } from "../primitives/atomic.ts";
import {
  ensureStateDirectory,
  resolveStateRoot,
  stateArtifactPath,
} from "../primitives/state-root.ts";
import { checkDeliveryPreparation, deliveryDigest } from "./delivery-checks.ts";
import {
  activeDeliverySnapshot,
  assertDeliveryEligibility,
  deliveryQueueIdentity,
} from "./delivery.ts";
import { writeAcceptanceIndex } from "../plan/acceptance-index.ts";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function branchName(cwd: string): string {
  return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim();
}

/** Calculate the currently authorized projection before any write. */
export function deliverySliceProjection(cwd: string, partId: string): Workplan {
  cwd = resolveStateRoot({ cwd, feature: "delivery-slice", dir: ".navori/state/handoffs" }).cwd;
  const snapshot = activeDeliverySnapshot(cwd);
  const result = checkDeliveryPreparation(cwd, snapshot.input);
  if (!result.parts || result.blockers.length || !result.sourceDigest || !result.designDigest)
    throw new Error(`delivery source invalid: ${result.blockers.join("; ")}`);
  const doc = result.parts;
  const baselineIdentity = deliveryDigest([
    doc.digest,
    result.sourceDigest,
    result.designDigest,
    snapshot.masterDigest,
  ]);
  const baseline = snapshot.state.baseline;
  if (
    baseline?.identity !== baselineIdentity ||
    baseline.contractDigest !== doc.digest ||
    baseline.sourceDigest !== result.sourceDigest ||
    baseline.designDigest !== result.designDigest ||
    baseline.masterDigest !== snapshot.masterDigest
  )
    throw new Error("delivery baseline is absent or stale");
  const part = doc.parts.find((item) => item.id === partId);
  if (!part) throw new Error(`unknown part ${partId}`);
  const delivery = doc.deliveries.find((item) => item.id === part.deliveryId);
  if (!delivery || !delivery.partIds.includes(partId))
    throw new Error("part assignment is invalid");
  const queue = snapshot.state.authorization;
  if (
    !queue ||
    queue.baselineIdentity !== baselineIdentity ||
    queue.deliveryId !== delivery.id ||
    !queue.partIds.includes(partId) ||
    queue.identity !== deliveryQueueIdentity(queue)
  )
    throw new Error("part is not in the current authorized queue");
  if (branchName(cwd) !== delivery.git.branch)
    throw new Error(`delivery requires branch ${delivery.git.branch}`);
  assertDeliveryEligibility(cwd, partId);
  const executable = part.acceptance.filter((criterion) => criterion.method !== "manual");
  if (!executable.length) throw new Error("manual-only part is not an implementer dispatch");
  const criterionMap = Object.fromEntries(
    executable.map((criterion, index) => [`A${index + 1}`, `${part.id}.${criterion.id}`]),
  );
  const config = readConfig(join(cwd, "navori.config.json"));
  const classification = classify({
    files: part.scope,
    // The delivery definition is a shared executable contract. Conservative
    // floor until per-part risk declarations exist; never downgrade it.
    sharedContract: true,
    criticalPaths: config.project?.criticalPaths,
    localSkillIds: config.project?.localSkills,
  });
  const level = Math.max(1, classification.level) as 1 | 2;
  return WorkplanSchema.parse({
    feature: `delivery-${snapshot.stageSlug}-${part.id.toLowerCase()}`,
    level,
    classification: {
      score: classification.score,
      level: classification.level,
      signals: classification.signals,
    },
    objective: part.objective,
    acceptance: executable.map((criterion, index) => ({
      id: `A${index + 1}`,
      description: criterion.description,
      command: criterion.command,
      expected: criterion.expected,
    })),
    outOfScope: part.outOfScope,
    files: part.scope.map((path) => ({ path, new: false })),
    progress: {},
    decisions: [],
    source: {
      kind: "master-delivery",
      stageSlug: snapshot.stageSlug,
      deliveryId: delivery.id,
      partId: part.id,
      baselineIdentity,
      contractDigest: doc.digest,
      sourceDigest: result.sourceDigest,
      designDigest: result.designDigest,
      masterDigest: snapshot.masterDigest,
      queueIdentity: queue.identity,
      ...(queue.generation ? { authorityGeneration: queue.generation } : {}),
      criterionMap,
    },
  });
}

/** Compare source-owned fields; never treat human additions as source authority. */
export function checkDeliveryPlanSource(cwd: string, plan: Workplan): string[] {
  if (!plan.source) return [];
  try {
    const expected = deliverySliceProjection(cwd, plan.source.partId);
    const source = plan.source;
    if (!same(source, expected.source))
      return ["delivery source, baseline or criterion map changed"];
    if (
      plan.feature !== expected.feature ||
      plan.objective !== expected.objective ||
      !same(plan.acceptance, expected.acceptance) ||
      !same(plan.files, expected.files) ||
      !same(plan.outOfScope, expected.outOfScope)
    )
      return ["delivery scope or executable criteria diverged from source"];
    if (
      plan.level < expected.level ||
      plan.classification.level < expected.classification.level ||
      plan.classification.score < expected.classification.score ||
      expected.classification.signals.some(
        (signal) => !plan.classification.signals.includes(signal),
      )
    )
      return ["delivery risk reclassification raises the workplan level"];
    return [];
  } catch (cause: unknown) {
    return [cause instanceof Error ? cause.message : "invalid delivery projection"];
  }
}

/** Write once; replay preserves a human-edited plan and never silently refreshes it. */
export function prepareDeliverySlice(
  cwd: string,
  partId: string,
  refresh = false,
  approvedBy?: string,
): { feature: string; unchanged: boolean } {
  const projection = deliverySliceProjection(cwd, partId);
  const root = resolveStateRoot({
    cwd,
    feature: projection.feature,
    dir: ".navori/state/handoffs",
  });
  const path = stateArtifactPath(root, `workplan_${projection.feature}.json`);
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    const existing: unknown = JSON.parse(raw);
    const parsed = WorkplanSchema.parse(existing);
    if (refresh) {
      if (approvedBy !== "user") throw new Error("projection refresh requires --approved-by user");
      const stripQueue = (source: Workplan["source"]): unknown => {
        if (!source) return null;
        const { queueIdentity: _queue, authorityGeneration: _generation, ...definition } = source;
        return definition;
      };
      if (
        !same(stripQueue(parsed.source), stripQueue(projection.source)) ||
        !same(parsed.files, projection.files) ||
        !same(parsed.acceptance, projection.acceptance) ||
        parsed.objective !== projection.objective ||
        !same(parsed.outOfScope, projection.outOfScope)
      )
        throw new Error(
          "source definitions changed; refresh cannot substitute for source/baseline reapproval",
        );
      // Same source and queue: nothing to reverify, so keep progress, evidence and decisions.
      if (same(parsed.source, projection.source))
        return { feature: projection.feature, unchanged: true };
      const next = WorkplanSchema.parse({
        ...parsed,
        source: projection.source,
        progress: Object.fromEntries(parsed.acceptance.map((entry) => [entry.id, "pendiente"])),
        evidence: {},
        decisions: [
          ...parsed.decisions,
          {
            text: "Explicit reverification projection refresh; normal tier approval is required again.",
            date: new Date().toISOString().slice(0, 10),
          },
        ],
      });
      if (!checkWorkplan(next, root.cwd).ok)
        throw new Error("refreshed projection needs valid human planning metadata");
      // The index is derived from the plan files on disk, so the plan is written first.
      // If the index write fails the previous plan bytes are restored: a retry then sees the
      // old queue identity again and converges instead of finding a no-op over a stale index.
      writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
      try {
        writeAcceptanceIndex(root);
      } catch (cause: unknown) {
        writeFileAtomic(path, raw);
        throw cause;
      }
      return { feature: projection.feature, unchanged: false };
    }
    const sourceProblems = checkDeliveryPlanSource(root.cwd, parsed);
    if (sourceProblems.length)
      throw new Error(
        `existing workplan diverged; manual review required: ${sourceProblems.join("; ")}` +
          " (after a queue change, re-run with --refresh --approved-by user)",
      );
    const validation = checkWorkplan(parsed, root.cwd);
    if (!validation.ok)
      throw new Error(
        `existing workplan requires valid human planning metadata: ${validation.findings.map((finding) => finding.message).join("; ")}`,
      );
    return { feature: projection.feature, unchanged: true };
  }
  ensureStateDirectory(root);
  // No index write: a new plan is not gate-valid until `navori plan` writes the acceptance index.
  writeFileAtomic(path, `${JSON.stringify(projection, null, 2)}\n`);
  return { feature: projection.feature, unchanged: false };
}
