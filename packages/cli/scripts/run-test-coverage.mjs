import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const floorScript = join(packageRoot, "scripts", "check-coverage-floor.mjs");

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
 * @returns {number}
 */
export function runCoverage(dependencies = {}) {
  const env = { ...process.env, ...dependencies.env };
  const makeTempDir = dependencies.mkdtempSync ?? mkdtempSync;
  const removeDir = dependencies.rmSync ?? rmSync;
  const run = dependencies.spawnSync ?? spawnSync;
  const callerOwned = Boolean(env.NAVORI_COVERAGE_DIR);
  const coverageDir = env.NAVORI_COVERAGE_DIR ?? makeTempDir(join(tmpdir(), "navori-coverage-"));
  const childEnv = { ...env, NAVORI_COVERAGE_DIR: coverageDir };

  const vitest = run("bun", ["x", "vitest", "run", "--coverage"], {
    cwd: packageRoot,
    env: childEnv,
    stdio: "inherit",
  });
  if (vitest.error) {
    process.stderr.write(`test:coverage could not start Vitest: ${vitest.error.message}\n`);
    return 1;
  }
  if (vitest.status !== 0) return vitest.status ?? 1;

  const floor = run(process.execPath, [floorScript], {
    cwd: packageRoot,
    env: childEnv,
    stdio: "inherit",
  });
  if (floor.error) {
    process.stderr.write(`test:coverage could not start the coverage floor: ${floor.error.message}\n`);
    return 1;
  }
  if (floor.status !== 0) return floor.status ?? 1;

  if (!callerOwned) removeDir(coverageDir, { recursive: true, force: true });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCoverage();
}
