import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Spec 0054 R2 — the per-file test time budget (`packages/cli/test-budget.json`).
 *
 * `defaultMs` is the budget of every test file; `exceptions[]` raises it for a
 * named file and must say why. M1 ships ONLY the schema and the `--report` flag;
 * enforcing the budget against a bench report (R3, factor, CI) lands in T16.
 *
 * Usage: node scripts/check-test-budget.mjs [--budget <path>] [--report <bench json>]
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
        ctx.addIssue({ code: "custom", path: ["exceptions", index, "file"], message: `duplicate exception for ${entry.file}` });
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
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`) };
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
    process.stderr.write(`check-test-budget: invalid ${budgetPath}\n${result.errors.map((e) => `  - ${e}`).join("\n")}\n`);
    return 1;
  }
  const reportPath = flag("--report");
  if (reportPath) {
    try {
      JSON.parse(readFileSync(resolve(reportPath), "utf8"));
    } catch (error) {
      process.stderr.write(`check-test-budget: cannot read report ${reportPath}: ${error.message}\n`);
      return 1;
    }
    // TODO(R3, T16): compare report.files[] with the budget (x NAVORI_TEST_BUDGET_FACTOR) and fail naming file, duration and budget.
  }
  process.stdout.write(`check-test-budget: ${budgetPath} valid (defaultMs=${result.budget.defaultMs}, ${result.budget.exceptions.length} exceptions)\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
