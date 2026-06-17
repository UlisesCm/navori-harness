import { performance } from "node:perf_hooks";

/**
 * Lightweight step timing — spec 0003 §3.3.4.
 *
 * Gated by `NAVORI_BENCH=1`. A command calls `benchStart()` once, instruments
 * the flow with `benchMark("label")` at step boundaries, and `benchReport()`
 * prints a per-step table to stderr (stdout stays clean for `--json` piping).
 * When the env var is off, every call is a no-op — zero overhead in normal use.
 *
 * Module-level singleton: a navori invocation is a single-shot process, so
 * threading a timer object through every call site buys nothing.
 */

const enabled = process.env.NAVORI_BENCH === "1";

interface Mark {
  label: string;
  ms: number;
}

let startTime = 0;
let lastTime = 0;
const marks: Mark[] = [];

export function benchEnabled(): boolean {
  return enabled;
}

export function benchStart(): void {
  if (!enabled) return;
  startTime = lastTime = performance.now();
  marks.length = 0;
}

export function benchMark(label: string): void {
  if (!enabled) return;
  const now = performance.now();
  if (startTime === 0) startTime = lastTime = now;
  marks.push({ label, ms: now - lastTime });
  lastTime = now;
}

export function benchReport(): void {
  if (!enabled || marks.length === 0) return;
  const total = performance.now() - startTime;
  const rows = [...marks, { label: "total", ms: total }];
  const width = Math.max(...rows.map((r) => r.label.length));
  let out = "\n[navori bench]\n";
  for (const r of rows) {
    out += `  ${r.label.padEnd(width)}  ${r.ms.toFixed(1).padStart(8)}ms\n`;
  }
  process.stderr.write(out);
}
