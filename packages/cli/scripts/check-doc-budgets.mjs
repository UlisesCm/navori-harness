import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #815 — extends the word-cap primitive from `SKILL_TYPE_CAPS`
 * (`packages/cli/src/lib/skill-meta.ts`) to the prose that grows unchecked:
 * root `CLAUDE.md` and the managed blocks under
 * `packages/core/core-assets/managed/*.md`. Both render into every session,
 * so an unbounded one grows by accretion — a session that learns something
 * appends, and none of them prune.
 *
 * `countWords` below is a deliberate duplicate of `skill-meta.ts`'s function,
 * not an import: that module is TypeScript compiled by tsup, and this script
 * runs as plain Node before any build step (`check:doc-budgets` has no build
 * dependency, same as `check-links.mjs`). Keep both in sync by hand if either
 * changes — they are one line each, so the drift risk is small next to
 * bundling a whole build step just to reuse it.
 *
 * Three fail modes:
 *  1. A budgeted file exceeds its ceiling.
 *  2. A budgeted file no longer exists — you cannot dodge the ceiling by
 *     renaming or deleting; update the manifest in the SAME change instead.
 *  3. A managed `.md` under `core-assets/managed/` is missing from the
 *     manifest entirely. Deliberate: an unbudgeted managed block is a ceiling
 *     nobody set, which is how a NEW block ships unchecked from day one.
 *     `CLAUDE.md` itself is not auto-discovered (it is not under
 *     `core-assets/managed/`) — it is required in the manifest below instead.
 *
 * Usage:
 *   node packages/cli/scripts/check-doc-budgets.mjs           # fail on violation
 *   node packages/cli/scripts/check-doc-budgets.mjs --list    # print, exit 0
 *
 * #815's own acceptance criterion required a ceiling raise to leave ≥5%
 * headroom (margin / actual word count) and document why — but that policy
 * lived only in prose (the #815 issue body and PR #855's description), so
 * nothing enforced it. Two later raises (`c7718ab0`, `ac8ec4fb`/#887) bumped
 * `CLAUDE.md`'s ceiling by exactly the amount needed to pass, with no
 * headroom and no documented reason, and the gate silently let them through
 * — that's how #908 (CLAUDE.md at 2548/2550, margin 2) happened. Below, a
 * margin under 5% now prints a WARNING (not a failure): a hard error here
 * would turn "a file approached its cap" into a red gate for every unrelated
 * PR that merely adds a sentence to a file someone else is about to touch —
 * fragile and unrelated to that PR's own change. A warning surfaces the
 * erosion early (the actual #908 ask) without blocking work that didn't
 * cause it. Exceeding the cap outright stays a hard failure below,
 * unchanged.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const MANIFEST_PATH = resolve(HERE, "doc-budgets.manifest.json");
const MANAGED_DIR = resolve(REPO_ROOT, "packages/core/core-assets/managed");

/** Word counter mirrored from `skill-meta.ts`'s `countWords` — see the docblock above. */
function countWords(body) {
  const trimmed = body.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const manifestPaths = new Set(Object.keys(manifest));

const managedFiles = execFileSync("git", ["ls-files", "*.md"], {
  cwd: MANAGED_DIR,
  encoding: "utf-8",
})
  .split("\n")
  .filter(Boolean)
  .map((rel) => `packages/core/core-assets/managed/${rel}`);

const unbudgeted = managedFiles.filter((rel) => !manifestPaths.has(rel)).sort();

const rows = [];
const overBudget = [];
const missing = [];

for (const [rel, ceiling] of Object.entries(manifest)) {
  const abs = resolve(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    missing.push(rel);
    continue;
  }
  const words = countWords(readFileSync(abs, "utf-8"));
  const margin = ceiling - words;
  rows.push({ rel, words, ceiling, margin });
  if (words > ceiling) overBudget.push({ rel, words, ceiling });
}

const listMode = process.argv.includes("--list");

if (listMode) {
  for (const { rel, words, ceiling, margin } of rows.sort((a, b) => a.rel.localeCompare(b.rel))) {
    console.log(`${rel}: ${words}/${ceiling} words (margin ${margin})`);
  }
  process.exit(0);
}

if (missing.length > 0) {
  console.error(`✗ doc budgets: ${missing.length} budgeted file(s) no longer exist:`);
  for (const rel of missing) {
    console.error(`    ${rel} (renamed or deleted? update packages/cli/scripts/doc-budgets.manifest.json in the same change)`);
  }
  process.exit(1);
}

if (unbudgeted.length > 0) {
  console.error(`✗ doc budgets: ${unbudgeted.length} managed file(s) missing from the manifest:`);
  for (const rel of unbudgeted) {
    console.error(`    ${rel} (add it to packages/cli/scripts/doc-budgets.manifest.json with a ceiling)`);
  }
  process.exit(1);
}

if (overBudget.length > 0) {
  console.error(`✗ doc budgets: ${overBudget.length} file(s) over their word ceiling:`);
  for (const { rel, words, ceiling } of overBudget) {
    console.error(`    ${rel}: ${words} words > ${ceiling} ceiling`);
  }
  process.exit(1);
}

// #908 — headroom = margin as a fraction of the actual word count (the same
// basis #815 used: "2220 actual words, 5.85% headroom"). A file with 0 words
// has no meaningful ratio; skip it rather than divide by zero.
const lowHeadroom = rows.filter(({ words, margin }) => words > 0 && margin / words < 0.05);
if (lowHeadroom.length > 0) {
  console.warn(`⚠ doc budgets: ${lowHeadroom.length} file(s) below 5% headroom:`);
  for (const { rel, words, ceiling, margin } of lowHeadroom) {
    const pct = ((margin / words) * 100).toFixed(1);
    console.warn(`    ${rel}: ${words}/${ceiling} words (${pct}% headroom, < 5%)`);
  }
}

console.log(`✓ doc budgets: ${rows.length} file(s) within their word ceiling`);
