/**
 * Nested agent worktrees vs. tools that resolve their config by walking UP the
 * directory tree (#522).
 *
 * The harness creates agent worktrees INSIDE the repo, at
 * `.claude/worktrees/<id>/`, and each one is a full checkout that gets its own
 * `node_modules` the moment the agent installs. eslint then resolves config
 * upward from the file it lints, so a run started inside a worktree loads the
 * worktree's config AND the parent repo's — two configs, two installs of the
 * same plugin, and a fatal error:
 *
 *   ESLint couldn't determine the plugin "reactotron" uniquely.
 *
 * The visible failure is never that error, though: repos run eslint from a
 * pre-commit hook, so the agent simply cannot commit, its branch is never
 * pushed, and what a human finds weeks later is "abandoned worktrees" with
 * gigabytes and unpublished work in them (measured: 3 worktrees, 2.6 GB, 3
 * unpushed branches, 6 files that existed nowhere else). Doctor cannot fix the
 * layout, but naming the cause is the difference between a known constraint and
 * silent data loss.
 *
 * eslint is the one member of this class that fails FATALLY (prettier, a
 * `tsconfig` with `extends`, jest's `rootDir` and babel resolve upward too, and
 * degrade quietly), so the check is scoped to it on purpose rather than
 * guessing at the rest.
 *
 * Deliberately CHEAP and read-only: two `readdir`s and at most one small JSON
 * parse. It reports; it never deletes a worktree — they may hold uncommitted
 * work, which is exactly the failure mode being reported.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Repo-relative home of the agent worktrees (see EPHEMERAL_HARNESS_PATHS). */
const WORKTREES_DIR = ".claude/worktrees";

/** eslintrc-style config: `.eslintrc` plus its `.js/.cjs/.mjs/.json/.yaml/.yml`
 *  variants. This is the family whose cascade produces the fatal duplicate. */
const ESLINTRC_RE = /^\.eslintrc(\.(?:[cm]?js|json|ya?ml))?$/;

/** Flat config (`eslint.config.js` and its ts/cjs/mjs variants). It does not
 *  cascade the same way, but a parent config still reaches into the nested
 *  checkout (linting thousands of copied files), so it counts as a config. */
const ESLINT_FLAT_RE = /^eslint\.config\.[cm]?[jt]s$/;

export interface NestedWorktreeConflict {
  /** Repo-relative eslint config a nested run also resolves — a filename, or
   *  `package.json#eslintConfig` when the config lives in the manifest. */
  eslintConfig: string;
  /** Repo-relative paths of the nested worktrees carrying their own install,
   *  sorted. A worktree without `node_modules` cannot duplicate a plugin, so it
   *  is not reported. */
  worktrees: string[];
}

/**
 * Report nested agent worktrees that carry their own `node_modules` while the
 * repo declares an eslint config. Null when either half is missing — a repo
 * with no eslint config has nothing to duplicate, and worktrees with no install
 * resolve nothing upward.
 */
export function scanNestedWorktrees(cwd: string): NestedWorktreeConflict | null {
  const worktrees = installedWorktrees(cwd);
  if (worktrees.length === 0) return null;
  const eslintConfig = findEslintConfig(cwd);
  if (eslintConfig === null) return null;
  return { eslintConfig, worktrees };
}

/** Nested worktrees that have their own `node_modules`. Unreadable or missing
 *  worktree dir (the common case) is simply "none". */
function installedWorktrees(cwd: string): string[] {
  const root = join(cwd, WORKTREES_DIR);
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries
    .filter((name) => existsSync(join(root, name, "node_modules")))
    .map((name) => `${WORKTREES_DIR}/${name}`)
    .sort();
}

/** The repo's eslint config, or null when it has none. */
function findEslintConfig(cwd: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return null;
  }
  // Sorted so a repo carrying two configs always reports the same one.
  const [match] = entries.filter((n) => ESLINTRC_RE.test(n) || ESLINT_FLAT_RE.test(n)).sort();
  if (match !== undefined) return match;
  return hasEslintConfigKey(join(cwd, "package.json")) ? "package.json#eslintConfig" : null;
}

/** True when package.json carries an `eslintConfig` key (the third supported
 *  location). Malformed/absent manifest → false, never a throw. */
function hasEslintConfigKey(packageJsonPath: string): boolean {
  try {
    const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    return typeof pkg === "object" && pkg !== null && "eslintConfig" in pkg;
  } catch {
    return false;
  }
}
