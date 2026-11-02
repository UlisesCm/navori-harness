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

function medianMs(run: () => void, runs = 3): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  return samples.sort((a, b) => a - b)[Math.floor(runs / 2)] ?? 0;
}

/** Ratio bound for 2N vs N: linear is ~2.0 (less with fixed startup), quadratic is ~4. */
export const MAX_DOUBLING_RATIO = 2.5;
/** Under this base time process startup dominates and a ratio is noise. */
const NOISE_FLOOR_MS = 30;
/** Absolute ceiling for 2N when the base is under the noise floor. */
const ABSOLUTE_FLOOR_MS = 250;

/**
 * Asserts a hook scales linearly: the median of three runs on a 2N-byte command is at most
 * {@link MAX_DOUBLING_RATIO} times the median on N bytes. A base under {@link NOISE_FLOOR_MS} is
 * compared against an absolute floor instead, so startup noise cannot flake it.
 */
export function expectLinearScaling(runSmall: () => void, runLarge: () => void): void {
  runSmall(); // warm the page cache and PATH lookups
  const small = medianMs(runSmall);
  const large = medianMs(runLarge);
  if (small <= NOISE_FLOOR_MS) expect(large).toBeLessThan(ABSOLUTE_FLOOR_MS);
  else expect(large / small).toBeLessThanOrEqual(MAX_DOUBLING_RATIO);
}
