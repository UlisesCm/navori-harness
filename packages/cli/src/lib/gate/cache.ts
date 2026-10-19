/**
 * Quality-gate result cache (spec 0054 D1). A green gate is remembered under a key
 * that names the exact bytes it ran on, so a second run over the same tree (or a
 * commit of it) can answer from the record. The cache is a TIME shortcut, never
 * evidence: a hit needs the key to match completely AND the recorded log to still
 * exist with the same sha256 and the success sentinel as its last line; anything
 * else (unreadable record, unknown version, tampered log, any error) is a miss.
 * Receipt signing and checking never read this file (R15).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { readCliVersion } from "../render/bundled-assets.ts";
import { contentIdentity, indexContentIdentity } from "../primitives/content-identity.ts";
import { withFileLock } from "../primitives/lockfile.ts";
import {
  ensureStateDirectory,
  stateArtifactPath,
  writeStateFileAtomic,
  type StateRoot,
} from "../primitives/state-root.ts";

export type CachedKind = "fast" | "full";

const RESULTS_FILE = "results.json";
const LOCK_FILE = "results.lock";
const MAX_ENTRIES = 16;
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

/** Everything a green result depends on; a hit needs every field equal. */
export interface GateCacheKey {
  fingerprint: string;
  kind: CachedKind;
  /** sha256 of the `qualityGate[kind]` string. */
  commandHash: string;
  /** sha256 of the lockfiles present at the repo root. */
  lockHash: string;
  navoriVersion: string;
  bunVersion: string;
  nodeVersion: string;
}

export interface GateCacheEntry extends GateCacheKey {
  /** ISO timestamp of the green run. */
  ts: string;
  /** Repo-relative POSIX path of the log. */
  log: string;
  logSha256: string;
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** Success sentinel appended to a green log before it is hashed. */
export function passSentinel(kind: CachedKind, fingerprint: string): string {
  return `[navori gate] PASS ${kind} ${fingerprint}`;
}

/** `<tool> --version`, spawned (not `process.version`, which bun reports as its Node-compat one). */
function toolVersion(tool: string): string {
  const result = spawnSync(tool, ["--version"], { encoding: "utf8", timeout: 5_000 });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

/** Versions part of the key; computed once per call site and shared by lookup and record. */
export function toolchainKey(
  repo: string,
): Pick<GateCacheKey, "lockHash" | "navoriVersion" | "bunVersion" | "nodeVersion"> {
  const hash = createHash("sha256");
  for (const name of LOCKFILES) {
    const path = resolve(repo, name);
    if (existsSync(path)) hash.update(`${name}\0`).update(readFileSync(path)).update("\0");
  }
  return {
    lockHash: hash.digest("hex"),
    navoriVersion: readCliVersion(),
    bunVersion: toolVersion("bun"),
    nodeVersion: toolVersion("node"),
  };
}

/** Builds the full key for `kind`; `tools` lets a caller reuse one toolchain probe. */
export function gateCacheKey(input: {
  repo: string;
  kind: CachedKind;
  command: string;
  fingerprint: string;
  tools?: ReturnType<typeof toolchainKey>;
}): GateCacheKey {
  return {
    fingerprint: input.fingerprint,
    kind: input.kind,
    commandHash: sha256(input.command),
    ...(input.tools ?? toolchainKey(input.repo)),
  };
}

const KEY_FIELDS = [
  "fingerprint",
  "kind",
  "commandHash",
  "lockHash",
  "navoriVersion",
  "bunVersion",
  "nodeVersion",
] as const satisfies ReadonlyArray<keyof GateCacheKey>;

function isEntry(value: unknown): value is GateCacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return [...KEY_FIELDS, "ts", "log", "logSha256"].every((f) => typeof record[f] === "string");
}

/** Lock-free read; an invalid file or unknown version is an empty record (a miss). */
function readEntries(root: StateRoot): GateCacheEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateArtifactPath(root, RESULTS_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const record = parsed as { v?: unknown; entries?: unknown };
    if (record.v !== 1 || !Array.isArray(record.entries)) return [];
    return record.entries.filter(isEntry);
  } catch {
    return [];
  }
}

/** The log must exist, hash to `logSha256` and end with the success sentinel. */
function logProvesGreen(root: StateRoot, entry: GateCacheEntry): boolean {
  try {
    const path = resolve(root.cwd, entry.log);
    if (relative(root.cwd, path).startsWith("..")) return false;
    const bytes = readFileSync(path);
    if (sha256(bytes) !== entry.logSha256) return false;
    const last = bytes.toString("utf8").trimEnd().split("\n").pop();
    return last === passSentinel(entry.kind, entry.fingerprint);
  } catch {
    return false;
  }
}

/** Returns the recorded green run matching `key` exactly, or undefined. Never throws. */
export function lookupGreen(root: StateRoot, key: GateCacheKey): GateCacheEntry | undefined {
  try {
    return readEntries(root)
      .reverse()
      .find((entry) => KEY_FIELDS.every((f) => entry[f] === key[f]) && logProvesGreen(root, entry));
  } catch {
    return undefined;
  }
}

/**
 * Records a green run: lock + atomic write, last 16 entries, an entry with the
 * same key replaced. Best effort: a cache that cannot be written must never fail the gate.
 */
export function recordGreen(
  root: StateRoot,
  key: GateCacheKey,
  logPath: string,
  now: Date = new Date(),
): void {
  try {
    const bytes = readFileSync(logPath);
    const entry: GateCacheEntry = {
      ...key,
      ts: now.toISOString(),
      log: relative(root.cwd, logPath).split("\\").join("/"),
      logSha256: sha256(bytes),
    };
    ensureStateDirectory(root);
    withFileLock(stateArtifactPath(root, LOCK_FILE), () => {
      const kept = readEntries(root).filter((e) => !KEY_FIELDS.every((f) => e[f] === key[f]));
      kept.push(entry);
      writeStateFileAtomic(
        root,
        RESULTS_FILE,
        `${JSON.stringify({ v: 1, entries: kept.slice(-MAX_ENTRIES) })}\n`,
      );
    });
  } catch {
    // best effort; see above
  }
}

type Scripts = Readonly<Record<string, string>>;

/** `&&` steps of a chain with the effective cwd of each (`cd X` updates it, is not a step). */
function stepsWithCwd(chain: string): Array<[cwd: string, step: string]> | undefined {
  if (/\|\||;/.test(chain)) return undefined;
  const out: Array<[string, string]> = [];
  let cwd = ".";
  for (const raw of chain.split("&&")) {
    const step = raw.trim().replace(/\s+/g, " ");
    if (step === "") return undefined;
    const cd = /^cd (\S+)$/.exec(step);
    if (cd) cwd = posix.normalize(posix.join(cwd, cd[1] as string));
    else out.push([cwd, step]);
  }
  return out;
}

/** Scripts of the repo-root package.json, or undefined when unreadable. */
function readRootScripts(repo: string): Scripts | undefined {
  try {
    const pkg: unknown = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8"));
    const scripts = (pkg as { scripts?: unknown }).scripts;
    return typeof scripts === "object" && scripts !== null ? (scripts as Scripts) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True only when every `&&` step of `fast`, with its cwd, is covered by `full`: the step
 * appears literally in `full`, or it is a root-cwd `bun|npm run <script>` whose root
 * `scripts` body (expanded ONE level, nested `run` steps stay literal) is a plain `&&`
 * chain with every step literal in `full`. An unknown script is not covered. `||` / `;`
 * chains are never covered.
 */
export function fastCoveredByFull(fast: string, full: string, scripts: Scripts = {}): boolean {
  const fastSteps = stepsWithCwd(fast);
  const fullSteps = stepsWithCwd(full);
  if (!fastSteps || !fullSteps || fastSteps.length === 0) return false;
  const have = new Set(fullSteps.map(([cwd, step]) => `${cwd}\0${step}`));
  const literal = (cwd: string, step: string): boolean => have.has(`${cwd}\0${step}`);
  return fastSteps.every(([cwd, step]) => {
    if (literal(cwd, step)) return true;
    const run = cwd === "." ? /^(?:bun|npm) run (\S+)$/.exec(step) : null;
    const body = run ? scripts[run[1] as string] : undefined;
    const inner = body === undefined ? undefined : stepsWithCwd(body);
    return inner !== undefined && inner.length > 0 && inner.every(([c, st]) => literal(c, st));
  });
}

/**
 * Looks up a green result that satisfies `kind`: its own record first, then (for
 * `fast`) a `full` record when `fastCoveredByFull`.
 */
export function lookupSatisfying(
  root: StateRoot,
  input: {
    kind: CachedKind;
    fingerprint: string;
    commands: Partial<Record<CachedKind, string>>;
    tools?: ReturnType<typeof toolchainKey>;
  },
): GateCacheEntry | undefined {
  const tools = input.tools ?? toolchainKey(root.cwd);
  const keyFor = (kind: CachedKind): GateCacheKey | undefined => {
    const command = input.commands[kind];
    return command === undefined
      ? undefined
      : gateCacheKey({ repo: root.cwd, kind, command, fingerprint: input.fingerprint, tools });
  };
  const own = keyFor(input.kind);
  const hit = own && lookupGreen(root, own);
  if (hit || input.kind !== "fast") return hit;
  const { fast, full } = input.commands;
  const fullKey = keyFor("full");
  return fast !== undefined &&
    full !== undefined &&
    fastCoveredByFull(fast, full, readRootScripts(root.cwd)) &&
    fullKey
    ? lookupGreen(root, fullKey)
    : undefined;
}

export type ProbeMode = "working" | "index" | "clean";

/**
 * `gate probe`: does a green `fast` (or covering `full`) exist for the bytes about
 * to be committed? `index` keys on the index fingerprint (git's pre-commit hook),
 * `clean` demands index == working tree == record (a hook that cannot see the final
 * index: `-a`, pathspecs), `working` is the plain tree. Any error is a miss.
 */
export function probeGreen(
  root: StateRoot,
  mode: ProbeMode,
  commands: Partial<Record<CachedKind, string>>,
): GateCacheEntry | undefined {
  try {
    const working = mode === "index" ? undefined : contentIdentity(root.cwd);
    if (working && !working.ok) return undefined;
    const index = mode === "working" ? undefined : indexContentIdentity(root.cwd);
    if (index && !index.ok) return undefined;
    const fingerprint = (index ?? working)?.fingerprint;
    if (fingerprint === undefined) return undefined;
    if (mode === "clean" && working?.fingerprint !== index?.fingerprint) return undefined;
    return lookupSatisfying(root, { kind: "fast", fingerprint, commands });
  } catch {
    return undefined;
  }
}
