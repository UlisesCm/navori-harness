/** Read-only preparation checks; never infer operator approval from valid files. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readConfig } from "../config/config.ts";
import { DeliveryPartsSchema, type DeliveryParts } from "./delivery-schema.ts";
import { activeStage, masterDirPath, readMasterIndex } from "./stages.ts";

/** A `parts.json` delivery that a spec implements, with its git targets (R22). */
export interface SpecDeliveryRef {
  id: string;
  prTarget: string;
  integrationTarget: string;
}

/**
 * Read-only mapping of a spec to the deliveries of the active master-plan
 * stage (spec 0044 R22). `specPath` is the spec directory, absolute or
 * relative to `cwd`. Returns `null` when the spec is not a part of a stage in
 * deliveries mode (no config/index, no active stage, legacy workflow,
 * unreadable `parts.json`, or no part links the spec). Never touches
 * authority or queues.
 */
export function deliveryIdsForSpec(cwd: string, specPath: string): SpecDeliveryRef[] | null {
  let specsDir = "specs";
  let stage;
  try {
    const configPath = join(cwd, "navori.config.json");
    if (existsSync(configPath)) {
      specsDir = readConfig(configPath).sdd?.specsDir ?? specsDir;
    }
    stage = activeStage(readMasterIndex(cwd, specsDir));
  } catch {
    return null;
  }
  if (!stage || stage.workflow !== "deliveries") return null;
  const partsPath = join(masterDirPath(cwd, specsDir), stage.dir, "parts.json");
  if (!existsSync(partsPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(partsPath, "utf8"));
  } catch {
    return null;
  }
  const parsed = DeliveryPartsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const spec = resolve(cwd, specPath);
  const ids = new Set<string>();
  for (const part of parsed.data.parts) {
    if (part.spec === null) continue;
    const linked = resolve(cwd, part.spec);
    if (linked === spec || linked.startsWith(`${spec}${sep}`)) ids.add(part.deliveryId);
  }
  if (ids.size === 0) return null;
  return parsed.data.deliveries
    .filter((delivery) => ids.has(delivery.id))
    .map((delivery) => ({
      id: delivery.id,
      prTarget: delivery.git.prTarget,
      integrationTarget: delivery.git.integrationTarget,
    }));
}

/** Hash a deterministic JSON identity without logging source content. */
export function deliveryDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Hash normalized contract definitions, excluding their stored digest. */
export function contractDigest(parts: DeliveryParts): string {
  const { digest: _digest, ...definitions } = DeliveryPartsSchema.parse(parts);
  return deliveryDigest(definitions);
}

function duplicates(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

/** Find a dependency back edge, visiting each declared node only once. */
function cycle(
  ids: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): string | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): string | null => {
    if (visiting.has(id)) return id;
    if (visited.has(id)) return null;
    visiting.add(id);
    for (const next of dependencies.get(id) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of ids) {
    const found = visit(id);
    if (found) return found;
  }
  return null;
}

/** Resolve only existing, physically contained source/design files. */
export function containedFile(cwd: string, relative: string): string | null {
  const root = realpathSync(cwd);
  const lexicalRoot = resolve(cwd);
  const target = resolve(cwd, relative);
  if (target === lexicalRoot || !target.startsWith(`${lexicalRoot}${sep}`) || !existsSync(target))
    return null;
  const physical = realpathSync(target);
  return physical.startsWith(`${root}${sep}`) ? target : null;
}

/** Check source bytes, IDs, assignments, coverage and design readiness without writes. */
export function checkDeliveryPreparation(
  cwd: string,
  input: unknown,
): {
  parts: DeliveryParts | null;
  blockers: string[];
  sourceDigest: string | null;
  designDigest: string | null;
  expectedDigest: string | null;
} {
  const parsed = DeliveryPartsSchema.safeParse(input);
  if (!parsed.success)
    return {
      parts: null,
      blockers: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      sourceDigest: null,
      designDigest: null,
      expectedDigest: null,
    };
  const doc = parsed.data;
  const blockers: string[] = [];
  const expectedDigest = contractDigest(doc);
  if (doc.digest !== expectedDigest) blockers.push("contract digest does not match definitions");
  const sources = new Map(doc.sources.map((source) => [source.id, source]));
  const requirements = new Map(doc.requirements.map((req) => [req.id, req]));
  const deliveries = new Map(doc.deliveries.map((delivery) => [delivery.id, delivery]));
  const parts = new Map(doc.parts.map((part) => [part.id, part]));
  for (const [name, ids] of [
    ["source", doc.sources.map((source) => source.id)],
    ["requirement", doc.requirements.map((req) => req.id)],
    ["delivery", doc.deliveries.map((delivery) => delivery.id)],
    ["part", doc.parts.map((part) => part.id)],
  ] as const)
    for (const id of duplicates(ids)) blockers.push(`duplicate ${name} ${id}`);
  for (const id of duplicates(doc.sources.flatMap((source) => source.requirements)))
    blockers.push(`requirement ${id} appears in multiple source declarations`);
  for (const source of doc.sources) {
    for (const id of source.requirements)
      if (requirements.get(id)?.sourceId !== source.id)
        blockers.push(`${source.id}: ${id} has no matching requirement disposition`);
    for (const id of duplicates(source.requirements))
      blockers.push(`${source.id}: duplicate requirement ${id}`);
    const path = containedFile(cwd, source.path);
    if (!path) {
      blockers.push(`${source.id}: source path is missing or outside repo`);
      continue;
    }
    const bytes = readFileSync(path);
    if (createHash("sha256").update(bytes).digest("hex") !== source.digest)
      blockers.push(`${source.id}: source digest changed`);
    const content = bytes.toString("utf8");
    if (!content.includes(source.locator)) blockers.push(`${source.id}: locator not found`);
    for (const id of source.requirements)
      if (!content.includes(id)) blockers.push(`${source.id}: ${id} not found in source`);
  }
  for (const req of doc.requirements) {
    const source = sources.get(req.sourceId);
    if (!source || !source.requirements.includes(req.id))
      blockers.push(`${req.id}: unresolved source`);
    if (req.disposition !== "in-scope" && !req.reason)
      blockers.push(`${req.id}: exclusion/deferral needs reason`);
    if (
      req.disposition === "in-scope" &&
      !doc.parts.some((part) => part.requirementIds.includes(req.id))
    )
      blockers.push(`${req.id}: uncovered`);
  }
  for (const delivery of doc.deliveries) {
    for (const id of duplicates(delivery.partIds))
      blockers.push(`${delivery.id}: duplicate part ${id}`);
    for (const id of delivery.partIds)
      if (parts.get(id)?.deliveryId !== delivery.id)
        blockers.push(`${delivery.id}: invalid assignment ${id}`);
    for (const id of delivery.dependsOn)
      if (!deliveries.has(id)) blockers.push(`${delivery.id}: unknown dependency ${id}`);
  }
  for (const part of doc.parts) {
    for (const item of part.scope)
      if (part.outOfScope.includes(item))
        blockers.push(`${part.id}: scope conflicts with outOfScope: ${item}`);
    for (const item of duplicates(part.scope))
      blockers.push(`${part.id}: duplicate scope: ${item}`);
    if (!deliveries.get(part.deliveryId)?.partIds.includes(part.id))
      blockers.push(`${part.id}: missing reverse assignment`);
    for (const id of part.sourceIds)
      if (!sources.has(id)) blockers.push(`${part.id}: unknown source ${id}`);
    for (const id of part.requirementIds) {
      const requirement = requirements.get(id);
      if (
        !requirement ||
        requirement.disposition !== "in-scope" ||
        !part.sourceIds.includes(requirement.sourceId)
      )
        blockers.push(`${part.id}: invalid requirement ${id}`);
    }
    for (const id of part.dependsOn) {
      const prerequisite = parts.get(id);
      if (!prerequisite) blockers.push(`${part.id}: unknown dependency ${id}`);
      else if (
        prerequisite.deliveryId !== part.deliveryId &&
        !deliveries.get(part.deliveryId)?.dependsOn.includes(prerequisite.deliveryId)
      )
        blockers.push(`${part.id}: dependency ${id} lacks delivery order`);
    }
    for (const id of duplicates(part.acceptance.map((criterion) => criterion.id)))
      blockers.push(`${part.id}: duplicate criterion ${id}`);
    for (const question of part.questions)
      if (question.blocking) blockers.push(`${part.id}: blocking question: ${question.text}`);
      else if (!question.assignedPartId || !parts.has(question.assignedPartId))
        blockers.push(`${part.id}: future question has no valid owner`);
  }
  const partCycle = cycle(
    [...parts.keys()],
    new Map(doc.parts.map((part) => [part.id, part.dependsOn])),
  );
  const deliveryCycle = cycle(
    [...deliveries.keys()],
    new Map(doc.deliveries.map((delivery) => [delivery.id, delivery.dependsOn])),
  );
  if (partCycle) blockers.push(`part dependency cycle at ${partCycle}`);
  if (deliveryCycle) blockers.push(`delivery dependency cycle at ${deliveryCycle}`);
  if (doc.design.ui === "none" && doc.sources.some((source) => source.uiBearing))
    blockers.push("UI-bearing source cannot use ui:none");
  if (doc.design.ui !== "none") {
    for (const key of ["architecture", "flow", "system"] as const)
      if (!containedFile(cwd, doc.design[key]))
        blockers.push(`design ${key} is missing or outside repo`);
    if (doc.design.ui === "new" && !parts.get(doc.design.foundationPartId)?.foundation)
      blockers.push("new UI needs a declared foundation part");
  }
  const design = doc.design;
  const designBytes =
    design.ui === "none"
      ? []
      : (["architecture", "flow", "system"] as const).map((key) => {
          const path = containedFile(cwd, design[key]);
          return [key, path ? createHash("sha256").update(readFileSync(path)).digest("hex") : null];
        });
  return {
    parts: doc,
    blockers,
    sourceDigest: deliveryDigest(doc.sources.map((source) => [source.id, source.digest])),
    designDigest: deliveryDigest([doc.design, designBytes]),
    expectedDigest,
  };
}
