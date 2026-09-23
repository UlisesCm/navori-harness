/**
 * Disk-usage surveillance (#393) — the two directories navori knows can grow
 * without an owner, measured so growth never goes unnoticed.
 *
 * #348/#373 fixed the CAUSES of runaway growth (backups copying worktrees),
 * but nothing watches the footprint itself: `~/.navori/backups` is bounded
 * only by prune-on-write (a repo that stops rendering keeps its backups
 * forever) and `.claude/worktrees/` is bounded by nobody (4.2 GB over 15
 * worktrees measured in the field).
 *
 * Deliberately CHEAP and read-only: two `du -sk` calls. Doctor reports the
 * real size and the exact cleanup command; it never deletes anything itself —
 * worktrees especially may hold uncommitted work.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { backupRoot } from "./backup.ts";

export type DiskUsageTarget = "backups" | "worktrees";

export interface DiskUsageIssue {
  /** Which directory crossed its threshold. */
  target: DiskUsageTarget;
  /** Absolute path of the measured directory. */
  path: string;
  /** Measured size in bytes (allocated, as reported by `du`). */
  bytes: number;
  thresholdBytes: number;
}

export interface DiskUsageThresholds {
  backupsBytes?: number;
  worktreesBytes?: number;
}

/** 1 GiB — half the purge cap in `purgeOldBackups`, so doctor warns before
 * the hard limit does the deleting for you. */
const DEFAULT_BACKUPS_THRESHOLD_BYTES = 1024 * 1024 * 1024;
/** 2 GiB — a handful of live worktrees fit comfortably; the measured runaway
 * case (4.2 GB / 15 worktrees) sat well past this. */
const DEFAULT_WORKTREES_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;

/** Allocated size of a directory via `du -sk`, or null when it can't be
 * measured (no `du` on PATH, unreadable path) — a skipped check, never a
 * doctor failure. */
function duBytes(path: string): number | null {
  try {
    const out = execFileSync("du", ["-sk", path], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const kib = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(kib) && kib >= 0 ? kib * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Measure the two unowned growth points — `~/.navori/backups` (machine-global)
 * and `<cwd>/.claude/worktrees` — and report each one that exceeds its
 * threshold. Missing directories are simply fine (zero footprint).
 */
export function scanDiskUsage(cwd: string, thresholds: DiskUsageThresholds = {}): DiskUsageIssue[] {
  const targets: Array<{ target: DiskUsageTarget; path: string; thresholdBytes: number }> = [
    {
      target: "backups",
      path: backupRoot(),
      thresholdBytes: thresholds.backupsBytes ?? DEFAULT_BACKUPS_THRESHOLD_BYTES,
    },
    {
      target: "worktrees",
      path: join(cwd, ".claude", "worktrees"),
      thresholdBytes: thresholds.worktreesBytes ?? DEFAULT_WORKTREES_THRESHOLD_BYTES,
    },
  ];

  const issues: DiskUsageIssue[] = [];
  for (const { target, path, thresholdBytes } of targets) {
    if (!existsSync(path)) continue;
    const bytes = duBytes(path);
    if (bytes === null || bytes <= thresholdBytes) continue;
    issues.push({ target, path, bytes, thresholdBytes });
  }
  return issues;
}

/** Human-readable size: "512 MB" under a GiB, "4.2 GB" above. */
export function humanBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib >= 10 ? Math.round(gib) : Math.round(gib * 10) / 10} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
