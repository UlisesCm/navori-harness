import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";

/**
 * Upper bound on forks. The e2e specs each `spawnSync(dist/index.js)`, so too
 * many workers exhaust file descriptors (EMFILE, #281). Measured in spec 0054 M2:
 * under load, CAP=8 gave wall 545-568 s vs 495-574 s at 4 workers, while per-file
 * time rose 1.3-1.8x (sumFiles 3833-4072 s vs 1822 s), causing timeouts and 28
 * files over budget. Revalidate on an idle machine (M8).
 */
export const WORKER_CAP = 4;

/** File descriptors budgeted per worker (its fork plus the CLI children it spawns). */
export const FDS_PER_WORKER = 64;

/** Reads the soft fd limit once via a shell; `unlimited` and failures yield `Infinity`. */
export function readUlimit(): number {
  const result = spawnSync("sh", ["-c", "ulimit -n"], { encoding: "utf8" });
  const value = Number.parseInt(result.stdout.trim(), 10);
  return result.status === 0 && Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

export interface WorkerInputs {
  env?: Record<string, string | undefined>;
  cpus?: number;
  ulimit?: number;
}

/**
 * `NAVORI_TEST_WORKERS` (a positive integer) wins; otherwise
 * `min(cpus - 1, WORKER_CAP, floor(ulimit / FDS_PER_WORKER))`, never below 1.
 */
export function resolveMaxWorkers(inputs: WorkerInputs = {}): number {
  const override = Number.parseInt((inputs.env ?? process.env).NAVORI_TEST_WORKERS ?? "", 10);
  if (Number.isInteger(override) && override > 0) return override;
  const cpus = inputs.cpus ?? availableParallelism();
  const ulimit = inputs.ulimit ?? readUlimit();
  return Math.max(1, Math.min(cpus - 1, WORKER_CAP, Math.floor(ulimit / FDS_PER_WORKER)));
}
