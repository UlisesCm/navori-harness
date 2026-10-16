import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDistLock, releaseOnProcessExit, type DistLockHandle } from "./vitest.distLock.ts";
import { ensureDist } from "./scripts/ensure-dist.ts";
import { createTempRun, type TempRun } from "./vitest.tempLifecycle.ts";
import type { TestProject } from "vitest/node";

const pkgRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Suite-wide setup.
 *
 * The e2e specs execute the fixed `dist/index.js`, so the checkout-scoped
 * suite lock stays held from the (sealed, usually skipped) build through
 * global teardown. A live lock is
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
    // Seal hit => no build. The lock is already ours; ensureDist never re-takes it.
    ensureDist({ packageRoot: pkgRoot, lockHeld: true });

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
