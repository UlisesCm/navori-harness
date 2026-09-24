/**
 * `navori plan check` — the single validator both `plan check` (CLI) and,
 * later, the reviewer (R21) call. Fails loudly and names each violation
 * instead of guessing at a fix (R15).
 */
import { WorkplanSchema, type Workplan } from "./schema.ts";

export interface CheckFinding {
  /** A stable id for the violated rule, so a caller can filter/count by kind
   * without parsing `message`. */
  rule: string;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  findings: CheckFinding[];
}

function checkStructural(plan: Workplan): CheckFinding[] {
  const findings: CheckFinding[] = [];

  for (const criterion of plan.acceptance) {
    if (!criterion.command.trim()) {
      findings.push({
        rule: "acceptance-command",
        message: `${criterion.id} is missing a command`,
      });
    }
    if (!criterion.expected.trim()) {
      findings.push({
        rule: "acceptance-expected",
        message: `${criterion.id} is missing expected output`,
      });
    }
  }

  const acceptanceIds = new Set(plan.acceptance.map((a) => a.id));
  for (const id of Object.keys(plan.progress)) {
    if (!acceptanceIds.has(id)) {
      findings.push({
        rule: "progress-unknown-id",
        message: `progress references unknown id ${id}`,
      });
    }
  }
  for (const phase of plan.phases ?? []) {
    for (const id of phase.acceptance) {
      if (!acceptanceIds.has(id)) {
        findings.push({
          rule: "phase-unknown-id",
          message: `phase "${phase.name}" references unknown id ${id}`,
        });
      }
    }
  }

  if (plan.level >= 2) {
    if (!plan.solution)
      findings.push({ rule: "level2-solution", message: "level 2 requires a solution section" });
    if (!plan.phases || plan.phases.length === 0) {
      findings.push({ rule: "level2-phases", message: "level 2 requires at least one phase" });
    }
    if (!plan.risks || plan.risks.length === 0) {
      findings.push({
        rule: "level2-risks",
        message: "level 2 requires at least one risk with rollback",
      });
    }
  }

  return findings;
}

/** R15's third rule: the declared level cannot be lower than what `classify`
 * computed when the workplan was created — `classification.level` IS that
 * computed value, embedded at creation time (schema.ts's `Classification`). */
function checkLevel(plan: Workplan): CheckFinding[] {
  if (plan.classification.level > plan.level) {
    return [
      {
        rule: "level-below-classification",
        message: `declared level ${plan.level} is below classify's level ${plan.classification.level}`,
      },
    ];
  }
  return [];
}

/** Validates a raw (unparsed) workplan value against the schema and R15's
 * structural rules. Returns every failure, not just the first, so a single
 * run can drive a full fix. */
export function checkWorkplan(raw: unknown): CheckResult {
  const parsed = WorkplanSchema.safeParse(raw);
  if (!parsed.success) {
    const findings = parsed.error.issues.map((issue) => ({
      rule: "schema",
      message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    }));
    return { ok: false, findings };
  }

  const findings = [...checkStructural(parsed.data), ...checkLevel(parsed.data)];
  return { ok: findings.length === 0, findings };
}

/** One line per finding, for CLI output. */
export function formatCheckResult(result: CheckResult): string {
  if (result.ok) return "OK";
  return result.findings.map((f) => `${f.rule}: ${f.message}`).join("\n");
}
