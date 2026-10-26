import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Spec 0054 R1 — `bun run bench:tests`.
 *
 * Runs the full suite with Vitest's JSON reporter and writes
 * `.navori/state/bench/tests-<timestamp>.json` (+ `latest.json`) with the wall
 * clock, per-file durations, the 25 slowest files, `loadavg` and CPU count.
 * Spec 0055 adds `files[].spawns` / `sumSpawns` (direct child processes per file, counted
 * by `vitest.setup.ts` through NAVORI_BENCH_PROC_DIR), `workers` and `comparable`
 * (`loadavgBefore[0] <= workers`; D10).
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
 * @typedef {{ file: string, ms: number, status: string, tests: number, spawns: number }} FileTiming
 * @typedef {{ wallMs: number, files: FileTiming[], top: FileTiming[], sumFilesMs: number, sumSpawns: number, totalTests: number, totalFiles: number, success: boolean }} BenchSummary
 */

/**
 * Spec 0055 R2/D10 — a run is comparable when the 1-minute load average at the START
 * does not exceed the worker count. The final load is recorded but never judged: it
 * includes the suite itself (workers plus thousands of children).
 *
 * @param {number[]} loadavgBefore `os.loadavg()` taken before vitest started
 * @param {number} workers number of vitest forks
 * @returns {boolean}
 */
export function isComparable(loadavgBefore, workers) {
  return (loadavgBefore[0] ?? Number.POSITIVE_INFINITY) <= workers;
}

/**
 * Reads the `{ file, spawns }` records the vitest setup wrote (`NAVORI_BENCH_PROC_DIR`).
 * A file that ran twice (retry) keeps its largest count.
 *
 * @param {string} dir
 * @returns {Record<string, number>} package-relative file name to child processes spawned
 */
export function readSpawnCounts(dir) {
  /** @type {Record<string, number>} */
  const counts = {};
  if (!existsSync(dir)) return counts;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (typeof record?.file !== "string" || typeof record.spawns !== "number") continue;
    counts[record.file] = Math.max(counts[record.file] ?? 0, record.spawns);
  }
  return counts;
}

/**
 * Summarizes a Vitest JSON report.
 *
 * @param {unknown} report parsed output of `vitest --reporter=json`
 * @param {number} wallMs wall clock measured around the vitest process
 * @param {string} root directory the file names are made relative to
 * @param {Record<string, number>} [spawnsByFile] child processes per package-relative file ({@link readSpawnCounts})
 * @returns {BenchSummary}
 */
export function summarizeReport(report, wallMs, root, spawnsByFile = {}) {
  if (typeof report !== "object" || report === null || !Array.isArray(report.testResults)) {
    throw new Error("not a vitest json report: missing testResults[]");
  }
  /** @type {FileTiming[]} */
  const files = report.testResults.map((entry) => {
    const { name, startTime, endTime, status, assertionResults } = entry;
    if (typeof name !== "string" || typeof startTime !== "number" || typeof endTime !== "number") {
      throw new Error("not a vitest json report: testResults[] entry without name/startTime/endTime");
    }
    const file = relative(root, name).split("\\").join("/");
    return {
      file,
      ms: Math.round(endTime - startTime),
      status: String(status),
      tests: Array.isArray(assertionResults) ? assertionResults.length : 0,
      spawns: spawnsByFile[file] ?? 0,
    };
  });
  files.sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
  return {
    wallMs: Math.round(wallMs),
    files,
    top: files.slice(0, TOP_N),
    sumFilesMs: files.reduce((sum, f) => sum + f.ms, 0),
    sumSpawns: files.reduce((sum, f) => sum + f.spawns, 0),
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
  const { readProvenance } = await import(pathToFileURL(join(REPO_ROOT, "scripts", "js", "bench-provenance.mjs")).href);
  const provenance = readProvenance(REPO_ROOT);
  const scratch = mkdtempSync(join(tmpdir(), "navori-bench-tests-"));
  const reportPath = join(scratch, "report.json");
  const procDir = join(scratch, "procs");
  const { resolveMaxWorkers } = await import(pathToFileURL(join(PACKAGE_ROOT, "vitest.workers.ts")).href);
  const workers = resolveMaxWorkers();
  const loadBefore = loadavg();
  const started = Date.now();
  try {
    const run = spawnSync(
      "bun",
      ["x", "vitest", "run", "--reporter=json", `--outputFile=${reportPath}`, ...process.argv.slice(2)],
      { cwd: PACKAGE_ROOT, env: { ...withoutRepoGitEnv(process.env), NAVORI_BENCH_PROC_DIR: procDir }, stdio: ["ignore", "ignore", "inherit"] },
    );
    const wallMs = Date.now() - started;
    if (run.error) {
      process.stderr.write(`bench:tests could not start vitest: ${run.error.message}\n`);
      return 2;
    }
    const summary = summarizeReport(
      JSON.parse(readFileSync(reportPath, "utf8")),
      wallMs,
      PACKAGE_ROOT,
      readSpawnCounts(procDir),
    );
    const comparable = isComparable(loadBefore, workers);
    const result = {
      generatedAt: new Date(started).toISOString(),
      cpus: availableParallelism(),
      loadavgBefore: loadBefore,
      loadavgAfter: loadavg(),
      workers,
      comparable,
      vitestExit: run.status,
      provenance,
      args: process.argv.slice(2),
      ...summary,
    };
    // Only a complete, green run is accreditable: a failed, signalled or filtered run keeps its
    // stamped file for diagnosis but never becomes `latest.json`.
    const accreditable = run.status === 0 && summary.success && result.args.length === 0;
    const dir = join(REPO_ROOT, ".navori", "state", "bench");
    mkdirSync(dir, { recursive: true });
    const stamped = join(dir, `tests-${result.generatedAt.replace(/[:.]/g, "-")}.json`);
    writeFileSync(stamped, `${JSON.stringify(result, null, 2)}\n`);
    if (accreditable) copyFileSync(stamped, join(dir, "latest.json"));
    else process.stderr.write("bench:tests run is not accreditable (failed or filtered): latest.json not updated\n");
    process.stdout.write(
      `bench:tests wall=${(summary.wallMs / 1000).toFixed(1)}s files=${summary.totalFiles} ` +
        `tests=${summary.totalTests} sumFiles=${(summary.sumFilesMs / 1000).toFixed(1)}s ` +
        `spawns=${summary.sumSpawns} workers=${workers} comparable=${comparable} ` +
        `load=${loadBefore.map((n) => n.toFixed(2)).join("/")} cpus=${result.cpus}\n`,
    );
    if (!comparable) process.stderr.write("bench:tests NOT comparable: the machine was not idle at the start\n");
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
