import { execFileSync, spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { withoutRepoGitEnv } from "./git-env.mjs";

/**
 * Runs only the CLI tests related to the changed files (`vitest related`).
 *
 * Without arguments it reads the staged files (the pre-commit pass); with
 * `--base <ref>` it reads `git diff <ref>...HEAD` (the `dev` CI pass).
 * Anything outside `packages/cli/src` has no Vitest graph to follow, so it is
 * left to the full gate that PRs to `main` run.
 */

const CLI_DIR = "packages/cli";
const CLI_SRC = `${CLI_DIR}/src/`;

/** @param {string[]} args @returns {string} */
function git(...args) {
  return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

/** @param {string[]} argv @returns {string[]} */
function changedFiles(argv) {
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex === -1 ? undefined : argv[baseIndex + 1];
  if (baseIndex !== -1 && !base) throw new Error("--base needs a ref");
  // A push that creates the branch reports an all-zero `before`: nothing to
  // diff against, so fall back to the branch `dev` is cut from.
  if (base && /^0+$/.test(base)) return diffNames("origin/main...HEAD");
  return base ? diffNames(`${base}...HEAD`) : diffNames("--cached");
}

/** @param {string} range @returns {string[]} */
function diffNames(range) {
  return git("diff", "--name-only", "--diff-filter=ACMR", range).split("\n").filter(Boolean);
}

const root = git("rev-parse", "--show-toplevel");
const cliRoot = resolve(root, CLI_DIR);
const targets = changedFiles(process.argv.slice(2))
  .filter((f) => f.startsWith(CLI_SRC) && /\.tsx?$/.test(f))
  .map((f) => relative(cliRoot, resolve(root, f)));

if (targets.length === 0) {
  console.log("⊘ test:related: no changed files under packages/cli/src — skip");
  process.exit(0);
}

// Our own `git diff --cached` above needs the inherited env (it reads the
// commit's index); Vitest does not, and its fixtures must not reach this repo.
console.log(`▶ test:related: ${targets.length} changed file(s)`);
const result = spawnSync(
  "bun",
  ["x", "vitest", "related", "--run", "--passWithNoTests", ...targets],
  { cwd: cliRoot, stdio: "inherit", env: withoutRepoGitEnv(process.env) },
);
process.exit(result.status ?? 1);
