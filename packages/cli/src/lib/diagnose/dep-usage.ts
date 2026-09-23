/**
 * Best-effort import counting for dependency adoption gating. Library skills and
 * migration rules should reflect how much a dep is ACTUALLY used, not merely
 * that it's declared in package.json — a dep imported in one or two files earns
 * neither a full skill nor a "migrate away" rule (see lib/library-skills.ts,
 * issues #86/#92). This module walks the project tree once and, per tracked dep,
 * counts how many source files import it.
 */

import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

/** File extensions worth scanning for ES/CommonJS import specifiers. */
const SCAN_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
]);

/** Directories never worth descending into — vendored deps and build output. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "vendor",
  "__pycache__",
]);

/**
 * Safety bound on files read for a single scan. Real repos stay well under this;
 * the cap just keeps a pathological tree from stalling `init`. Counts are only
 * used against thresholds, so a truncated scan degrades gracefully.
 */
const MAX_FILES = 12_000;

/** Escape a dep name for use inside a RegExp (npm names carry `.`, `-`, `@`, `/`). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Count, per dependency, how many source files under `projectRoot` import it.
 * Heuristic: a file counts (at most once per dep) when it contains an import
 * specifier equal to the dep or one of its subpaths — `'axios'`, `"axios/foo"`,
 * `'@mantine/form'` — which is how the dep appears in `import … from`,
 * `import('…')`, and `require('…')`. Distinct from siblings by construction:
 * the `axios` matcher ignores `'axios-retry'`, `react` ignores `'react-dom'`.
 *
 * Best-effort and non-throwing: unreadable files/dirs are skipped silently.
 * Only the `depNames` handed in are matched, bounding the per-file work.
 */
export function countDepImports(
  projectRoot: string,
  depNames: ReadonlyArray<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of depNames) counts.set(d, 0);
  if (depNames.length === 0) return counts;

  const matchers = depNames.map((dep) => ({
    dep,
    // A quoted specifier: the dep itself, or the dep followed by a `/subpath`.
    re: new RegExp(`['"]${escapeRegExp(dep)}(?:/[^'"]*)?['"]`),
  }));

  let budget = MAX_FILES;

  const walk = (dir: string): void => {
    if (budget <= 0) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      if (budget <= 0) return;
      const name = entry.name;
      if (entry.isDirectory()) {
        // Skip vendored/build dirs and every dotfolder (.git, .claude, …).
        if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
        walk(join(dir, name));
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = name.lastIndexOf(".");
      if (dot < 0 || !SCAN_EXTENSIONS.has(name.slice(dot))) continue;
      budget -= 1;
      let text: string;
      try {
        text = readFileSync(join(dir, name), "utf-8");
      } catch {
        continue; // unreadable file — skip
      }
      for (const m of matchers) {
        if (m.re.test(text)) counts.set(m.dep, (counts.get(m.dep) ?? 0) + 1);
      }
    }
  };

  walk(projectRoot);
  return counts;
}
