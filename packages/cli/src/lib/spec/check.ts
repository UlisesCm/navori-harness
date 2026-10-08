/**
 * Structural validation of a spec's `tasks.md` (spec 0044 R11-R14). Pure: a
 * parsed file, the thresholds and the `R<n>` ids of `requirements.md` in, a
 * {@link SpecCheck} out. `effect:` and `[observable]` are self-declared, so
 * the check detects the shape of a delivery, not its truth (D2).
 */
import type { DeliveryThresholds } from "../config/schema.ts";
import type { SpecDeliveryRef } from "../master/delivery-checks.ts";
import { classifySpec, type SpecClassification } from "./classify.ts";
import { allTasks, type ParsedTask, type ParsedTasks, type TasksFormat } from "./tasks.ts";

export type FindingSeverity = "error" | "warning";

export type FindingRule =
  | "delivery-without-milestone"
  | "milestone-without-acceptance"
  | "acceptance-malformed"
  | "task-outside-milestone"
  | "task-malformed"
  | "task-duplicated"
  | "duplicate-id"
  | "requirement-uncovered"
  | "unknown-requirement"
  | "requirements-unreadable"
  | "task-without-effect"
  | "delivery-not-vertical"
  | "foundation-not-first"
  | "foundation-without-consumer"
  | "too-many-deliveries"
  | "master-delivery-unmapped"
  | "master-target-mismatch"
  | "legacy-format";

export interface SpecFinding {
  rule: FindingRule;
  severity: FindingSeverity;
  /** The delivery, milestone, task or file the finding concerns. */
  where: string;
  message: string;
  /** 1-based line in `tasks.md`; `undefined` for file-level findings. */
  line?: number;
}

export interface SpecCheck {
  format: TasksFormat;
  /** No `error` finding. */
  ok: boolean;
  findings: SpecFinding[];
  classification: SpecClassification;
}

/** Effects that, alone, never change observable behavior (R12). */
const NON_BEHAVIOR = new Set(["docs", "tests", "schema"]);

/** Deliveries of the master-plan stage this spec belongs to (R22). */
export interface MasterMapping {
  deliveries: readonly SpecDeliveryRef[];
  /** The repo's effective PR target (`prTarget ?? branchBase`). */
  prTarget: string;
}

/**
 * Checks a parsed `tasks.md`. `master` is set only for a spec that is a part
 * of a master-plan stage in deliveries mode (R22): each `E<n>` must then map
 * to a delivery of `parts.json`.
 *
 * `requirementIds` is `undefined` when `requirements.md` could not be read:
 * coverage is then skipped with a warning. A legacy file (R14) yields only
 * `legacy-format` warnings, so it can never fail the check.
 */
export function checkSpec(
  parsed: ParsedTasks,
  thresholds: DeliveryThresholds,
  requirementIds: readonly string[] | undefined,
  master?: MasterMapping | null,
): SpecCheck {
  const classification = classifySpec(parsed, thresholds);
  const findings: SpecFinding[] = [];
  const add = (
    rule: FindingRule,
    severity: FindingSeverity,
    where: string,
    message: string,
    line?: number,
  ): void => {
    findings.push(
      line === undefined
        ? { rule, severity, where, message }
        : { rule, severity, where, message, line },
    );
  };

  if (parsed.format === "legacy") {
    for (const warning of classification.warnings) {
      add("legacy-format", "warning", warning.where, warning.message);
    }
    return { format: parsed.format, ok: true, findings, classification };
  }

  if (classification.error) {
    add("too-many-deliveries", "error", "tasks.md", classification.error.what);
  }
  const verticalSeverity: FindingSeverity = classification.shape === "split" ? "error" : "warning";

  const seen = new Map<string, string>();
  const claim = (id: string, where: string, line: number): void => {
    const first = seen.get(id);
    if (first === undefined) seen.set(id, where);
    else add("duplicate-id", "error", where, `${id} is already declared in ${first}`, line);
  };

  const taskOwner = new Map<string, string>();
  const covered = new Set<string>();
  const countTask = (task: ParsedTask, where: string): void => {
    for (const r of task.requirements) covered.add(r);
    const first = taskOwner.get(task.id);
    if (first === undefined) taskOwner.set(task.id, where);
    else {
      add(
        "task-duplicated",
        "error",
        task.id,
        `${task.id} is declared in ${first} and in ${where}`,
        task.line,
      );
    }
    if (task.effect === undefined) {
      add(
        "task-without-effect",
        "warning",
        task.id,
        task.effectRaw === undefined
          ? `${task.id} declares no "effect:" (behavior, docs, tests or schema)`
          : `${task.id} declares effect "${task.effectRaw}", not one of behavior, docs, tests, schema`,
        task.line,
      );
    }
  };

  parsed.deliveries.forEach((delivery, index) => {
    claim(delivery.id, delivery.id, delivery.line);
    if (master) {
      const mapped = master.deliveries.find((ref) => ref.id === delivery.id);
      if (!mapped) {
        add(
          "master-delivery-unmapped",
          "error",
          delivery.id,
          `${delivery.id} is not a delivery of this part in parts.json (${master.deliveries.map((ref) => ref.id).join(", ")})`,
          delivery.line,
        );
      } else if (mapped.prTarget !== master.prTarget) {
        add(
          "master-target-mismatch",
          "warning",
          delivery.id,
          `${delivery.id} targets ${mapped.prTarget} in parts.json but the repo's prTarget is ${master.prTarget}`,
          delivery.line,
        );
      }
    }
    if (delivery.milestones.length === 0) {
      add(
        "delivery-without-milestone",
        "error",
        delivery.id,
        `${delivery.id} declares no milestone (### M<n>)`,
        delivery.line,
      );
    }
    if (delivery.foundation) {
      if (index !== 0) {
        add(
          "foundation-not-first",
          "error",
          delivery.id,
          `${delivery.id} is marked (foundation) but is not the first delivery`,
          delivery.line,
        );
      }
      if (!delivery.milestones.some((m) => m.consumers.length > 0)) {
        add(
          "foundation-without-consumer",
          "error",
          delivery.id,
          `${delivery.id} is a foundation but none of its milestones has a "- **Consumes:**" line naming a consumer inside the delivery`,
          delivery.line,
        );
      }
    }
    for (const milestone of delivery.milestones) {
      claim(milestone.id, `${delivery.id}/${milestone.id}`, milestone.line);
      if (milestone.criteria.length === 0) {
        add(
          "milestone-without-acceptance",
          "error",
          milestone.id,
          `${milestone.id} declares no acceptance criterion (- **A<n>**)`,
          milestone.line,
        );
      }
      for (const criterion of milestone.criteria) {
        claim(criterion.id, milestone.id, criterion.line);
        const missing = [
          criterion.command === "" ? "a command in backticks" : "",
          criterion.expected === "" ? 'an expected output after "→"' : "",
        ].filter((part) => part !== "");
        if (missing.length > 0) {
          add(
            "acceptance-malformed",
            "error",
            criterion.id,
            `${criterion.id} lacks ${missing.join(" and ")}`,
            criterion.line,
          );
        }
      }
      for (const task of milestone.tasks) countTask(task, milestone.id);
    }

    const tasks = delivery.milestones.flatMap((m) => m.tasks);
    const observable = delivery.milestones.some((m) => m.criteria.some((c) => c.observable));
    if (
      tasks.length > 0 &&
      !observable &&
      tasks.every((t) => t.effect !== undefined && NON_BEHAVIOR.has(t.effect))
    ) {
      add(
        "delivery-not-vertical",
        verticalSeverity,
        delivery.id,
        `${delivery.id} only changes docs, tests or schema and has no [observable] acceptance criterion; it is not a functional delivery`,
        delivery.line,
      );
    }
  });

  for (const task of parsed.orphanTasks) {
    add(
      "task-outside-milestone",
      "error",
      task.id,
      `${task.id} is not inside any milestone (### M<n>)`,
      task.line,
    );
    countTask(task, "no milestone");
  }
  for (const criterion of parsed.orphanCriteria) {
    add(
      "task-outside-milestone",
      "error",
      criterion.id,
      `${criterion.id} is not inside any milestone (### M<n>)`,
      criterion.line,
    );
  }
  for (const item of parsed.malformed) {
    add(
      "task-malformed",
      "error",
      `line ${item.line}`,
      `checkbox item without a "**T<n>**" id: ${item.text.slice(0, 60)}`,
      item.line,
    );
  }

  if (requirementIds === undefined) {
    add(
      "requirements-unreadable",
      "warning",
      "requirements.md",
      "requirements.md could not be read; requirement coverage was not checked",
    );
  } else {
    const known = new Set(requirementIds);
    for (const id of requirementIds) {
      if (!covered.has(id)) {
        add(
          "requirement-uncovered",
          "error",
          id,
          `${id} of requirements.md is not covered by any task`,
        );
      }
    }
    for (const task of allTasks(parsed)) {
      for (const r of task.requirements) {
        if (!known.has(r)) {
          add(
            "unknown-requirement",
            "warning",
            task.id,
            `${task.id} cites ${r}, which requirements.md does not declare`,
            task.line,
          );
        }
      }
    }
  }

  return {
    format: parsed.format,
    ok: !findings.some((f) => f.severity === "error"),
    findings,
    classification,
  };
}
