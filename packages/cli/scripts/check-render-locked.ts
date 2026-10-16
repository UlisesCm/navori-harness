import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDistLock, releaseOnProcessExit } from "../vitest.distLock.ts";
import { ensureDist, type EnsureDistOptions, type EnsureDistResult } from "./ensure-dist.ts";

/**
 * Spec 0054 R6 — `check:render` under the dist lock.
 *
 * Takes the lock, ensures `dist/` (a sealed hit builds nothing), runs
 * `scripts/js/check-render.mjs`, and only then releases: `clean: true` wipes
 * `dist/` when a concurrent suite rebuilds, so reading it unlocked could fail
 * spuriously.
 */
export interface CheckRenderOptions {
  packageRoot: string;
  /** Test seam for `ensureDist`. */
  ensure?: (options: EnsureDistOptions) => EnsureDistResult;
  /** Test seam for the render check; returns its exit status. */
  runCheck?: () => number;
}

export async function checkRenderLocked(options: CheckRenderOptions): Promise<number> {
  const lock = await acquireDistLock({ packageRoot: options.packageRoot });
  const disarm = releaseOnProcessExit(lock);
  try {
    (options.ensure ?? ensureDist)({ packageRoot: options.packageRoot, lockHeld: true });
    const run =
      options.runCheck ??
      ((): number => {
        const script = resolve(options.packageRoot, "../../scripts/js/check-render.mjs");
        return spawnSync("node", [script], { stdio: "inherit" }).status ?? 1;
      });
    return run();
  } finally {
    disarm();
    lock.release();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  checkRenderLocked({ packageRoot }).then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
