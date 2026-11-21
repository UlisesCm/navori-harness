#!/usr/bin/env node
/**
 * Post-activation check (spec 0062, R81-R83): after a batch of native hooks moves from
 * `shadow` to `active`, confirm on the installed binary that each activated hook is decided
 * by `navori-rust` in every engine it is registered in, and how long the call takes.
 *
 * First, the `navori-rust` on PATH must embed `<root>/crates/ported.json` byte for byte
 * (`include_str!` in navori-core manifest.rs). The binary decides shadow vs active from its
 * embedded manifest (hook.rs `use_shadow`), so a binary installed before the merge keeps
 * running the shell for a hook the checkout already shows as active.
 *
 * Then, for each hook (default: every `active` hook in `<root>/crates/ported.json`) and each
 * Claude/Pi registration of it, the check:
 *   1. reads `mode` in `ported.json` (must be `active`);
 *   2. reads the registered wrapper (Claude: the `settings.json` command and the script it
 *      runs; Pi: `.pi/navori/hooks/<hook>.sh`): it must carry the native-runtime block and
 *      must not pass `--shadow`;
 *   3. runs one fabricated call (bench payload, Bash `PreToolUse`) through the registered
 *      command with `NAVORI_HOOK_IMPL=rust`: the wrapper then never falls back to bash, and
 *      reports a deferred or missing native runtime on stderr; either one fails the hook, as
 *      does a deferral the binary answers with exit 1 (`navori-rust: hook deferred:`);
 *   4. runs the same call with the default environment and requires the same stdout and exit
 *      code (the decision the session sees is the native one);
 *   5. times `--runs` default calls (wall clock, bash `time`) and reports median and p95.
 *      This is the end-to-end cost through the wrapper (Pi adds starting bash on the script),
 *      so a p95 over 12 ms is a note, not a failure: the batch cap is R17's, measured on the
 *      binary itself (`bench-hooks --impl rust`).
 * Calls run in a scratch copy of the hook trees (bench-hooks sandbox), never in `<root>`.
 *
 * Registrations: Claude from `<root>/.claude/settings.json`; Pi from the rendered
 * `<root>/.pi/navori.json`, else from `packages/cli/src/engines/pi/hook-bindings.ts` (this repo).
 * A registration whose script is missing is kept, so the hook fails on it instead of skipping
 * that engine. `--engine` (repeatable) makes a hook without a registration in that engine fail;
 * without it, a hook missing from an engine is reported as a note.
 * A call that does not finish (`--call-timeout`, default 30 s, or a signal) fails the hook: a hung
 * native must not read as an empty "pass".
 * `--manifest` points at another `ported.json` (an installed package ships it under
 * `node_modules/navori/legacy/crates/ported.json`). Without `navori-rust` on PATH every hook
 * fails with that cause, and the calls still run (dist-e2e documents that state).
 *
 * Usage: node scripts/js/activation-verify.mjs [--root DIR] [--manifest FILE] [--hook ID ...] [--engine claude|pi ...]
 *        [--runs N] [--call-timeout MS] [--json]
 * Exit: 0 all hooks pass, 1 a hook fails, 2 usage or setup error.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandbox, parseClaudeRegistrations, parsePiRegistrations, writePayload } from "./bench-hooks.mjs";

/** R17 p95 cap for a short command (decisiones-ulises/2026-11-19); informative here. */
export const CAP_MS = 12;
/** A wrapper or binary deferral: the native did not decide (stderr). */
export const DEFERRED = /native runtime unavailable or deferred|^navori-rust: hook deferred: /m;
/** The wrapper's fail-closed `ask` after a native crash or an unknown exit (stdout, exit 0). */
export const FAILED = /native runtime failed/;

/** Engines a hook can be registered in. */
export const ENGINES = ["claude", "pi"];

/**
 * @param {string[]} argv
 * @returns {{ root: string, manifest: string | undefined, hooks: string[], engines: string[], runs: number, callTimeoutMs: number, json: boolean }}
 */
export function parseArgs(argv) {
  const out = {
    root: process.cwd(),
    manifest: /** @type {string | undefined} */ (undefined),
    hooks: /** @type {string[]} */ ([]),
    engines: /** @type {string[]} */ ([]),
    runs: 30,
    callTimeoutMs: 30_000,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--root") out.root = resolve(value());
    else if (arg === "--manifest") out.manifest = resolve(value());
    else if (arg === "--hook") out.hooks.push(value().replace(/\.sh$/, ""));
    else if (arg === "--engine") {
      const engine = value();
      if (!ENGINES.includes(engine)) throw new Error(`--engine must be one of: ${ENGINES.join(", ")}`);
      if (!out.engines.includes(engine)) out.engines.push(engine);
    } else if (arg === "--call-timeout") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new Error("--call-timeout needs a positive integer (ms)");
      out.callTimeoutMs = n;
    } else if (arg === "--runs") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new Error("--runs needs a positive integer");
      out.runs = n;
    } else if (arg === "--json") out.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/**
 * Hook id a registered command runs, or null.
 *
 * @param {string} command
 * @returns {string | null}
 */
export function hookOf(command) {
  return /(?:\.claude|\.pi\/navori)\/hooks\/([\w-]+)\.sh/.exec(command)?.[1] ?? null;
}

/**
 * Problems of a wrapper text for an active hook.
 *
 * @param {string} text registered command or installed script
 * @param {string} label
 * @returns {string[]}
 */
export function wrapperProblems(text, label) {
  const problems = [];
  if (!text.includes("navori:native-runtime start")) problems.push(`${label}: no native-runtime block`);
  const block = text.slice(text.indexOf("navori:native-runtime start"), text.indexOf("navori:native-runtime end"));
  if (/--shadow\b/.test(block)) problems.push(`${label}: still passes --shadow (render --apply pending?)`);
  return problems;
}

/** Pi events of the rendered bindings (`.pi/navori.json`), as bench-hooks names them. */
const PI_EVENTS = { tool_call: "PreToolUse", tool_result: "PostToolUse", session_shutdown: "SessionEnd" };
const PI_TOOLS = { bash: "Bash", edit: "Edit", write: "Write" };

/**
 * Pi registrations of a rendered `.pi/navori.json`.
 *
 * @param {{ hooks?: Array<{ script?: string, path?: string, on?: string, tools?: string[] }> }} runtime
 * @returns {import("./bench-hooks.mjs").Registration[]}
 */
export function piRuntimeRegistrations(runtime) {
  return (runtime.hooks ?? []).flatMap((row) => {
    const event = PI_EVENTS[/** @type {keyof typeof PI_EVENTS} */ (row.on ?? "")];
    if (event === undefined || typeof row.path !== "string") return [];
    const tools = (row.tools ?? []).map((t) => PI_TOOLS[/** @type {keyof typeof PI_TOOLS} */ (t)] ?? t);
    return [{ engine: "pi", event, matcher: tools.length > 0 ? tools.join("|") : null, command: `bash "${row.path}"` }];
  });
}

/**
 * Claude and Pi registrations of a checkout or an installed project.
 *
 * @param {string} root
 */
export function registrationsOf(root) {
  const settings = join(root, ".claude", "settings.json");
  const runtime = join(root, ".pi", "navori.json");
  const bindings = join(root, "packages", "cli", "src", "engines", "pi", "hook-bindings.ts");
  return [
    ...(existsSync(settings) ? parseClaudeRegistrations(JSON.parse(readFileSync(settings, "utf8"))) : []),
    ...(existsSync(runtime)
      ? piRuntimeRegistrations(JSON.parse(readFileSync(runtime, "utf8")))
      : existsSync(bindings)
        ? parsePiRegistrations(readFileSync(bindings, "utf8"))
        : []),
  ];
}

/**
 * Decision a hook answered, summarized for the report.
 *
 * @param {string} stdout
 * @param {number | null} code
 * @returns {string}
 */
export function decisionOf(stdout, code) {
  const decision = /"(?:permissionDecision|decision)"\s*:\s*"(\w+)"/.exec(stdout)?.[1];
  if (decision) return decision;
  if (code === 2) return "block (exit 2)";
  return stdout.trim() === "" ? `pass (exit ${code})` : `output (exit ${code})`;
}

/**
 * @param {number[]} values
 * @param {number} p
 */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const k = (sorted.length - 1) * p;
  const f = Math.floor(k);
  const c = Math.min(f + 1, sorted.length - 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

/**
 * Why a call did not finish with an exit code, or null when it did.
 *
 * @param {{ status: number | null, signal: NodeJS.Signals | null, error?: Error }} run
 * @param {number} timeoutMs
 * @returns {string | null}
 */
export function unfinished(run, timeoutMs) {
  if (run.status !== null) return null;
  const code = /** @type {{ code?: string } | undefined} */ (run.error)?.code;
  if (code === "ETIMEDOUT") return `did not finish within ${timeoutMs} ms`;
  if (run.signal !== null) return `killed by ${run.signal}`;
  return `did not run (${run.error?.message ?? "no exit code"})`;
}

/**
 * `bash -c script` bounded by `timeoutMs`. The call runs in its own process group with its
 * output in files, not pipes: a hung grandchild (the native under the wrapper's `$(...)`) would
 * otherwise hold the pipe open and keep spawnSync waiting past the timeout. The whole group is
 * killed afterwards, so nothing it started outlives the check.
 *
 * @param {string} script
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {number} timeoutMs
 */
function bashBounded(script, cwd, env, timeoutMs) {
  const dir = mkdtempSync(join(tmpdir(), "activation-verify-"));
  const outPath = join(dir, "stdout");
  const errPath = join(dir, "stderr");
  const out = openSync(outPath, "w");
  const err = openSync(errPath, "w");
  try {
    const run = spawnSync("bash", ["-c", script], {
      cwd,
      env,
      stdio: ["ignore", out, err],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      detached: true,
    });
    if (typeof run.pid === "number" && run.pid > 0) {
      try {
        process.kill(-run.pid, "SIGKILL");
      } catch {
        // ESRCH: the group already exited.
      }
    }
    return {
      status: run.status,
      unfinished: unfinished(run, timeoutMs),
      stdout: readFileSync(outPath, "utf8"),
      stderr: readFileSync(errPath, "utf8"),
    };
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} command
 * @param {string} payload
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {number} timeoutMs
 */
function runOnce(command, payload, cwd, env, timeoutMs) {
  const run = bashBounded('bash -c "$VERIFY_CMD" <"$VERIFY_PAYLOAD"', cwd, { ...env, VERIFY_CMD: command, VERIFY_PAYLOAD: payload }, timeoutMs);
  return { code: run.status, unfinished: run.unfinished, stdout: run.stdout, stderr: run.stderr };
}

/**
 * Wall ms of one call, from bash's `time` (same method as bench-hooks).
 *
 * @param {string} command
 * @param {string} payload
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {number} timeoutMs
 */
function timeOnce(command, payload, cwd, env, timeoutMs) {
  const { LC_ALL, ...rest } = env;
  const run = bashBounded(
    'TIMEFORMAT="%3R"; time bash -c "$VERIFY_CMD" <"$VERIFY_PAYLOAD" >/dev/null 2>/dev/null',
    cwd,
    { ...rest, ...(LC_ALL ? { LANG: LC_ALL } : {}), LC_NUMERIC: "C", VERIFY_CMD: command, VERIFY_PAYLOAD: payload },
    timeoutMs,
  );
  if (run.unfinished !== null) throw new Error(`timed call ${run.unfinished}`);
  const match = /(\d+\.\d+)\s*$/.exec(run.stderr);
  if (!match) throw new Error(`cannot read time output for: ${command}\n${run.stderr}`);
  return Number(match[1]) * 1000;
}

/**
 * @param {ReturnType<typeof parseArgs>} args
 */
export function verify(args) {
  const manifestBytes = readFileSync(args.manifest ?? join(args.root, "crates", "ported.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  /** @type {Record<string, { mode?: string }>} */
  const ported = manifest.hooks ?? {};
  const hooks = args.hooks.length > 0 ? args.hooks : Object.keys(ported).filter((id) => ported[id].mode === "active");
  if (hooks.length === 0) throw new Error("no active hook in the manifest and no --hook given");
  const which = spawnSync("sh", ["-c", "command -v navori-rust"], { encoding: "utf8" });
  const found = (which.stdout ?? "").trim();
  const binary = which.status === 0 && found !== "" ? found : null;
  const version =
    binary === null
      ? null
      : bashBounded('"$VERIFY_BIN" --version', args.root, { ...process.env, VERIFY_BIN: binary }, args.callTimeoutMs).stdout.trim();
  const embedsManifest = binary !== null && readFileSync(binary).includes(manifestBytes);

  const registrations = registrationsOf(args.root);
  const sandbox = createSandbox(args.root);
  const rows = [];
  try {
    for (const hook of hooks) {
      const regs = registrations.filter((reg) => hookOf(reg.command) === hook && reg.event === "PreToolUse");
      if (regs.length === 0) {
        rows.push({ hook, engine: "-", ok: false, problems: ["not registered on PreToolUse in Claude or Pi"] });
        continue;
      }
      const absent = ENGINES.filter((engine) => !regs.some((reg) => reg.engine === engine));
      for (const engine of absent) {
        const required = args.engines.includes(engine);
        rows.push({
          hook,
          engine,
          ok: !required,
          problems: required ? [`not registered on PreToolUse in ${engine} (--engine ${engine})`] : [],
          notes: required ? [] : [`not registered on PreToolUse in ${engine}: not checked there`],
        });
      }
      for (const reg of regs) {
        const problems = [];
        if (ported[hook]?.mode !== "active") problems.push(`ported.json mode is ${ported[hook]?.mode ?? "missing"}, not active`);
        if (binary === null) problems.push("navori-rust is not on PATH");
        else if (!embedsManifest) problems.push("navori-rust does not embed this crates/ported.json: reinstall the binary");
        const script = reg.engine === "claude" ? `.claude/hooks/${hook}.sh` : `.pi/navori/hooks/${hook}.sh`;
        const scriptPath = join(args.root, script);
        if (!existsSync(scriptPath)) problems.push(`${script} missing`);
        else problems.push(...wrapperProblems(readFileSync(scriptPath, "utf8"), script));
        if (reg.engine === "claude") problems.push(...wrapperProblems(reg.command, ".claude/settings.json"));

        const payload = writePayload(sandbox, "Bash", reg);
        const env = sandbox.env("absent");
        const forced = runOnce(reg.command, payload, sandbox.project, { ...env, NAVORI_HOOK_IMPL: "rust" }, args.callTimeoutMs);
        if (forced.unfinished !== null) problems.push(`native call (NAVORI_HOOK_IMPL=rust) ${forced.unfinished}`);
        if (DEFERRED.test(forced.stderr)) problems.push("native deferred or unavailable (NAVORI_HOOK_IMPL=rust)");
        if (FAILED.test(forced.stdout)) problems.push("native runtime failed (fail-closed ask)");
        const plain = runOnce(reg.command, payload, sandbox.project, env, args.callTimeoutMs);
        if (plain.unfinished !== null) problems.push(`default call ${plain.unfinished}`);
        if (DEFERRED.test(plain.stderr)) problems.push("native deferred on the default call");
        if (plain.code !== forced.code || plain.stdout !== forced.stdout) {
          problems.push(`default call differs from the native one (exit ${plain.code} vs ${forced.code})`);
        }
        const decision = forced.unfinished === null ? decisionOf(forced.stdout, forced.code) : "unfinished";
        if (forced.unfinished !== null || plain.unfinished !== null) {
          // Timing a call that hangs would cost runs × the timeout and say nothing new.
          rows.push({ hook, engine: reg.engine, ok: false, decision, problems, notes: [] });
          continue;
        }
        const times = [];
        const notes = [];
        try {
          for (let i = 0; i < args.runs; i += 1) times.push(timeOnce(reg.command, payload, sandbox.project, env, args.callTimeoutMs));
        } catch (error) {
          problems.push(error instanceof Error ? error.message : String(error));
        }
        const p50 = times.length > 0 ? percentile(times, 0.5) : undefined;
        const p95 = times.length > 0 ? percentile(times, 0.95) : undefined;
        if (p95 !== undefined && p95 > CAP_MS) notes.push(`p95 through the wrapper over ${CAP_MS} ms (R17 measures the binary)`);
        rows.push({
          hook,
          engine: reg.engine,
          ok: problems.length === 0,
          decision,
          p50Ms: p50 === undefined ? undefined : Number(p50.toFixed(2)),
          p95Ms: p95 === undefined ? undefined : Number(p95.toFixed(2)),
          runs: times.length,
          problems,
          notes,
        });
      }
    }
  } finally {
    sandbox.cleanup();
  }
  return { binary, version, embedsManifest, root: args.root, rows };
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`activation-verify: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let result;
  try {
    result = verify(args);
  } catch (error) {
    process.stderr.write(`activation-verify: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(
      `navori-rust: ${result.binary === null ? "NOT ON PATH" : `${result.binary} (${result.version})`}\n` +
        `embeds the manifest: ${result.embedsManifest ? "yes" : "NO"}\n`,
    );
    for (const row of result.rows) {
      const time = row.p50Ms === undefined ? "" : ` p50=${row.p50Ms} ms p95=${row.p95Ms} ms n=${row.runs}`;
      process.stdout.write(
        `${row.ok ? "OK  " : "FAIL"} ${row.hook.padEnd(26)} ${row.engine.padEnd(6)} ${row.decision ?? ""}${time}\n`,
      );
      for (const problem of row.problems) process.stdout.write(`       - ${problem}\n`);
      for (const note of row.notes ?? []) process.stdout.write(`       note: ${note}\n`);
    }
  }
  return result.rows.every((row) => row.ok) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
