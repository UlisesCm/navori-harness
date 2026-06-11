import { mkdirSync, copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { safeHomedir } from "./home.ts";

// Lazy so importing this module doesn't throw if HOME isn't set yet — the
// throw happens only when someone actually tries to use a backup operation.
function backupRootLazy(): string {
  return join(safeHomedir(), ".navori", "backups");
}
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

export interface BackupOptions {
  /** Repo-relative paths to skip while copying. Matching rule: a candidate
   * `rel` is excluded if `rel === ex` OR `rel.startsWith(ex + "/")`. Use the
   * directory form (without trailing slash) to exclude a whole subtree. */
  exclude?: string[];
}

/**
 * Create a backup directory under ~/.navori/backups/<timestamp>/.
 * Each path can be a file or a directory; directories are walked
 * recursively. Missing sources are skipped silently (a first-time render
 * has nothing to back up). Exclusions match by repo-relative path.
 */
export function createBackup(
  repoRoot: string,
  paths: string[],
  options: BackupOptions = {},
): BackupHandle {
  const dir = join(backupRootLazy(), timestamp());
  mkdirSync(dir, { recursive: true });

  const exclude = (options.exclude ?? []).map((e) => e.replace(/\/+$/, ""));
  const copied: string[] = [];

  for (const p of paths) {
    const abs = resolve(repoRoot, p);
    if (!existsSync(abs)) continue;
    copyRecursive(abs, dir, repoRoot, exclude, copied);
  }

  return { path: dir, files: copied };
}

function copyRecursive(
  abs: string,
  backupDir: string,
  repoRoot: string,
  exclude: string[],
  copied: string[],
): void {
  const rel = relative(repoRoot, abs);
  if (isExcluded(rel, exclude)) return;

  const stat = statSync(abs);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(abs)) {
      copyRecursive(join(abs, entry), backupDir, repoRoot, exclude, copied);
    }
    return;
  }
  if (!stat.isFile()) return; // skip symlinks, sockets, etc.

  const dest = join(backupDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(abs, dest);
  copied.push(rel);
}

function isExcluded(rel: string, exclude: string[]): boolean {
  for (const ex of exclude) {
    if (rel === ex) return true;
    if (rel.startsWith(ex + "/")) return true;
  }
  return false;
}

/**
 * Remove backups older than `retentionDays`. Returns the list of pruned dirs.
 * Silent if BACKUP_ROOT does not exist yet.
 */
export function purgeOldBackups(retentionDays = DEFAULT_RETENTION_DAYS): string[] {
  const root = backupRootLazy();
  if (!existsSync(root)) return [];
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const pruned: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
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
  return backupRootLazy();
}
