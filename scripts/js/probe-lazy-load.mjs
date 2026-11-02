import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec 0055 R14 / D8 — probe of what lazy subcommands could save.
 *
 * For each hot subcommand (`tools`, `plan`) it bundles a minimal entry that imports ONLY that
 * command, with the options of `tsdown.config.ts` and no splitting (an upper bound of what
 * chunking can reach), then compares the cold start of `node <entry> <sub> --help` with
 * `node dist/index.js <sub> --help`: `--runs` (default 10) alternated runs, median. Writes
 * `.navori/state/bench/lazy-<ts>.json` and `lazy-latest.json`:
 *   { generatedAt, cpus, loadavgBefore, loadavgAfter, workers, comparable,
 *     subs: [{ sub, bundleMs[], isolatedMs[], savingMsMedian }] }
 * Plain run: reports and exits 0. `--compare`: exits 1 when the saving of any hot subcommand is
 * under {@link THRESHOLD_MS} (D8: below that, the lazy-subcommand milestone leaves the delivery).
 *
 * Usage: node scripts/js/probe-lazy-load.mjs [--compare] [--runs N]
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_ROOT = join(REPO_ROOT, "packages", "cli");
const DIST = join(PACKAGE_ROOT, "dist", "index.js");
export const THRESHOLD_MS = 20;
export const HOT_SUBCOMMANDS = ["tools", "plan"];

/**
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (values.length === 0) throw new Error("median of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per-subcommand result of alternated timings.
 *
 * @param {string} sub
 * @param {number[]} bundleMs cold starts of `dist/index.js`
 * @param {number[]} isolatedMs cold starts of the minimal entry
 * @returns {{ sub: string, bundleMs: number[], isolatedMs: number[], savingMsMedian: number }}
 */
export function summarizeSub(sub, bundleMs, isolatedMs) {
  return { sub, bundleMs, isolatedMs, savingMsMedian: Math.round((median(bundleMs) - median(isolatedMs)) * 10) / 10 };
}

/**
 * Subcommands under the threshold, for `--compare`.
 *
 * @param {Array<{ sub: string, savingMsMedian: number }>} subs
 * @param {number} [thresholdMs]
 * @returns {string[]}
 */
export function belowThreshold(subs, thresholdMs = THRESHOLD_MS) {
  return subs.filter((s) => s.savingMsMedian < thresholdMs).map((s) => `${s.sub}: ${s.savingMsMedian} ms < ${thresholdMs} ms`);
}

/**
 * Config of `tsdown.config.ts` minus entry/output; plugins load by absolute path. The render-data
 * plugin is left out: it fails unless the Pi bridge modules are in the graph, and it only
 * re-encodes their strings (a few KB), which does not move a cold start.
 */
function tsdownConfig(entry, outDir) {
  const scripts = join(PACKAGE_ROOT, "scripts");
  return `import { defineConfig } from "tsdown";
import { bundleCommentsPlugin } from ${JSON.stringify(join(scripts, "bundle-comments.ts"))};
export default defineConfig({
  entry: [${JSON.stringify(entry)}],
  outDir: ${JSON.stringify(outDir)},
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: false,
  minify: true,
  deps: { alwaysBundle: [/./] },
  banner: { js: "#!/usr/bin/env node" },
  plugins: [bundleCommentsPlugin()],
  outputOptions: { codeSplitting: false, entryFileNames: "index.js", comments: { legal: true, annotation: false, jsdoc: false } },
});
`;
}

/**
 * Bundles the one-command entry of `sub` under `scratch/<sub>/out/index.js`.
 *
 * @param {string} scratch
 * @param {string} sub
 * @returns {string} bundled entry
 */
function bundleIsolated(scratch, sub) {
  const dir = join(scratch, sub);
  mkdirSync(dir, { recursive: true });
  // The bundle looks for `../package.json` (version) next to its own directory.
  copyFileSync(join(PACKAGE_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(dir, "node_modules"));
  const entry = join(dir, "entry.ts");
  const command = join(PACKAGE_ROOT, "src", "commands", `${sub}.ts`);
  writeFileSync(
    entry,
    `import { defineCommand, runMain } from "citty";\nimport { ${sub}Command } from ${JSON.stringify(command)};\n` +
      `runMain(defineCommand({ meta: { name: "navori" }, subCommands: { ${sub}: ${sub}Command } }));\n`,
  );
  const config = join(dir, "tsdown.config.ts");
  writeFileSync(config, tsdownConfig(entry, join(dir, "out")));
  const build = spawnSync(join(PACKAGE_ROOT, "node_modules", ".bin", "tsdown"), ["-c", config], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  const out = join(dir, "out", "index.js");
  if (build.status !== 0 || !existsSync(out)) throw new Error(`probe: cannot bundle the ${sub} entry\n${(build.stdout + build.stderr).slice(0, 3000)}`);
  return out;
}

/** Wall time (ms) of `node <script> <args…>`; the run must succeed. */
function coldStartMs(script, args, home) {
  const started = process.hrtime.bigint();
  const run = spawnSync("node", [script, ...args], {
    encoding: "utf8",
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, NO_COLOR: "1" },
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (run.status !== 0) throw new Error(`probe: node ${script} ${args.join(" ")} exited ${run.status}\n${run.stderr}`);
  return Math.round(ms * 10) / 10;
}

/** @param {string[]} argv */
function main(argv) {
  const compare = argv.includes("--compare");
  const runsAt = argv.indexOf("--runs");
  const runs = runsAt === -1 ? 10 : Number(argv[runsAt + 1]);
  if (!Number.isInteger(runs) || runs < 1) {
    process.stderr.write("probe-lazy-load: --runs needs a positive integer\n");
    return 2;
  }
  if (!existsSync(DIST)) {
    process.stderr.write("probe-lazy-load: packages/cli/dist/index.js is missing; run `bun run build` first\n");
    return 2;
  }
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "navori-probe-lazy-")));
  const home = join(scratch, "home");
  mkdirSync(home);
  const loadBefore = loadavg();
  try {
    const subs = HOT_SUBCOMMANDS.map((sub) => {
      const isolated = bundleIsolated(scratch, sub);
      const bundleMs = [];
      const isolatedMs = [];
      coldStartMs(DIST, [sub, "--help"], home); // warm the file cache for both
      coldStartMs(isolated, [sub, "--help"], home);
      for (let i = 0; i < runs; i += 1) {
        bundleMs.push(coldStartMs(DIST, [sub, "--help"], home));
        isolatedMs.push(coldStartMs(isolated, [sub, "--help"], home));
      }
      return summarizeSub(sub, bundleMs, isolatedMs);
    });
    const cpus = availableParallelism();
    const result = {
      generatedAt: new Date().toISOString(),
      cpus,
      loadavgBefore: loadBefore,
      loadavgAfter: loadavg(),
      workers: 1,
      comparable: (loadBefore[0] ?? Number.POSITIVE_INFINITY) <= cpus / 2,
      runs,
      subs,
    };
    const dir = join(REPO_ROOT, ".navori", "state", "bench");
    mkdirSync(dir, { recursive: true });
    const stamped = join(dir, `lazy-${result.generatedAt.replace(/[:.]/g, "-")}.json`);
    writeFileSync(stamped, `${JSON.stringify(result, null, 2)}\n`);
    copyFileSync(stamped, join(dir, "lazy-latest.json"));
    for (const s of subs) {
      process.stdout.write(
        `probe-lazy-load ${s.sub}: bundle=${median(s.bundleMs)} ms isolated=${median(s.isolatedMs)} ms saving=${s.savingMsMedian} ms\n`,
      );
    }
    process.stdout.write(`probe-lazy-load comparable=${result.comparable} load=${loadBefore.map((n) => n.toFixed(2)).join("/")} cpus=${cpus}\n`);
    const low = belowThreshold(subs);
    if (low.length > 0) process.stderr.write(`probe-lazy-load: under the ${THRESHOLD_MS} ms bar (D8):\n${low.map((l) => `  - ${l}`).join("\n")}\n`);
    return compare && low.length > 0 ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
