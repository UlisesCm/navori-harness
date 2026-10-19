import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec 0055 R24 / D12 — fan-in of tests per module, for the hub rule of `test:affected`.
 *
 * Statically follows the relative imports of every `*.test.ts` under `packages/cli/src` and
 * counts, per non-test module, how many test files reach it (directly or through other modules).
 * A module reached by at least {@link HUB_FRACTION} of the test files is a hub: a change to it
 * affects too much of the suite to be worth selecting tests. Dynamic `import("./x.ts")` counts;
 * bare package specifiers do not. Writes `.navori/state/bench/graph-latest.json`.
 *
 * Usage: node scripts/js/test-import-graph.mjs
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(REPO_ROOT, "packages", "cli", "src");
export const HUB_FRACTION = 0.4;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/**
 * Relative specifiers a source text imports or re-exports.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function parseSpecifiers(source) {
  return [...source.matchAll(SPECIFIER)].map((m) => m[1]);
}

/**
 * Resolves a relative specifier against the known files, trying the usual TypeScript suffixes.
 *
 * @param {string} from importing file (posix, relative to the root)
 * @param {string} specifier
 * @param {Set<string>} known
 * @returns {string | null}
 */
export function resolveSpecifier(from, specifier, known) {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stripped = base.replace(/\.(?:js|mjs|ts)$/, "");
  for (const candidate of [base, `${stripped}.ts`, `${base}.ts`, `${base}/index.ts`]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Import graph of a file set.
 *
 * @param {Record<string, string>} sources posix path to file text
 * @returns {Map<string, string[]>} file to the files it imports
 */
export function buildGraph(sources) {
  const known = new Set(Object.keys(sources));
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  for (const [file, text] of Object.entries(sources)) {
    const edges = new Set();
    for (const spec of parseSpecifiers(text)) {
      const target = resolveSpecifier(file, spec, known);
      if (target !== null && target !== file) edges.add(target);
    }
    graph.set(file, [...edges]);
  }
  return graph;
}

/**
 * Per module, the test files that reach it. A test file does not count as a module.
 *
 * @param {Map<string, string[]>} graph
 * @param {string[]} testFiles
 * @returns {{ totalTests: number, modules: Array<{ module: string, fanIn: number, pct: number }> }}
 */
export function fanIn(graph, testFiles) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  const tests = new Set(testFiles);
  for (const test of testFiles) {
    const seen = new Set([test]);
    const stack = [test];
    while (stack.length > 0) {
      for (const next of graph.get(stack.pop()) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    seen.delete(test);
    for (const module of seen) if (!tests.has(module)) counts.set(module, (counts.get(module) ?? 0) + 1);
  }
  const total = testFiles.length;
  const modules = [...counts.entries()]
    .map(([module, n]) => ({ module, fanIn: n, pct: Math.round((n / total) * 1000) / 10 }))
    .sort((a, b) => b.fanIn - a.fanIn || a.module.localeCompare(b.module));
  return { totalTests: total, modules };
}

/**
 * Modules reached by at least `fraction` of the tests.
 *
 * @param {ReturnType<typeof fanIn>} result
 * @param {number} [fraction]
 * @returns {string[]}
 */
export function hubs(result, fraction = HUB_FRACTION) {
  return result.modules.filter((m) => m.fanIn / result.totalTests >= fraction).map((m) => m.module);
}

/** Every `.ts` file under `dir`, posix paths relative to the repo root. */
function listTs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listTs(path);
    return entry.name.endsWith(".ts") ? [relative(REPO_ROOT, path).split("\\").join("/")] : [];
  });
}

function main() {
  const files = listTs(SRC);
  const sources = Object.fromEntries(files.map((f) => [f, readFileSync(join(REPO_ROOT, f), "utf8")]));
  const testFiles = files.filter((f) => f.endsWith(".test.ts"));
  const result = fanIn(buildGraph(sources), testFiles);
  const hubList = hubs(result);
  const output = { generatedAt: new Date().toISOString(), hubFraction: HUB_FRACTION, totalTests: result.totalTests, hubs: hubList, modules: result.modules };
  const dir = join(REPO_ROOT, ".navori", "state", "bench");
  mkdirSync(dir, { recursive: true });
  const stamped = join(dir, `graph-${output.generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(stamped, `${JSON.stringify(output, null, 2)}\n`);
  copyFileSync(stamped, join(dir, "graph-latest.json"));
  process.stdout.write(`test-import-graph: ${result.totalTests} test files, ${result.modules.length} modules reached, ${hubList.length} hubs (>= ${HUB_FRACTION * 100}%)\n`);
  for (const h of result.modules.filter((m) => hubList.includes(m.module))) {
    process.stdout.write(`  ${String(h.pct).padStart(5)}%  ${h.module}\n`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
