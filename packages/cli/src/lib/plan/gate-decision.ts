/**
 * Gate decision for a workplan with phases (spec 0045 D7, R10, R11).
 *
 * A review round only needs `qualityGate.full` when no later phase still has
 * pending work; otherwise `scoped` forces a commit-only publication, so a
 * wrong `scoped` can over-restrict but never publish without `full`.
 */
import { existsSync, readFileSync } from "node:fs";
import { stateArtifactPath, type StateRoot } from "../primitives/state-root.ts";
import { WorkplanSchema } from "./schema.ts";

export type WorkplanGateReason =
  | "pending-later-work"
  | "no-phases"
  | "unknown-phase"
  | "no-completed-phase"
  | "closing-phase"
  | "unit-complete"
  | "workplan-unreadable";

export interface WorkplanGateDecision {
  gateKind: "scoped" | "full";
  reason: WorkplanGateReason;
  /** The feature the workplan belongs to; null when it could not be read. */
  unit: string | null;
  /** Workplans have phases, not milestones. */
  closingMilestone: null;
  /** Name of the last phase; null when unknown. */
  closingPhase: string | null;
  /** `A<n>` of later phases that are not `cumplido` (why the cycle is commit-only). */
  pendingLater: string[];
}

/**
 * Decides `scoped` or `full` for `phase` (exact name or 1-based index; without
 * it, the last phase whose criteria are all `cumplido`).
 *
 * `scoped` only when phases exist, the reference phase exists and a later phase
 * has an `A<n>` not `cumplido`. Everything else, including an unreadable
 * workplan (`plan` that is not a valid workplan), is `full`.
 */
export function decideWorkplanGate(plan: unknown, phase?: string): WorkplanGateDecision {
  const parsed = WorkplanSchema.safeParse(plan);
  if (!parsed.success) return full("workplan-unreadable", null, null);
  const { feature, phases, progress } = parsed.data;
  if (!phases || phases.length === 0) return full("no-phases", feature, null);
  const closingPhase = phases[phases.length - 1]!.name;
  const done = (id: string): boolean => progress[id] === "cumplido";
  let index: number;
  if (phase === undefined) {
    index = phases.map((p) => p.acceptance.every(done)).lastIndexOf(true);
    if (index < 0) return full("no-completed-phase", feature, closingPhase);
  } else {
    index = phases.findIndex((p, i) => p.name === phase || String(i + 1) === phase);
    if (index < 0) return full("unknown-phase", feature, closingPhase);
  }
  if (index === phases.length - 1) return full("closing-phase", feature, closingPhase);
  const pendingLater = phases
    .slice(index + 1)
    .flatMap((p) => p.acceptance)
    .filter((id) => !done(id));
  if (pendingLater.length === 0) return full("unit-complete", feature, closingPhase);
  return {
    gateKind: "scoped",
    reason: "pending-later-work",
    unit: feature,
    closingMilestone: null,
    closingPhase,
    pendingLater,
  };
}

function full(
  reason: WorkplanGateReason,
  unit: string | null,
  closingPhase: string | null,
): WorkplanGateDecision {
  return { gateKind: "full", reason, unit, closingMilestone: null, closingPhase, pendingLater: [] };
}

/** Reads `workplan_<feature>.json` from `root`; a missing or unparsable file decides `full`. */
export function decideWorkplanGateFromDisk(
  root: StateRoot,
  feature: string,
  phase?: string,
): WorkplanGateDecision {
  try {
    const path = stateArtifactPath(root, `workplan_${feature}.json`);
    if (!existsSync(path)) return full("workplan-unreadable", null, null);
    return decideWorkplanGate(JSON.parse(readFileSync(path, "utf8")) as unknown, phase);
  } catch {
    return full("workplan-unreadable", null, null);
  }
}
