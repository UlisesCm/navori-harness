import { globSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
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
 * Proposal only: --propose <bench1.json> <bench2.json> <bench3.json> [--budget <path>]
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

const BenchSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    workers: z.number().int().positive(),
    loadavgBefore: z.array(z.number().finite().nonnegative()).length(3),
    comparable: z.literal(true),
    success: z.literal(true),
    vitestExit: z.literal(0),
    wallMs: z.number().finite().nonnegative(),
    totalFiles: z.number().int().positive(),
    totalTests: z.number().int().nonnegative(),
    sumFilesMs: z.number().finite().nonnegative(),
    files: z
      .array(
        z.object({
          file: z.string().min(1),
          ms: z.number().finite().nonnegative(),
          status: z.enum(["passed", "skipped", "pending"]),
          tests: z.number().int().nonnegative(),
        }),
      )
      .min(1),
  })
  .superRefine((report, ctx) => {
    if (report.loadavgBefore[0] > report.workers)
      ctx.addIssue({ code: "custom", message: "initial load exceeds workers" });
    if (new Set(report.files.map(({ file }) => file)).size !== report.files.length)
      ctx.addIssue({ code: "custom", message: "duplicate file in bench report" });
    if (
      report.totalFiles !== report.files.length ||
      report.totalTests !== report.files.reduce((sum, file) => sum + file.tests, 0) ||
      report.sumFilesMs !== report.files.reduce((sum, file) => sum + file.ms, 0)
    )
      ctx.addIssue({ code: "custom", message: "bench totals do not match files" });
  });

/**
 * Proposes D10/R30 exceptions from exactly three complete, idle observations.
 * The caller supplies the current Vitest inventory; matching report totals alone
 * cannot distinguish three filtered runs from three full runs. No files are written.
 *
 * @param {unknown[]} reports
 * @param {z.infer<typeof TestBudgetSchema>} budget
 * @param {string[]} expectedFiles current package-relative test inventory under src
 * @returns {z.infer<typeof TestBudgetSchema>}
 */
export function proposeBudget(reports, budget, expectedFiles) {
  const observations = z.array(BenchSchema).length(3).parse(reports);
  if (new Set(observations.map(({ generatedAt }) => generatedAt)).size !== 3)
    throw new Error("proposal requires three distinct observations (generatedAt)");
  if (new Set(observations.map(({ workers }) => workers)).size !== 1)
    throw new Error("proposal requires the same worker count in all observations");
  const inventory = [...new Set(expectedFiles)].sort();
  if (
    inventory.length === 0 ||
    observations.some(
      ({ files }) =>
        files.length !== inventory.length ||
        files
          .map(({ file }) => file)
          .sort()
          .some((file, index) => file !== inventory[index]),
    )
  )
    throw new Error("proposal requires the same complete current test file set in every report");
  const timings = observations.map(({ files }) => new Map(files.map(({ file, ms }) => [file, ms])));
  const exceptions = inventory.flatMap((file) => {
    const samples = timings.map((run) => run.get(file));
    const ms = Math.ceil((Math.max(...samples) * 1.25) / 5000) * 5000;
    if (!Number.isSafeInteger(ms))
      throw new Error(`proposed budget is not a safe integer: ${file}`);
    return ms > budget.defaultMs
      ? [
          {
            file,
            ms,
            reason: `Idle bench observations ${observations.map(({ generatedAt }) => generatedAt).join(", ")}: ${samples.join(", ")} ms; max × 1.25 rounded up to 5 s`,
          },
        ]
      : [];
  });
  return TestBudgetSchema.parse({ defaultMs: budget.defaultMs, exceptions });
}

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
  if (argv.includes("--propose")) {
    try {
      const paths = [];
      for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--budget" && argv[index + 1] && !argv[index + 1].startsWith("--")) index++;
        else if (arg === "--propose" && argv.indexOf(arg) === index) continue;
        else if (arg.startsWith("--")) throw new Error(`invalid proposal argument: ${arg}`);
        else paths.push(arg);
      }
      const files = globSync("src/**/*.test.ts", { cwd: PACKAGE_ROOT }).map((file) =>
        relative(PACKAGE_ROOT, resolve(PACKAGE_ROOT, file)).split("\\").join("/"),
      );
      const proposal = proposeBudget(
        paths.map((path) => JSON.parse(readFileSync(resolve(path), "utf8"))),
        result.budget,
        files,
      );
      process.stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(
        `check-test-budget: cannot propose: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
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
  process.exitCode = main(process.argv.slice(2));
}
