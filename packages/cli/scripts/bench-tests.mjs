import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Spec 0054 R1 — `bun run bench:tests`.
 *
 * Runs the full suite with Vitest's JSON reporter and writes
 * `.navori/state/bench/tests-<timestamp>.json` (+ `latest.json`) with the wall
 * clock, per-file durations, the 25 slowest files, `loadavg` and CPU count.
 *
 * Reporter shape, pinned against vitest 5.0.1 (`--reporter=json`):
 *   { startTime, success, numTotalTests, ...,
 *     testResults: [{ name: <absolute path>, startTime, endTime, status,
 *                     assertionResults: [{ fullName, status, duration, ... }] }] }
 * There is NO total duration in the report: the wall clock is measured by this
 * script around the child process. A file's duration is `endTime - startTime`
 * (both epoch ms, `endTime` fractional), which covers import + setup + tests.
 *
 * Extra CLI args are forwarded to vitest (e.g. a file filter). A machine that is
 * not idle makes the numbers meaningless: `loadavg` is recorded so a reader can tell.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const TOP_N = 25;

/**
 * @typedef {{ file: string, ms: number, status: string, tests: number }} FileTiming
 * @typedef {{ wallMs: number, files: FileTiming[], top: FileTiming[], sumFilesMs: number, totalTests: number, totalFiles: number, success: boolean }} BenchSummary
 */

/**
 * Summarizes a Vitest JSON report.
 *
 * @param {unknown} report parsed output of `vitest --reporter=json`
 * @param {number} wallMs wall clock measured around the vitest process
 * @param {string} root directory the file names are made relative to
 * @returns {BenchSummary}
 */
export function summarizeReport(report, wallMs, root) {
  if (typeof report !== "object" || report === null || !Array.isArray(report.testResults)) {
    throw new Error("not a vitest json report: missing testResults[]");
  }
  /** @type {FileTiming[]} */
  const files = report.testResults.map((entry) => {
    const { name, startTime, endTime, status, assertionResults } = entry;
    if (typeof name !== "string" || typeof startTime !== "number" || typeof endTime !== "number") {
      throw new Error("not a vitest json report: testResults[] entry without name/startTime/endTime");
    }
    return {
      file: relative(root, name).split("\\").join("/"),
      ms: Math.round(endTime - startTime),
      status: String(status),
      tests: Array.isArray(assertionResults) ? assertionResults.length : 0,
    };
  });
  files.sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
  return {
    wallMs: Math.round(wallMs),
    files,
    top: files.slice(0, TOP_N),
    sumFilesMs: files.reduce((sum, f) => sum + f.ms, 0),
    totalTests: files.reduce((sum, f) => sum + f.tests, 0),
    totalFiles: files.length,
    success: report.success === true,
  };
}

/**
 * Runs the suite and writes the bench files; returns vitest's exit status.
 * `git-env.mjs` lives outside the package, so it is loaded by computed URL
 * (a static import would pull it under the package's tsconfig rootDir).
 */
async function main() {
  const { withoutRepoGitEnv } = await import(pathToFileURL(join(REPO_ROOT, "scripts", "js", "git-env.mjs")).href);
  const scratch = mkdtempSync(join(tmpdir(), "navori-bench-tests-"));
  const reportPath = join(scratch, "report.json");
  const loadBefore = loadavg();
  const started = Date.now();
  try {
    const run = spawnSync(
      "bun",
      ["x", "vitest", "run", "--reporter=json", `--outputFile=${reportPath}`, ...process.argv.slice(2)],
      { cwd: PACKAGE_ROOT, env: withoutRepoGitEnv(process.env), stdio: ["ignore", "ignore", "inherit"] },
    );
    const wallMs = Date.now() - started;
    if (run.error) {
      process.stderr.write(`bench:tests could not start vitest: ${run.error.message}\n`);
      return 2;
    }
    const summary = summarizeReport(JSON.parse(readFileSync(reportPath, "utf8")), wallMs, PACKAGE_ROOT);
    const result = {
      generatedAt: new Date(started).toISOString(),
      cpus: availableParallelism(),
      loadavgBefore: loadBefore,
      loadavgAfter: loadavg(),
      vitestExit: run.status,
      ...summary,
    };
    const dir = join(REPO_ROOT, ".navori", "state", "bench");
    mkdirSync(dir, { recursive: true });
    const stamped = join(dir, `tests-${result.generatedAt.replace(/[:.]/g, "-")}.json`);
    writeFileSync(stamped, `${JSON.stringify(result, null, 2)}\n`);
    copyFileSync(stamped, join(dir, "latest.json"));
    process.stdout.write(
      `bench:tests wall=${(summary.wallMs / 1000).toFixed(1)}s files=${summary.totalFiles} ` +
        `tests=${summary.totalTests} sumFiles=${(summary.sumFilesMs / 1000).toFixed(1)}s ` +
        `load=${loadBefore.map((n) => n.toFixed(2)).join("/")} cpus=${result.cpus}\n`,
    );
    for (const f of summary.top.slice(0, 5)) process.stdout.write(`  ${(f.ms / 1000).toFixed(1)}s ${f.file}\n`);
    process.stdout.write(`bench:tests wrote ${relative(REPO_ROOT, stamped)}\n`);
    return run.status ?? 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
