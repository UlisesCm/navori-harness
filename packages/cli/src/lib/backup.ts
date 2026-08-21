import { mkdirSync, copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { safeHomedir } from "./home.ts";

// Lazy so importing this module doesn't throw if HOME isn't set yet — the
// throw happens only when someone actually tries to use a backup operation.
function backupRootLazy(): string {
  return join(safeHomedir(), ".navori", "backups");
}
const DEFAULT_RETENTION_DAYS = 30;
/** Generous cap on the TOTAL size of ~/.navori/backups (#393). Age alone does
 * not bound the footprint — a busy month of rollouts can pile up gigabytes that
 * all survive the 30-day window — so size is the second criterion. */
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * ISO-like timestamp safe for paths: `YYYY-MM-DDTHH-mm-ss-SSS-p<pid>`.
 * The millisecond + pid suffix disambiguates two backups taken in the same
 * second — different repos in a rollout loop, or concurrent processes — which
 * with second granularity would share one `~/.navori/backups/<ts>/` directory
 * and cross-contaminate each other's snapshots (#82).
 */
function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}` +
    `-${pad(d.getMilliseconds(), 3)}-p${process.pid}`
  );
}

/** Filesystem-safe label identifying which repo a backup belongs to, derived
 * from the repo directory name. Falls back to "repo" for odd roots (e.g. "/").
 * A snapshot dir is `<repo>-<timestamp>` so `backup list` and `restore` can
 * tell whose backup is whose in a multi-repo rollout (#82). */
export function backupRepoLabel(repoRoot: string): string {
  const safe = basename(resolve(repoRoot)).replace(/[^a-zA-Z0-9._-]/g, "-");
  return safe.length > 0 ? safe : "repo";
}

/** Per-process monotonic counter appended to every backup dir. pid + ms already
 * disambiguate across processes and repos; this closes the last gap — two
 * backups of the same repo in the same millisecond within ONE process. */
let backupSeq = 0;

/** The `<repo>-<timestamp>-<seq>` regex, used to split a backup id back into its
 * repo label for `restore`'s destination sanity check. */
const BACKUP_ID_RE = /^(.*)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-p\d+-\d+$/;

/** Extract the repo label from a backup directory name, or null if it doesn't
 * match the `<repo>-<timestamp>` shape (e.g. a legacy timestamp-only backup). */
export function backupIdRepoLabel(backupId: string): string | null {
  const m = BACKUP_ID_RE.exec(backupId);
  return m ? m[1]! : null;
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
  const dir = join(backupRootLazy(), `${backupRepoLabel(repoRoot)}-${timestamp()}-${backupSeq++}`);
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

export interface PurgeOptions {
  /** Delete backups older than this many days (default: 30). First criterion. */
  retentionDays?: number;
  /** After the age pass, delete oldest-first until the total size of what
   * remains is at or under this many bytes (default: 2 GiB). Second criterion
   * (#393): age alone lets a busy repo grow without bound. */
  maxTotalBytes?: number;
}

/**
 * Remove backups older than `retentionDays`, then — if what survives still
 * exceeds `maxTotalBytes` in total — keep deleting from oldest to newest until
 * the total is under the cap (#393). Returns the list of pruned dirs.
 * Silent if BACKUP_ROOT does not exist yet.
 */
export function purgeOldBackups(options: PurgeOptions = {}): string[] {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const root = backupRootLazy();
  if (!existsSync(root)) return [];
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const pruned: string[] = [];
  const survivors: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    // A concurrent navori process (the 16-repo rollout overlaps) may create or
    // remove a backup between our readdir and this stat/rm. Never let that race
    // crash the caller's render — skip the entry that vanished (#82).
    try {
      const stat = statSync(full);
      if (!stat.isDirectory()) continue;
      if (stat.mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
        pruned.push(full);
      } else {
        survivors.push({ path: full, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // entry disappeared mid-scan, or is momentarily unreadable — ignore
    }
  }

  // Size pass: oldest-first until under the cap. Sizes are computed lazily —
  // when the total never crosses the cap this pass costs one walk, no deletes.
  const sized = survivors
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map((s) => ({ ...s, bytes: dirSizeBytes(s.path) }));
  let total = sized.reduce((sum, s) => sum + s.bytes, 0);
  for (const backup of sized) {
    if (total <= maxTotalBytes) break;
    try {
      rmSync(backup.path, { recursive: true, force: true });
      pruned.push(backup.path);
    } catch {
      // same race as above — a concurrent process beat us to it
    }
    total -= backup.bytes;
  }
  return pruned;
}

/** Total size in bytes of the regular files under `dir` (0 on any race). */
function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) total += dirSizeBytes(full);
      else if (stat.isFile()) total += stat.size;
    }
  } catch {
    // entry disappeared mid-scan — its bytes no longer count
  }
  return total;
}

export function backupRoot(): string {
  return backupRootLazy();
}
