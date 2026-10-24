import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Pin harness resolution before a replay case restricts PATH or changes the working directory.
 * @param {string} binary
 * @returns {string}
 */
function executable(binary) {
  const candidates = isAbsolute(binary) || binary.includes("/")
    ? [resolve(binary)]
    : (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, binary));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // A missing PATH entry is expected; the selected executable must still be available.
    }
  }
  throw new Error(`native unavailable: binary is missing or not executable: ${binary}`);
}

/**
 * Spec 0057 R11/R12 — direct native transport, never a shell/shadow fallback.
 * Process fixtures test this protocol; they do not prove a hook has been ported.
 *
 * @typedef {{ available: true, status: number, stdout: Buffer, stderr: Buffer } | { available: false, reason: string }} NativeResult
 */

/**
 * Execute an already prepared script through the binary. Rust owns definitive integrity and
 * compiled-registry validation; an ordinary exit 1 is still a valid advisory/error verdict.
 *
 * @param {{ binary: string, script: string, input: string, event?: string, cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} options
 * @returns {NativeResult}
 */
export function runRustHook({ binary, script, input, event, cwd, env = {}, timeoutMs = 10_000 }) {
  let pinned;
  try {
    pinned = executable(binary);
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : "native binary unavailable" };
  }
  const argv = event === undefined
    ? ["hook", "--via-script", resolve(script)]
    : ["hook", "--via-command", event, resolve(script)];
  const output = spawnSync(pinned, argv, {
    input,
    cwd,
    env: { ...process.env, ...env, NAVORI_HOOK_IMPL: "rust" },
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (output.error !== undefined) {
    return { available: false, reason: `native process error: ${output.error.code ?? output.error.message}` };
  }
  if (output.signal !== null || output.status === null) {
    return { available: false, reason: `native process ended without a verdict (${output.signal ?? "no status"})` };
  }
  if (output.status === 3 || (output.status === 1 && output.stderr.toString("utf8").startsWith("navori-rust: hook deferred: "))) {
    return { available: false, reason: "native runtime deferred; no native verdict was evaluated" };
  }
  if (![0, 1, 2].includes(output.status)) {
    return { available: false, reason: `native process returned unsupported exit ${output.status}` };
  }
  return { available: true, status: output.status, stdout: output.stdout, stderr: output.stderr };
}

/**
 * Read-only replay preflight. The producer must supply scripts already signed by the renderer;
 * this tool never creates a signature, guesses an implementation or activates shadow hooks.
 *
 * @param {{ manifestPath: string, binary: string, scriptsRoot?: string }} options
 * @returns {{ binary: string, resolveHook: (hook: string, engine: string) => string }}
 */
export function prepareRustReplay({ manifestPath, binary, scriptsRoot }) {
  /** @type {unknown} */
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!record(manifest) || manifest.schema !== 1 || !record(manifest.hooks)) {
    throw new Error("native unavailable: invalid hook registry");
  }
  const hooks = manifest.hooks;
  if (Object.keys(hooks).length === 0) throw new Error("native unavailable: hook registry is empty");
  const pinned = executable(binary);
  const scripts = scriptsRoot === undefined || scriptsRoot === "" ? undefined : resolve(scriptsRoot);
  return {
    binary: pinned,
    resolveHook(hook, engine) {
      if (basename(hook) !== hook || !/^[A-Za-z0-9_-]+\.sh$/.test(hook)) {
        throw new Error("native unavailable: invalid hook identity");
      }
      const id = hook.slice(0, -3);
      if (!Object.hasOwn(hooks, id)) throw new Error(`native unavailable: ${hook} is not registered`);
      const entry = hooks[id];
      if (!record(entry) || entry.mode !== "active") throw new Error(`native unavailable: ${hook} is not active (shadow cannot supply a verdict)`);
      if (scripts === undefined) {
        throw new Error("native unavailable: prepared scripts are missing; renderer integration is pending");
      }
      const directory = { claude: ".claude/hooks", codex: ".codex/hooks", pi: ".pi/navori/hooks" }[engine];
      if (directory === undefined) throw new Error("native unavailable: unknown engine");
      const script = join(scripts, directory, hook);
      let regular = false;
      try {
        regular = lstatSync(script).isFile();
      } catch {
        // The renderer has not prepared this fixture; never substitute an expanded shell hook.
      }
      if (!regular) throw new Error("native unavailable: prepared script is missing or not a regular file");
      return script;
    },
  };
}
