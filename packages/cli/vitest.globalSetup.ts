import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(fileURLToPath(import.meta.url));

/** The developer's real backup store — the suite must never write to or delete
 * from it. `null` when HOME is unusable (nothing to protect). */
function realBackupRoot(): string | null {
  const home = homedir();
  return home && isAbsolute(home) ? join(home, ".navori", "backups") : null;
}

/**
 * Entry names under the real backup store, sorted. `[]` when the directory
 * doesn't exist yet (a clean machine or CI still gets guarded: a run that
 * CREATES it shows up as added entries). `null` when it can't be read, which
 * disables the comparison — an unreadable home is not a test failure.
 * Read-only by construction: this never creates or removes anything.
 */
export function listBackupEntries(root: string | null): string[] | null {
  if (!root) return null;
  try {
    return readdirSync(root).sort();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
}

const MAX_LISTED = 20;

function bullets(entries: string[]): string {
  const shown = entries.slice(0, MAX_LISTED).map((e) => `    - ${e}`);
  const rest = entries.length - shown.length;
  return [...shown, ...(rest > 0 ? [`    …and ${rest} more`] : [])].join("\n");
}

/**
 * Compare the before/after listings of the real backup store and describe the
 * damage, or `null` when the run left it untouched. Entry names are
 * `<repoLabel>-<timestamp>-<seq>`, and `<repoLabel>` is the fixture directory
 * name — so the list points straight at the test that escaped isolation (#404).
 */
export function describeBackupLeak(
  root: string,
  before: string[] | null,
  after: string[] | null,
): string | null {
  if (!before || !after) return null;
  const created = after.filter((e) => !before.includes(e));
  const deleted = before.filter((e) => !after.includes(e));
  if (created.length === 0 && deleted.length === 0) return null;

  const parts = [
    `The test run touched the REAL backup store at ${root}.`,
    `Tests must never read or write it: set NAVORI_BACKUP_ROOT (vitest.setup.ts does it`,
    `for every spec) so createBackup/purgeOldBackups stay inside a throwaway dir.`,
    `The label before the timestamp is the fixture directory that escaped isolation`,
    `— unless a real navori run happened concurrently, which reads as a false positive.`,
  ];
  if (created.length > 0) {
    parts.push(`  Created ${created.length} entr${created.length === 1 ? "y" : "ies"}:`);
    parts.push(bullets(created));
  }
  if (deleted.length > 0) {
    parts.push(`  DELETED ${deleted.length} entr${deleted.length === 1 ? "y" : "ies"}:`);
    parts.push(bullets(deleted));
  }
  return parts.join("\n");
}

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
 * 3. Snapshots the real store and, on teardown, fails the run if it changed.
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

  const realRoot = realBackupRoot();
  const before = listBackupEntries(realRoot);

  return () => {
    rmSync(runRoot, { recursive: true, force: true });
    if (!realRoot) return;
    const leak = describeBackupLeak(realRoot, before, listBackupEntries(realRoot));
    if (!leak) return;
    // Throwing here is swallowed by vitest (it logs "error during close" and
    // still exits 0), so the failure is signalled by the exit code directly.
    process.stderr.write(`\n✖ backup isolation guard (#404)\n${leak}\n\n`);
    process.exitCode = 1;
  };
}
