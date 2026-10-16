import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec 0054 R11 / D3 — `bun run test:affected`.
 *
 * Runs only the tests a change can reach. It is a time shortcut for the
 * iteration loop, NOT a gate: the closing full gate and CI `quality` back it.
 * Routing lives in the pure `planAffected` so it is testable without git.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const CLI = "packages/cli";
const TESTS_ROOT = `${CLI}/src/`;

/** Config, toolchain and lockfile changes can alter any test: run everything. */
const FULL_SUITE_NAME = /^(vitest\..*|tsconfig.*\.json|package\.json|bun\.lockb?|bunfig\.toml)$/;

/** Files whose content feeds `dist/` (mirrors ensure-dist.ts D2). */
function isDistInput(path) {
  if (path.startsWith(TESTS_ROOT)) return !path.split("/").includes("__tests__");
  return (
    path.startsWith("packages/core/") ||
    path.startsWith("packages/plugins/") ||
    [
      `${CLI}/tsdown.config.ts`,
      `${CLI}/scripts/copy-assets.mjs`,
      `${CLI}/scripts/bundle-comments.ts`,
      `${CLI}/scripts/bundle-render-data.ts`,
    ].includes(path)
  );
}

const isTestFile = (path) => path.startsWith(TESTS_ROOT) && path.endsWith(".test.ts");
const isRenderOrGolden = (path) =>
  path.includes("/render/__tests__/") || basename(path).startsWith("golden-");

/**
 * @typedef {{ path: string, deleted: boolean }} Change
 * @typedef {{
 *   changes: Change[],
 *   hasMergeBase: boolean,
 *   testFiles: string[],
 *   grep: (needle: string) => string[],
 * }} PlanInput
 * @typedef {{
 *   full: boolean,
 *   reason: string,
 *   related: string[],
 *   tests: string[],
 * }} Plan
 */

/**
 * Decides what to run. Paths are repo-relative. `testFiles` is every
 * `*.test.ts` in the package; `grep` returns the test files whose text contains
 * a literal. Deleted files never reach `vitest related` (it errors on them):
 * they select the tests that still name them.
 *
 * @param {PlanInput} input
 * @returns {Plan}
 */
export function planAffected({ changes, hasMergeBase, testFiles, grep }) {
  if (!hasMergeBase) return { full: true, reason: "no merge-base with origin/dev or dev", related: [], tests: [] };
  const trigger = changes.find((c) => FULL_SUITE_NAME.test(basename(c.path)));
  if (trigger) return { full: true, reason: `${trigger.path} can affect every test`, related: [], tests: [] };

  const related = new Set();
  const tests = new Set();
  const addAll = (paths) => paths.forEach((p) => tests.add(p));
  const known = new Set(testFiles);

  for (const { path, deleted } of changes) {
    if (isTestFile(path)) {
      if (!deleted && known.has(path)) tests.add(path);
      continue;
    }
    if (isDistInput(path)) addAll(grep("dist/index.js"));
    if (path.startsWith("packages/core/core-assets/")) addAll(testFiles.filter(isRenderOrGolden));
    if (path.startsWith(TESTS_ROOT) && path.endsWith(".ts")) {
      if (deleted) {
        addAll(grep(path));
        addAll(grep(basename(path, ".ts")));
      } else {
        related.add(path);
      }
      continue;
    }
    addAll(grep(path));
  }
  const live = (p) => known.has(p);
  return { full: false, reason: "", related: [...related].sort(), tests: [...tests].filter(live).sort() };
}

function git(args) {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : null;
}

function mergeBase() {
  for (const ref of ["origin/dev", "dev"]) {
    const out = git(["merge-base", "HEAD", ref]);
    if (out !== null && out.trim() !== "") return out.trim();
  }
  return null;
}

/** Repo-relative changed paths: committed since the merge-base, modified, untracked and deleted. */
function collectChanges(base) {
  const committed = git(["diff", "--name-only", "--no-renames", base]) ?? "";
  const dirty = git(["ls-files", "-m", "-o", "-d", "--exclude-standard"]) ?? "";
  const paths = new Set([...committed.split("\n"), ...dirty.split("\n")].filter(Boolean));
  return [...paths].sort().map((path) => ({ path, deleted: !existsSync(join(REPO_ROOT, path)) }));
}

/** Runs vitest from the package root; returns its exit status. */
function vitest(args) {
  const r = spawnSync("bun", ["x", "vitest", ...args], { cwd: PACKAGE_ROOT, stdio: "inherit" });
  return r.status ?? 1;
}

function main() {
  process.stdout.write("test:affected: affected subset, not a gate\n");
  const base = mergeBase();
  const changes = base === null ? [] : collectChanges(base);
  const testFiles = (git(["ls-files", "-co", "--exclude-standard", "--", `${TESTS_ROOT}`]) ?? "")
    .split("\n")
    .filter((p) => p.endsWith(".test.ts") && existsSync(join(REPO_ROOT, p)));
  const plan = planAffected({
    changes,
    hasMergeBase: base !== null,
    testFiles,
    grep: (needle) => {
      const out = git(["grep", "-l", "-F", "--untracked", "-e", needle, "--", `${TESTS_ROOT}`]);
      return (out ?? "").split("\n").filter((p) => p.endsWith(".test.ts"));
    },
  });
  const rel = (p) => p.slice(`${CLI}/`.length);
  if (plan.full) {
    process.stdout.write(`test:affected: running the full suite (${plan.reason})\n`);
    return vitest(["run"]);
  }
  if (plan.related.length === 0 && plan.tests.length === 0) {
    process.stdout.write("test:affected: no affected tests\n");
    return 0;
  }
  let status = 0;
  if (plan.related.length > 0) {
    process.stdout.write(`test:affected: related to ${plan.related.length} changed source file(s)\n`);
    status = vitest(["related", "--run", ...plan.related.map(rel)]);
  }
  if (plan.tests.length > 0) {
    process.stdout.write(`test:affected: ${plan.tests.length} selected test file(s)\n`);
    status = vitest(["run", ...plan.tests.map(rel)]) || status;
  }
  return status;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
