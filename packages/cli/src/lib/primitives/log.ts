/**
 * Structured logger — spec 0003 §3.4.4.
 *
 * Level gated by `NAVORI_LOG` (debug|info|warn|error), default `warn`. Writes
 * to stderr so stdout stays clean for `--json` piping. `debug`/`info` are
 * silent unless NAVORI_LOG raises the level — use them freely to trace the
 * render/sync flow without polluting normal runs.
 *
 * The threshold is read per call (not cached) so it's testable and honours a
 * mid-process env change; logging is never a hot path so the cost is moot.
 */
type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = process.env.NAVORI_LOG;
  return raw && raw in ORDER ? ORDER[raw as Level] : ORDER.warn;
}

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  process.stderr.write(`[navori:${level}] ${message}${suffix}\n`);
}

export const log = {
  debug: (message: string, meta?: Record<string, unknown>) => emit("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit("error", message, meta),
};
