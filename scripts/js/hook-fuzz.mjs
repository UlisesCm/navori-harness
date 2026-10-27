import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScratch, firstDifference, loadDeps, runMode } from "./hook-verdict-replay.mjs";
import { prepareRustReplay } from "./rust-hook-adapter.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_CASES = 100_000;

/**
 * Spec 0057 T24 / R11-R12 — deterministic live differential, never a recorded expected verdict.
 * Native active audit and productive shadow logging remain unavailable until their runtime lands.
 *
 * @typedef {{ seed: number, cases: number, hook: string, engine: "claude" | "codex" | "pi", shell: "bash" | "zsh", audit: "off" | "active", timeoutMs: number }} FuzzOptions
 * @typedef {{ manifestPath?: string, binary?: string, scriptsRoot?: string, shellScript?: string }} ProcessFixtures
 */

/** Validate programmatic input as strictly as CLI arguments, before any process is launched.
 * @param {Partial<FuzzOptions>} input
 * @returns {FuzzOptions}
 */
function optionsOf(input) {
  const options = { seed: 1, cases: 1000, hook: "subagent-no-background.sh", engine: "claude", shell: "bash", audit: "off", timeoutMs: 10_000, ...input };
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffff_ffff) throw new Error("seed must be a uint32");
  if (!Number.isInteger(options.cases) || options.cases < 1 || options.cases > MAX_CASES) throw new Error(`cases must be between 1 and ${MAX_CASES}`);
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000) throw new Error("timeout-ms must be between 1 and 60000");
  if (!/^[A-Za-z0-9_-]+(?:\.sh)?$/.test(options.hook)) throw new Error("hook must be a single hook name");
  if (!["claude", "codex", "pi"].includes(options.engine)) throw new Error("engine must be claude, codex or pi");
  if (!["bash", "zsh"].includes(options.shell)) throw new Error("shell must be bash or zsh");
  if (!["off", "active"].includes(options.audit)) throw new Error("audit must be off or active");
  return { ...options, hook: options.hook.endsWith(".sh") ? options.hook : `${options.hook}.sh` };
}

/** Strict standalone CLI: every option has one value and may appear only once.
 * @param {string[]} argv
 * @returns {FuzzOptions}
 */
export function parseFuzzArgs(argv) {
  /** @type {Map<string, string>} */
  const values = new Map();
  const flags = ["--seed", "--cases", "--hook", "--engine", "--shell", "--audit", "--timeout-ms"];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flags.includes(flag)) throw new Error(`unknown option ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate option ${flag}`);
    const value = argv[++index];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (["--seed", "--cases", "--timeout-ms"].includes(flag) && !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${flag} needs a decimal integer`);
    values.set(flag, value);
  }
  return optionsOf({
    seed: Number(values.get("--seed") ?? 1), cases: Number(values.get("--cases") ?? 1000),
    timeoutMs: Number(values.get("--timeout-ms") ?? 10_000), hook: values.get("--hook") ?? "subagent-no-background.sh",
    engine: values.get("--engine") ?? "claude", shell: values.get("--shell") ?? "bash", audit: values.get("--audit") ?? "off",
  });
}

/** Fixed uint32 LCG and a bounded payload grammar: malformed JSON plus tool/agent edge values.
 * @param {number} seed
 * @param {number} count
 * @returns {string[]}
 */
export function generatePayloads(seed, count) {
  optionsOf({ seed, cases: count });
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0);
  const tools = ["Bash", "Agent", "Task", "Read", "Write", "Edit"];
  const commands = ["true", "git status", "git push --force origin main", "rm -rf /", "echo 'quoted'", "printf '%s' \"${HOME}\"", "cat file\npwd", "echo ñ🚀"];
  const agents = ["scout", "implementer", "general-purpose", "unknown"];
  const malformed = ["", "{", "null", "[]", "{}", '{"tool_input":'];
  return Array.from({ length: count }, (_, index) => {
    if (index % 11 === 0) return malformed[(next() >>> 16) % malformed.length];
    return JSON.stringify({
      session_id: `fuzz-${seed}-${index}`, cwd: "@CWD@", tool_name: tools[(next() >>> 16) % tools.length],
      tool_input: { command: commands[(next() >>> 16) % commands.length], subagent_type: agents[(next() >>> 16) % agents.length], run_in_background: (next() & 1) === 1, file_path: "@REPO@/fixture.ts", content: `seed:${seed} case:${index}` },
    });
  });
}

/** Real bounded shell invocation for one generated payload; failures never become verdicts.
 * @param {string} script
 * @param {string} shell
 * @param {{ input: string, cwd: string, env: Record<string, string> }} call
 * @param {number} timeoutMs
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runShell(script, shell, call, timeoutMs) {
  const result = spawnSync(shell, [script], { input: call.input, cwd: call.cwd, env: { ...process.env, ...call.env, NAVORI_HOOK_IMPL: "shell" }, shell: false, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  if (result.error !== undefined || result.signal !== null || result.status === null) {
    throw new Error(`shell unavailable: ${result.error?.code ?? result.signal ?? "missing status"}`);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return { status: result.status, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

/**
 * Compare each generated payload against a LIVE shell run and DIRECT native execution. A full
 * scratch snapshot is restored at the same path before each runtime, including HOME and TMPDIR.
 * Process fixture paths are only for protocol tests; they never certify productive Rust parity.
 *
 * @param {Partial<FuzzOptions>} input
 * @param {ProcessFixtures} [fixtures]
 * @returns {Promise<{ ok: boolean, seed: number, completed: number, index?: number, payload?: string, difference?: object, failure?: string }>}
 */
export async function fuzzHooks(input, fixtures = {}) {
  const options = optionsOf(input);
  if (options.audit === "active") return { ok: false, seed: options.seed, completed: 0, failure: "native unavailable: audit active requires CLI-writer fixtures and log replay support" };
  let completed = 0;
  let payload;
  let scratch;
  let baselineRoot;
  try {
    const native = prepareRustReplay({ manifestPath: fixtures.manifestPath ?? join(REPO_ROOT, "crates", "ported.json"), binary: fixtures.binary ?? process.env.NAVORI_RUST_BIN ?? "navori-rust", scriptsRoot: fixtures.scriptsRoot ?? process.env.NAVORI_RUST_HOOKS_DIR });
    const prepared = native.resolveHook(options.hook, options.engine);
    const shellDeps = fixtures.shellScript === undefined ? await loadDeps() : undefined;
    scratch = createScratch();
    const enginePath = options.engine === "pi" ? ".pi/navori" : `.${options.engine}`;
    const nativeRoot = join(scratch.root, "native", enginePath);
    mkdirSync(dirname(nativeRoot), { recursive: true });
    cpSync(dirname(dirname(prepared)), nativeRoot, { recursive: true });
    const nativeScript = join(nativeRoot, "hooks", basename(prepared));
    const shellScript = join(scratch.root, "shell", enginePath, "hooks", options.hook);
    mkdirSync(dirname(shellScript), { recursive: true });
    if (fixtures.shellScript === undefined) cpSync(shellDeps.resolveHook(options.hook, options.engine, scratch), shellScript);
    else cpSync(resolve(fixtures.shellScript), shellScript);
    // Warm the host-fact cache once and keep it in the baseline: restoring the snapshot before each
    // case would otherwise erase it and make every case a cold probe run, which can defer under load.
    // The cold path has its own tests; R17 is about the warm path. Warming uses the first case, so a
    // deferral is still reported as case 1 with its reproducible payload.
    payload = generatePayloads(options.seed, 1)[0];
    const warm = { hook: options.hook, engine: options.engine, shell: options.shell, input: payload, envDelta: { NAVORI_HOOK_IMPL: "shell" }, cwdKind: "repo" };
    for (let attempt = 1; ; attempt += 1) {
      try {
        runMode([warm], "off", { ...native, resolveHook: () => nativeScript, scratch, impl: "rust", timeoutMs: options.timeoutMs });
        break;
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
    baselineRoot = mkdtempSync(join(tmpdir(), "navori-fuzz-baseline-"));
    const baseline = join(baselineRoot, "root");
    cpSync(scratch.root, baseline, { recursive: true });
    const restore = () => {
      rmSync(scratch.root, { recursive: true, force: true });
      cpSync(baseline, scratch.root, { recursive: true });
    };
    for (payload of generatePayloads(options.seed, options.cases)) {
      const c = { hook: options.hook, engine: options.engine, shell: options.shell, input: payload, envDelta: { NAVORI_HOOK_IMPL: "shell" }, cwdKind: "repo" };
      restore();
      // Native first: a compiled-registry/integrity deferral aborts before a shell batch/later cases.
      const actual = runMode([c], "off", { ...native, resolveHook: () => nativeScript, scratch, impl: "rust", timeoutMs: options.timeoutMs })[0];
      restore();
      const expected = runMode([c], "off", { resolveHook: () => shellScript, runHookBatch: (script, shell, calls) => calls.map((call) => runShell(script, shell, call, options.timeoutMs)), scratch })[0];
      const difference = firstDifference(expected, actual);
      completed += 1;
      if (difference !== null) return { ok: false, seed: options.seed, completed, index: completed, payload, difference };
    }
    return { ok: true, seed: options.seed, completed };
  } catch (error) {
    return { ok: false, seed: options.seed, completed, index: payload === undefined ? undefined : completed + 1, payload, failure: error instanceof Error ? error.message : "fuzz execution unavailable" };
  } finally {
    scratch?.cleanup();
    if (baselineRoot !== undefined) rmSync(baselineRoot, { recursive: true, force: true });
  }
}

/** Strict CLI entry; an unavailable runtime or a divergence is always a nonzero result.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const result = await fuzzHooks(parseFuzzArgs(argv));
  if (!result.ok) {
    process.stderr.write(`hook-fuzz: ${JSON.stringify(result)}\n`);
    return 1;
  }
  process.stdout.write(`hook-fuzz: seed ${result.seed}, ${result.completed} live cases identical\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`hook-fuzz: ${error instanceof Error ? error.message : "invalid invocation"}\n`);
    process.exit(1);
  }
}
