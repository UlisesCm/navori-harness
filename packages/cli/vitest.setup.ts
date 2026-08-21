import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Give every test FILE its own backup store (#404).
 *
 * `vitest.globalSetup.ts` already points `NAVORI_BACKUP_ROOT` at a throwaway
 * root for the run; this narrows it once more per spec file so that a purge in
 * one file (`purgeOldBackups` deletes oldest-first under whatever root is
 * active) can never eat another file's fixtures while both run in parallel.
 *
 * The fallback covers running vitest with a config that skips the global setup:
 * an isolated dir in tmpdir is still infinitely better than the real
 * `~/.navori/backups`. Cleanup is the run root's `rmSync` in globalSetup.
 */
const runRoot = process.env.NAVORI_BACKUP_ROOT;
if (runRoot) {
  mkdirSync(runRoot, { recursive: true });
  process.env.NAVORI_BACKUP_ROOT = mkdtempSync(join(runRoot, "suite-"));
} else {
  process.env.NAVORI_BACKUP_ROOT = mkdtempSync(join(tmpdir(), "navori-test-backups-"));
}
