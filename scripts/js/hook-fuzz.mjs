import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, homedir, release, setPriority, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createScratch, firstDifference, runMode, signedAssets } from "./hook-verdict-replay.mjs";
import { prepareRustReplay } from "./rust-hook-adapter.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_CASES = 100_000;

/**
 * Spec 0057 T24 / R11-R12 — deterministic live differential. Rust always runs live; the shell
 * oracle may come from a local cache keyed by the exact shell bytes, harness and host tools, and a
 * deterministic ~1% of cache hits is re-run live (D9 amendment, 2026-10-28). Payloads that differ
 * only in `session_id` are compared once: with audit off no rule reads it.
 * Native active audit and productive shadow logging remain unavailable until their runtime lands.
 *
 * @typedef {{ seed: number, cases: number, hook: string, engine: "claude" | "codex" | "pi", shell: "bash" | "zsh", audit: "off" | "active", timeoutMs: number }} FuzzOptions
 * @typedef {{ manifestPath?: string, binary?: string, scriptsRoot?: string, shellScript?: string }} ProcessFixtures
 * @typedef {{ everyMs?: number, now?: () => number, report?: (compared: number, total: number, elapsedMs: number) => void }} ProgressOptions
 * @typedef {{ shard?: { index: number, count: number }, cacheDir?: string, verifyEvery?: number }} RunOptions
 * @typedef {{ jobs: number, cache: "on" | "off", priority: "low" | "normal", shard?: { index: number, count: number }, fixtures?: ProcessFixtures }} CliRun
 */

const PROGRESS_EVERY_MS = 10 * 60_000;

/** One progress line: done/total, percent, elapsed and a linear estimate of what is left.
 * @param {number} completed
 * @param {number} total
 * @param {number} elapsedMs
 * @returns {string}
 */
export function progressLine(completed, total, elapsedMs) {
  const minutes = (ms) => `${Math.round(ms / 60_000)}m`;
  const left = completed === 0 ? "?" : minutes((elapsedMs / completed) * (total - completed));
  return `hook-fuzz: ${completed}/${total} (${Math.floor((completed / total) * 100)}%) in ${minutes(elapsedMs)}, ~${left} left`;
}

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

/** Default worker count: half the cores, at most 8, so the host keeps headroom.
 * @returns {number}
 */
function defaultJobs() {
  return Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2)));
}

/** Strict standalone CLI: every option has one value and may appear only once. `--shard` and
 * `--fixtures` are internal: the parent passes them to its workers (fixtures only for protocol tests).
 * @param {string[]} argv
 * @returns {FuzzOptions & { run: CliRun }}
 */
export function parseFuzzArgs(argv) {
  /** @type {Map<string, string>} */
  const values = new Map();
  const flags = ["--seed", "--cases", "--hook", "--engine", "--shell", "--audit", "--timeout-ms", "--jobs", "--cache", "--priority", "--shard", "--fixtures"];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flags.includes(flag)) throw new Error(`unknown option ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate option ${flag}`);
    const value = argv[++index];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (["--seed", "--cases", "--timeout-ms", "--jobs"].includes(flag) && !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${flag} needs a decimal integer`);
    values.set(flag, value);
  }
  const jobs = Number(values.get("--jobs") ?? defaultJobs());
  if (jobs < 1 || jobs > 64) throw new Error("jobs must be between 1 and 64");
  const cache = values.get("--cache") ?? "on";
  if (cache !== "on" && cache !== "off") throw new Error("cache must be on or off");
  const priority = values.get("--priority") ?? "low";
  if (priority !== "low" && priority !== "normal") throw new Error("priority must be low or normal");
  /** @type {CliRun} */
  const run = { jobs, cache, priority };
  const shard = values.get("--shard");
  if (shard !== undefined) {
    const match = /^(0|[1-9][0-9]*)\/([1-9][0-9]*)$/.exec(shard);
    if (match === null || Number(match[1]) >= Number(match[2]) || Number(match[2]) > 64) throw new Error("shard must be k/N with k < N <= 64");
    run.shard = { index: Number(match[1]), count: Number(match[2]) };
  }
  const fixtures = values.get("--fixtures");
  if (fixtures !== undefined) {
    if (shard === undefined) throw new Error("fixtures are internal to a shard worker");
    run.fixtures = JSON.parse(fixtures);
  }
  const options = optionsOf({
    seed: Number(values.get("--seed") ?? 1), cases: Number(values.get("--cases") ?? 1000),
    timeoutMs: Number(values.get("--timeout-ms") ?? 10_000), hook: values.get("--hook") ?? "subagent-no-background.sh",
    engine: values.get("--engine") ?? "claude", shell: values.get("--shell") ?? "bash", audit: values.get("--audit") ?? "off",
  });
  return { ...options, run };
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

/** Role spellings around `general-purpose`: the exact role, near misses and other roles. */
const GP_ROLES = ["general-purpose", "general-purpose", "scout", "implementer", "general-purpose-lite", "General-Purpose", "", " general-purpose", "general-purpose\n", "general\u0000purpose"];
/** Non-text values the extractor must not read as the role. */
const GP_ODD = [7, null, ["general-purpose"], { type: "general-purpose" }, true];

/** One general-purpose-confirm payload: `subagent_type` and/or `agent_type`, odd values, and the
 * substring elsewhere so the fast path passes without the role.
 * @param {() => number} next
 * @param {number} seed
 * @param {number} index
 * @returns {string}
 */
function gpConfirmPayload(next, seed, index) {
  const pick = (list) => list[(next() >>> 16) % list.length];
  const value = () => ((next() >>> 16) % 6 === 0 ? pick(GP_ODD) : pick(GP_ROLES));
  const shape = (next() >>> 16) % 8;
  /** @type {Record<string, unknown>} */
  const input = {};
  if (shape !== 1) input.subagent_type = value();
  if (shape === 1 || shape === 2 || shape === 3) input.agent_type = value();
  if (shape === 4) input.prompt = "use general-purpose for this";
  if (shape === 5) input.command = "echo general-purpose";
  if (shape === 6) input.message = pick(GP_ROLES);
  const payload = {
    session_id: `fuzz-${seed}-${index}`,
    tool_name: pick(["Agent", "spawn_agent", "Task", "Bash"]),
    tool_input: shape === 7 ? pick(GP_ROLES) : input,
  };
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
  if (hook === "general-purpose-confirm.sh") {
    const malformed = ["", "{", "null", "[]", "{}", "general-purpose", '{"tool_input":{"subagent_type":"general-purpose"'];
    return Array.from({ length: count }, (_, index) =>
      index % 11 === 0 ? malformed[(next() >>> 16) % malformed.length] : gpConfirmPayload(next, seed, index),
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

/** Comparison key of a payload: the payload without `session_id`. With audit off no rule reads
 * it (the audit recorder is the only reader), so two payloads that differ only there are one case.
 * @param {string} payload
 * @returns {string}
 */
function caseKey(payload) {
  try {
    const value = JSON.parse(payload);
    if (typeof value !== "object" || value === null || Array.isArray(value) || !("session_id" in value)) return payload;
    const { session_id: _session, ...rest } = value;
    return JSON.stringify(rest);
  } catch {
    return payload;
  }
}

/** First occurrence of each comparison key, with how many generated payloads it stands for.
 * @param {string[]} payloads
 * @returns {Array<{ index: number, weight: number }>}
 */
export function uniqueCases(payloads) {
  /** @type {Map<string, { index: number, weight: number }>} */
  const seen = new Map();
  payloads.forEach((payload, index) => {
    const key = caseKey(payload);
    const entry = seen.get(key);
    if (entry === undefined) seen.set(key, { index, weight: 1 });
    else entry.weight += 1;
  });
  return [...seen.values()];
}

/** Every file under `dir`, sorted, with its bytes: part of the shell cache fingerprint.
 * @param {string} dir
 * @returns {Array<[string, Buffer]>}
 */
function treeFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((file) => [relative(dir, file), readFileSync(file)]);
}

/** Everything a cached shell verdict depends on: the exact shell bytes (hook and sibling scripts),
 * this harness, the host tools the hook may call, and the platform. A change in any of them opens
 * a fresh cache; tools the key cannot see are caught by the live re-run sample.
 * @param {{ shellScript: string, shell: string, engine: string, hook: string }} input
 * @returns {string}
 */
function shellFingerprint({ shellScript, shell, engine, hook }) {
  const hash = createHash("sha256");
  const add = (label, value) => hash.update(`${label}\0`).update(value).update("\0");
  add("schema", "1");
  add("case", `${hook}\0${engine}\0${shell}`);
  add("hook", readFileSync(shellScript));
  for (const [name, bytes] of treeFiles(join(dirname(dirname(shellScript)), "scripts"))) add(`scripts/${name}`, bytes);
  const here = fileURLToPath(import.meta.url);
  for (const file of [here, join(dirname(here), "hook-verdict-replay.mjs")]) add(basename(file), readFileSync(file));
  for (const [tool, args] of [[shell, ["--version"]], ["jq", ["--version"]], ["git", ["--version"]]]) {
    const out = spawnSync(tool, args, { encoding: "utf8" });
    add(`version:${tool}`, out.status === 0 ? out.stdout.split("\n")[0] : "missing");
  }
  for (const tool of ["jq", "git", "tgrep", "rg", "node", "navori"]) {
    const out = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
    add(`path:${tool}`, out.status === 0 ? out.stdout.trim() : "missing");
  }
  add("platform", `${process.platform} ${process.arch} ${release()}`);
  return hash.digest("hex").slice(0, 32);
}

/** Append-only shell verdict cache: one JSONL file per writer process, all read at start.
 * @param {string} dir
 * @param {string} tag
 * @returns {{ get: (key: string) => object | undefined, put: (key: string, value: object) => void }}
 */
function openShellCache(dir, tag) {
  /** @type {Map<string, object>} */
  const entries = new Map();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
      for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
        if (line === "") continue;
        try {
          const { k, v } = JSON.parse(line);
          if (typeof k === "string" && typeof v === "object" && v !== null && typeof v.status === "number") entries.set(k, v);
        } catch {
          // A torn last line from an interrupted run is skipped; the case runs live again.
        }
      }
    }
  }
  const file = join(dir, `${tag}-${process.pid}.jsonl`);
  return {
    get: (key) => entries.get(key),
    put: (key, value) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(file, `${JSON.stringify({ k: key, v: value })}\n`);
      entries.set(key, value);
    },
  };
}

/** Default cache root, outside the repo.
 * @returns {string}
 */
function defaultCacheDir() {
  return process.env.NAVORI_FUZZ_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "navori", "hook-fuzz");
}

/**
 * Compare each unique generated payload (see {@link uniqueCases}) against the shell oracle and
 * DIRECT native execution. A full scratch snapshot is restored at the same path before each
 * runtime, including HOME and TMPDIR. With `run.cacheDir` the shell verdict may come from the
 * cache, and every `verifyEvery`-th hit (by key hash) is re-run live; a mismatch fails as a stale
 * cache. With `run.shard` this process takes every N-th unique case. Process fixture paths are only
 * for protocol tests; they never certify productive Rust parity.
 *
 * `completed` counts generated payloads covered (duplicates included); `compared` counts unique
 * cases run; `cached` counts shell verdicts served by the cache.
 *
 * @param {Partial<FuzzOptions>} input
 * @param {ProcessFixtures} [fixtures]
 * @param {ProgressOptions} [progress] Off unless `everyMs` > 0 and `report` is given.
 * @param {RunOptions} [run]
 * @returns {Promise<{ ok: boolean, seed: number, completed: number, compared: number, cached: number, index?: number, payload?: string, difference?: object, failure?: string }>}
 */
export async function fuzzHooks(input, fixtures = {}, progress = {}, run = {}) {
  const options = optionsOf(input);
  const { everyMs = 0, now = Date.now, report } = progress;
  const { shard = { index: 0, count: 1 }, cacheDir, verifyEvery = 100 } = run;
  const startedAt = now();
  let nextReportAt = startedAt + everyMs;
  let completed = 0;
  let compared = 0;
  let cached = 0;
  if (options.audit === "active") return { ok: false, seed: options.seed, completed, compared, cached, failure: "native unavailable: audit active requires CLI-writer fixtures and log replay support" };
  let payload;
  let index = 0;
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
    const cache = cacheDir === undefined
      ? undefined
      : openShellCache(join(cacheDir, shellFingerprint({ shellScript, shell: options.shell, engine: options.engine, hook: options.hook })), `shard${shard.index}`);
    const runShellCase = (c) => {
      restore();
      return runMode([c], "off", { resolveHook: () => shellScript, runHookBatch: (script, shell, calls) => calls.map((call) => runShell(script, shell, call, options.timeoutMs)), scratch })[0];
    };
    const payloads = generatePayloads(options.seed, options.cases, options.hook);
    const mine = uniqueCases(payloads).filter((_, position) => position % shard.count === shard.index);
    for (const { index: at, weight } of mine) {
      index = at;
      payload = payloads[at];
      const c = { hook: options.hook, engine: options.engine, shell: options.shell, input: payload, envDelta, cwdKind: "repo" };
      restore();
      // Native first: a compiled-registry/integrity deferral aborts before a shell batch/later cases.
      const actual = runMode([c], "off", { ...native, resolveHook: () => nativeScript, scratch, impl: "rust", timeoutMs: options.timeoutMs })[0];
      const key = createHash("sha256").update(caseKey(payload)).digest("hex");
      let expected = cache?.get(key);
      if (expected === undefined) {
        expected = runShellCase(c);
        cache?.put(key, expected);
      } else {
        cached += 1;
        if (Number.parseInt(key.slice(0, 8), 16) % verifyEvery === 0) {
          const live = runShellCase(c);
          const stale = firstDifference(expected, live);
          if (stale !== null) {
            return { ok: false, seed: options.seed, completed, compared, cached, index: at + 1, payload, failure: `stale shell cache in ${cacheDir} (${stale.field} differs from the live shell): delete it and rerun` };
          }
        }
      }
      const difference = firstDifference(expected, actual);
      compared += 1;
      if (difference !== null) return { ok: false, seed: options.seed, completed: compared, compared, cached, index: at + 1, payload, difference };
      completed += weight;
      if (report !== undefined && everyMs > 0 && compared < mine.length) {
        const at2 = now();
        if (at2 >= nextReportAt) {
          report(compared, mine.length, at2 - startedAt);
          nextReportAt = at2 + everyMs;
        }
      }
    }
    return { ok: true, seed: options.seed, completed, compared, cached };
  } catch (error) {
    return { ok: false, seed: options.seed, completed, compared, cached, index: payload === undefined ? undefined : index + 1, payload, failure: error instanceof Error ? error.message : "fuzz execution unavailable" };
  } finally {
    scratch?.cleanup();
    if (baselineRoot !== undefined) rmSync(baselineRoot, { recursive: true, force: true });
    if (signed !== undefined) rmSync(signed, { recursive: true, force: true });
  }
}

/** CLI flags that rebuild `options` in a worker.
 * @param {FuzzOptions} options
 * @returns {string[]}
 */
function optionArgs(options) {
  return ["--seed", String(options.seed), "--cases", String(options.cases), "--hook", options.hook, "--engine", options.engine, "--shell", options.shell, "--audit", options.audit, "--timeout-ms", String(options.timeoutMs)];
}

/**
 * Split the unique cases across `run.jobs` worker processes (each with its own scratch), at low
 * scheduling priority unless asked otherwise: macOS `taskpolicy -c utility`, elsewhere nice 10.
 * The first divergence stops every worker; among the failures that reached the parent, the lowest
 * case index is reported. Progress is summed across workers.
 *
 * @param {FuzzOptions} options
 * @param {CliRun} run
 * @param {{ fixtures?: ProcessFixtures, everyMs?: number, report?: (line: string) => void }} [extra]
 * @returns {Promise<{ ok: boolean, seed: number, completed: number, compared: number, cached: number, elapsedMs: number, jobs?: number, index?: number, payload?: string, difference?: object, failure?: string }>}
 */
export async function fuzzParallel(options, run, { fixtures, everyMs = PROGRESS_EVERY_MS, report } = {}) {
  const startedAt = Date.now();
  const total = uniqueCases(generatePayloads(options.seed, options.cases, options.hook)).length;
  const jobs = Math.max(1, Math.min(run.jobs, total));
  const script = fileURLToPath(import.meta.url);
  const taskpolicy = "/usr/sbin/taskpolicy";
  const low = run.priority === "low";
  const wrapped = low && process.platform === "darwin" && existsSync(taskpolicy);
  const progress = new Array(jobs).fill(0);
  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  /** Placeholders for workers that ended without reporting (usually killed after another failed). */
  const silent = new Set();
  const workers = [];
  const timer = report === undefined ? undefined : setInterval(() => {
    report(progressLine(progress.reduce((a, b) => a + b, 0), total, Date.now() - startedAt));
  }, everyMs);
  timer?.unref();
  await Promise.all(Array.from({ length: jobs }, (_, shardIndex) => new Promise((done) => {
    const args = [script, ...optionArgs(options), "--jobs", "1", "--cache", run.cache, "--priority", "normal", "--shard", `${shardIndex}/${jobs}`];
    if (fixtures !== undefined) args.push("--fixtures", JSON.stringify(fixtures));
    const child = wrapped
      ? spawn(taskpolicy, ["-c", "utility", process.execPath, ...args], { stdio: ["ignore", "pipe", "inherit"] })
      : spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    if (low && !wrapped && child.pid !== undefined) {
      try {
        setPriority(child.pid, 10);
      } catch {
        // Lowering priority is best effort; the run itself is unaffected.
      }
    }
    workers.push(child);
    let result;
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message.progress === "number") progress[shardIndex] = message.progress;
      if (typeof message.result === "object" && message.result !== null) {
        result = message.result;
        if (result.ok !== true) for (const other of workers) if (other !== child) other.kill("SIGTERM");
      }
    });
    child.on("close", () => {
      if (result === undefined) {
        result = { ok: false, seed: options.seed, completed: 0, compared: 0, cached: 0, failure: `worker ${shardIndex}/${jobs} ended without a result` };
        silent.add(result);
      }
      results.push(result);
      done();
    });
  })));
  if (timer !== undefined) clearInterval(timer);
  const elapsedMs = Date.now() - startedAt;
  const sum = (field) => results.reduce((acc, r) => acc + (typeof r[field] === "number" ? r[field] : 0), 0);
  const failures = results.filter((r) => r.ok !== true);
  if (failures.length > 0) {
    // A worker killed after another failed ends silent; report a real failure when there is one.
    const real = failures.filter((r) => !silent.has(r));
    const first = (real.length > 0 ? real : failures).sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))[0];
    return { ...first, ok: false, seed: options.seed, completed: sum("completed"), compared: sum("compared"), cached: sum("cached"), elapsedMs };
  }
  return { ok: true, seed: options.seed, completed: sum("completed"), compared: sum("compared"), cached: sum("cached"), elapsedMs, jobs };
}

/** Strict CLI entry; an unavailable runtime or a divergence is always a nonzero result.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const { run, ...options } = parseFuzzArgs(argv);
  const cacheDir = run.cache === "on" ? defaultCacheDir() : undefined;
  if (run.shard !== undefined) {
    // Worker: JSON lines only, read by the parent.
    const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
    const result = await fuzzHooks(options, run.fixtures ?? {}, { everyMs: 5_000, report: (compared) => emit({ progress: compared }) }, { shard: run.shard, cacheDir });
    emit({ result });
    return result.ok ? 0 : 1;
  }
  const result = await fuzzParallel(options, run, { report: (line) => process.stderr.write(`${line}\n`) });
  if (!result.ok) {
    process.stderr.write(`hook-fuzz: ${JSON.stringify(result)}\n`);
    return 1;
  }
  const from = result.cached > 0 ? `, ${result.cached} shell verdicts from cache` : "";
  process.stdout.write(`hook-fuzz: seed ${result.seed}, ${result.completed} live cases identical (${result.compared} unique${from}) in ${Math.round(result.elapsedMs / 1000)}s with ${result.jobs} jobs\n`);
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
