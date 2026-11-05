import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

/** Programs whose execs the shape tests count. */
export type ShimmedProgram = "grep" | "awk" | "tr" | "sed";

export interface ExecShims {
  /** Env to merge into a spawn: the shim dir first on PATH, plus the log location. */
  readonly env: NodeJS.ProcessEnv;
  /** Truncates the log; call before the run being measured. */
  reset(): void;
  /** Execs per program since the last {@link ExecShims.reset}. */
  counts(): Record<ShimmedProgram, number>;
}

/**
 * PATH shims that log every exec of `grep`/`awk`/`tr`/`sed` and then exec the real binary by
 * absolute path (the same idea as `bench-hooks.mjs`, whose helper is a script, not importable here).
 * Counting forks is robust where wall time is not: a per-segment fork shows up as a count that grows
 * with the command, on any machine load.
 */
export function createExecShims(): ExecShims {
  const dir = mkdtempSync(join(tmpdir(), "navori-exec-shims-"));
  const log = join(dir, "exec.log");
  writeFileSync(log, "");
  const programs: ShimmedProgram[] = ["grep", "awk", "tr", "sed"];
  for (const name of programs) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], {
      encoding: "utf-8",
    }).stdout.trim();
    const shim = join(dir, name);
    writeFileSync(shim, `#!/bin/sh\necho ${name} >> "$EXEC_SHIM_LOG"\nexec "${found}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  return {
    env: { PATH: `${dir}:${process.env.PATH ?? ""}`, EXEC_SHIM_LOG: log },
    reset: () => writeFileSync(log, ""),
    counts: () => {
      const counts: Record<ShimmedProgram, number> = { grep: 0, awk: 0, tr: 0, sed: 0 };
      for (const line of readFileSync(log, "utf-8").split("\n")) {
        if (line in counts) counts[line as ShimmedProgram] += 1;
      }
      return counts;
    },
  };
}

/** Ratio bound for 2N vs N: linear is ~2.0 (less with fixed startup), quadratic is ~4. */
export const MAX_DOUBLING_RATIO = 2.5;

/** The shell work one hook run did, read from its xtrace: deterministic on any machine load. */
export interface TraceShape {
  /** Exit status of the traced run. */
  readonly status: number;
  /** `+`-prefixed xtrace lines: one per simple command bash executed. */
  readonly lines: number;
  /** Total xtrace bytes: every expanded word and assignment, so an O(n) copy per step shows. */
  readonly bytes: number;
}

export interface TraceRun {
  readonly script: string;
  readonly input: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** The bash binary; defaults to `bash` on PATH. */
  readonly bash?: string;
}

/**
 * Runs `bash -x <script>` and measures its trace. xtrace is inherited by functions, subshells,
 * command substitutions and sourced files, so it covers the whole composition. The trace goes to
 * stderr (portable to bash 3.2, which lacks `BASH_XTRACEFD`), so measure only allow-path runs, whose
 * stderr carries nothing else. Work inside a forked program (`sed`, `awk`) or inside a builtin's
 * own expansion is invisible here; fork counts ({@link createExecShims}) cover the former.
 */
export function traceShape(run: TraceRun): TraceShape {
  const result = spawnSync(run.bash ?? "bash", ["-x", run.script], {
    input: run.input,
    encoding: "utf-8",
    env: run.env,
    cwd: run.cwd,
    maxBuffer: 256 * 1024 * 1024,
  });
  const trace = result.stderr ?? "";
  return {
    status: result.status ?? -1,
    lines: trace.split("\n").filter((l) => l.startsWith("+")).length,
    bytes: Buffer.byteLength(trace),
  };
}

/** Doubling ratios of 2N vs N, per trace dimension. */
export function traceRatios(
  small: TraceShape,
  large: TraceShape,
): { lines: number; bytes: number } {
  return { lines: large.lines / small.lines, bytes: large.bytes / small.bytes };
}

/**
 * Asserts a hook scales linearly by SHAPE, not wall time: on a 2N-sized input both the executed
 * command count and the trace bytes stay within {@link MAX_DOUBLING_RATIO} of the N-sized run.
 * Both runs must succeed and produce a trace, so the ratio is never vacuous.
 */
export function expectLinearTrace(small: TraceShape, large: TraceShape): void {
  expect(small.status).toBe(0);
  expect(large.status).toBe(0);
  expect(small.lines).toBeGreaterThan(0);
  const ratios = traceRatios(small, large);
  expect(ratios.lines).toBeLessThanOrEqual(MAX_DOUBLING_RATIO);
  expect(ratios.bytes).toBeLessThanOrEqual(MAX_DOUBLING_RATIO);
}
