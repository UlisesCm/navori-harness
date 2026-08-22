import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeNavoriHomeLeak, realNavoriHome, snapshotNavoriHome } from "./vitest.homeGuard.ts";

const pkgRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Suite-wide setup.
 *
 * 1. Builds the CLI. The e2e specs spawn the compiled binary (`dist/index.js`)
 *    rather than the source, so a stale or missing `dist/` makes them assert
 *    against old behavior and fail for environmental reasons (e.g. a fresh
 *    worktree where `dist/` is gitignored). Building here — once per vitest run
 *    — makes `dist/` a guaranteed prerequisite regardless of which script
 *    (`test`, `test:watch`, `test:coverage`) invoked vitest.
 * 2. Points `NAVORI_BACKUP_ROOT` at a throwaway dir for the whole run (forked
 *    workers inherit this env), so no spec can write backups into — or purge
 *    backups from — the developer's `~/.navori/backups` (#404). It overrides an
 *    inherited value on purpose: isolation is not opt-out.
 * 3. Snapshots the real `~/.navori` root and, on teardown, fails the run if any
 *    entry appeared, changed or disappeared (#424 — the other five
 *    machine-global directories have no env override, only per-spec mocks).
 */
export default function setup(): () => void {
  const r = spawnSync("pnpm", ["build"], {
    cwd: pkgRoot,
    stdio: "inherit",
    // pnpm resolves through a shell shim on Windows CI.
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    throw new Error(
      `vitest globalSetup: 'pnpm build' failed (exit ${r.status ?? "signal"}). ` +
        `The e2e suite runs against ${resolve(pkgRoot, "dist/index.js")}.`,
    );
  }

  const runRoot = mkdtempSync(join(tmpdir(), "navori-test-backups-"));
  process.env.NAVORI_BACKUP_ROOT = runRoot;

  const realRoot = realNavoriHome();
  const before = snapshotNavoriHome(realRoot);

  return () => {
    rmSync(runRoot, { recursive: true, force: true });
    if (!realRoot) return;
    const leak = describeNavoriHomeLeak(realRoot, before, snapshotNavoriHome(realRoot));
    if (!leak) return;
    // Throwing here is swallowed by vitest (it logs "error during close" and
    // still exits 0), so the failure is signalled by the exit code directly.
    process.stderr.write(`\n✖ ~/.navori isolation guard (#404/#424)\n${leak}\n\n`);
    process.exitCode = 1;
  };
}
