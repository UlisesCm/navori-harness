/** Preparation and explicit, bounded operator decisions for deliveries v2. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { readConfig } from "../config/config.ts";
import { writeFileAtomic } from "../primitives/atomic.ts";
import { checkDeliveryPreparation, containedFile, deliveryDigest } from "./delivery-checks.ts";
import { DeliveryStateSchema, type DeliveryState } from "./delivery-schema.ts";
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
function prepared(cwd: string): {
  stagePath: string;
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
    state: context.state,
    checked: result.parts,
    sourceDigest: result.sourceDigest,
    designDigest: result.designDigest,
    masterDigest: operatorMasterDigest(cwd, context.stagePath),
  };
}

function writeState(cwd: string, stagePath: string, state: DeliveryState): void {
  const path = containedFile(cwd, join(stagePath, "state.json"));
  if (!path) throw new Error("delivery state changed before write");
  writeFileAtomic(path, `${JSON.stringify(DeliveryStateSchema.parse(state), null, 2)}\n`);
}

/** Record explicit operator review of the exact current source/design contract. */
export function approveDeliveryBaseline(
  cwd: string,
  approvedBy: string,
): { identity: string; unchanged: boolean } {
  if (approvedBy !== "user") throw new Error("baseline requires --approved-by user");
  const { stagePath, state, checked, sourceDigest, designDigest, masterDigest } = prepared(cwd);
  const identity = deliveryDigest([checked.digest, sourceDigest, designDigest, masterDigest]);
  if (state.baseline?.identity === identity) return { identity, unchanged: true };
  if (state.authorization)
    throw new Error(
      "changed baseline requires explicit queue revision; existing authorization retained",
    );
  state.baseline = {
    identity,
    contractDigest: checked.digest,
    sourceDigest,
    designDigest,
    masterDigest,
    approvedBy: "user",
    approvedAt: new Date().toISOString(),
  };
  writeState(cwd, stagePath, state);
  return { identity, unchanged: false };
}

/** Authorize only named parts in one delivery; it never attests completion. */
export function authorizeDeliveryQueue(
  cwd: string,
  deliveryId: string,
  partIds: readonly string[],
  approvedBy: string,
): { identity: string; unchanged: boolean } {
  if (approvedBy !== "user") throw new Error("queue requires --approved-by user");
  const { stagePath, state, checked, sourceDigest, designDigest, masterDigest } = prepared(cwd);
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
  if (delivery.dependsOn.length)
    throw new Error("dependent deliveries await verified completion in D3");
  const foundationId = checked.design.ui === "new" ? checked.design.foundationPartId : null;
  if (foundationId && partIds.some((id) => id !== foundationId))
    throw new Error("product slices await implemented foundation evidence");
  for (const id of partIds) {
    const part = checked.parts.find((item) => item.id === id)!;
    if (part.dependsOn.some((dependency) => !partIds.includes(dependency)))
      throw new Error(`${id}: prerequisite is not in authorized queue`);
  }
  const identity = deliveryDigest([baselineIdentity, deliveryId, partIds]);
  if (state.authorization?.identity === identity) return { identity, unchanged: true };
  if (state.authorization)
    state.authorizationHistory = [...(state.authorizationHistory ?? []), state.authorization];
  state.authorization = {
    identity,
    baselineIdentity,
    deliveryId,
    partIds: [...partIds],
    approvedBy: "user",
    approvedAt: new Date().toISOString(),
  };
  state.phase = "execution";
  writeState(cwd, stagePath, state);
  return { identity, unchanged: false };
}
