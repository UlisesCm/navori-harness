import { spawnSync } from "node:child_process";
import { constants, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const floorScript = join(packageRoot, "scripts", "check-coverage-floor.mjs");
const budgetScript = join(packageRoot, "scripts", "check-test-budget.mjs");

/**
 * Parse mutually exclusive shard/merge modes without accepting ambiguous or partial numbers.
 * @param {string[]} args
 * @returns {{ shard: string | undefined, merge: string | undefined, shards: number }}
 */
export function parseCoverageArgs(args) {
  /** @type {{ shard: string | undefined, merge: string | undefined, shards: number }} */
  const options = { shard: undefined, merge: undefined, shards: 4 };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (
      !["--shard", "--merge", "--shards"].includes(key) ||
      seen.has(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error(`Invalid coverage option: ${key}`);
    seen.add(key);
    const value = args[++i];
    if (key === "--shards") {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error("--shards requires a positive integer");
      options.shards = Number(value);
    } else if (key === "--shard") options.shard = value;
    else options.merge = value;
  }
  if (options.shard && options.merge) throw new Error("--shard and --merge are exclusive");
  if (seen.has("--shards") && !options.merge) throw new Error("--shards requires --merge");
  if (options.shard) {
    const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(options.shard);
    if (
      !match ||
      !Number.isSafeInteger(Number(match[1])) ||
      !Number.isSafeInteger(Number(match[2])) ||
      Number(match[1]) > Number(match[2])
    )
      throw new Error("--shard requires i/N with 1 <= i <= N");
  }
  return options;
}

/**
 * Only wrapper-published successful shards with every unique index may enter the native merge.
 * @param {string[]} names
 * @param {number} count
 * @returns {void}
 */
export function validateShardFiles(names, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Expected a positive shard count");
  const seen = new Set();
  for (const name of names) {
    const match = /^shard-([1-9]\d*)-([1-9]\d*)\.json$/.exec(name);
    if (
      !match ||
      Number(match[2]) !== count ||
      Number(match[1]) > count ||
      seen.has(Number(match[1]))
    )
      throw new Error(`Invalid, duplicate or mixed-count shard: ${name}`);
    seen.add(Number(match[1]));
  }
  if (seen.size !== count)
    throw new Error(`Missing shard blobs: expected ${count}, found ${seen.size}`);
}

/** @typedef {{ status: number | null, signal?: string | null, error?: Error }} ChildResult */
/** @typedef {(prefix: string) => string} MakeTempDir */
/** @typedef {(path: string, options: { recursive: boolean, force: boolean }) => void} RemoveDir */
/** @typedef {(command: string, args: string[], options: { cwd: string, env: NodeJS.ProcessEnv, stdio: "inherit" }) => ChildResult} Spawn */
/** @typedef {{ env?: NodeJS.ProcessEnv, mkdtempSync?: MakeTempDir, rmSync?: RemoveDir, spawnSync?: Spawn }} CoverageRunnerDependencies */

/**
 * Runs Vitest and its per-file coverage floor against the same run-local report.
 * A caller-provided NAVORI_COVERAGE_DIR remains caller-owned and is never removed.
 *
 * @param {CoverageRunnerDependencies} dependencies
 * @param {string[]} args
 * @returns {number}
 */
export function runCoverage(dependencies = {}, args = []) {
  const options = parseCoverageArgs(args);
  const partial = options.shard !== undefined && Number(options.shard.split("/")[1]) > 1;
  if (options.merge)
    validateShardFiles(readdirSync(resolve(packageRoot, options.merge)), options.shards);
  const env = { ...process.env, ...dependencies.env };
  const makeTempDir = dependencies.mkdtempSync ?? mkdtempSync;
  const removeDir = dependencies.rmSync ?? rmSync;
  const run = dependencies.spawnSync ?? spawnSync;
  const callerOwned = Boolean(env.NAVORI_COVERAGE_DIR);
  const coverageDir = env.NAVORI_COVERAGE_DIR ?? makeTempDir(join(tmpdir(), "navori-coverage-"));
  const childEnv = { ...env, NAVORI_COVERAGE_DIR: coverageDir };
  // Never allow an inherited partial-run flag to disable aggregate thresholds.
  delete childEnv.NAVORI_COVERAGE_SHARD;
  if (partial) childEnv.NAVORI_COVERAGE_SHARD = "1";
  const blobPath = join(coverageDir, "shard.blob.json");
  const testReport = env.NAVORI_TEST_REPORT ?? join(coverageDir, "vitest-report.json");
  const publishBlob = () => {
    const output = resolve(packageRoot, env.NAVORI_BLOB_DIR ?? ".vitest-reports");
    mkdirSync(output, { recursive: true });
    // Exclusive publication prevents an old/retried shard from silently replacing evidence.
    copyFileSync(
      blobPath,
      join(output, `shard-${options.shard.replace("/", "-")}.json`),
      constants.COPYFILE_EXCL,
    );
  };
  let interrupted = false;
  try {
    // NAVORI_TEST_REPORT: also write Vitest's JSON report there (input of check-test-budget).
    // The explicit --reporter replaces config's, so repeat the TTY-dependent console pick.
    const consoleReporter = process.stdout.isTTY ? "default" : "./vitest.reporter.ts";
    const reportArgs =
      env.NAVORI_TEST_REPORT || options.merge
        ? [`--reporter=${consoleReporter}`, "--reporter=json", `--outputFile.json=${testReport}`]
        : [];
    const modeArgs = options.shard
      ? [
          `--shard=${options.shard}`,
          `--reporter=${consoleReporter}`,
          "--reporter=blob",
          `--outputFile.blob=${blobPath}`,
        ]
      : options.merge
        ? [`--merge-reports=${resolve(packageRoot, options.merge)}`, ...reportArgs]
        : reportArgs;
    const vitest = run("bun", ["x", "vitest", "run", "--coverage", ...modeArgs], {
      cwd: packageRoot,
      env: childEnv,
      stdio: "inherit",
    });
    interrupted = Boolean(vitest.signal) || (vitest.status === null && !vitest.error);
    if (vitest.error) {
      process.stderr.write(`test:coverage could not start Vitest: ${vitest.error.message}\n`);
      return 1;
    }
    if (vitest.status !== 0) return vitest.status ?? 1;
    if (partial) {
      publishBlob();
      return 0;
    }

    const floor = run(process.execPath, [floorScript], {
      cwd: packageRoot,
      env: childEnv,
      stdio: "inherit",
    });
    interrupted = Boolean(floor.signal) || (floor.status === null && !floor.error);
    if (floor.error) {
      process.stderr.write(
        `test:coverage could not start the coverage floor: ${floor.error.message}\n`,
      );
      return 1;
    }
    if (floor.status !== 0) return floor.status ?? 1;
    if (options.shard) publishBlob();

    if (options.merge) {
      const budget = run(process.execPath, [budgetScript, "--report", testReport], {
        cwd: packageRoot,
        env: childEnv,
        stdio: "inherit",
      });
      interrupted = Boolean(budget.signal) || (budget.status === null && !budget.error);
      if (budget.error)
        process.stderr.write(
          `test:coverage could not start the time budget: ${budget.error.message}\n`,
        );
      return budget.error ? 1 : (budget.status ?? 1);
    }

    return 0;
  } finally {
    if (!callerOwned) {
      if (interrupted || env.NAVORI_KEEP_TEST_ARTIFACTS === "1") {
        process.stderr.write(
          `test:coverage report retained (${interrupted ? "interrupted child" : "NAVORI_KEEP_TEST_ARTIFACTS=1"}): ${coverageDir}\n`,
        );
      } else {
        removeDir(coverageDir, { recursive: true, force: true });
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCoverage({}, process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`test:coverage: ${error.message}\n`);
    process.exitCode = 1;
  }
}
