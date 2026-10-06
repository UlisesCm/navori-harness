/** Preparation and explicit, bounded operator decisions for deliveries v2. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { evidenceIdentity } from "../diagnose/receipt.ts";
import { join, relative, sep } from "node:path";
import type { Workplan } from "../plan/schema.ts";
import { fingerprintTree, readHead, type DeliveryEvidenceBinding } from "../plan/evidence.ts";
import { readConfig } from "../config/config.ts";
import { writeFileAtomic } from "../primitives/atomic.ts";
import { checkDeliveryPreparation, containedFile, deliveryDigest } from "./delivery-checks.ts";
import {
  DeliveryReviewEnvelopeSchema,
  DeliveryStateSchema,
  type DeliveryState,
} from "./delivery-schema.ts";
import { activeStage, masterDirPath, readMasterIndex } from "./stages.ts";

/** Read only the physically contained active deliveries stage and its contract. */
function active(cwd: string): {
  stagePath: string;
  stageSlug: string;
  state: DeliveryState;
  input: unknown;
} {
  const config = readConfig(join(cwd, "navori.config.json"));
  const index = readMasterIndex(cwd, config.sdd?.specsDir ?? "specs");
  const stage = index && activeStage(index);
  if (!stage || stage.workflow !== "deliveries") throw new Error("no active deliveries stage");
  const stagePath = join(masterDirPath(cwd, config.sdd?.specsDir ?? "specs"), stage.dir);
  const root = realpathSync(cwd);
  if (!realpathSync(stagePath).startsWith(`${root}${sep}`))
    throw new Error("stage outside repository");
  const statePath = containedFile(cwd, join(stagePath, "state.json"));
  if (!statePath) throw new Error("delivery state is missing or outside repository");
  const partsPath = join(stagePath, "parts.json");
  if (!existsSync(partsPath)) throw new Error("delivery parts.json is missing");
  const safeParts = containedFile(cwd, partsPath);
  if (!safeParts) throw new Error("delivery parts.json outside repository");
  return {
    stagePath,
    stageSlug: stage.slug,
    state: DeliveryStateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")) as unknown),
    input: JSON.parse(readFileSync(safeParts, "utf8")) as unknown,
  };
}

/** Hash only a physically contained operator document; never generate or rewrite it. */
function operatorMasterDigest(cwd: string, stagePath: string): string {
  const masterPath = containedFile(cwd, join(stagePath, "MASTER.md"));
  if (!masterPath) throw new Error("operator MASTER.md is missing or outside repository");
  return createHash("sha256").update(readFileSync(masterPath)).digest("hex");
}

/** Expose checked active context without weakening preparation or containment. */
export function activeDeliverySnapshot(
  cwd: string,
): ReturnType<typeof active> & { masterDigest: string } {
  const context = active(cwd);
  return {
    ...context,
    masterDigest: operatorMasterDigest(cwd, context.stagePath),
  };
}

/**
 * Validate current authority and the full preparation projection ONCE for a source, then
 * bind any number of its criteria. Callers with several criteria per plan reuse the result
 * instead of re-running the projection per criterion.
 */
export function deliveryCriterionCapture(
  cwd: string,
  source: NonNullable<Workplan["source"]>,
): (id: string, command: string) => DeliveryEvidenceBinding {
  deliveryPartAuthority(cwd, source.partId);
  const snapshot = activeDeliverySnapshot(cwd);
  const result = checkDeliveryPreparation(cwd, snapshot.input);
  if (!result.parts || result.blockers.length || !result.sourceDigest || !result.designDigest)
    throw new Error("delivery preparation is not current");
  const baselineIdentity = deliveryDigest([
    result.parts.digest,
    result.sourceDigest,
    result.designDigest,
    snapshot.masterDigest,
  ]);
  const queue = snapshot.state.authorization;
  if (
    snapshot.state.baseline?.identity !== baselineIdentity ||
    source.stageSlug !== snapshot.stageSlug ||
    source.baselineIdentity !== baselineIdentity ||
    source.contractDigest !== result.parts.digest ||
    source.sourceDigest !== result.sourceDigest ||
    source.designDigest !== result.designDigest ||
    source.masterDigest !== snapshot.masterDigest ||
    !queue ||
    queue.baselineIdentity !== baselineIdentity ||
    queue.identity !== source.queueIdentity ||
    queue.deliveryId !== source.deliveryId ||
    !queue.partIds.includes(source.partId) ||
    !queue.generation ||
    queue.generation !== snapshot.state.authorityGeneration ||
    source.authorityGeneration !== queue.generation ||
    queue.identity !== deliveryQueueIdentity(queue)
  )
    throw new Error("delivery authority is absent or stale");
  const part = result.parts.parts.find(
    (entry) => entry.id === source.partId && entry.deliveryId === source.deliveryId,
  );
  const stagePath = relative(realpathSync(cwd), realpathSync(snapshot.stagePath))
    .split(sep)
    .join("/");
  const generation = queue.generation;
  return (id, command) => {
    const qualifiedId = source.criterionMap[id];
    const criterion = part?.acceptance.find((entry) => `${part.id}.${entry.id}` === qualifiedId);
    if (
      !qualifiedId ||
      !criterion ||
      criterion.method === "manual" ||
      criterion.command !== command
    )
      throw new Error("delivery executable criterion is absent or changed");
    return {
      policy: "deliveries-content-v1",
      authorityGeneration: generation,
      stagePath,
      sourceIdentity: deliveryDigest(source),
      baselineIdentity,
      queueIdentity: queue.identity,
      qualifiedId,
      criterionIdentity: deliveryDigest(criterion),
    };
  };
}

/** Bind a recorder entry to current authority and the full qualified definition. */
export function captureDeliveryCriterion(
  cwd: string,
  source: NonNullable<Workplan["source"]>,
  id: string,
  command: string,
): DeliveryEvidenceBinding {
  return deliveryCriterionCapture(cwd, source)(id, command);
}

/** Read-only D2 preparation; reports blockers rather than silently approving. */
export function checkActiveDelivery(
  cwd: string,
): ReturnType<typeof checkDeliveryPreparation> & { masterDigest: string | null } {
  const context = active(cwd);
  const result = checkDeliveryPreparation(cwd, context.input);
  return {
    ...result,
    masterDigest: result.parts ? operatorMasterDigest(cwd, context.stagePath) : null,
  };
}

/** Require valid source and design identities before an authority write. */
/** Read and validate source and design inputs without changing operator files. */
export function preparedDelivery(cwd: string): {
  stagePath: string;
  stageSlug: string;
  state: DeliveryState;
  checked: NonNullable<ReturnType<typeof checkDeliveryPreparation>["parts"]>;
  sourceDigest: string;
  designDigest: string;
  masterDigest: string;
} {
  const context = active(cwd);
  const result = checkDeliveryPreparation(cwd, context.input);
  if (result.blockers.length || !result.parts || !result.sourceDigest || !result.designDigest)
    throw new Error(`deliveries preparation blocked: ${result.blockers.join("; ")}`);
  return {
    stagePath: context.stagePath,
    stageSlug: context.stageSlug,
    state: context.state,
    checked: result.parts,
    sourceDigest: result.sourceDigest,
    designDigest: result.designDigest,
    masterDigest: operatorMasterDigest(cwd, context.stagePath),
  };
}

/** Current four-component authority; stored booleans are never proof of readiness. */
export function deliveryAuthority(
  cwd: string,
): ReturnType<typeof preparedDelivery> & { identity: string } {
  const context = preparedDelivery(cwd);
  const identity = deliveryDigest([
    context.checked.digest,
    context.sourceDigest,
    context.designDigest,
    context.masterDigest,
  ]);
  if (
    context.state.baseline?.identity !== identity ||
    context.state.baseline.contractDigest !== context.checked.digest ||
    context.state.baseline.sourceDigest !== context.sourceDigest ||
    context.state.baseline.designDigest !== context.designDigest ||
    context.state.baseline.masterDigest !== context.masterDigest
  )
    throw new Error("baseline is missing or stale");
  return { ...context, identity };
}

/** Require exact current queue and branch for a criterion mutation. */
export function deliveryPartAuthority(
  cwd: string,
  partId: string,
): ReturnType<typeof deliveryAuthority> & {
  part: ReturnType<typeof preparedDelivery>["checked"]["parts"][number];
} {
  const context = deliveryAuthority(cwd);
  if (context.state.phase === "closed") throw new Error("closed deliveries are immutable");
  const part = context.checked.parts.find((entry) => entry.id === partId);
  const queue = context.state.authorization;
  if (
    !part ||
    !queue ||
    queue.deliveryId !== part.deliveryId ||
    !queue.partIds.includes(partId) ||
    queue.baselineIdentity !== context.identity ||
    !queue.generation ||
    queue.generation !== context.state.authorityGeneration ||
    queue.identity !== deliveryQueueIdentity(queue)
  )
    throw new Error("part is not in the current authorized queue");
  const delivery = context.checked.deliveries.find((entry) => entry.id === part.deliveryId)!;
  assertDeliveryEligibility(cwd, partId);
  const branch = execFileSync("git", ["-c", "core.fsmonitor=false", "branch", "--show-current"], {
    cwd,
    encoding: "utf8",
  }).trim();
  if (branch !== delivery.git.branch)
    throw new Error(`delivery requires branch ${delivery.git.branch}`);
  return { ...context, part };
}

/**
 * Fingerprint the whole worktree, excluding only this stage's own `state.json`
 * and `STATUS.md` (the lifecycle files this tooling rewrites). Any other change
 * (code, MASTER.md, sibling stages, the global receipt) alters the fingerprint.
 */
export function deliveryProofTree(
  cwd: string,
  stagePath: string,
): { head: string; worktreeTree: string } {
  const fingerprint = fingerprintTree(cwd, {
    stagePath: relative(realpathSync(cwd), realpathSync(stagePath)).split(sep).join("/"),
  });
  if (!fingerprint.ok) throw new Error(fingerprint.reason);
  return { head: readHead(cwd), worktreeTree: fingerprint.tree };
}

/** State is the sole durable commit point; callers must recompute authority before calling. */
export function writeDeliveryState(cwd: string, stagePath: string, state: DeliveryState): void {
  const path = containedFile(cwd, join(stagePath, "state.json"));
  if (!path || realpathSync(path) !== join(realpathSync(stagePath), "state.json"))
    throw new Error("delivery state changed before write");
  writeFileAtomic(path, `${JSON.stringify(DeliveryStateSchema.parse(state), null, 2)}\n`);
}

/** Re-read authority inputs right before a write; abort if anything moved since the first read. */
function recheckPrepared(
  cwd: string,
  before: string,
  identity: string,
  operation: string,
): ReturnType<typeof preparedDelivery> {
  const fresh = preparedDelivery(cwd);
  if (
    deliveryDigest(fresh.state) !== before ||
    deliveryDigest([
      fresh.checked.digest,
      fresh.sourceDigest,
      fresh.designDigest,
      fresh.masterDigest,
    ]) !== identity
  )
    throw new Error(`delivery changed before ${operation}`);
  return fresh;
}

/** Record explicit operator review of the exact current source/design contract. */
export function approveDeliveryBaseline(
  cwd: string,
  approvedBy: string,
): { identity: string; unchanged: boolean } {
  if (approvedBy !== "user") throw new Error("baseline requires --approved-by user");
  const { state, checked, sourceDigest, designDigest, masterDigest } = preparedDelivery(cwd);
  const before = deliveryDigest(state);
  if (state.phase === "closed") throw new Error("closed deliveries are immutable");
  const identity = deliveryDigest([checked.digest, sourceDigest, designDigest, masterDigest]);
  if (state.baseline?.identity === identity) return { identity, unchanged: true };
  if (state.authorization)
    throw new Error(
      "changed baseline requires explicit queue revision; existing authorization retained",
    );
  const fresh = recheckPrepared(cwd, before, identity, "baseline approval");
  fresh.state.baseline = {
    identity,
    contractDigest: checked.digest,
    sourceDigest,
    designDigest,
    masterDigest,
    approvedBy: "user",
    approvedAt: new Date().toISOString(),
  };
  writeDeliveryState(cwd, fresh.stagePath, fresh.state);
  return { identity, unchanged: false };
}

/** Authorize only named parts in one delivery; it never attests completion. */
export function authorizeDeliveryQueue(
  cwd: string,
  deliveryId: string,
  partIds: readonly string[],
  approvedBy: string,
  transition: "replacement" | "continuation" = "replacement",
): { identity: string; unchanged: boolean } {
  if (approvedBy !== "user") throw new Error("queue requires --approved-by user");
  const { state, checked, sourceDigest, designDigest, masterDigest } = preparedDelivery(cwd);
  const before = deliveryDigest(state);
  if (state.phase === "closed") throw new Error("closed deliveries are immutable");
  const baselineIdentity = deliveryDigest([
    checked.digest,
    sourceDigest,
    designDigest,
    masterDigest,
  ]);
  if (state.baseline?.identity !== baselineIdentity)
    throw new Error("baseline is missing or stale");
  const delivery = checked.deliveries.find((item) => item.id === deliveryId);
  if (!delivery) throw new Error(`unknown delivery ${deliveryId}`);
  if (
    !partIds.length ||
    new Set(partIds).size !== partIds.length ||
    partIds.some((id) => !delivery.partIds.includes(id))
  )
    throw new Error("queue must contain distinct parts from the named delivery");
  if (transition !== "replacement" && transition !== "continuation")
    throw new Error("invalid authority transition");
  const continuing = transition === "continuation";
  if (
    continuing &&
    (!state.authorityGeneration ||
      !state.authorization?.generation ||
      state.authorization.generation !== state.authorityGeneration ||
      state.authorization.baselineIdentity !== baselineIdentity)
  )
    throw new Error("continuation requires current generation-bearing authority");
  const generation = continuing ? state.authorityGeneration! : (state.authorityGeneration ?? 0) + 1;
  const foundationId = checked.design.ui === "new" ? checked.design.foundationPartId : null;
  // Every part verified here would lose its review when a replacement bumps the generation.
  const verified = new Set<string>();
  for (const prerequisite of delivery.dependsOn) {
    const required = checked.deliveries.find((entry) => entry.id === prerequisite)!;
    for (const id of required.partIds) {
      effectiveDeliveryPart(cwd, id);
      verified.add(id);
    }
  }
  if (
    foundationId &&
    partIds.some((id) => id !== foundationId) &&
    !partIds.includes(foundationId)
  ) {
    try {
      effectiveDeliveryPart(cwd, foundationId);
      verified.add(foundationId);
    } catch {
      throw new Error("product slices await implemented foundation evidence");
    }
  }
  for (const id of partIds) {
    const part = checked.parts.find((item) => item.id === id)!;
    for (const dependency of part.dependsOn)
      if (!partIds.includes(dependency)) {
        effectiveDeliveryPart(cwd, dependency);
        verified.add(dependency);
      }
  }
  if (!continuing && verified.size)
    throw new Error(
      `replacement would invalidate the verified prerequisite parts ${[...verified].join(", ")} ` +
        "and the dependent queue could never dispatch; use --transition continuation",
    );
  const identity = deliveryDigest([baselineIdentity, deliveryId, partIds, generation]);
  if (continuing && state.authorization?.identity === identity)
    return { identity, unchanged: true };
  const fresh = recheckPrepared(cwd, before, baselineIdentity, "queue authorization");
  if (fresh.state.authorization)
    fresh.state.authorizationHistory = [
      ...(fresh.state.authorizationHistory ?? []),
      fresh.state.authorization,
    ];
  fresh.state.authorization = {
    identity,
    baselineIdentity,
    deliveryId,
    partIds: [...partIds],
    approvedBy: "user",
    approvedAt: new Date().toISOString(),
    generation,
    transition,
  };
  fresh.state.authorityGeneration = generation;
  fresh.state.phase = "execution";
  writeDeliveryState(cwd, fresh.stagePath, fresh.state);
  return { identity, unchanged: false };
}

/** Recompute queue identity; legacy records never gain generation implicitly. */
export function deliveryQueueIdentity(queue: NonNullable<DeliveryState["authorization"]>): string {
  return deliveryDigest(
    queue.generation
      ? [queue.baselineIdentity, queue.deliveryId, queue.partIds, queue.generation]
      : [queue.baselineIdentity, queue.deliveryId, queue.partIds],
  );
}

/** Explicit revocation advances authority even when a later queue repeats membership. */
export function revokeDeliveryQueue(cwd: string, approvedBy: string): { generation: number } {
  if (approvedBy !== "user") throw new Error("queue revocation requires --approved-by user");
  const context = active(cwd);
  if (context.state.phase === "closed") throw new Error("closed deliveries are immutable");
  const fresh = active(cwd);
  if (deliveryDigest(fresh.state) !== deliveryDigest(context.state))
    throw new Error("delivery changed before revocation");
  if (fresh.state.authorization)
    fresh.state.authorizationHistory = [
      ...(fresh.state.authorizationHistory ?? []),
      fresh.state.authorization,
    ];
  delete fresh.state.authorization;
  fresh.state.authorityGeneration = (fresh.state.authorityGeneration ?? 0) + 1;
  // No queue is authorized any more: return to the pre-authorization phase.
  fresh.state.phase = "context";
  writeDeliveryState(cwd, fresh.stagePath, fresh.state);
  return { generation: fresh.state.authorityGeneration };
}

/** Completion provenance can resolve retained queues, but never authorizes a new run. */
function proofQueue(
  context: ReturnType<typeof deliveryAuthority>,
  identity: string,
  partId: string,
  generation: number,
): void {
  const queue = [context.state.authorization, ...(context.state.authorizationHistory ?? [])].find(
    (entry) => entry?.identity === identity && entry.generation === generation,
  );
  const part = context.checked.parts.find((entry) => entry.id === partId);
  if (
    !queue ||
    generation !== context.state.authorityGeneration ||
    queue.baselineIdentity !== context.identity ||
    queue.identity !== deliveryQueueIdentity(queue) ||
    !part ||
    queue.deliveryId !== part.deliveryId ||
    !queue.partIds.includes(partId)
  )
    throw new Error("completion provenance is revoked or invalid");
}

/** Revalidate historical operator-attested technical content, not current receipt coverage. */
export function effectiveDeliveryPart(
  cwd: string,
  partId: string,
): NonNullable<DeliveryState["verifiedParts"]>[number] {
  const context = deliveryAuthority(cwd);
  const part = context.checked.parts.find((entry) => entry.id === partId);
  const review = context.state.verifiedParts?.find((entry) => entry.partId === partId);
  if (
    !part ||
    !review ||
    review.baselineIdentity !== context.identity ||
    review.authorityGeneration !== context.state.authorityGeneration
  )
    throw new Error(`${partId}: current technical review is missing`);
  const tree = deliveryProofTree(cwd, context.stagePath);
  const stagePath = relative(realpathSync(cwd), realpathSync(context.stagePath))
    .split(sep)
    .join("/");
  const criteria = part.acceptance.map((criterion) => {
    const record = context.state.criteria?.find(
      (entry) => entry.qualifiedId === `${partId}.${criterion.id}`,
    );
    if (
      !record ||
      record.baselineIdentity !== context.identity ||
      record.criterionIdentity !== deliveryDigest(criterion)
    )
      throw new Error(`${partId}: criterion definition changed`);
    if (record.proof.kind === "recorded") {
      proofQueue(
        context,
        record.proof.binding.queueIdentity,
        partId,
        record.proof.binding.authorityGeneration,
      );
      // The stored evidence must belong to this criterion, feature and stage. `head` and
      // `dirty` are deliberately not compared: `worktreeTree` below already binds the
      // content, and committing identical content legitimately changes both.
      if (criterion.method === "manual" || record.proof.evidence.command !== criterion.command)
        throw new Error(`${partId}: recorded command differs from the criterion command`);
      if (record.proof.feature !== review.feature)
        throw new Error(
          `${partId}: recorded provenance belongs to feature ${record.proof.feature}, not ${review.feature}`,
        );
      if (
        record.proof.binding.stagePath !== stagePath ||
        record.proof.source.stageSlug !== context.stageSlug
      )
        throw new Error(`${partId}: recorded provenance belongs to another stage`);
      if (
        record.proof.binding.policy !== "deliveries-content-v1" ||
        record.proof.binding.baselineIdentity !== context.identity ||
        record.proof.binding.criterionIdentity !== deliveryDigest(criterion) ||
        record.proof.binding.sourceIdentity !== deliveryDigest(record.proof.source) ||
        record.proof.binding.qualifiedId !== record.qualifiedId ||
        record.proof.source.partId !== partId ||
        record.proof.source.deliveryId !== part.deliveryId ||
        record.proof.source.queueIdentity !== record.proof.binding.queueIdentity ||
        record.proof.source.authorityGeneration !== record.proof.binding.authorityGeneration ||
        record.proof.source.criterionMap[record.proof.criterionId] !== record.qualifiedId ||
        record.proof.source.contractDigest !== context.checked.digest ||
        record.proof.source.sourceDigest !== context.sourceDigest ||
        record.proof.source.designDigest !== context.designDigest ||
        record.proof.source.masterDigest !== context.masterDigest ||
        record.proof.evidence.worktreeTree !== tree.worktreeTree
      )
        throw new Error(`${partId}: executable provenance is stale`);
    } else {
      proofQueue(context, record.proof.queueIdentity, partId, record.proof.authorityGeneration);
      const artifact = criterion.method === "manual" && containedFile(cwd, criterion.artifact);
      if (
        !artifact ||
        record.proof.artifactDigest !== deliveryDigest(readFileSync(artifact, "utf8")) ||
        record.proof.tree.worktreeTree !== tree.worktreeTree
      )
        throw new Error(`${partId}: manual proof is stale`);
    }
    return deliveryDigest(record);
  });
  const envelope = DeliveryReviewEnvelopeSchema.parse(JSON.parse(review.envelope) as unknown);
  const config = readConfig(join(cwd, "navori.config.json"));
  const gate = config.qualityGate?.full ?? "";
  const inputs = evidenceIdentity(cwd, gate);
  const proof = { criteriaIdentity: deliveryDigest(criteria), tree: review.tree };
  if (
    tree.worktreeTree !== review.tree.worktreeTree ||
    proof.criteriaIdentity !== review.criteriaIdentity ||
    review.gate !== gate ||
    review.gateIdentity !== inputs.gate ||
    review.inputsIdentity !== inputs.inputs ||
    review.reviewDigest !== deliveryDigest(review.report) ||
    review.envelopeDigest !== deliveryDigest(review.envelope) ||
    review.receiptDigest !== deliveryDigest(review.receipt) ||
    envelope.reportDigest !== review.reviewDigest ||
    envelope.criteriaIdentity !== review.criteriaIdentity ||
    envelope.worktreeTree !== tree.worktreeTree ||
    envelope.baselineIdentity !== context.identity ||
    envelope.authorityGeneration !== context.state.authorityGeneration ||
    envelope.partId !== partId ||
    envelope.feature !== review.feature ||
    envelope.producerId !== review.producerId ||
    envelope.reviewerId !== review.reviewerId ||
    envelope.gate !== review.gate ||
    review.identity !==
      deliveryDigest([
        partId,
        context.identity,
        proof,
        review.reviewDigest,
        review.envelopeDigest,
        review.receiptDigest,
      ])
  )
    throw new Error(`${partId}: technical snapshot is stale`);
  proofQueue(context, envelope.queueIdentity, partId, envelope.authorityGeneration);
  return review;
}

/** Dependency-first eligibility is identical for projection, dispatch and recording. */
export function assertDeliveryEligibility(cwd: string, partId: string): void {
  const context = deliveryAuthority(cwd);
  const part = context.checked.parts.find((entry) => entry.id === partId);
  if (!part) throw new Error("unknown part");
  const delivery = context.checked.deliveries.find((entry) => entry.id === part.deliveryId)!;
  const dependencies = new Set(part.dependsOn);
  for (const id of delivery.dependsOn)
    for (const predecessor of context.checked.deliveries.find((entry) => entry.id === id)!.partIds)
      dependencies.add(predecessor);
  if (context.checked.design.ui === "new" && partId !== context.checked.design.foundationPartId)
    dependencies.add(context.checked.design.foundationPartId);
  for (const id of dependencies) if (id !== partId) effectiveDeliveryPart(cwd, id);
}

/** Current reviewed delivery identity; code changes never restore acceptance implicitly. */
export function reviewedDeliveryIdentity(
  cwd: string,
  deliveryId: string,
): { identity: string; partIdentities: string[]; tree: { head: string; worktreeTree: string } } {
  const context = deliveryAuthority(cwd);
  const delivery = context.checked.deliveries.find((entry) => entry.id === deliveryId);
  if (!delivery) throw new Error("unknown delivery");
  const partIdentities = delivery.partIds.map((id) => effectiveDeliveryPart(cwd, id).identity);
  const tree = deliveryProofTree(cwd, context.stagePath);
  return {
    identity: deliveryDigest([
      context.identity,
      context.state.authorityGeneration,
      deliveryId,
      partIdentities,
      tree.worktreeTree,
    ]),
    partIdentities,
    tree,
  };
}

/** Presentation requires a current technical snapshot, not current coverage of lifecycle bytes. */
export function presentDelivery(
  cwd: string,
  deliveryId: string,
): { identity: string; unchanged: boolean } {
  const context = deliveryAuthority(cwd);
  if (context.state.phase === "closed") throw new Error("closed deliveries are immutable");
  const snapshot = reviewedDeliveryIdentity(cwd, deliveryId);
  const last = context.state.presentations
    ?.filter((entry) => entry.deliveryId === deliveryId)
    .at(-1);
  if (last?.identity === snapshot.identity) return { identity: snapshot.identity, unchanged: true };
  const current = deliveryAuthority(cwd);
  if (
    deliveryDigest(current.state) !== deliveryDigest(context.state) ||
    reviewedDeliveryIdentity(cwd, deliveryId).identity !== snapshot.identity
  )
    throw new Error("delivery changed before presentation");
  current.state.presentations = [
    ...(current.state.presentations ?? []),
    {
      deliveryId,
      ...snapshot,
      baselineIdentity: current.identity,
      authorityGeneration: current.state.authorityGeneration!,
      presentedAt: new Date().toISOString(),
    },
  ];
  current.state.phase = "review";
  writeDeliveryState(cwd, current.stagePath, current.state);
  return { identity: snapshot.identity, unchanged: false };
}

/** Current unimplemented scope identity for explicit reasoned deferral/discard. */
export function deliveryScopeIdentity(cwd: string, deliveryId: string): string {
  const context = deliveryAuthority(cwd);
  const delivery = context.checked.deliveries.find((entry) => entry.id === deliveryId);
  if (!delivery) throw new Error("unknown delivery");
  return deliveryDigest([
    context.identity,
    context.state.authorityGeneration,
    delivery,
    deliveryProofTree(cwd, context.stagePath).worktreeTree,
  ]);
}

/** Explicit, identity-bound operator decision; the tooling does not authenticate the client. */
export function decideDelivery(
  cwd: string,
  deliveryId: string,
  identity: string,
  decision: "accepted" | "declined" | "deferred" | "discarded",
  approvedBy: string,
  reason?: string,
  reference?: string,
): { unchanged: boolean } {
  if (approvedBy !== "user") throw new Error("delivery decision requires --approved-by user");
  if (!["accepted", "declined", "deferred", "discarded"].includes(decision))
    throw new Error("invalid delivery decision");
  if (decision !== "accepted" && !reason?.trim())
    throw new Error("non-acceptance requires a reason");
  const check = (): ReturnType<typeof deliveryAuthority> => {
    const context = deliveryAuthority(cwd);
    if (context.state.phase === "closed") throw new Error("closed deliveries are immutable");
    if (decision === "accepted" || decision === "declined") {
      const latest = context.state.presentations
        ?.filter((entry) => entry.deliveryId === deliveryId)
        .at(-1);
      if (
        !latest ||
        latest.identity !== identity ||
        reviewedDeliveryIdentity(cwd, deliveryId).identity !== identity
      )
        throw new Error("decision requires the exact current presented delivery identity");
    } else if (deliveryScopeIdentity(cwd, deliveryId) !== identity)
      throw new Error("disposition requires the exact current scope identity");
    return context;
  };
  const context = check();
  const last = context.state.decisions?.filter((entry) => entry.deliveryId === deliveryId).at(-1);
  if (
    last?.reviewedIdentity === identity &&
    last.decision === decision &&
    last.reason === reason &&
    last.reference === reference
  )
    return { unchanged: true };
  const current = check();
  if (deliveryDigest(current.state) !== deliveryDigest(context.state))
    throw new Error("delivery changed before decision");
  current.state.decisions = [
    ...(current.state.decisions ?? []),
    {
      kind: "operator-attestation",
      deliveryId,
      reviewedIdentity: identity,
      decision,
      approvedBy: "user",
      ...(reason !== undefined ? { reason } : {}),
      ...(reference !== undefined ? { reference } : {}),
      recordedAt: new Date().toISOString(),
    },
  ];
  writeDeliveryState(cwd, current.stagePath, current.state);
  return { unchanged: false };
}

/** Record only an explicitly attested release/deploy reference; never execute deployment. */
export function publishDelivery(
  cwd: string,
  deliveryId: string,
  identity: string,
  kind: "release" | "deploy",
  reference: string,
  approvedBy: string,
): { unchanged: boolean } {
  if (approvedBy !== "user") throw new Error("publication requires --approved-by user");
  if ((kind !== "release" && kind !== "deploy") || !reference.trim())
    throw new Error("publication requires release|deploy and a nonempty reference");
  const context = deliveryAuthority(cwd);
  if (context.state.phase === "closed") throw new Error("closed deliveries are immutable");
  const decision = context.state.decisions
    ?.filter((entry) => entry.deliveryId === deliveryId)
    .at(-1);
  if (
    decision?.decision !== "accepted" ||
    decision.reviewedIdentity !== identity ||
    reviewedDeliveryIdentity(cwd, deliveryId).identity !== identity
  )
    throw new Error("publication requires the exact accepted current delivery identity");
  if (
    context.state.publications?.some(
      (entry) =>
        entry.deliveryId === deliveryId &&
        entry.reviewedIdentity === identity &&
        entry.kind === kind &&
        entry.reference === reference,
    )
  )
    return { unchanged: true };
  const current = deliveryAuthority(cwd);
  if (
    deliveryDigest(current.state) !== deliveryDigest(context.state) ||
    reviewedDeliveryIdentity(cwd, deliveryId).identity !== identity
  )
    throw new Error("delivery changed before publication");
  current.state.publications = [
    ...(current.state.publications ?? []),
    {
      deliveryId,
      reviewedIdentity: identity,
      kind,
      reference,
      recordedBy: "user",
      recordedAt: new Date().toISOString(),
    },
  ];
  writeDeliveryState(cwd, current.stagePath, current.state);
  return { unchanged: false };
}

/**
 * Derive readiness from exact identities. Publication must be recorded before
 * domain close: closed stages are immutable, so `master close` refuses while
 * `pendingPublication` is non-empty.
 */
export function deliveryLifecycle(cwd: string): {
  blockers: string[];
  pendingPublication: string[];
  deliveries: {
    id: string;
    scopeIdentity: string;
    presentedIdentity: string | null;
    decision: string | null;
    published: boolean;
  }[];
} {
  const context = deliveryAuthority(cwd);
  const blockers: string[] = [],
    pendingPublication: string[] = [];
  const deliveries = context.checked.deliveries.map((delivery) => {
    const scopeIdentity = deliveryScopeIdentity(cwd, delivery.id);
    const lastPresentation = context.state.presentations
      ?.filter((entry) => entry.deliveryId === delivery.id)
      .at(-1);
    let presentedIdentity: string | null = null;
    try {
      const reviewed = reviewedDeliveryIdentity(cwd, delivery.id).identity;
      if (lastPresentation?.identity === reviewed) presentedIdentity = reviewed;
    } catch {
      /* Stale proof never supplies a consent target. */
    }
    const last = context.state.decisions
      ?.filter((entry) => entry.deliveryId === delivery.id)
      .at(-1);
    const settled =
      last &&
      ((last.decision === "accepted" && last.reviewedIdentity === presentedIdentity) ||
        (["deferred", "discarded"].includes(last.decision) &&
          Boolean(last.reason) &&
          last.reviewedIdentity === scopeIdentity));
    if (!settled)
      blockers.push(`${delivery.id}: current acceptance or reasoned disposition pending`);
    const published = Boolean(
      settled &&
      last?.decision === "accepted" &&
      context.state.publications?.some(
        (entry) => entry.deliveryId === delivery.id && entry.reviewedIdentity === presentedIdentity,
      ),
    );
    if (settled && last?.decision === "accepted" && !published)
      pendingPublication.push(delivery.id);
    return {
      id: delivery.id,
      scopeIdentity,
      presentedIdentity,
      decision: settled ? last!.decision : null,
      published,
    };
  });
  return { blockers, pendingPublication, deliveries };
}
