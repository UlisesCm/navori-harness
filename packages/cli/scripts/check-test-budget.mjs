import { globSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
 * Reports are rejected when `success`/`vitestExit` are present and not green, and, when they
 * carry `provenance`, when it is dirty or not the current `git rev-parse HEAD` (`--propose`
 * also rejects mixing reports with and without provenance, or at different heads).
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

/**
 * Why a report cannot be accredited as a passing run: a `success` / `vitestExit` that is
 * present but not green (a crashed or partial run still writes a report).
 *
 * @param {unknown} report
 * @returns {string[]}
 */
export function runProblems(report) {
  if (typeof report !== "object" || report === null) return [];
  const problems = [];
  if ("success" in report && report.success !== true) problems.push("success is not true");
  if ("vitestExit" in report && report.vitestExit !== 0) problems.push(`vitestExit is ${String(report.vitestExit)}`);
  return problems;
}

/**
 * Provenance rules (spec 0055 / #1354). Reports without `provenance` keep the legacy behavior;
 * those carrying it must be clean and measured at `currentHead`. With several reports they must
 * not mix with/without provenance nor differ in head.
 *
 * @param {unknown[]} reports
 * @param {string | null} currentHead `git rev-parse HEAD` of this checkout
 * @param {boolean} [cohort] several reports that must agree (`--propose`)
 * @returns {string[]}
 */
export function provenanceProblems(reports, currentHead, cohort = false) {
  const provenances = reports.map((report) =>
    typeof report === "object" && report !== null && "provenance" in report ? report.provenance : undefined,
  );
  const present = provenances.filter((p) => p !== undefined);
  if (present.length === 0) return [];
  const problems = [];
  if (cohort && present.length !== reports.length) problems.push("reports mix with and without provenance");
  const heads = new Set();
  for (const p of present) {
    const head = typeof p === "object" && p !== null && "head" in p ? p.head : undefined;
    const dirty = typeof p === "object" && p !== null && "dirty" in p ? p.dirty : undefined;
    heads.add(head);
    if (typeof head !== "string") problems.push("provenance without head");
    else if (head !== currentHead) problems.push(`provenance head ${head} is not the current HEAD ${currentHead ?? "(none)"}`);
    if (dirty !== false) problems.push("provenance is dirty or unknown");
  }
  if (cohort && heads.size > 1) problems.push("reports were measured at different heads");
  return [...new Set(problems)];
}

/** `git rev-parse HEAD` of the checkout this script lives in; `null` outside git. */
async function currentHead() {
  const { gitHead } = await import(pathToFileURL(join(PACKAGE_ROOT, "..", "..", "scripts", "js", "bench-provenance.mjs")).href);
  return gitHead(PACKAGE_ROOT);
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
async function main(argv) {
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
      const reports = paths.map((path) => JSON.parse(readFileSync(resolve(path), "utf8")));
      const problems = [
        ...reports.flatMap(runProblems),
        ...provenanceProblems(reports, await currentHead(), true),
      ];
      if (problems.length > 0) throw new Error(problems.join("; "));
      const proposal = proposeBudget(reports, result.budget, files);
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
      const report = JSON.parse(readFileSync(resolve(reportPath), "utf8"));
      const problems = [...runProblems(report), ...provenanceProblems([report], await currentHead())];
      if (problems.length > 0) throw new Error(problems.join("; "));
      violations = budgetViolations(result.budget, reportFiles(report), factor);
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
  process.exitCode = await main(process.argv.slice(2));
}
