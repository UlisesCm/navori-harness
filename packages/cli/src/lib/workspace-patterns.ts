import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Workspace-pattern extraction shared by monorepo detection and scanning.
 *
 * Lives in its own module (not `scan.ts`) because `detect.ts` needs it too,
 * and `scan.ts` imports `detect.ts` — putting these helpers there would create
 * an import cycle. These functions are pure (fs + parsing only).
 */

/**
 * Pull workspace patterns from whichever source the monorepo uses.
 * `pnpm-workspace.yaml` wins because it's the canonical source for pnpm
 * workspaces — `package.json#workspaces` may exist alongside it but pnpm
 * ignores it. For npm/yarn/turbo without pnpm, `package.json#workspaces`
 * is the only source.
 *
 * Returns `[]` when no real package patterns are declared. Callers use that
 * to tell a true monorepo from a single-package repo that merely ships a
 * `pnpm-workspace.yaml` for build config (e.g. `onlyBuiltDependencies`).
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

/**
 * Expand one workspace pattern into concrete relative paths under `cwd`.
 *
 * Supports per-segment `*` and literal paths. Double-star and partial-segment
 * globs like `foo-X` (where X is `*`) are treated as literals, so they only
 * match if a directory with that literal name exists. Intentional: real-world
 * monorepos almost always use single-star patterns, and a real glob lib (~80kb)
 * isn't worth the long tail. Lives here (not scan.ts) so `detect.ts` can reuse
 * it without the scan.ts → detect.ts import cycle.
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
