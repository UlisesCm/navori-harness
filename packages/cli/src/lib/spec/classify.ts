/**
 * Spec classification (spec 0044 R4-R7, R14): decides whether a spec ships as
 * one PR (`single`) or one PR per delivery (`split`). Pure: a parsed
 * `tasks.md` and the effective thresholds in, a {@link SpecClassification}
 * out.
 */
import type { DeliveryThresholds } from "../config/schema.ts";
import { allTasks, type ParsedTasks, type TasksFormat } from "./tasks.ts";

export type SpecShape = "single" | "split";

/** A classification warning; `where` names the delivery or file it concerns. */
export interface SpecWarning {
  rule: "merged-deliveries" | "loc-undeclared" | "single-over-threshold" | "legacy-format";
  where: string;
  message: string;
}

/** ERROR / WHY / FIX triple, rendered by the command (R7, R9). */
export interface SpecError {
  rule: string;
  what: string;
  why: string;
  fix: string;
}

export interface ClassifiedMilestone {
  id: string;
  title: string;
  acceptance: string[];
  tasks: { id: string; done: boolean }[];
  /** Last milestone of its PR unit: the structural input of `decideGate` (R25). */
  closesUnit: boolean;
}

export interface ClassifiedDelivery {
  id: string;
  title: string;
  foundation: boolean;
  estimatedLoc: number;
  /** Last delivery of the spec (the one whose PR closes the issue, R19). */
  last: boolean;
  milestones: ClassifiedMilestone[];
}

export interface SpecSignals {
  tasks: number;
  deliveries: number;
  milestones: number;
  estimatedLoc: number;
  /** Every delivery declared `Estimated LOC:`. */
  locDeclared: boolean;
  exceedsTasks: boolean;
  exceedsLoc: boolean;
}

export interface SpecClassification {
  format: TasksFormat;
  shape: SpecShape;
  prCount: number;
  signals: SpecSignals;
  thresholds: DeliveryThresholds & { comparison: "strict-greater" };
  deliveries: ClassifiedDelivery[];
  warnings: SpecWarning[];
  error: SpecError | null;
}

/**
 * Classifies a parsed `tasks.md`.
 *
 * `split` only with >=2 deliveries AND (tasks > splitMinTasks OR estimated
 * LOC > splitMinLoc) — strictly greater (R5). >=2 deliveries under both
 * thresholds is `single` with a `merged-deliveries` warning (R6). More
 * deliveries than `maxPrsPerSpec` sets `error` (R7). A legacy file is one
 * `single` delivery whatever it declares (R14).
 */
export function classifySpec(
  parsed: ParsedTasks,
  thresholds: DeliveryThresholds,
): SpecClassification {
  const legacy = parsed.format === "legacy";
  const warnings: SpecWarning[] = [];
  const taskCount = legacy ? parsed.legacyTaskCount : allTasks(parsed).length;
  const declared = parsed.deliveries.map((d) => d.estimatedLoc);
  const estimatedLoc = declared.reduce<number>((sum, loc) => sum + (loc ?? 0), 0);
  const locDeclared = !legacy && declared.length > 0 && declared.every((loc) => loc !== undefined);
  if (!legacy) {
    for (const delivery of parsed.deliveries) {
      if (delivery.estimatedLoc === undefined) {
        warnings.push({
          rule: "loc-undeclared",
          where: delivery.id,
          message: `${delivery.id} declares no "Estimated LOC:"; counted as 0, so only the task threshold decides`,
        });
      }
    }
  }
  const exceedsTasks = taskCount > thresholds.splitMinTasks;
  const exceedsLoc = estimatedLoc > thresholds.splitMinLoc;
  const deliveryCount = legacy ? 1 : parsed.deliveries.length;

  let shape: SpecShape = "single";
  if (legacy) {
    warnings.push({
      rule: "legacy-format",
      where: "tasks.md",
      message:
        "tasks.md uses the previous format (no E<n> deliveries); treated as one delivery — shape single",
    });
    if (exceedsTasks || exceedsLoc) {
      warnings.push({
        rule: "single-over-threshold",
        where: "tasks.md",
        message: `${taskCount} tasks exceed splitMinTasks=${thresholds.splitMinTasks}; consider splitting the spec into deliveries`,
      });
    }
  } else if (deliveryCount >= 2) {
    if (exceedsTasks || exceedsLoc) {
      shape = "split";
    } else {
      warnings.push({
        rule: "merged-deliveries",
        where: "tasks.md",
        message: `${deliveryCount} deliveries do not exceed splitMinTasks=${thresholds.splitMinTasks} or splitMinLoc=${thresholds.splitMinLoc}; they ship as one PR`,
      });
    }
  }

  const deliveries: ClassifiedDelivery[] = legacy
    ? [
        {
          id: "E1",
          title: "(previous format)",
          foundation: false,
          estimatedLoc: 0,
          last: true,
          milestones: [],
        },
      ]
    : parsed.deliveries.map((delivery, di, all) => ({
        id: delivery.id,
        title: delivery.title,
        foundation: delivery.foundation,
        estimatedLoc: delivery.estimatedLoc ?? 0,
        last: di === all.length - 1,
        milestones: delivery.milestones.map((m, mi) => ({
          id: m.id,
          title: m.title,
          acceptance: m.criteria.map((c) => c.id),
          tasks: m.tasks.map((t) => ({ id: t.id, done: t.done })),
          closesUnit:
            mi === delivery.milestones.length - 1 && (shape === "split" || di === all.length - 1),
        })),
      }));

  let error: SpecError | null = null;
  if (deliveryCount > thresholds.maxPrsPerSpec) {
    error = {
      rule: "too-many-deliveries",
      what: `spec declares ${deliveryCount} deliveries; sdd.deliveries.maxPrsPerSpec is ${thresholds.maxPrsPerSpec}`,
      why: "each delivery ships as its own PR, and a spec beyond the cap is too large to review as one unit",
      fix: "split the spec into several specs of at most maxPrsPerSpec deliveries each, or raise sdd.deliveries.maxPrsPerSpec",
    };
  }

  return {
    format: parsed.format,
    shape,
    prCount: shape === "split" ? deliveryCount : 1,
    signals: {
      tasks: taskCount,
      deliveries: deliveryCount,
      milestones: parsed.deliveries.reduce((n, d) => n + d.milestones.length, 0),
      estimatedLoc,
      locDeclared,
      exceedsTasks,
      exceedsLoc,
    },
    thresholds: { ...thresholds, comparison: "strict-greater" },
    deliveries,
    warnings,
    error,
  };
}

export type GateKind = "scoped" | "full";

/** Why {@link decideGate} chose its kind; `no-spec-flags` is set by callers that never asked. */
export type GateReason =
  | "pending-later-work"
  | "closing-milestone"
  | "unit-complete"
  | "legacy-format"
  | "unknown-milestone"
  | "tasks-unreadable"
  | "no-spec-flags";

export interface GateDecision {
  gateKind: GateKind;
  reason: GateReason;
  /** PR unit of the milestone: the delivery id in `split`, `"spec"` in `single`; null when unknown. */
  unit: string | null;
  /** Last milestone of that unit (the one that needs the full gate); null when unknown. */
  closingMilestone: string | null;
}

/**
 * Decides the gate a review cycle for `milestoneId` needs (spec 0044 R25).
 *
 * `scoped` only when the format is the new one, the milestone exists and at
 * least one task is still unchecked in a LATER milestone of the same PR unit
 * (a delivery in `split`, the whole spec in `single`). Every other case is
 * `full`, so a stale checkbox can only over-gate, never skip the gate.
 */
export function decideGate(
  parsed: ParsedTasks,
  classification: SpecClassification,
  milestoneId: string,
): GateDecision {
  const full = (
    reason: GateReason,
    unit: string | null = null,
    closingMilestone: string | null = null,
  ): GateDecision => ({ gateKind: "full", reason, unit, closingMilestone });
  if (parsed.format === "legacy" || classification.format === "legacy") {
    return full("legacy-format");
  }
  const split = classification.shape === "split";
  const owner = classification.deliveries.find((d) =>
    d.milestones.some((m) => m.id === milestoneId),
  );
  if (!owner) return full("unknown-milestone");
  const unitMilestones = (split ? [owner] : classification.deliveries).flatMap((d) => d.milestones);
  const unit = split ? owner.id : "spec";
  const closing = unitMilestones[unitMilestones.length - 1]?.id ?? null;
  const later = unitMilestones.slice(unitMilestones.findIndex((m) => m.id === milestoneId) + 1);
  if (later.length === 0) return full("closing-milestone", unit, closing);
  if (later.every((m) => m.tasks.every((t) => t.done))) return full("unit-complete", unit, closing);
  return { gateKind: "scoped", reason: "pending-later-work", unit, closingMilestone: closing };
}
