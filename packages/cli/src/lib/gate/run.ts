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
import {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { isSafeGateChain } from "../../engines/shared/permission-rules.ts";
import { readConfig } from "../config/config.ts";
import { gitOut, isRegisteredCheckout } from "../workspace/workspace.ts";
import {
  ensureStateDirectory,
  resolveStateRoot,
  stateArtifactPath,
} from "../primitives/state-root.ts";
import { renderVerdict, sentinelLine } from "./summary.ts";

export type GateKind = "fast" | "full";

/**
 * Exit code of a `navori gate foreign` refusal (#1097). Distinct from every plain
 * refusal (2) so a caller can tell "not eligible" from "the destination's gate
 * exited 2"; the caller still pairs it with the first output line.
 */
export const FOREIGN_REFUSED_EXIT = 64;
/** Prefix of the private per-run log directories; pruned to `FOREIGN_LOG_KEEP`. */
export const FOREIGN_LOG_PREFIX = "navori-gate-foreign-";
const FOREIGN_LOG_KEEP = 20;

export interface GateResult {
  exitCode: number;
  /** Compact verdict for stdout; starts with the sentinel when the gate ran. */
  stdout: string;
  /** Refusal / config problems; no sentinel was produced. */
  stderr: string;
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;
const SIGNAL_NUMBER: Record<(typeof SIGNALS)[number], number> = { SIGINT: 2, SIGTERM: 15 };

function refuse(kind: string, reason: string, exitCode = 2): GateResult {
  return { exitCode, stdout: "", stderr: `navori gate ${kind}: refused — ${reason}` };
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

/**
 * Runs the configured gate. Refuses (exit 2, no sentinel) when the config is
 * missing/empty or the string fails the same predicate that decides whether the
 * renderer emits a permission rule for it (#197).
 */
export async function runGate(options: {
  cwd: string;
  kind: GateKind;
  now?: Date;
}): Promise<GateResult> {
  const { kind } = options;
  const root = resolveStateRoot({
    cwd: options.cwd,
    feature: "gate",
    dir: ".navori/state/gate",
  });
  const repo = root.cwd;
  let gate: string | undefined;
  try {
    gate = readConfig(resolve(repo, "navori.config.json")).qualityGate?.[kind];
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
  const log = readFileSync(logPath, "utf8");
  return {
    exitCode: result.code,
    stdout: renderVerdict(kind, result.code, shown, log),
    stderr: "",
  };
}

/** Keeps the newest `keep` own-prefix log dirs under `root`; never follows symlinks. */
export function pruneForeignLogs(root: string, keep = FOREIGN_LOG_KEEP): void {
  try {
    const uid = process.getuid?.();
    const dirs = readdirSync(root)
      .filter((name) => name.startsWith(FOREIGN_LOG_PREFIX))
      .map((name) => ({ path: join(root, name), st: lstatSync(join(root, name)) }))
      .filter(({ st }) => st.isDirectory() && (uid === undefined || st.uid === uid))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    for (const { path } of dirs.slice(keep)) rmSync(path, { recursive: true, force: true });
  } catch {
    // retention is best effort; it never decides a verdict
  }
}

/**
 * `navori gate foreign --cwd <toplevel>` (#1097): runs the destination repo's
 * `qualityGate.fast` for a commit that lands outside the hook's own repo. The
 * destination's config is untrusted content, so, in this order: the canonical
 * toplevel must be registered by the user (or be a back-linked worktree of a
 * registered repo) BEFORE its config is parsed; `nativeHooks` repos refuse (their
 * own pre-commit runs it); the chain must pass `isSafeGateChain`; then it runs
 * shell-free. The log goes to a private temp directory, never into the
 * destination tree. Every refusal is exit `FOREIGN_REFUSED_EXIT` with no sentinel.
 */
export async function runForeignGate(options: { cwd: string; now?: Date }): Promise<GateResult> {
  const kind = "foreign";
  let top: string;
  try {
    const out = gitOut(resolve(options.cwd), ["rev-parse", "--show-toplevel"])?.trim();
    if (!out) throw new Error("not a git checkout");
    top = realpathSync(out);
  } catch {
    return refuse(kind, `--cwd is not a Git checkout: ${options.cwd}`, FOREIGN_REFUSED_EXIT);
  }
  if (!isRegisteredCheckout(top)) {
    return refuse(
      kind,
      `${top} is not registered in any navori workspace; run 'navori workspace link <workspace> --cwd ${top}' to opt in`,
      FOREIGN_REFUSED_EXIT,
    );
  }
  let config: ReturnType<typeof readConfig>;
  try {
    config = readConfig(resolve(top, "navori.config.json"));
  } catch (err) {
    return refuse(
      kind,
      `cannot read navori.config.json (${(err as Error).message})`,
      FOREIGN_REFUSED_EXIT,
    );
  }
  const gate = config.qualityGate?.fast;
  if (!gate?.trim()) {
    return refuse(kind, "qualityGate.fast is not set in navori.config.json", FOREIGN_REFUSED_EXIT);
  }
  if (config.qualityGate?.nativeHooks === true) {
    return refuse(
      kind,
      "qualityGate.nativeHooks is true; the destination's native pre-commit runs its gate",
      FOREIGN_REFUSED_EXIT,
    );
  }
  if (!isSafeGateChain(gate)) {
    return refuse(
      kind,
      `qualityGate.fast is not a plain command chain; run it by hand in the destination: ${gate.trim()}`,
      FOREIGN_REFUSED_EXIT,
    );
  }

  const base = tmpdir();
  pruneForeignLogs(base);
  const dir = mkdtempSync(join(base, FOREIGN_LOG_PREFIX)); // mode 0700
  const logPath = join(dir, `fast-${timestamp(options.now ?? new Date())}.log`);
  const fd = openSync(logPath, "wx", 0o600);
  let result: { code: number; signal: string | null };
  try {
    result = await runChain(gate, top, fd);
  } finally {
    closeSync(fd);
  }
  if (result.signal !== null) {
    const exitCode = 128 + (SIGNAL_NUMBER[result.signal as (typeof SIGNALS)[number]] ?? 1);
    const note = `killed by ${result.signal}`;
    appendFileSync(logPath, `\n[navori gate] ${note}\n`);
    return { exitCode, stdout: `${sentinelLine(kind, exitCode, logPath)}\n${note}`, stderr: "" };
  }
  return {
    exitCode: result.code,
    stdout: renderVerdict(kind, result.code, logPath, readFileSync(logPath, "utf8")),
    stderr: "",
  };
}
