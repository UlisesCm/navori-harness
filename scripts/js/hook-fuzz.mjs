import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScratch, firstDifference, runMode, signedAssets } from "./hook-verdict-replay.mjs";
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

/** Fixed uint32 LCG: the same seed always yields the same stream.
 * @param {number} seed
 * @returns {() => number}
 */
function lcg(seed) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0);
}

/** Commands aimed at every guard-destructive rule, its near misses and inert spellings of both. */
const GUARD_CORES = [
  // 1: hook skipping, and the inert spellings of it.
  "git commit --no-verify -m wip", "git commit -n -m x", "git -C . commit \"--no-verify\"", "git push --no-verify",
  "git commit -m \"skip --no-verify later\"", "git commit -am fix",
  // 2: force-push to the base branch, and the safe forms.
  "git push --force origin main", "git push -f origin dev", "git push origin +main", "git push --force origin feature",
  "git push --force-with-lease origin main", "git push origin main",
  // 3 and 3b: recursive rm over root, home, system dirs, variables and the scratch root.
  "rm -rf /", "rm -rf ~", "rm -rf $HOME", "rm -rf /usr", "rm -rf /tmp", "rm -rf \"$DIR\"", "rm -rf ${X}/",
  "rm -rf ./dist", "rm -rf node_modules/.cache", "rm -rf /*", "rm -rf --no-preserve-root /", "rm -r -f @TMP@",
  "rm file.txt", "rm -rf @REPO@/build",
  // 4 and 5: fork bomb and block devices.
  ":(){ :|:& };:", "dd if=/dev/zero of=/dev/sda", "cat x > /dev/disk2", "mkfs.ext4 /dev/sdb1", "echo x > /dev/null",
  // 6, 6b and 6d: rewrites and copies onto navori-managed files.
  "echo x > CLAUDE.md", "printf y >> AGENTS.md", "sed -i '' s/a/b/ .claude/settings.json", "tee .codex/config.toml",
  "cat a > @REPO@/.claude/hooks/guard-destructive.sh", "cp x .claude/settings.json", "mv a AGENTS.md",
  "install -m 644 f .claude/agents/scout.md", "ln -sf a CLAUDE.md", "cp CLAUDE.md /tmp/x", "echo x > notes.md",
  // 6c: the Pi control plane and shared rules.
  "pi --no-extensions", "echo x > .pi/settings.json", "engram delete obs-1", "pi --version",
  // 7: whole-tree discards, from here and from elsewhere.
  "git reset --hard", "git checkout -- .", "git clean -fdx", "git restore .", "git stash clear", "git clean -n",
  "cd /tmp && git reset --hard", "git -C sub clean -fd", "git reset --soft HEAD~1",
  // tgrep search lane.
  "grep -rn foo .", "rg foo", "grep -R x src", "FOO=1 rg bar", "git grep foo", "grep foo package.json", "rg --files",
  // Benign and inert content.
  "ls -la", "bun run test", "echo hello", "git status", "cat README.md", "git log --oneline -3",
  "gh pr create --body \"git push --force origin main\"", "cat <<'EOF'\nrm -rf /\nEOF", "echo 'rm -rf /'",
];
const GUARD_PREFIXES = ["", "", "", "sudo ", "env A=1 ", "command ", "\\", "time ", "(", "nohup "];
const GUARD_JOINERS = [" && ", " || ", "; ", " | ", "\n", " & ", " \\\n  "];
const GUARD_TAILS = ["", "", "", "", " # \u00f1\u{1f680}", " 2>&1", "\u0000x", "\n"];

/** One guard-destructive payload: one to three rule segments under the payload's edge shapes.
 * @param {() => number} next
 * @param {number} seed
 * @param {number} index
 * @returns {string}
 */
function guardPayload(next, seed, index) {
  const pick = (list) => list[(next() >>> 16) % list.length];
  const segments = Array.from({ length: 1 + ((next() >>> 16) % 3) }, () => {
    const prefix = pick(GUARD_PREFIXES);
    return `${prefix}${pick(GUARD_CORES)}${prefix === "(" ? ")" : ""}`;
  });
  let command = segments[0];
  for (const segment of segments.slice(1)) command += pick(GUARD_JOINERS) + segment;
  command += pick(GUARD_TAILS);
  const shape = (next() >>> 16) % 16;
  const toolInput = shape === 0 ? { command: 7 } : shape === 1 ? { command: [command] } : shape === 2 ? {} : { command };
  const payload = {
    session_id: `fuzz-${seed}-${index}`,
    hook_event_name: "PreToolUse",
    tool_name: shape === 3 ? "Read" : "Bash",
    tool_input: shape === 4 ? command : { ...toolInput, ...(shape === 5 ? { file_path: "a\u0000b" } : {}) },
  };
  if (shape !== 6) payload.cwd = shape === 7 ? "@REPO@/sub" : shape === 8 ? "" : "@CWD@";
  return JSON.stringify(payload);
}

/** Fixed uint32 LCG and a bounded payload grammar: malformed JSON plus tool/agent edge values.
 * guard-destructive gets its own grammar over every rule; the others keep the original one.
 * @param {number} seed
 * @param {number} count
 * @param {string} [hook]
 * @returns {string[]}
 */
export function generatePayloads(seed, count, hook = "subagent-no-background.sh") {
  optionsOf({ seed, cases: count });
  const next = lcg(seed);
  if (hook === "guard-destructive.sh") {
    const malformed = ["", "{", "null", "[]", "{}", '{"tool_input":', '{"tool_input":{"command":"rm -rf /"'];
    return Array.from({ length: count }, (_, index) =>
      index % 11 === 0 ? malformed[(next() >>> 16) % malformed.length] : guardPayload(next, seed, index),
    );
  }
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
  /** @type {string | undefined} */
  let signed;
  try {
    const scriptsRoot = fixtures.scriptsRoot ?? process.env.NAVORI_RUST_HOOKS_DIR ?? (signed = await signedAssets());
    const native = prepareRustReplay({ manifestPath: fixtures.manifestPath ?? join(REPO_ROOT, "crates", "ported.json"), binary: fixtures.binary ?? process.env.NAVORI_RUST_BIN ?? "navori-rust", scriptsRoot });
    const prepared = native.resolveHook(options.hook, options.engine);
    scratch = createScratch();
    const enginePath = options.engine === "pi" ? ".pi/navori" : `.${options.engine}`;
    // Only what a hook runs: its script and the engine's sibling scripts (manifest `deps`). The
    // rest of a rendered engine tree would be copied again by every per-case restore.
    const copyHook = (root) => {
      mkdirSync(join(root, "hooks"), { recursive: true });
      cpSync(prepared, join(root, "hooks", basename(prepared)));
      const scripts = join(dirname(dirname(prepared)), "scripts");
      if (existsSync(scripts)) cpSync(scripts, join(root, "scripts"), { recursive: true });
    };
    const nativeRoot = join(scratch.root, "native", enginePath);
    copyHook(nativeRoot);
    const nativeScript = join(nativeRoot, "hooks", basename(prepared));
    // The shell runs the very bytes the binary verified (its own engine tree, sibling scripts
    // included), under NAVORI_HOOK_IMPL=shell, so a rendered copy is compared with itself.
    const shellRoot = join(scratch.root, "shell", enginePath);
    const shellScript = join(shellRoot, "hooks", options.hook);
    if (fixtures.shellScript === undefined) copyHook(shellRoot);
    else {
      mkdirSync(dirname(shellScript), { recursive: true });
      cpSync(resolve(fixtures.shellScript), shellScript);
    }
    // Warm the host-fact cache once and keep it in the baseline: restoring the snapshot before each
    // case would otherwise erase it and make every case a cold probe run, which can defer under load.
    // The cold path has its own tests; R17 is about the warm path. Warming uses the first case, so a
    // deferral is still reported as case 1 with its reproducible payload.
    payload = generatePayloads(options.seed, 1, options.hook)[0];
    // Claude always exports the project directory; Codex and Pi derive it from the payload.
    const envDelta = { NAVORI_HOOK_IMPL: "shell", ...(options.engine === "claude" ? { CLAUDE_PROJECT_DIR: "@REPO@" } : {}) };
    const warm = { hook: options.hook, engine: options.engine, shell: options.shell, input: payload, envDelta, cwdKind: "repo" };
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
    for (payload of generatePayloads(options.seed, options.cases, options.hook)) {
      const c = { hook: options.hook, engine: options.engine, shell: options.shell, input: payload, envDelta, cwdKind: "repo" };
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
    if (signed !== undefined) rmSync(signed, { recursive: true, force: true });
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
