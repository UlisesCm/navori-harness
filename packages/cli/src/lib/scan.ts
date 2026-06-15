import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { detectProject } from "./detect.ts";

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

/**
 * Pull workspace patterns from whichever source the monorepo uses.
 * `pnpm-workspace.yaml` wins because it's the canonical source for pnpm
 * workspaces — `package.json#workspaces` may exist alongside it but pnpm
 * ignores it. For npm/yarn/turbo without pnpm, `package.json#workspaces`
 * is the only source.
 */
export function collectWorkspacePatterns(cwd: string): string[] {
  const pnpmYaml = join(cwd, "pnpm-workspace.yaml");
  if (existsSync(pnpmYaml)) {
    try {
      return parsePnpmWorkspaceYaml(readFileSync(pnpmYaml, "utf-8"));
    } catch {
      return [];
    }
  }

  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8").replace(/^﻿/, "")) as {
        workspaces?: unknown;
      };
      return readPackageJsonWorkspaces(pkg.workspaces);
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Minimal YAML extractor for `packages:` in `pnpm-workspace.yaml`.
 * Handles the two common shapes:
 *   packages:
 *     - 'apps/*'
 *     - "packages/*"
 * and
 *   packages: ['apps/*', "packages/*"]
 *
 * Ignores negation patterns (`!apps/excluded`) — pnpm supports them but they
 * complicate scan UX (we'd need to apply them after expansion). Out of scope
 * for Fase 3; rare in the wild.
 */
export function parsePnpmWorkspaceYaml(content: string): string[] {
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = line.match(/^packages\s*:\s*(.*)$/);
    if (m) {
      const inline = m[1]!.trim();
      if (inline.startsWith("[")) {
        return parseInlineYamlArray(inline);
      }
      // Block form: read indented `- value` lines that follow.
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i]!;
        if (/^\s*#/.test(cur) || /^\s*$/.test(cur)) {
          i++;
          continue;
        }
        const itemMatch = cur.match(/^\s+-\s+(.+?)\s*(?:#.*)?$/);
        if (!itemMatch) break;
        const raw = itemMatch[1]!.trim();
        const unquoted = stripYamlQuotes(raw);
        if (unquoted && !unquoted.startsWith("!")) items.push(unquoted);
        i++;
      }
      return items;
    }
    i++;
  }
  return [];
}

function parseInlineYamlArray(inline: string): string[] {
  const closed = inline.lastIndexOf("]");
  if (closed < 0) return [];
  const body = inline.slice(1, closed);
  return body
    .split(",")
    .map((s) => stripYamlQuotes(s.trim()))
    .filter((s) => s && !s.startsWith("!"));
}

function stripYamlQuotes(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0]!;
    const last = raw[raw.length - 1]!;
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/**
 * `package.json#workspaces` may be either:
 *   - `["apps/*", "packages/*"]`
 *   - `{ "packages": ["apps/*"], "nohoist": [...] }`  (yarn-style)
 */
function readPackageJsonWorkspaces(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string" && !s.startsWith("!"));
  }
  if (raw && typeof raw === "object" && "packages" in raw) {
    const pkgs = (raw as { packages?: unknown }).packages;
    if (Array.isArray(pkgs)) {
      return pkgs.filter((s): s is string => typeof s === "string" && !s.startsWith("!"));
    }
  }
  return [];
}

// ============================================================
// Glob expansion
// ============================================================

/**
 * Expand one workspace pattern into concrete relative paths under `cwd`.
 *
 * Supports per-segment `*` and literal paths. Double-star and partial-segment
 * globs like `foo-X` (where X is `*`) are treated as literals, so they will
 * only match if a directory with that literal name exists. This is intentional:
 * monorepos in the wild almost always use single-star patterns, and the cost
 * of a real glob lib (~80kb to add picomatch) isn't worth it for the long tail.
 */
export function expandPattern(cwd: string, pattern: string): string[] {
  const segments = pattern.split("/").filter(Boolean);
  if (segments.length === 0) return [];
  return walk(cwd, [], segments);
}

function walk(cwd: string, accum: string[], remaining: string[]): string[] {
  if (remaining.length === 0) {
    return [accum.join("/")];
  }
  const [head, ...tail] = remaining;
  const currentRel = accum.join("/");
  const currentAbs = currentRel ? join(cwd, currentRel) : cwd;

  if (head === "*") {
    if (!existsSync(currentAbs)) return [];
    let entries;
    try {
      entries = readdirSync(currentAbs, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .flatMap((d) => walk(cwd, [...accum, d.name], tail));
  }

  // Literal segment (or unsupported partial glob — treated as literal).
  const next = join(currentAbs, head!);
  if (!existsSync(next)) return [];
  return walk(cwd, [...accum, head!], tail);
}

// ============================================================
// Per-workspace describe
// ============================================================

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
