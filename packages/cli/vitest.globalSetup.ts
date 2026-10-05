import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDistLock, releaseOnProcessExit, type DistLockHandle } from "./vitest.distLock.ts";
import { createTempRun, type TempRun } from "./vitest.tempLifecycle.ts";
import type { TestProject } from "vitest/node";

const pkgRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Suite-wide setup.
 *
 * The e2e specs execute the fixed `dist/index.js`, so the checkout-scoped
 * suite lock stays held from the build through global teardown. A live lock is
 * never reclaimed by age: a long suite is safer than deleting dist/ below it.
 */
export default async function setup(project: TestProject): Promise<() => void> {
  let lock: DistLockHandle | undefined;
  let disarmExitRelease: (() => void) | undefined;
  let run: TempRun | undefined;

  try {
    lock = await acquireDistLock({ packageRoot: pkgRoot });
    // Vitest exits on SIGINT/SIGTERM without running this teardown (#1159).
    disarmExitRelease = releaseOnProcessExit(lock);
    const result = spawnSync("bun", ["run", "build"], {
      cwd: pkgRoot,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(
        `vitest globalSetup: 'bun run build' failed (exit ${result.status ?? "signal"}). ` +
          `The e2e suite runs against ${resolve(pkgRoot, "dist/index.js")}.`,
      );
    }

    run = createTempRun();
    project.provide("navoriTempRunRoot", run.root);

    return () => {
      try {
        run?.dispose();
      } finally {
        disarmExitRelease?.();
        lock?.release();
      }
    };
  } catch (error) {
    try {
      run?.dispose();
    } finally {
      disarmExitRelease?.();
      lock?.release();
    }
    throw error;
  }
}
