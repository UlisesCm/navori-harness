import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectProject } from "./detect.ts";
import { collectWorkspacePatterns, expandPattern } from "./workspace-patterns.ts";
import type { MonorepoWorkspace } from "./monorepo.ts";

export interface DetectedWorkspace {
  /** Workspace package name (from package.json#name, normalized to kebab) or directory basename. */
  name: string;
  /** Path relative to the monorepo root, POSIX-style. */
  path: string;
  /** Preset suggested by the workspace's own stack (e.g. "medusa-v2", "nextjs"). */
  suggestedPreset: string;
  /** Framework dep that drove the preset suggestion (display hint only). */
  framework: string | null;
}

/**
 * Best-effort scan of a monorepo's workspace patterns.
 *
 * Reads `pnpm-workspace.yaml` first, then falls back to `package.json#workspaces`.
 * Expands glob patterns one segment at a time (supports apps slash star and
 * literal paths). Multi-segment double-star and partial globs like foo-star
 * are not supported in v1 — they cover <1% of real-world monorepos.
 *
 * For every expanded directory that has a `package.json`, runs `detectProject` to
 * derive a per-workspace preset suggestion. Returns deduped, path-sorted results.
 */
export function scanMonorepoWorkspaces(cwd: string): DetectedWorkspace[] {
  const patterns = collectWorkspacePatterns(cwd);
  if (patterns.length === 0) return [];

  const seen = new Set<string>();
  const results: DetectedWorkspace[] = [];

  for (const pattern of patterns) {
    for (const relPath of expandPattern(cwd, pattern)) {
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      const info = describeWorkspace(cwd, relPath);
      if (info) results.push(info);
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

// ============================================================
// Pattern collection
// ============================================================

// Workspace-pattern parsing lives in `workspace-patterns.ts` so `detect.ts`
// can reuse it without an import cycle (scan.ts imports detect.ts). Re-exported
// here so existing importers keep resolving these from "./scan.ts".
export { collectWorkspacePatterns, parsePnpmWorkspaceYaml, expandPattern } from "./workspace-patterns.ts";

// Glob expansion moved to workspace-patterns.ts (shared with detect.ts without
// an import cycle); re-exported below for existing importers.

// ============================================================
// Diff vs configured workspaces
// ============================================================

export interface ScanDiff {
  /** Workspaces present on disk but missing from config.monorepo.workspaces[]. */
  added: DetectedWorkspace[];
  /** Workspaces already in config (matched by path). */
  existing: MonorepoWorkspace[];
  /** Workspaces in config whose path no longer exists on disk. */
  orphan: MonorepoWorkspace[];
}

/**
 * Compare what the filesystem says vs what `navori.config.json` says.
 * Match is by `path` because `name` can drift (rename of package.json) while
 * the path stays stable. `orphan` catches stale config entries after the
 * user moved or deleted a workspace dir.
 */
export function diffWorkspaces(
  detected: DetectedWorkspace[],
  configured: MonorepoWorkspace[],
): ScanDiff {
  const detectedByPath = new Map(detected.map((d) => [d.path, d]));
  const configuredByPath = new Map(configured.map((c) => [c.path, c]));

  const added = detected.filter((d) => !configuredByPath.has(d.path));
  const existing = configured.filter((c) => detectedByPath.has(c.path));
  const orphan = configured.filter((c) => !detectedByPath.has(c.path));

  return { added, existing, orphan };
}

function describeWorkspace(cwd: string, relPath: string): DetectedWorkspace | null {
  const abs = join(cwd, relPath);
  if (!existsSync(join(abs, "package.json"))) return null;
  const project = detectProject(abs);
  return {
    name: project.name ?? relPath.split("/").pop()!,
    path: relPath,
    suggestedPreset: project.suggestedPreset,
    framework: project.stack.framework,
  };
}
