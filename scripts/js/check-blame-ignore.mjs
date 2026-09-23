import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #1002 — `.git-blame-ignore-revs` entries were never validated, only trusted.
 *
 * Two ways an entry rots silently:
 *   1. A squash-merge rewrites the SHA. The pre-squash commits stop being
 *      ancestors of `main` the moment the PR merges, so an entry that once
 *      pointed at real history now points at nothing `git blame` will ever
 *      walk through — a no-op nobody notices (#986 did exactly this: the
 *      PR-branch commits `02c28377`/`5c508829` were never ancestors of the
 *      squash-merged `main`).
 *   2. The entry is NOT actually mechanical: it changes behavior, not just
 *      formatting, so skipping it in `git blame` hides real authorship of
 *      real logic — the opposite of what the file is for.
 *
 * This check enforces both, against `origin/main` specifically — NOT the
 * current branch. A PR-branch check that validates ancestry against its own
 * branch goes green and still breaks the moment that branch squash-merges
 * (see #986 above): the branch's pre-squash commits are ancestors of
 * themselves, but never of the `main` that results from the squash.
 *
 * Content verification is a normalized-equality diff against the first
 * parent (`-M` for rename detection): any Added or Deleted file fails
 * outright, and every Modified/Renamed file must reduce to the same content
 * once whitespace, `,`/`;`/`(`/`)`, quote style and import/export module
 * specifiers are normalized away. This is deliberately coarser than "run the
 * formatter and diff" (which would require pinning and invoking the exact
 * tool version that produced each historical entry) — it is what makes a pure
 * oxfmt reformat (#889, entry `9f886f8d`) and an import-path rewrite both
 * verifiable with the same rule, while still failing on a content rewrite
 * like a literal string changing.
 *
 * Requires full history: `git merge-base --is-ancestor` cannot answer against
 * a shallow clone. CI checks out with `fetch-depth: 0` (`.github/workflows/ci.yml`)
 * precisely so this check can run; a shallow local clone fails loud (see
 * `resolveOriginMain` below), never silently.
 *
 * Usage: node scripts/js/check-blame-ignore.mjs
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IGNORE_FILE = resolve(REPO_ROOT, ".git-blame-ignore-revs");

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" });
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** SHAs listed in the file, `#` comments and blank lines dropped. */
function parseEntries(content) {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * `origin/main`'s resolved commit, or a hard failure — never a silent
 * fallback to the current branch. Ancestry must be checked against the branch
 * that will actually ship, not the branch making the check (see file header).
 */
function resolveOriginMain() {
  try {
    return git(["rev-parse", "--verify", "origin/main^{commit}"]).trim();
  } catch {
    fail(
      "origin/main could not be resolved — fetch it first (`git fetch origin main`). " +
        "CI checks out with fetch-depth: 0 for this reason; a shallow local clone needs the same fetch by hand.",
    );
  }
}

/** Whether `sha` resolves to a real commit. */
function resolveCommit(sha) {
  try {
    return git(["rev-parse", "--verify", `${sha}^{commit}`]).trim();
  } catch {
    return null;
  }
}

/** `git merge-base --is-ancestor` exits 0 iff `sha` is an ancestor of `mainSha`. */
function isAncestor(sha, mainSha) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, mainSha], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** `{ status: "A"|"D"|"M"|"R100", paths: [old?, new] }` per changed file. */
function diffNameStatus(parentSha, sha) {
  const out = git(["diff", "-M", "--name-status", parentSha, sha]).trim();
  if (out === "") return [];
  return out.split("\n").map((line) => {
    const [status, ...paths] = line.split("\t");
    return { status, paths };
  });
}

// Anchored to REAL module specifiers, matched on the raw (pre-strip) text —
// a `from`/`import` keyword directly followed by a quoted string, never a
// member call. `.from("table")` (a Supabase query builder call, say) has a
// `(` between `from` and the quote, so none of these match it: only a static
// `import ... from "x"` (including the closing `} from "x";` line of a
// multi-line import), a bare side-effect `import "x";`, or a dynamic
// `import("x")` reduce to a blanked specifier. Order matters: DYNAMIC_IMPORT
// must run before SIDE_EFFECT_IMPORT, or the latter's `\bimport\s+` (which
// requires real whitespace, not `(`) would never see the untouched text.
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'`])(?:\\.|(?!\1).)*\1\s*\)/g;
const FROM_CLAUSE = /\bfrom\s+(["'`])(?:\\.|(?!\1).)*\1/g;
const SIDE_EFFECT_IMPORT = /\bimport\s+(["'`])(?:\\.|(?!\1).)*\1/g;

function normalize(content) {
  const blanked = content
    .replace(DYNAMIC_IMPORT, 'import("")')
    .replace(FROM_CLAUSE, 'from ""')
    .replace(SIDE_EFFECT_IMPORT, 'import ""');
  return blanked
    .replace(/\s+/g, "")
    .replace(/[,;()]/g, "")
    .replace(/[`']/g, '"');
}

function showBlob(rev, path) {
  return git(["show", `${rev}:${path}`]);
}

/**
 * Verifies one entry's content is mechanical: no added/deleted file, and
 * every modified/renamed file normalizes to identical content on both sides.
 * Returns a list of human-readable problems (empty = mechanical).
 */
function checkContent(sha, parentSha) {
  const problems = [];
  for (const { status, paths } of diffNameStatus(parentSha, sha)) {
    if (status.startsWith("A")) {
      problems.push(`added file ${paths[0]}`);
      continue;
    }
    if (status.startsWith("D")) {
      problems.push(`deleted file ${paths[0]}`);
      continue;
    }
    const [oldPath, newPath] = status.startsWith("R") ? paths : [paths[0], paths[0]];
    const oldContent = normalize(showBlob(parentSha, oldPath));
    const newContent = normalize(showBlob(sha, newPath));
    if (oldContent !== newContent) {
      problems.push(`non-mechanical change in ${newPath}${oldPath !== newPath ? ` (was ${oldPath})` : ""}`);
    }
  }
  return problems;
}

function main() {
  if (!existsSync(IGNORE_FILE)) {
    console.log("✓ no .git-blame-ignore-revs file — nothing to validate");
    process.exit(0);
  }

  const entries = parseEntries(readFileSync(IGNORE_FILE, "utf-8"));
  if (entries.length === 0) {
    console.log("✓ .git-blame-ignore-revs has zero entries");
    process.exit(0);
  }

  const mainSha = resolveOriginMain();
  const failures = [];

  for (const sha of entries) {
    const commit = resolveCommit(sha);
    if (!commit) {
      failures.push(`${sha}: does not resolve to a commit`);
      continue;
    }
    if (!isAncestor(commit, mainSha)) {
      failures.push(
        `${sha}: not an ancestor of origin/main — a squash merge likely rewrote it; ` +
          "point the entry at the actual merge commit instead",
      );
      continue;
    }
    let parent;
    try {
      parent = git(["rev-parse", `${commit}^`]).trim();
    } catch {
      failures.push(`${sha}: is a root commit with no parent — cannot verify a mechanical diff`);
      continue;
    }
    const problems = checkContent(commit, parent);
    if (problems.length > 0) {
      failures.push(`${sha}: not mechanical — ${problems.join("; ")}`);
    }
  }

  if (failures.length > 0) {
    fail(`.git-blame-ignore-revs has ${failures.length} invalid entr${failures.length === 1 ? "y" : "ies"}:\n  ${failures.join("\n  ")}`);
  }

  console.log(`✓ every entry in .git-blame-ignore-revs is an ancestor of origin/main with a mechanical diff (${entries.length} checked)`);
  process.exit(0);
}

main();
