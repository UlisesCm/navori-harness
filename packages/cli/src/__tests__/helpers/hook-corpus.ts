import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHookIncludes } from "../../lib/render/hook-includes.ts";
import type { HookCase } from "./hook-batch.ts";

/**
 * Spec 0055 R13 / D2 — capture of the hook verdict corpus.
 *
 * With `NAVORI_HOOK_CORPUS=<dir>` every hook invocation a test makes is appended to
 * `<dir>/raw-<pid>.jsonl`. It is recorded INSIDE the hook helpers (`runHookBatch`,
 * `runHookIsolated`) because a batch hands its payloads to ONE driver process through files, which
 * a `child_process` wrapper cannot see; the wrapper in `vitest.setup.ts` only covers the singles
 * that spawn a hook with their own `spawnSync`/`execFileSync` ({@link recordSpawnedHook}).
 * `scripts/js/hook-verdict-replay.mjs --generate` turns the raw lines into the committed corpus
 * (expected output with the audit off and active). Without the variable this module does nothing.
 *
 * A hook is identified by the NAME of a core hook asset plus an engine (`claude`, `codex`, `pi`,
 * read from the path it ran at), never by the temp file the test wrote: the replay re-expands the
 * source asset. A copy that does not look like that asset (a fixture script, a rewritten hook) is
 * not recorded as a case.
 */

export type CorpusEngine = "claude" | "codex" | "pi";

/** One line of `raw-<pid>.jsonl`: an invocation the helpers saw, with the verdict of recording it. */
export interface RawCorpusLine {
  hook: string;
  engine: CorpusEngine;
  shell: string;
  input: string;
  envDelta: Record<string, string>;
  cwdKind: "none" | "repo";
  /** The hook's own arguments (its mode, `$1`); absent when it got none. */
  args?: string[];
  /**
   * Text files the case's temp working directory held when the hook ran (path relative to it,
   * content normalized), for the state a hook reads from it (spec 0059 R54); absent when empty.
   */
  files?: Record<string, string>;
  /** `included` lines become cases; the others only feed the coverage denominator. */
  status: "included" | "excluded";
  reason?: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const HOOKS_SOURCE = join(REPO_ROOT, "packages", "core", "core-assets", "hooks");
const rawTmp = tmpdir();
const TEMP_ROOTS = [...new Set([rawTmp, existsSync(rawTmp) ? realpathSync(rawTmp) : rawTmp])];
const sizeCache = new Map<string, number>();

/** Placeholder for the checkout, for the temp root and for the random tail of a `mkdtemp` name. */
export const REPO_TOKEN = "@REPO@";
export const TMP_TOKEN = "@TMP@";
export const RANDOM_TOKEN = "@R@";
/** The temp working dir of a case, replayed as a fresh empty directory. */
export const CWD_TOKEN = "@CWD@";

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Makes a string independent of this checkout and of the random part of its temp dirs.
 *
 * @param text any string a case carries (payload, env value, cwd)
 */
export function normalizeCorpusText(text: string): string {
  let out = text.replaceAll(REPO_ROOT, REPO_TOKEN);
  for (const root of TEMP_ROOTS) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`${escaped}/([^/\\s"'\\\\]*?-)([A-Za-z0-9]{6})(?=[/\\s"'\\\\:]|$)`, "g"),
      `${TMP_TOKEN}/$1${RANDOM_TOKEN}`,
    );
    out = out.replaceAll(root, TMP_TOKEN);
  }
  return out;
}

/** Bounds of a working-directory snapshot: state files, never a tree. */
const SNAPSHOT_MAX_FILES = 40;
const SNAPSHOT_MAX_FILE_BYTES = 16 * 1024;
const SNAPSHOT_MAX_BYTES = 128 * 1024;
const SNAPSHOT_MAX_DEPTH = 4;
const SNAPSHOT_SKIP = new Set([".git", "node_modules"]);

/**
 * The text files under a case's temp working directory, as `{ relative path: content }`. Symlinks,
 * binary or oversized files and the `.git`/`node_modules` trees are left out, and a directory that
 * exceeds the bounds yields nothing at all: a partial setup would replay a different state.
 */
export function snapshotWorkdir(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  let total = 0;
  let count = 0;
  let complete = true;
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || SNAPSHOT_SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= SNAPSHOT_MAX_DEPTH) complete = false;
        else walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(path);
      if (bytes.length > SNAPSHOT_MAX_FILE_BYTES || bytes.includes(0)) {
        complete = false;
        continue;
      }
      total += bytes.length;
      count += 1;
      if (count > SNAPSHOT_MAX_FILES || total > SNAPSHOT_MAX_BYTES) complete = false;
      else files[relative(root, path).split(sep).join("/")] = bytes.toString("utf8");
    }
  };
  walk(root, 0);
  return complete ? files : {};
}

const isUnder = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

function engineOf(hookPath: string): CorpusEngine {
  if (hookPath.includes("/.codex/")) return "codex";
  if (hookPath.includes("/.pi/navori/")) return "pi";
  return "claude";
}

/** The core hook asset a file stands for, or `null` when it does not look like one. */
function coreHookName(hookPath: string): string | null {
  const name = basename(hookPath);
  const source = join(HOOKS_SOURCE, name);
  if (!name.endsWith(".sh") || !existsSync(source) || !existsSync(hookPath)) return null;
  let expected = sizeCache.get(name);
  if (expected === undefined) {
    expected = expandHookIncludes(readFileSync(source, "utf-8")).length;
    sizeCache.set(name, expected);
  }
  // A rendered copy differs from the expanded asset by substituted placeholders only; a fixture
  // that merely shares the name is far smaller.
  const ratio = readFileSync(hookPath, "utf-8").length / expected;
  return ratio >= 0.7 && ratio <= 1.4 ? name : null;
}

/**
 * Appends one invocation to the raw corpus when `NAVORI_HOOK_CORPUS` is set.
 *
 * @param hookPath the file that ran
 * @param shell the shell that ran it
 * @param c the case: payload, env ON TOP of the inherited one, working dir
 */
export function recordHookCase(hookPath: string, shell: string, c: HookCase): void {
  const dir = process.env.NAVORI_HOOK_CORPUS;
  if (dir === undefined || dir === "") return;
  const hook = coreHookName(hookPath);
  if (hook === null) return;
  const cwd = c.cwd;
  const tempCwd =
    cwd !== undefined && !isUnder(cwd, REPO_ROOT) && TEMP_ROOTS.some((root) => isUnder(cwd, root));
  // A temp cwd is replayed as a fresh empty dir: its name becomes a token, never a literal path.
  const tokenize = (text: string): string => {
    if (!tempCwd) return normalizeCorpusText(text);
    let out = text;
    for (const name of new Set([cwd, safeRealpath(cwd)])) out = out.replaceAll(name, CWD_TOKEN);
    return normalizeCorpusText(out);
  };
  // The audit root of a test points at state the replay cannot recreate: the replay mode owns it.
  const snapshot =
    tempCwd && cwd !== undefined && existsSync(cwd)
      ? Object.fromEntries(
          Object.entries(snapshotWorkdir(cwd)).map(([name, text]) => [name, tokenize(text)]),
        )
      : null;
  const envDelta = Object.fromEntries(
    Object.entries(c.env ?? {})
      .filter(([k]) => k !== "NAVORI_AUDITS_ROOT")
      .map(([k, v]) => [k, tokenize(v)]),
  );
  const line: RawCorpusLine = {
    hook,
    engine: engineOf(hookPath),
    shell,
    input: tokenize(c.input),
    envDelta,
    cwdKind: tempCwd ? "none" : "repo",
    ...(c.args !== undefined && c.args.length > 0 ? { args: [...c.args] } : {}),
    ...(snapshot !== null && Object.keys(snapshot).length > 0 ? { files: snapshot } : {}),
    status: "included",
  };
  const out: RawCorpusLine =
    cwd !== undefined && !isUnder(cwd, REPO_ROOT) && !tempCwd
      ? { ...line, status: "excluded", reason: "cwd-outside-checkout" }
      : line;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `raw-${process.pid}.jsonl`), `${JSON.stringify(out)}\n`);
}

/**
 * The `child_process` wrapper's entry: records a direct `spawnSync`/`execFileSync` of a hook.
 * Recognizes `<shell> <hook>.sh` with a string `input`; its env delta is the keys whose value
 * differs from the worker's own environment, so the per-file temp HOME does not count.
 *
 * @param command the program the test spawned
 * @param args the arguments the test passed (the options object may be last)
 */
export function recordSpawnedHook(command: unknown, args: readonly unknown[]): void {
  if (process.env.NAVORI_HOOK_CORPUS === undefined || process.env.NAVORI_HOOK_CORPUS === "") return;
  if (command !== "bash" && command !== "zsh" && command !== "sh") return;
  const argv = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
  const hookPath = argv[0];
  const options = args.find(
    (a): a is Record<string, unknown> => typeof a === "object" && a !== null && !Array.isArray(a),
  );
  if (typeof hookPath !== "string" || argv.length !== 1 || typeof options?.input !== "string")
    return;
  const env = (options.env ?? {}) as Record<string, string | undefined>;
  const delta: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && v !== process.env[k]) delta[k] = v;
  recordHookCase(hookPath, command, {
    input: options.input,
    env: delta,
    cwd: typeof options.cwd === "string" ? options.cwd : undefined,
  });
}
