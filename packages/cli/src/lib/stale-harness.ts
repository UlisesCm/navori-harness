import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { NavoriConfig } from "./config.ts";

/**
 * Harness files no render will ever refresh again (spec 0018 R6).
 *
 * Two shapes, one problem: the content is frozen at whatever navori version
 * wrote it, and nothing on disk says so.
 *
 *   1. `undeclared-workspace` — a `.claude/` living in a subdirectory the
 *      config does not declare as a monorepo workspace. The render loop only
 *      visits declared workspaces, so this tree is invisible to it. Real case
 *      in navori's own repo: `packages/cli/.claude/`, frozen at 0.6.5.
 *
 *   2. `trimmed-workspace` — `.claude/scripts/` left inside a DECLARED
 *      workspace after `workspaceHarness: "minimal"` stopped writing it. The
 *      render deliberately does not delete these: a plugin script is the one
 *      file navori generates without a proof of authorship (`scriptAssets` has
 *      no `managedId`, unlike hooks/agents/skills), and navori never deletes
 *      what it cannot prove it wrote. So the render goes quiet and doctor says
 *      it once, here, where a human is already looking.
 *
 * Both are reported, never touched. And both are FINITE: delete them once and
 * nothing recreates them, because the render that stopped writing them is the
 * one that will keep not writing them.
 */

/** How deep to look for a stray `.claude/`. Deep enough for `apps/x/y`, cheap. */
const MAX_DEPTH = 3;

/** Directories never worth walking — big, and never harness. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
]);

export interface StaleHarness {
  /** Repo-relative path of the frozen directory. */
  path: string;
  /** Why no render reaches it. */
  reason: "undeclared-workspace" | "trimmed-workspace";
  /** Oldest navori version stamped inside, or null when nothing carries one. */
  frozenAt: string | null;
  /** How many files sit there. */
  files: number;
}

const VERSION_STAMP = /navori:managed[^\n]*version="([0-9]+\.[0-9]+\.[0-9]+)"/;

/** Compare two `x.y.z` strings numerically; the oldest wins. */
function older(a: string | null, b: string): string {
  if (a === null) return b;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? a : b;
  }
  return a;
}

/** File count and the OLDEST version stamp found under `dir`. */
function surveyDir(dir: string, depth = 0): { files: number; frozenAt: string | null } {
  let files = 0;
  let frozenAt: string | null = null;
  if (depth > MAX_DEPTH + 2) return { files, frozenAt };
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { files, frozenAt };
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      const sub = surveyDir(full, depth + 1);
      files += sub.files;
      if (sub.frozenAt !== null) frozenAt = older(frozenAt, sub.frozenAt);
      continue;
    }
    files += 1;
    try {
      const stamp = VERSION_STAMP.exec(readFileSync(full, "utf-8"))?.[1];
      if (stamp !== undefined) frozenAt = older(frozenAt, stamp);
    } catch {
      // unreadable or binary — it still counts as a file, just not as a stamp
    }
  }
  return { files, frozenAt };
}

/** Every `<subdir>/.claude` under `cwd`, excluding the root's own. */
function findNestedClaudeDirs(cwd: string, dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() && !SKIP_DIRS.has(d.name) ? [d.name] : [],
    );
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (name === ".claude") {
      if (full !== join(cwd, ".claude")) out.push(relative(cwd, full));
      continue; // never walk INTO a harness dir looking for another
    }
    findNestedClaudeDirs(cwd, full, depth + 1, out);
  }
}

/**
 * Frozen harness directories in this repo. Empty for the overwhelming case — a
 * single-package repo, or a monorepo whose every `.claude/` is declared.
 */
export function scanStaleHarness(cwd: string, config: NavoriConfig): StaleHarness[] {
  const declared = new Set(
    (config.monorepo?.workspaces ?? []).map((w) => join(w.path, ".claude").replace(/\\/g, "/")),
  );
  const out: StaleHarness[] = [];

  const nested: string[] = [];
  findNestedClaudeDirs(cwd, cwd, 0, nested);
  for (const rel of nested) {
    const normalized = rel.replace(/\\/g, "/");
    if (declared.has(normalized)) continue;
    const survey = surveyDir(join(cwd, rel));
    if (survey.files === 0) continue;
    out.push({ path: normalized, reason: "undeclared-workspace", ...survey });
  }

  // The trimmed leftovers live INSIDE a declared workspace, so the loop above
  // skipped them by design.
  if (config.monorepo?.workspaceHarness === "minimal") {
    for (const ws of config.monorepo.workspaces ?? []) {
      const rel = join(ws.path, ".claude", "scripts").replace(/\\/g, "/");
      if (!existsSync(join(cwd, rel))) continue;
      const survey = surveyDir(join(cwd, rel));
      if (survey.files === 0) continue;
      out.push({ path: rel, reason: "trimmed-workspace", ...survey });
    }
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}
