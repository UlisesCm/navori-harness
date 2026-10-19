import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Root-level utilities stay outside the package's TypeScript rootDir (as in bench-tests.mjs).
/** @type {{ buildGraph: (sources: Record<string, string>) => Map<string, string[]>, HUB_FRACTION: number }} */
const { buildGraph, HUB_FRACTION } = await import(
  new URL("../../../scripts/js/test-import-graph.mjs", import.meta.url).href
);

/**
 * Spec 0054 R11 / D3 — `bun run test:affected`.
 *
 * Runs only the tests a change can reach. It is a time shortcut for the
 * iteration loop, NOT a gate: the closing full gate and CI shard merge back it.
 * Routing lives in the pure `planAffected` so it is testable without git.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const CLI = "packages/cli";
const TESTS_ROOT = `${CLI}/src/`;
// Spec 0045 measured these dynamic hubs beyond the useful selector crossover.
const DECLARED_HUBS = new Set([
  `${TESTS_ROOT}lib/config/config.ts`,
  `${TESTS_ROOT}engines/shared/permission-rules.ts`,
]);

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
 *   graph?: Map<string, string[]>,
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
export function planAffected({ changes, hasMergeBase, testFiles, grep, graph = new Map() }) {
  if (!hasMergeBase)
    return { full: true, reason: "no merge-base with origin/dev or dev", related: [], tests: [] };
  const trigger = changes.find((c) => FULL_SUITE_NAME.test(basename(c.path)));
  if (trigger)
    return { full: true, reason: `${trigger.path} can affect every test`, related: [], tests: [] };
  // The graph covers src TypeScript only. Run full until it includes runner
  // scripts/config and their relative imports, rather than returning an empty subset.
  const script = changes.find(
    (c) => c.path.startsWith(`${CLI}/scripts/`) || c.path.startsWith("scripts/"),
  );
  if (script)
    return {
      full: true,
      reason: `${script.path} is outside the source import graph`,
      related: [],
      tests: [],
    };
  const partial = changes.find((c) =>
    c.path.startsWith("packages/core/core-assets/hooks/_partials/"),
  );
  if (partial)
    return {
      full: true,
      reason: `${partial.path} feeds shared rendered hooks`,
      related: [],
      tests: [],
    };
  const hub = changes.find((c) => DECLARED_HUBS.has(c.path));
  if (hub)
    return {
      full: true,
      reason: `${hub.path} is a declared hub (spec 0045)`,
      related: [],
      tests: [],
    };

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
    // Hook helpers and relative imports often name only the asset filename.
    addAll(grep(basename(path)));
  }
  const live = (p) => known.has(p);
  const estimated = new Set([...tests].filter(live));
  const changed = new Set(changes.map((c) => c.path));
  for (const test of testFiles) {
    const seen = new Set();
    const pending = [test];
    while (pending.length > 0) {
      const next = pending.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      if (changed.has(next)) {
        estimated.add(test);
        break;
      }
      pending.push(...(graph.get(next) ?? []));
    }
  }
  if (testFiles.length > 0 && estimated.size / testFiles.length >= HUB_FRACTION) {
    return {
      full: true,
      reason: `estimated ${estimated.size}/${testFiles.length} test files (>=40%)`,
      related: [],
      tests: [],
    };
  }
  return {
    full: false,
    reason: "",
    related: [...related].sort(),
    tests: [...tests].filter(live).sort(),
  };
}

function git(args) {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : null;
}

/** @param {string | undefined} base @param {NodeJS.ProcessEnv} env @returns {string[]} */
export function mergeBaseRefs(base, env = process.env) {
  return base
    ? [base]
    : env.NAVORI_AFFECTED_BASE
      ? [env.NAVORI_AFFECTED_BASE]
      : ["origin/dev", "dev"];
}

function mergeBase(base) {
  for (const ref of mergeBaseRefs(base)) {
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
  const report = process.env.NAVORI_TEST_REPORT;
  const reporterArgs = report
    ? [
        `--reporter=${process.stdout.isTTY ? "default" : "./vitest.reporter.ts"}`,
        "--reporter=json",
        `--outputFile.json=${report}`,
      ]
    : [];
  const r = spawnSync("bun", ["x", "vitest", ...args, ...reporterArgs], {
    cwd: PACKAGE_ROOT,
    stdio: "inherit",
  });
  return r.status ?? 1;
}

/**
 * Parse the bounded CLI surface; --files is an explicit repo-relative path list.
 * @param {string[]} args
 * @returns {{ base: string | undefined, files: string[] | undefined, planJson: boolean }}
 */
export function parseAffectedArgs(args) {
  /** @type {{ base: string | undefined, files: string[] | undefined, planJson: boolean }} */
  const options = { base: undefined, files: undefined, planJson: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    if (seen.has(args[i])) throw new Error(`Repeated affected option: ${args[i]}`);
    seen.add(args[i]);
    if (args[i] === "--plan-json") options.planJson = true;
    else if (args[i] === "--base" && args[i + 1] && !args[i + 1].startsWith("--"))
      options.base = args[++i];
    else if (args[i] === "--files") {
      options.files = [];
      while (args[i + 1] && !args[i + 1].startsWith("--")) options.files.push(args[++i]);
    } else throw new Error(`Unknown or incomplete affected option: ${args[i]}`);
  }
  for (const path of options.files ?? []) {
    if (!path || path.startsWith("/") || path.split(/[\\/]/).includes(".."))
      throw new Error(`Expected repo-relative file: ${path}`);
  }
  return options;
}

/**
 * One native related invocation includes explicit tests, which are related to themselves.
 * @param {Plan} plan
 * @returns {string[]}
 */
export function affectedVitestArgs(plan) {
  if (plan.full) return ["run"];
  return [
    "related",
    "--run",
    ...[...new Set([...plan.related, ...plan.tests])].sort().map((p) => p.slice(`${CLI}/`.length)),
  ];
}

/** Plan without execution for CI, or run exactly the chosen native Vitest command. */
function main() {
  const options = parseAffectedArgs(process.argv.slice(2));
  const base = mergeBase(options.base);
  const changes = options.files
    ? options.files.map((path) => ({ path, deleted: !existsSync(join(REPO_ROOT, path)) }))
    : base === null
      ? []
      : collectChanges(base);
  const files = (git(["ls-files", "-co", "--exclude-standard", "--", `${TESTS_ROOT}`]) ?? "")
    .split("\n")
    .filter((p) => p.endsWith(".ts") && existsSync(join(REPO_ROOT, p)));
  const testFiles = [...new Set(files.filter((p) => p.endsWith(".test.ts")))];
  const plan = planAffected({
    changes,
    hasMergeBase: options.files !== undefined || base !== null,
    testFiles,
    graph: buildGraph(
      Object.fromEntries(files.map((p) => [p, readFileSync(join(REPO_ROOT, p), "utf8")])),
    ),
    grep: (needle) => {
      const out = git(["grep", "-l", "-F", "--untracked", "-e", needle, "--", `${TESTS_ROOT}`]);
      return (out ?? "").split("\n").filter((p) => p.endsWith(".test.ts"));
    },
  });
  if (options.planJson) {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return 0;
  }
  process.stdout.write("test:affected: affected subset, not a gate\n");
  if (plan.full) {
    process.stdout.write(`test:affected: running the full suite (${plan.reason})\n`);
    return vitest(affectedVitestArgs(plan));
  }
  if (plan.related.length === 0 && plan.tests.length === 0) {
    process.stdout.write("test:affected: no affected tests\n");
    if (process.env.NAVORI_TEST_REPORT)
      writeFileSync(process.env.NAVORI_TEST_REPORT, JSON.stringify({ files: [] }));
    return 0;
  }
  return vitest(affectedVitestArgs(plan));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
