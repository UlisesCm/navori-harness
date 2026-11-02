import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AREAS,
  PERMANENT_DELEGATION,
  areaOf,
  commandInventory,
  hookInventory,
  permanentlyDelegated,
} from "./rust-areas.mjs";

/**
 * Spec 0062 T8 (R20, with R17 and R18): is `migration/rust` ready for the cutover to `dev`?
 *
 *   bun run cutover:check                       exit 1 while anything is missing (the gate of E3)
 *   bun scripts/js/cutover-check.mjs --report   the same findings, exit 0 (while the long tail runs)
 *
 * Findings, one per line:
 *   - a subcommand or flag of `cli.ts` neither in `crates/ported.json` nor in the permanent
 *     delegation list of `rust-areas.mjs` (D41, D48 of 0060);
 *   - a hook of `core-assets` missing from the manifest, or still in `shadow`;
 *   - an open unport in `crates/ported-history.jsonl`;
 *   - R17: the last `bench:hooks --impl rust` report missing, not comparable or over its p95 budget,
 *     or `navori-rust --version` slower than 10 ms;
 *   - R18: the last `check:post-cutover` missing, red or over 300 s.
 *
 * The command tree is read from `packages/cli/src/cli.ts`, as the per-area inventory test does
 * (`dist/index.js` runs the CLI on import), so it runs under bun.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BENCH_DIR = join(REPO_ROOT, ".navori", "state", "bench");

/** R17: `navori-rust --version`, cold, in milliseconds. */
export const VERSION_BUDGET_MS = 10;
/** R17: direct native hook invocation, wall p95, in milliseconds. */
export const HOOK_P95_BUDGET_MS = 5;
/** R18: `check:post-cutover`, in seconds. */
export const POST_CUTOVER_BUDGET_S = 300;

/**
 * @typedef {{ path: string[], flags?: string[] }} ManifestCommand
 * @typedef {{ commands: ManifestCommand[], hooks: Record<string, { mode?: string }> }} Manifest
 * @typedef {{ date: string, op: string, id: string }} HistoryEvent
 * @typedef {{ comparable?: boolean, measurements?: Array<{ engine?: string, hook?: string, wallMsP95: number }> }} BenchReport
 * @typedef {{ ok: boolean, seconds: number }} PostCutoverReport
 * @typedef {{ check: string, detail: string }} Finding
 */

/**
 * What still blocks the cutover. Pure: every input is passed in.
 *
 * @param {{
 *   manifest: Manifest,
 *   commands: Array<{ path: string[], flags: string[] }>,
 *   hooks: string[],
 *   history: HistoryEvent[],
 *   delegation?: ReadonlyArray<{ path: string[], flags?: string[], reason: string }>,
 *   bench: BenchReport | null,
 *   versionMs: number | null,
 *   postCutover: PostCutoverReport | null,
 * }} input
 * @returns {Finding[]}
 */
export function cutoverFindings(input) {
  const delegation = input.delegation ?? PERMANENT_DELEGATION;
  /** @type {Finding[]} */
  const findings = [];
  const declared = new Map(input.manifest.commands.map((c) => [c.path.join(" "), c.flags ?? []]));
  for (const entry of input.commands) {
    areaOf({ command: entry.path });
    const key = entry.path.join(" ");
    const flags = declared.get(key);
    if (flags === undefined) {
      if (!permanentlyDelegated(entry.path, undefined, delegation))
        findings.push({ check: "command", detail: key });
      continue;
    }
    for (const flag of entry.flags)
      if (!flags.includes(flag) && !permanentlyDelegated(entry.path, flag, delegation))
        findings.push({ check: "flag", detail: `${key} --${flag}` });
  }
  for (const id of input.hooks) {
    areaOf({ hook: id });
    const hook = input.manifest.hooks[id];
    if (hook === undefined) findings.push({ check: "hook", detail: id });
    else if (hook.mode === "shadow") findings.push({ check: "shadow", detail: id });
  }
  const latest = new Map(
    input.history.filter((e) => e.op === "port" || e.op === "unport").map((e) => [e.id, e]),
  );
  for (const event of latest.values())
    if (event.op === "unport")
      findings.push({ check: "unport", detail: `${event.id} (since ${event.date})` });
  if (input.bench === null) {
    findings.push({ check: "R17", detail: "no bench:hooks --impl rust report" });
  } else {
    if (input.bench.comparable !== true)
      findings.push({ check: "R17", detail: "the last bench:hooks --impl rust is not comparable" });
    for (const row of input.bench.measurements ?? [])
      if (row.wallMsP95 > HOOK_P95_BUDGET_MS)
        findings.push({
          check: "R17",
          detail: `${row.engine ?? "?"}/${row.hook ?? "?"} p95 ${row.wallMsP95.toFixed(3)} ms > ${HOOK_P95_BUDGET_MS} ms`,
        });
  }
  if (input.versionMs === null)
    findings.push({ check: "R17", detail: "no navori-rust binary to time --version" });
  else if (input.versionMs > VERSION_BUDGET_MS)
    findings.push({
      check: "R17",
      detail: `navori-rust --version ${input.versionMs.toFixed(1)} ms > ${VERSION_BUDGET_MS} ms`,
    });
  if (input.postCutover === null)
    findings.push({ check: "R18", detail: "no check:post-cutover report" });
  else if (!input.postCutover.ok)
    findings.push({ check: "R18", detail: "the last check:post-cutover failed" });
  else if (input.postCutover.seconds > POST_CUTOVER_BUDGET_S)
    findings.push({
      check: "R18",
      detail: `check:post-cutover took ${input.postCutover.seconds.toFixed(0)} s > ${POST_CUTOVER_BUDGET_S} s`,
    });
  return findings;
}

/** The binary R17 times: `NAVORI_RUST_BIN`, else the release build, else the debug build. */
export function rustBinary(root = REPO_ROOT, env = process.env) {
  const candidates = [
    env.NAVORI_RUST_BIN,
    join(root, "target", "release", "navori-rust"),
    join(root, "target", "debug", "navori-rust"),
  ];
  return candidates.find((path) => path !== undefined && path !== "" && existsSync(path)) ?? null;
}

/** Median wall time of `runs` fresh `<bin> --version` processes, in milliseconds. */
export function timeVersion(bin, runs = 11) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    const run = spawnSync(bin, ["--version"], { stdio: "ignore" });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (run.status !== 0) throw new Error(`${bin} --version exited ${run.status}`);
    times.push(ms);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

async function main(argv) {
  const report = argv.includes("--report");
  if (typeof Bun === "undefined") {
    process.stderr.write("cutover-check: run it with bun (bun run cutover:check)\n");
    return 2;
  }
  const { main: cli } = await import(pathToFileURL(join(REPO_ROOT, "packages/cli/src/cli.ts")).href);
  const historyText = readFileSync(join(REPO_ROOT, "crates", "ported-history.jsonl"), "utf8");
  const bin = rustBinary();
  const findings = cutoverFindings({
    manifest: JSON.parse(readFileSync(join(REPO_ROOT, "crates", "ported.json"), "utf8")),
    commands: await commandInventory(cli),
    hooks: hookInventory(),
    history: historyText.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    bench: readJson(join(BENCH_DIR, "hooks-rust-latest.json")),
    versionMs: bin === null ? null : timeVersion(bin),
    postCutover: readJson(join(BENCH_DIR, "post-cutover-latest.json")),
  });
  if (findings.length === 0) {
    process.stdout.write(`cutover-check: ready (${Object.keys(AREAS).length} areas)\n`);
    return 0;
  }
  process.stdout.write(`cutover-check: ${findings.length} finding(s)\n`);
  for (const f of findings) process.stdout.write(`  ${f.check}: ${f.detail}\n`);
  return report ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
