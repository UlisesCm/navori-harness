import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { safeHomedir } from "./home.ts";
import { canonicalPath } from "./workspace.ts";
import { withFileLock } from "./lockfile.ts";

/**
 * Global machine-local registry of every repo that has navori installed
 * (`navori.config.json` at its root), regardless of folder or workspace.
 *
 * This is the source of truth for "run something across ALL my navori repos in
 * one command" — e.g. `navori render --all` after a harness bump. It is
 * orthogonal to workspaces: a workspace is a shared *policy* profile a repo
 * opts into (branchBase/prTarget), while the registry is just the flat set of
 * repos that exist on this machine. A repo with no workspace (navori itself)
 * still lives here.
 *
 * Like the workspace registry (#76) it is machine-local and never travels with
 * a repo: paths are absolute and symlink-resolved, so a teammate rebuilds their
 * own registry with `navori registry scan`.
 */

const RegistryEntrySchema = z.object({
  /** Absolute, symlink-resolved path to the repo root (holds navori.config.json). */
  path: z.string().min(1),
  /** Cached config.name for display; refreshed on re-register. Optional. */
  name: z.string().optional(),
});

const RegistrySchema = z.object({
  repos: z.array(RegistryEntrySchema).default([]),
});

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
export type Registry = z.infer<typeof RegistrySchema>;

/** Directory names never worth descending into during a bootstrap scan. */
const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
]);

const DEFAULT_SCAN_DEPTH = 4;

function navoriRoot(): string {
  return join(safeHomedir(), ".navori");
}

export function registryPath(): string {
  return join(navoriRoot(), "registry.json");
}

/**
 * Advisory lock guarding the registry's read-modify-write cycle. Two processes
 * touching registry.json concurrently (e.g. `workspace render` in one terminal
 * while `init` runs in another) would otherwise clobber each other's entry
 * (#82/#243). Ensures the navori root exists so `openSync(..,"wx")` can create
 * the lock file even on a fresh machine.
 */
function registryLockPath(): string {
  mkdirSync(navoriRoot(), { recursive: true });
  return join(navoriRoot(), ".registry.lock");
}

/** Read the registry, tolerating a missing or corrupt file (returns empty). */
export function readRegistry(): Registry {
  const path = registryPath();
  if (!existsSync(path)) return { repos: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const result = RegistrySchema.safeParse(parsed);
    return result.success ? result.data : { repos: [] };
  } catch {
    return { repos: [] };
  }
}

/** Write the registry, sorted by path for stable diffs. Returns the file path. */
export function writeRegistry(registry: Registry): string {
  mkdirSync(navoriRoot(), { recursive: true });
  const path = registryPath();
  const sorted = [...registry.repos].sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(path, `${JSON.stringify({ repos: sorted }, null, 2)}\n`);
  return path;
}

export type RegisterResult = "added" | "updated" | "unchanged";

/**
 * Register (or refresh) a repo in the global registry. Idempotent — keyed by the
 * canonical (symlink-resolved) path, so re-running never duplicates. Returns
 * "updated" only when the cached name changed for an existing entry.
 */
export function registerRepo(repoPath: string, name?: string): RegisterResult {
  const path = canonicalPath(repoPath);
  // Lock the whole read-modify-write so a concurrent register/unregister/prune
  // can't drop this entry (#243).
  return withFileLock(registryLockPath(), () => {
    const registry = readRegistry();
    const existing = registry.repos.find((r) => r.path === path);
    if (existing) {
      if (name && existing.name !== name) {
        existing.name = name;
        writeRegistry(registry);
        return "updated";
      }
      return "unchanged";
    }
    registry.repos.push({ path, ...(name ? { name } : {}) });
    writeRegistry(registry);
    return "added";
  });
}

/**
 * Best-effort self-registration for commands that write a repo's config (init,
 * update). Never throws — a failure to touch ~/.navori must not fail the real
 * command. Returns null when it could not register.
 */
export function registerRepoSafe(repoPath: string, name?: string): RegisterResult | null {
  try {
    return registerRepo(repoPath, name);
  } catch {
    return null;
  }
}

export type RefreshNameResult = "updated" | "unchanged" | "not-registered";

/**
 * #589 — refresh the cached `name` of a repo ALREADY in the registry, so the
 * entry tracks its `navori.config.json` instead of freezing whatever the name
 * was the day it was registered.
 *
 * The entry's name was only ever written by `init` and `update`. `init` runs
 * once in a repo's life and `update` is not part of a rollout, so a name
 * corrected in the config never reached the registry: in one 15-repo workspace
 * six entries had drifted, two of them displaying a SIBLING repo's name — which
 * is what `registry ls` and every `render --all` row then reported.
 *
 * Deliberately NOT an upsert: this refreshes, it never adds. `render` calls it
 * on every apply, and a render inside a git worktree (or any throwaway checkout)
 * must not enroll that path into the registry — enrolling worktrees is exactly
 * how `render --all` would start writing the harness into live ticket branches.
 * Registration stays an explicit act (`init`, `registry add`, `registry scan`).
 *
 * Never throws: a failure to touch ~/.navori must not fail the render.
 */
export function refreshRepoName(repoPath: string, name: string): RefreshNameResult | null {
  try {
    const path = canonicalPath(repoPath);
    // Cheap pre-check OUTSIDE the lock: the overwhelmingly common case is "name
    // already correct", and taking the advisory lock on every render — including
    // every `render --all` iteration — just to read would serialize them.
    const existing = readRegistry().repos.find((r) => r.path === path);
    if (!existing) return "not-registered";
    if (existing.name === name) return "unchanged";
    return withFileLock(registryLockPath(), () => {
      // Re-read under the lock: another process may have fixed it meanwhile.
      const registry = readRegistry();
      const entry = registry.repos.find((r) => r.path === path);
      if (!entry) return "not-registered";
      if (entry.name === name) return "unchanged";
      entry.name = name;
      writeRegistry(registry);
      return "updated";
    });
  } catch {
    return null;
  }
}

/** Remove a repo from the registry by path. Returns true if an entry was dropped. */
export function unregisterRepo(repoPath: string): boolean {
  const path = canonicalPath(repoPath);
  return withFileLock(registryLockPath(), () => {
    const registry = readRegistry();
    const next = registry.repos.filter((r) => r.path !== path);
    if (next.length === registry.repos.length) return false;
    writeRegistry({ repos: next });
    return true;
  });
}

export function listRegistryRepos(): RegistryEntry[] {
  return readRegistry().repos;
}

/**
 * Drop entries whose repo no longer has a navori.config.json on disk (moved,
 * deleted, or de-initialized). Returns what was removed and what was kept.
 */
export function pruneRegistry(): { removed: RegistryEntry[]; kept: RegistryEntry[] } {
  return withFileLock(registryLockPath(), () => {
    const registry = readRegistry();
    const kept: RegistryEntry[] = [];
    const removed: RegistryEntry[] = [];
    for (const entry of registry.repos) {
      if (existsSync(join(entry.path, "navori.config.json"))) kept.push(entry);
      else removed.push(entry);
    }
    if (removed.length > 0) writeRegistry({ repos: kept });
    return { removed, kept };
  });
}

/**
 * True when `dir` is a git WORKTREE rather than a normal clone. In a worktree
 * `.git` is a FILE holding `gitdir: <repo>/.git/worktrees/<name>`; in a clone it
 * is a directory. Structural, so it needs no name convention — a worktree parked
 * anywhere under the scanned tree is recognized.
 */
export function isGitWorktree(dir: string): boolean {
  const dotGit = join(dir, ".git");
  try {
    return statSync(dotGit).isFile();
  } catch {
    return false; // absent .git, or unreadable — not our business either way
  }
}

export interface ScanResult {
  /** Canonical paths of the navori repos found. */
  repos: string[];
  /** Canonical paths skipped for being git worktrees (see `isGitWorktree`). */
  worktrees: string[];
}

/**
 * Bootstrap helper: walk `rootDir` (up to `maxDepth` levels) and return the
 * canonical paths of every directory that holds a `navori.config.json`. Skips
 * heavy/uninteresting dirs and does not descend into a repo once found (a repo's
 * subdirs never hold their own root config). Used by `navori registry scan` to
 * populate the registry for repos that predate auto-registration.
 *
 * Git worktrees are found but NOT returned as repos (#589). A worktree carries
 * its parent's whole tree, harness included, so a scan of a workspace directory
 * used to enroll every open ticket worktree as an independent repo — under the
 * parent's own name, which made them indistinguishable in `registry ls`. In a
 * repo that VERSIONS its harness, a later `render --all` would then write the
 * harness into each of those live ticket branches. They are reported separately
 * so the skip is visible rather than silent; `registry add <path>` still
 * registers one on purpose.
 */
export function scanForRepos(rootDir: string, opts: { maxDepth?: number } = {}): ScanResult {
  // `??` only catches null/undefined, so a NaN slipping through from an
  // unvalidated caller would make `depth >= maxDepth` always false (unlimited
  // walk). Guard with isFinite so a bad value falls back to the default (#283).
  const maxDepth = Number.isFinite(opts.maxDepth) ? (opts.maxDepth as number) : DEFAULT_SCAN_DEPTH;
  const found: string[] = [];
  const worktrees: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (existsSync(join(dir, "navori.config.json"))) {
      (isGitWorktree(dir) ? worktrees : found).push(canonicalPath(dir));
      return; // don't descend into a repo
    }
    if (depth >= maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions, etc.)
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || SCAN_SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };

  walk(rootDir, 0);
  return { repos: found, worktrees };
}
