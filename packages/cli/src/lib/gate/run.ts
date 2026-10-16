/**
 * Runner behind `navori gate <fast|full>`: runs `qualityGate.<kind>` as a chain
 * of steps WITHOUT a shell (#1307). `runGate` has already validated the string
 * with `isSafeGateChain`, so every step is `<pm> …` or `cd <dir>`; we split it on
 * the same `&&` / `||` / `;` sequencers, apply POSIX and-or semantics left to
 * right, spawn each package-manager step directly, and emulate `cd` in-process.
 * Everything streams to one log file and the result is a compact verdict whose
 * first line is a stable sentinel.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isSafeGateChain } from "../../engines/shared/permission-rules.ts";
import { readConfig } from "../config/config.ts";
import { contentIdentity } from "../primitives/content-identity.ts";
import {
  ensureStateDirectory,
  resolveStateRoot,
  stateArtifactPath,
} from "../primitives/state-root.ts";
import {
  gateCacheKey,
  lookupSatisfying,
  passSentinel,
  recordGreen,
  toolchainKey,
  type GateCacheEntry,
} from "./cache.ts";
import { renderVerdict, sentinelLine } from "./summary.ts";

export type GateKind = "fast" | "full";

export interface GateResult {
  exitCode: number;
  /** Compact verdict for stdout; starts with the sentinel when the gate ran. */
  stdout: string;
  /** Refusal / config problems; no sentinel was produced. */
  stderr: string;
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;
const SIGNAL_NUMBER: Record<(typeof SIGNALS)[number], number> = { SIGINT: 2, SIGTERM: 15 };

function refuse(kind: string, reason: string): GateResult {
  return { exitCode: 2, stdout: "", stderr: `navori gate ${kind}: refused — ${reason}` };
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "");
}

/** Spawn recipe for one `<pm> …` step; `options` carries only the platform-specific bits. */
export interface SpawnSpec {
  file: string;
  args: string[];
  options: { windowsVerbatimArguments?: true };
}

/**
 * Builds the spawn recipe for a validated `<pm> …` step. POSIX: the first token is
 * the executable. win32: npm/pnpm/yarn are `.cmd` shims, which Node >= 20 refuses
 * to spawn with `shell: false` (EINVAL, CVE-2024-27980), so the step goes through
 * `cmd.exe /d /s /c` with verbatim arguments. That is safe because every step
 * already passed SAFE_GATE_STEP (`[\w @.:/=-]`): no quotes, `&`, `|`, `<`, `>`,
 * `^` or `%` (the cmd.exe escape and expansion characters) can reach the command line.
 */
export function buildSpawnSpec(
  step: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): SpawnSpec {
  if (platform === "win32") {
    return {
      file: env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", step],
      options: { windowsVerbatimArguments: true },
    };
  }
  const [file = "", ...args] = step.split(/\s+/);
  return { file, args, options: {} };
}

type ChainOp = ";" | "&&" | "||";
interface ChainStep {
  /** Operator that joins this step to the previous one (`;` for the first). */
  op: ChainOp;
  text: string;
}

/** Splits a validated gate on its sequencers, keeping the operator before each step. */
function parseChain(gate: string): ChainStep[] {
  const parts = gate.trim().split(/\s*(&&|\|\||;)\s*/);
  const steps: ChainStep[] = [{ op: ";", text: parts[0]!.trim() }];
  for (let i = 1; i < parts.length; i += 2) {
    steps.push({ op: parts[i] as ChainOp, text: parts[i + 1]!.trim() });
  }
  return steps;
}

/** Runs the validated chain without a shell; resolves the last status (or the received signal). */
async function runChain(
  gate: string,
  repoCwd: string,
  logFd: number,
  platform: NodeJS.Platform = process.platform,
): Promise<{ code: number; signal: string | null }> {
  const posix = platform !== "win32";
  let received: string | null = null;
  let current: ChildProcess | null = null;
  const forward = (signal: (typeof SIGNALS)[number]): void => {
    received = signal;
    const child = current;
    if (!child) return;
    try {
      // detached => own process group, so a signal reaches vitest/semgrep grandchildren too.
      if (posix && child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // already gone
    }
  };
  const handlers = SIGNALS.map((signal) => {
    const handler = (): void => forward(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  const spawnStep = (step: string, cwd: string): Promise<number> =>
    new Promise((resolveStep) => {
      const spec = buildSpawnSpec(step, platform);
      const child = spawn(spec.file, spec.args, {
        ...spec.options,
        shell: false,
        cwd,
        stdio: ["ignore", logFd, logFd],
        detached: posix,
      });
      current = child;
      child.on("error", () => resolveStep(127));
      child.on("close", (code, signal) => {
        received ??= signal;
        resolveStep(code ?? 1);
      });
    });

  let cwd = repoCwd;
  let status = 0;
  try {
    for (const { op, text } of parseChain(gate)) {
      if (received !== null) break;
      if ((op === "&&" && status !== 0) || (op === "||" && status === 0)) continue;
      const [head = "", dir = ""] = text.split(/\s+/);
      if (head === "cd") {
        const target = resolve(cwd, dir);
        if (isDirectory(target)) {
          cwd = target;
          status = 0;
        } else {
          appendFileSync(logFd, `[navori gate] cd: ${dir}: no such directory\n`);
          status = 1;
        }
        continue;
      }
      status = await spawnStep(text, cwd);
      current = null;
    }
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  return { code: status, signal: received };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** First stdout line of a cache hit (spec 0054 Contracts). */
function cachedVerdict(kind: GateKind, hit: GateCacheEntry): string {
  return `navori gate ${kind}: PASS (cached ${hit.ts} · from ${hit.kind} · log ${hit.log} · sha256 ${hit.logSha256})`;
}

/**
 * Runs the configured gate. Refuses (exit 2, no sentinel) when the config is
 * missing/empty or the string fails the same predicate that decides whether the
 * renderer emits a permission rule for it (#197).
 */
export async function runGate(options: {
  cwd: string;
  kind: GateKind;
  now?: Date;
  /** Skip the cache lookup (the green result is still recorded). */
  force?: boolean;
}): Promise<GateResult> {
  const { kind } = options;
  const root = resolveStateRoot({
    cwd: options.cwd,
    feature: "gate",
    dir: ".navori/state/gate",
  });
  const repo = root.cwd;
  let gate: string | undefined;
  let commands: { fast?: string; full?: string } = {};
  try {
    commands = readConfig(resolve(repo, "navori.config.json")).qualityGate ?? {};
    gate = commands[kind];
  } catch (err) {
    return refuse(kind, `cannot read navori.config.json (${(err as Error).message})`);
  }
  if (!gate?.trim()) return refuse(kind, `qualityGate.${kind} is not set in navori.config.json`);
  if (!isSafeGateChain(gate)) {
    return refuse(
      kind,
      `qualityGate.${kind} is not a plain command chain; run it by hand: ${gate.trim()}`,
    );
  }

  // Spec 0054 D1: the identity before the chain keys the lookup and, with the one
  // taken after, guards the record. An identity that cannot be computed disables the cache.
  const before = contentIdentity(repo);
  const tools = before.ok ? toolchainKey(repo) : undefined;
  if (before.ok && !options.force) {
    const hit = lookupSatisfying(root, { kind, fingerprint: before.fingerprint, commands, tools });
    if (hit) return { exitCode: 0, stdout: cachedVerdict(kind, hit), stderr: "" };
  }

  ensureStateDirectory(root);
  const logPath = stateArtifactPath(root, `${kind}-${timestamp(options.now ?? new Date())}.log`);
  const shown = relative(repo, logPath).split("\\").join("/");
  const fd = openSync(logPath, "wx", 0o644);
  let result: { code: number; signal: string | null };
  try {
    result = await runChain(gate, repo, fd);
  } finally {
    closeSync(fd);
  }

  if (result.signal !== null) {
    const exitCode = 128 + (SIGNAL_NUMBER[result.signal as (typeof SIGNALS)[number]] ?? 1);
    const note = `killed by ${result.signal}`;
    appendFileSync(logPath, `\n[navori gate] ${note}\n`);
    return { exitCode, stdout: `${sentinelLine(kind, exitCode, shown)}\n${note}`, stderr: "" };
  }
  if (result.code === 0 && before.ok) {
    const after = contentIdentity(repo);
    // An edit during the run means the green was earned on other bytes: do not record it.
    if (after.ok && after.fingerprint === before.fingerprint) {
      appendFileSync(logPath, `${passSentinel(kind, before.fingerprint)}\n`);
      const key = gateCacheKey({
        repo,
        kind,
        command: gate,
        fingerprint: before.fingerprint,
        tools,
      });
      recordGreen(root, key, logPath, options.now);
    }
  }
  const log = readFileSync(logPath, "utf8");
  return {
    exitCode: result.code,
    stdout: renderVerdict(kind, result.code, shown, log),
    stderr: "",
  };
}
