import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeNavoriHomeLeak, realNavoriHome, snapshotNavoriHome } from "./vitest.homeGuard.ts";
import { acquireDistLock, type DistLockHandle } from "./vitest.distLock.ts";

const pkgRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Suite-wide setup.
 *
 * The e2e specs execute the fixed `dist/index.js`, so the checkout-scoped
 * suite lock stays held from the build through global teardown. A live lock is
 * never reclaimed by age: a long suite is safer than deleting dist/ below it.
 */
export default async function setup(): Promise<() => void> {
  let lock: DistLockHandle | undefined;
  let runRoot: string | undefined;
  let runHome: string | undefined;

  try {
    lock = await acquireDistLock({ packageRoot: pkgRoot });
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

    runRoot = mkdtempSync(join(tmpdir(), "navori-test-backups-"));
    process.env.NAVORI_BACKUP_ROOT = runRoot;

    runHome = mkdtempSync(join(tmpdir(), "navori-test-home-"));
    process.env.HOME = runHome;
    // `os.homedir()` reads USERPROFILE on Windows and HOME elsewhere.
    process.env.USERPROFILE = runHome;

    const realRoot = realNavoriHome();
    const selfRepo = basename(resolve(pkgRoot, "..", ".."));
    const before = snapshotNavoriHome(realRoot);

    return () => {
      try {
        rmSync(runRoot, { recursive: true, force: true });
        const leak = realRoot
          ? describeNavoriHomeLeak(realRoot, before, snapshotNavoriHome(realRoot), selfRepo)
          : null;
        if (!leak) {
          rmSync(runHome, { recursive: true, force: true });
          return;
        }
        process.stderr.write(
          `\n✖ ~/.navori isolation guard (#404/#424)\n${leak}\n` +
            `  The run's home is kept for inspection: ${runHome}\n\n`,
        );
        process.exitCode = 1;
      } finally {
        lock?.release();
      }
    };
  } catch (error) {
    try {
      if (runRoot) rmSync(runRoot, { recursive: true, force: true });
      if (runHome) rmSync(runHome, { recursive: true, force: true });
    } finally {
      lock?.release();
    }
    throw error;
  }
}
