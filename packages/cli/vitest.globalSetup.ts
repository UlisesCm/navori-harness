import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeNavoriHomeLeak, realNavoriHome, snapshotNavoriHome } from "./vitest.homeGuard.ts";

const pkgRoot = dirname(fileURLToPath(import.meta.url));

// A cross-process mutex around `bun run build` (#914). Two concurrent vitest
// runs in this package (two agents/gates on the same machine) both build into
// the fixed `dist/`, so without serialization one run's compiled output can
// clobber the other's mid-write. Unlike #912's `NAVORI_COVERAGE_DIR`, moving the
// build output isn't cheap here: e2e specs hardcode `dist/index.js` in several
// files (not behind a shared helper/env var), so relocating it would mean
// touching every one of them instead of one config line. `mkdirSync` is atomic
// (EEXIST on contention) on every platform this repo targets, so it doubles as
// a lock with no extra dependency.
const BUILD_LOCK_DIR = join(tmpdir(), "navori-cli-dist-build.lock");
// A `bun run build` here takes low single-digit seconds; this is generous
// headroom before concluding the lock's holder crashed without releasing it.
const BUILD_LOCK_STALE_MS = 5 * 60 * 1000;
const BUILD_LOCK_POLL_MS = 200;

/**
 * Runs `fn` while holding an exclusive, cross-process lock on `dist/`'s build
 * step, waiting out other holders and reclaiming a stale lock left behind by a
 * crashed process instead of deadlocking forever.
 */
async function withBuildLock(fn: () => void): Promise<void> {
  const deadline = Date.now() + BUILD_LOCK_STALE_MS;
  for (;;) {
    try {
      mkdirSync(BUILD_LOCK_DIR);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(BUILD_LOCK_DIR).mtimeMs;
      } catch (statErr) {
        // The holder released the lock (its `finally`'s `rmSync`) between our
        // failed `mkdirSync` and this `statSync`. Retry the `mkdirSync`
        // immediately instead of treating this as a real error.
        if ((statErr as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statErr;
      }
      const age = Date.now() - mtimeMs;
      if (age > BUILD_LOCK_STALE_MS) {
        // Stale: its holder almost certainly crashed before releasing it.
        rmSync(BUILD_LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `vitest globalSetup: timed out waiting for the dist/ build lock at ${BUILD_LOCK_DIR}. ` +
            "If no other vitest run is building concurrently, remove that directory and retry.",
        );
      }
      await new Promise((r) => setTimeout(r, BUILD_LOCK_POLL_MS));
    }
  }
  try {
    fn();
  } finally {
    rmSync(BUILD_LOCK_DIR, { recursive: true, force: true });
  }
}

/**
 * Suite-wide setup.
 *
 * 1. Builds the CLI. The e2e specs spawn the compiled binary (`dist/index.js`)
 *    rather than the source, so a stale or missing `dist/` makes them assert
 *    against old behavior and fail for environmental reasons (e.g. a fresh
 *    worktree where `dist/` is gitignored). Building here — once per vitest run
 *    — makes `dist/` a guaranteed prerequisite regardless of which script
 *    (`test`, `test:watch`, `test:coverage`) invoked vitest. The build itself
 *    is serialized across processes by `withBuildLock` (#914), since `dist/`
 *    has no per-run isolation the way `NAVORI_BACKUP_ROOT` and
 *    `NAVORI_COVERAGE_DIR` give the other two shared paths below.
 * 2. Points `NAVORI_BACKUP_ROOT` at a throwaway dir for the whole run (forked
 *    workers inherit this env), so no spec can write backups into — or purge
 *    backups from — the developer's `~/.navori/backups` (#404). It overrides an
 *    inherited value on purpose: isolation is not opt-out.
 * 3. Snapshots the real `~/.navori` root and, on teardown, fails the run if any
 *    entry appeared, changed or disappeared (#424 — the other five
 *    machine-global directories have no env override, only per-spec mocks).
 *    The repo under test is named so the guard can tell this repo's audit logs
 *    (a real leak) from another repo's (a concurrent session, #656).
 */
export default async function setup(): Promise<() => void> {
  await withBuildLock(() => {
    const r = spawnSync("bun", ["run", "build"], {
      cwd: pkgRoot,
      stdio: "inherit",
      // Unlike pnpm/npm (JS shims that need a shell to resolve as `.cmd` on
      // Windows), bun installs as a native binary on every platform (see
      // oven-sh/setup-bun in CI), so no shell is needed here.
    });
    if (r.status !== 0) {
      throw new Error(
        `vitest globalSetup: 'bun run build' failed (exit ${r.status ?? "signal"}). ` +
          `The e2e suite runs against ${resolve(pkgRoot, "dist/index.js")}.`,
      );
    }
  });

  const runRoot = mkdtempSync(join(tmpdir(), "navori-test-backups-"));
  process.env.NAVORI_BACKUP_ROOT = runRoot;

  const realRoot = realNavoriHome();
  // The audit store keys per-repo directories by `basename(resolve(cwd))`
  // (`lib/audit/paths.ts`), and this package sits two levels under the repo root.
  const selfRepo = basename(resolve(pkgRoot, "..", ".."));
  const before = snapshotNavoriHome(realRoot);

  return () => {
    rmSync(runRoot, { recursive: true, force: true });
    if (!realRoot) return;
    const leak = describeNavoriHomeLeak(realRoot, before, snapshotNavoriHome(realRoot), selfRepo);
    if (!leak) return;
    // Throwing here is swallowed by vitest (it logs "error during close" and
    // still exits 0), so the failure is signalled by the exit code directly.
    process.stderr.write(`\n✖ ~/.navori isolation guard (#404/#424)\n${leak}\n\n`);
    process.exitCode = 1;
  };
}
