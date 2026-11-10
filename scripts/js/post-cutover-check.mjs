import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { postCutoverBudget } from "./cutover-check.mjs";

/**
 * Spec 0062 T8 (R18; D17 of 0057): `bun run check:post-cutover`, the full gate with the
 * composition it keeps after the cutover, timed. Without the TS suite: cargo, the frozen hook oracle
 * (the verdict corpus replayed against `navori-rust`), the artifact suites and the docs and render
 * checks. Each step runs in order and the first red one stops the run, unless `--keep-going`
 * (to time every step on a host where one is known red; the run still counts as red). Neither
 * cargo step includes the TS oracle crate, which the cutover removes.
 *
 * The hook oracle runs as `ORACLE_SHARDS` disjoint `--shard i/n` processes at once, each with its
 * own scratch; the step is green only when every shard is.
 *
 * It writes `.navori/state/bench/post-cutover-<stamp>.json` and `post-cutover-latest.json`
 * (`{ ok, host, seconds, budgetSeconds, steps }`), which `cutover:check` reads, and exits 1 when a
 * step fails or the whole run exceeds its host's R18 budget: 300 s on the reference machine, 600 s
 * on CI (`GITHUB_ACTIONS=true`).
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The binary the `cargo build` step leaves, which the later steps run. */
const BUILT_BINARY = join(REPO_ROOT, "target", "debug", "navori-rust");

/**
 * The suites that test the rendered artifact on its real host and stay after the cutover (D11 of
 * 0057, D39 of 0059): the first-class Pi suites, the syntax of the generated Pi resources, the Rust
 * tree loaded by Pi's real loader (mandatory here) and the fail-closed matrix of native hooks (R83).
 * Paths relative to `packages/cli`.
 */
export const ARTIFACT_SUITES = [
  "src/engines/pi/__tests__/first-class-",
  "src/engines/pi/__tests__/render-syntax.test.ts",
  "src/engines/pi/__tests__/rust-tree.test.ts",
  "src/__tests__/native-hook-failclosed.test.ts",
];

/**
 * The hooks the frozen oracle replays natively: those `crates/ported.json` registers (all 22 at the
 * cutover; until then, a hook outside it has no native implementation to replay).
 */
export function manifestHooks(root = REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, "crates", "ported.json"), "utf8"));
  return Object.keys(manifest.hooks ?? {}).sort();
}

/**
 * The crate that compares the Rust port with the TS. The cutover PR removes the TS oracle (R24,
 * D17 of 0057), so the post-cutover composition lints and tests the workspace without it.
 */
export const TS_ORACLE_CRATE = "navori-oracle-tests";

/**
 * The steps, in order. `env` is resolved when the step runs (the binary exists only after cargo).
 * A step with `sharded` runs once per oracle shard, in parallel, with `--shard i/n` appended.
 * @type {Array<{ name: string, cmd: string, args: string[], cwd?: string, env?: () => Record<string, string>, sharded?: boolean }>}
 */
export const STEPS = [
  { name: "cargo fmt", cmd: "cargo", args: ["fmt", "--all", "--check"] },
  {
    name: "cargo clippy",
    cmd: "cargo",
    args: [
      "clippy",
      "--workspace",
      "--exclude",
      TS_ORACLE_CRATE,
      "--all-targets",
      "--locked",
      "--",
      "-D",
      "warnings",
    ],
  },
  {
    name: "cargo test",
    cmd: "cargo",
    args: ["test", "--workspace", "--exclude", TS_ORACLE_CRATE, "--locked", "--no-fail-fast"],
  },
  { name: "cargo build", cmd: "cargo", args: ["build", "-p", "navori-cli", "--locked"] },
  {
    name: "hook oracle",
    cmd: "node",
    args: ["scripts/js/hook-verdict-replay.mjs", "--impl", "rust", "--only", manifestHooks().join(",")],
    env: () => ({ NAVORI_RUST_BIN: BUILT_BINARY }),
    sharded: true,
  },
  {
    name: "artifact suites",
    cmd: "bun",
    args: ["run", "vitest", "run", ...ARTIFACT_SUITES],
    cwd: "packages/cli",
    env: () => ({ NAVORI_RUST_TREE: "1", NAVORI_RUST_BIN: BUILT_BINARY }),
  },
  { name: "check:links", cmd: "bun", args: ["run", "check:links"] },
  { name: "check:render", cmd: "bun", args: ["run", "check:render"] },
  { name: "check:assets", cmd: "bun", args: ["run", "check:assets"] },
  { name: "check:doc-budgets", cmd: "bun", args: ["run", "check:doc-budgets"] },
];

/** Parallel processes for the hook oracle: one per available core. */
export const ORACLE_SHARDS = availableParallelism();

/**
 * The host whose R18 budget applies.
 * @param {NodeJS.ProcessEnv} env
 * @returns {"ci" | "reference"}
 */
export function postCutoverHost(env = process.env) {
  return env.GITHUB_ACTIONS === "true" ? "ci" : "reference";
}

/**
 * The argument lists a step runs: one, or one per shard for a sharded step.
 * @param {{ args: string[], sharded?: boolean }} step
 * @param {number} shards
 * @returns {string[][]}
 */
export function stepInvocations(step, shards = ORACLE_SHARDS) {
  if (!step.sharded) return [step.args];
  return Array.from({ length: shards }, (_, i) => [...step.args, "--shard", `${i + 1}/${shards}`]);
}

/** Whether a run is within R18: every step green and the total under the budget. */
export function postCutoverOk(steps, seconds, budget = postCutoverBudget("reference")) {
  return steps.every((s) => s.status === 0) && seconds <= budget;
}

/**
 * Runs one invocation with inherited stdio; resolves to its exit status (1 when it cannot start
 * or ends on a signal).
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 * @returns {Promise<number>}
 */
function runOnce(cmd, args, options) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { ...options, stdio: "inherit" });
    child.on("error", () => done(1));
    child.on("close", (code) => done(code ?? 1));
  });
}

async function main(argv) {
  const keepGoing = argv.includes("--keep-going");
  const host = postCutoverHost();
  const budget = postCutoverBudget(host);
  const started = process.hrtime.bigint();
  const steps = [];
  for (const step of STEPS) {
    const invocations = stepInvocations(step);
    const shardNote = invocations.length > 1 ? ` (${invocations.length} shards)` : "";
    process.stdout.write(`check:post-cutover: ${step.name}${shardNote}\n`);
    const t0 = process.hrtime.bigint();
    const options = { cwd: join(REPO_ROOT, step.cwd ?? "."), env: { ...process.env, ...step.env?.() } };
    const statuses = await Promise.all(invocations.map((args) => runOnce(step.cmd, args, options)));
    const status = statuses.find((code) => code !== 0) ?? 0;
    steps.push({ name: step.name, status, seconds: Number(process.hrtime.bigint() - t0) / 1e9 });
    if (status !== 0 && !keepGoing) break;
  }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const complete = steps.length === STEPS.length;
  const ok = postCutoverOk(steps, seconds, budget) && complete;
  const result = {
    generatedAt: new Date().toISOString(),
    ok,
    host,
    seconds,
    budgetSeconds: budget,
    steps,
  };
  const dir = join(REPO_ROOT, ".navori", "state", "bench");
  mkdirSync(dir, { recursive: true });
  const stamped = join(dir, `post-cutover-${result.generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(stamped, `${JSON.stringify(result, null, 2)}\n`);
  copyFileSync(stamped, join(dir, "post-cutover-latest.json"));
  for (const s of steps)
    process.stdout.write(`  ${s.status === 0 ? "ok  " : "FAIL"} ${s.name} ${s.seconds.toFixed(1)} s\n`);
  process.stdout.write(
    `check:post-cutover: ${ok ? "green" : "red"} in ${seconds.toFixed(1)} s (budget ${budget} s)\n`,
  );
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
