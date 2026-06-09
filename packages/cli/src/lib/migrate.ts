import { mkdirSync, existsSync, copyFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

const MIGRATIONS_ROOT = join(homedir(), ".navori", "migrations");

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

/**
 * Recursively copy a path (file or dir) to dest, preserving structure.
 * Mirrors Node 20's cpSync but avoids the dependency on options that differ
 * between Node versions.
 */
function copyRecursive(src: string, dest: string): void {
  const stat = statSync(src);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyRecursive(join(src, entry), join(dest, entry));
    }
  } else if (stat.isFile()) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

export interface MigrationResult {
  path: string;
  movedPaths: string[];
}

/**
 * "Replace" mode: move existing Claude infrastructure to
 * ~/.navori/migrations/<timestamp>/<repo-basename>/ before starting fresh.
 *
 * Files moved (when they exist):
 *   .claude/         (entire tree)
 *   CLAUDE.md
 *   AGENTS.md
 *   CHECKPOINTS.md
 *   feature_list.json
 *   progress/        (entire tree)
 *   specs/           (entire tree)
 *
 * Uses copy + remove rather than rename across filesystems to be safe with
 * symlinks and cross-device cases.
 */
export function createMigrationBackup(repoRoot: string, repoName: string): MigrationResult {
  const dir = join(MIGRATIONS_ROOT, timestamp(), repoName);
  mkdirSync(dir, { recursive: true });

  const candidates = [
    ".claude",
    "CLAUDE.md",
    "AGENTS.md",
    "CHECKPOINTS.md",
    "feature_list.json",
    "progress",
    "specs",
  ];

  const moved: string[] = [];
  for (const rel of candidates) {
    const src = resolve(repoRoot, rel);
    if (!existsSync(src)) continue;
    const dest = join(dir, rel);
    copyRecursive(src, dest);
    moved.push(rel);
  }

  return { path: dir, movedPaths: moved };
}

/**
 * Remove the originals after they have been backed up. Separated from
 * createMigrationBackup so the caller can confirm before destructive removal.
 */
export function removeOriginals(repoRoot: string, paths: string[]): void {
  for (const rel of paths) {
    const target = resolve(repoRoot, rel);
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
  }
}

export function migrationsRoot(): string {
  return MIGRATIONS_ROOT;
}
