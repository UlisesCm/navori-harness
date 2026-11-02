import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec 0060 T17 (D47) — `bun run rust:verify`: the evidence of a ported hook with the binary just
 * built from this checkout, never a stale `navori-rust` from PATH.
 *
 *   node scripts/js/rust-verify.mjs --hook <id>.sh[,<id>.sh…] [--cases N] [--seed S] [--engine E]
 *
 * Builds `navori-cli`, then runs the native replay of the corpus (`hook-verdict-replay --impl rust`)
 * and, with `--cases`, the differential fuzz of each hook. A call the binary defers because its
 * host-fact probes ran out of time is retried once by the shared transport (`rust-hook-adapter`).
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

/**
 * @param {string[]} argv
 * @returns {{ hooks: string[], cases?: number, seed: number, engine?: string }}
 */
export function parseArgs(argv) {
  const value = (name) => {
    const at = argv.indexOf(name);
    if (at === -1) return undefined;
    const next = argv[at + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`rust-verify: ${name} needs a value`);
    return next;
  };
  const known = new Set(["--hook", "--cases", "--seed", "--engine"]);
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i])) throw new Error(`rust-verify: unknown argument ${argv[i]}`);
  }
  const hooks = (value("--hook") ?? "").split(",").filter(Boolean);
  if (hooks.length === 0 || hooks.some((hook) => !/^[a-z0-9-]+\.sh$/.test(hook)))
    throw new Error("rust-verify: --hook needs <id>.sh[,<id>.sh…]");
  const integer = (name) => {
    const raw = value(name);
    if (raw === undefined) return undefined;
    if (!/^[1-9]\d*$/.test(raw)) throw new Error(`rust-verify: ${name} needs a positive integer`);
    return Number(raw);
  };
  const engine = value("--engine");
  return { hooks, cases: integer("--cases"), seed: integer("--seed") ?? 1, ...(engine ? { engine } : {}) };
}

/**
 * The steps, in order: build, replay of every hook, then one fuzz per hook.
 *
 * @param {ReturnType<typeof parseArgs>} options
 * @param {string} binary
 * @returns {{ cmd: string, args: string[], env?: Record<string, string> }[]}
 */
export function plan(options, binary) {
  const env = { NAVORI_RUST_BIN: binary };
  const steps = [
    { cmd: "cargo", args: ["build", "-p", "navori-cli", "--locked"] },
    {
      cmd: process.execPath,
      args: ["scripts/js/hook-verdict-replay.mjs", "--impl", "rust", "--only", options.hooks.join(",")],
      env,
    },
  ];
  if (options.cases !== undefined) {
    for (const hook of options.hooks) {
      steps.push({
        cmd: process.execPath,
        args: [
          "scripts/js/hook-fuzz.mjs",
          "--hook",
          hook,
          "--seed",
          String(options.seed),
          "--cases",
          String(options.cases),
          ...(options.engine ? ["--engine", options.engine] : []),
        ],
        env,
      });
    }
  }
  return steps;
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  const options = parseArgs(argv);
  const target = process.env.CARGO_TARGET_DIR ?? join(REPO_ROOT, "target");
  for (const step of plan(options, join(target, "debug", "navori-rust"))) {
    process.stderr.write(`rust-verify: ${[step.cmd, ...step.args].join(" ")}\n`);
    const result = spawnSync(step.cmd, step.args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, ...step.env },
    });
    if (result.status !== 0) return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
