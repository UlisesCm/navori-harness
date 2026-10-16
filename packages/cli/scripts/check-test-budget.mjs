import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { summarizeReport } from "./bench-tests.mjs";

/**
 * Spec 0054 R2 — the per-file test time budget (`packages/cli/test-budget.json`).
 *
 * `defaultMs` is the budget of every test file; `exceptions[]` raises it for a
 * named file and must say why. With `--report` (a Vitest JSON report or a
 * `bench:tests` summary) it enforces R3: a file over its budget x
 * `NAVORI_TEST_BUDGET_FACTOR` (default 1) fails, naming file, duration and budget.
 *
 * Usage: node scripts/check-test-budget.mjs [--budget <path>] [--report <json>]
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUDGET = resolve(PACKAGE_ROOT, "test-budget.json");

const ExceptionSchema = z
  .object({
    file: z.string().min(1),
    ms: z.number().int().positive(),
    reason: z.string().trim().min(1, "reason must not be empty"),
  })
  .strict();

/** Schema of `test-budget.json`. */
export const TestBudgetSchema = z
  .object({
    defaultMs: z.number().int().positive(),
    exceptions: z.array(ExceptionSchema),
  })
  .strict()
  .superRefine((budget, ctx) => {
    const seen = new Set();
    budget.exceptions.forEach((entry, index) => {
      if (seen.has(entry.file)) {
        ctx.addIssue({
          code: "custom",
          path: ["exceptions", index, "file"],
          message: `duplicate exception for ${entry.file}`,
        });
      }
      seen.add(entry.file);
    });
  });

/**
 * Validates a parsed budget document.
 *
 * @param {unknown} value
 * @returns {{ ok: true, budget: z.infer<typeof TestBudgetSchema> } | { ok: false, errors: string[] }}
 */
export function validateBudget(value) {
  const parsed = TestBudgetSchema.safeParse(value);
  if (parsed.success) return { ok: true, budget: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
  };
}

/**
 * Files over budget. A file's budget is its exception's `ms` or `defaultMs`, times `factor`.
 *
 * @param {z.infer<typeof TestBudgetSchema>} budget
 * @param {{ file: string, ms: number }[]} files
 * @param {number} factor
 * @returns {string[]} one line per violation
 */
export function budgetViolations(budget, files, factor) {
  const exceptions = new Map(budget.exceptions.map((entry) => [entry.file, entry.ms]));
  const violations = [];
  for (const { file, ms } of files) {
    const allowed = (exceptions.get(file) ?? budget.defaultMs) * factor;
    if (ms > allowed) violations.push(`${file}: ${ms} ms exceeds its budget of ${allowed} ms`);
  }
  return violations;
}

/**
 * Per-file timings from either report shape.
 *
 * @param {unknown} report
 * @returns {{ file: string, ms: number }[]}
 */
export function reportFiles(report) {
  if (typeof report === "object" && report !== null && Array.isArray(report.files))
    return report.files;
  return summarizeReport(report, 0, PACKAGE_ROOT).files;
}

/** Parses `NAVORI_TEST_BUDGET_FACTOR`; unset means 1, anything but a positive number throws. */
function parseFactor(raw) {
  if (raw === undefined || raw === "") return 1;
  const factor = Number(raw);
  if (!Number.isFinite(factor) || factor <= 0)
    throw new Error(`NAVORI_TEST_BUDGET_FACTOR must be a positive number, got "${raw}"`);
  return factor;
}

/** @param {string[]} argv */
function main(argv) {
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const budgetPath = resolve(flag("--budget") ?? DEFAULT_BUDGET);
  let result;
  try {
    result = validateBudget(JSON.parse(readFileSync(budgetPath, "utf8")));
  } catch (error) {
    process.stderr.write(`check-test-budget: cannot read ${budgetPath}: ${error.message}\n`);
    return 1;
  }
  if (!result.ok) {
    process.stderr.write(
      `check-test-budget: invalid ${budgetPath}\n${result.errors.map((e) => `  - ${e}`).join("\n")}\n`,
    );
    return 1;
  }
  const reportPath = flag("--report");
  if (reportPath) {
    let violations;
    try {
      const factor = parseFactor(process.env.NAVORI_TEST_BUDGET_FACTOR);
      violations = budgetViolations(
        result.budget,
        reportFiles(JSON.parse(readFileSync(resolve(reportPath), "utf8"))),
        factor,
      );
    } catch (error) {
      process.stderr.write(
        `check-test-budget: cannot use report ${reportPath}: ${error.message}\n`,
      );
      return 1;
    }
    if (violations.length > 0) {
      process.stderr.write(
        `check-test-budget: ${violations.length} file(s) over budget\n${violations.map((v) => `  - ${v}`).join("\n")}\n`,
      );
      return 1;
    }
  }
  process.stdout.write(
    `check-test-budget: ${budgetPath} valid (defaultMs=${result.budget.defaultMs}, ${result.budget.exceptions.length} exceptions)\n`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
