import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type NativeEngine = "claude" | "codex" | "pi";
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const hookSchema = z.object({
  mode: z.enum(["shadow", "active"]),
  gating: z.boolean(),
  blocks: z.record(z.string(), hash),
  deps: z.record(z.string(), hash).default({}),
  impl: hash,
});
const manifestSchema = z.object({
  schema: z.literal(1),
  hooks: z.record(z.string().regex(/^[a-z0-9_-]+$/), hookSchema),
});
export type NativeHook = z.infer<typeof hookSchema>;
export type NativeHooks = Readonly<Record<string, NativeHook>>;
export const NATIVE_HOOK_BIN = "navori-rust";
export const INTEGRITY_PREFIX = "# navori:native-hook v=1 file=sha256:";
const ZERO = "0".repeat(64);
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Only the migration checkout may opt in; an npm installation never searches consumer config. */
export function loadNativeHooks(manifestPath?: string): NativeHooks {
  if (manifestPath === undefined) {
    const here = dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let depth = 0; depth < 8; depth += 1) {
      if (
        ["packages/cli/src/lib/render", "packages/cli/dist"].includes(
          relative(dir, here).split(sep).join("/"),
        ) &&
        existsSync(resolve(dir, "crates/ported.json"))
      ) {
        manifestPath = resolve(dir, "crates/ported.json");
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (manifestPath === undefined) return {};
  try {
    return manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown).hooks;
  } catch {
    if (process.env.NAVORI_RUST_TRACE === "1")
      process.stderr.write("navori: native hook manifest unavailable or invalid; using shell\n");
    return {};
  }
}

export function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The same fixed failure verdict is emitted by the wrapper when the binary cannot answer. */
export function nativeSafeFailure(engine: NativeEngine, hook: string, gating: boolean): string {
  const reason = `navori: ${hook} could not evaluate this call (native runtime failed); confirm it manually`;
  if (gating && engine === "claude") {
    const verdict = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    });
    return `printf '%s\\n' ${quote(verdict)} >&1 || exit 2; exit 0`;
  }
  return `printf '%s\\n' ${quote(reason)} >&2 || :; exit ${gating ? 2 : 1}`;
}

export interface NativeShellOptions {
  engine: NativeEngine;
  hook: string;
  descriptor: NativeHook;
  /** Shell words produced by the renderer, never raw config or user text. */
  invocation: string;
  args?: string;
}

/** Preserve trailing newlines and exit status without exec or exposing partial native stdout. */
export function nativeRunnerShell(options: NativeShellOptions): string {
  const { engine, hook, descriptor, invocation, args } = options;
  const forced = `printf '%s\\n' ${quote(`navori: ${hook} native runtime unavailable or deferred`)} >&2; exit 1`;
  const failed = nativeSafeFailure(engine, hook, descriptor.gating);
  return [
    "# navori:native-runtime start",
    'if [ "${NAVORI_HOOK_IMPL:-}" != shell ]; then',
    `  if nv_native=$(command -v ${NATIVE_HOOK_BIN} 2>/dev/null); then`,
    // Explicit if avoids errexit in hooks whose managed body enables set -e.
    `    nv_out=$(if "$nv_native" hook ${invocation}${descriptor.mode === "shadow" ? " --shadow" : ""}${args ? ` ${args}` : ""}; then nv_status=0; else nv_status=$?; fi; printf '.%s' "$nv_status")`,
    "    nv_rc=${nv_out##*.}; nv_out=${nv_out%.*}",
    '    case "$nv_rc" in',
    `      0|1|2) printf '%s' "$nv_out" >&1 || exit ${descriptor.gating ? 2 : 1}; exit "$nv_rc" ;;`,
    `      3|126|127) if [ "\${NAVORI_HOOK_IMPL:-}" = rust ]; then ${forced}; fi ;;`,
    `      *) ${failed} ;;`,
    "    esac",
    `  elif [ "\${NAVORI_HOOK_IMPL:-}" = rust ]; then ${forced}; fi`,
    "fi",
    "# navori:native-runtime end",
  ].join("\n");
}

/** Signature is outside the managed block: including file= in its SHA-1 would create a cycle. */
export function signNativeScript(
  script: string,
  implementation: string,
  deps: readonly Buffer[],
): string {
  const header = `${INTEGRITY_PREFIX}${ZERO} impl=${implementation}\n`;
  const unsigned = header + script;
  const digest = createHash("sha256").update(unsigned);
  for (const dep of deps) digest.update(dep);
  return unsigned.replace(
    `${INTEGRITY_PREFIX}${ZERO}`,
    `${INTEGRITY_PREFIX}${digest.digest("hex")}`,
  );
}

/** Enforce checkout-contained dependencies; path strings never become shell commands. */
export function nativeDependencyPath(
  cwd: string,
  engine: NativeEngine,
  path: string,
): string | null {
  if (
    !/^scripts\/[A-Za-z0-9._/-]+$/.test(path) ||
    path.split("/").some((part: string): boolean => part === ".." || part === "." || part === "")
  )
    return null;
  const root = resolve(cwd, engine === "pi" ? ".pi/navori" : `.${engine}`);
  const result = resolve(root, path);
  return result.startsWith(root + sep) ? result : null;
}

/** Native planning never expands ownership through a symlink, even within the same engine. */
export function nativePathContained(cwd: string, path: string): boolean {
  const parts = relative(resolve(cwd), resolve(path)).split(sep);
  if (parts.some((part: string): boolean => part === "..")) return false;
  let current = resolve(cwd);
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return false;
    } catch (error: unknown) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
        continue;
      return false;
    }
  }
  return true;
}
