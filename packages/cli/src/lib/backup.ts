import { mkdirSync, copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

const BACKUP_ROOT = join(homedir(), ".navori", "backups");
const DEFAULT_RETENTION_DAYS = 30;

/** ISO-like timestamp safe for paths: YYYY-MM-DDTHH-mm-ss */
function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    "-",
    pad(d.getMonth() + 1),
    "-",
    pad(d.getDate()),
    "T",
    pad(d.getHours()),
    "-",
    pad(d.getMinutes()),
    "-",
    pad(d.getSeconds()),
  ].join("");
}

export interface BackupHandle {
  path: string;
  files: string[];
}

/**
 * Create a backup directory under ~/.navori/backups/<timestamp>/
 * Copies each existing source file preserving its repo-relative path.
 * Files that do not exist are skipped silently (first-time render has nothing to back up).
 */
export function createBackup(repoRoot: string, files: string[]): BackupHandle {
  const dir = join(BACKUP_ROOT, timestamp());
  mkdirSync(dir, { recursive: true });

  const copied: string[] = [];
  for (const file of files) {
    const abs = resolve(repoRoot, file);
    if (!existsSync(abs)) continue;
    const rel = relative(repoRoot, abs);
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    copied.push(rel);
  }

  return { path: dir, files: copied };
}

/**
 * Remove backups older than `retentionDays`. Returns the list of pruned dirs.
 * Silent if BACKUP_ROOT does not exist yet.
 */
export function purgeOldBackups(retentionDays = DEFAULT_RETENTION_DAYS): string[] {
  if (!existsSync(BACKUP_ROOT)) return [];
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const pruned: string[] = [];
  for (const entry of readdirSync(BACKUP_ROOT)) {
    const full = join(BACKUP_ROOT, entry);
    const stat = statSync(full);
    if (!stat.isDirectory()) continue;
    if (stat.mtimeMs < cutoff) {
      rmSync(full, { recursive: true, force: true });
      pruned.push(full);
    }
  }
  return pruned;
}

export function backupRoot(): string {
  return BACKUP_ROOT;
}
