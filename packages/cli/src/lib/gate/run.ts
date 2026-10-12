/**
 * Runner behind `navori gate <fast|full>`: runs `qualityGate.<kind>` verbatim
 * (no splitting, no rewriting), streams everything to a log file and returns a
 * compact verdict whose first line is a stable sentinel.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, appendFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isSafeGateChain } from "../../engines/shared/permission-rules.ts";
import { readConfig } from "../config/config.ts";
import {
  ensureStateDirectory,
  resolveStateRoot,
  stateArtifactPath,
} from "../primitives/state-root.ts";
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

/** Runs the shell string with stdio on the log fd; resolves the chain's exit code. */
function runShell(
  command: string,
  cwd: string,
  logFd: number,
): Promise<{ code: number; signal: string | null }> {
  return new Promise((resolveRun) => {
    const posix = process.platform !== "win32";
    // detached => own process group, so a signal reaches vitest/semgrep grandchildren too.
    // Intentional: the gate is a shell chain by contract, and `runGate` validated it with
    // `isSafeGateChain` (no pipes/quotes/`$`) before getting here.
    // prettier-ignore
    // ast-grep-ignore: no-shell-exec
    const child = spawn(command, { // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true
      cwd,
      shell: true,
      stdio: ["ignore", logFd, logFd],
      detached: posix,
    });
    let received: string | null = null;
    const forward = (signal: (typeof SIGNALS)[number]): void => {
      received = signal;
      try {
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
    const done = (code: number, signal: string | null): void => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolveRun({ code, signal: received ?? signal });
    };
    child.on("error", () => done(127, null));
    child.on("close", (code, signal) => done(code ?? 1, signal));
  });
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
    result = await runShell(gate.trim(), repo, fd);
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
