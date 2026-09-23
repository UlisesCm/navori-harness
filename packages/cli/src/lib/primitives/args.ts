import * as p from "@clack/prompts";
import { NavoriError } from "./errors.ts";

/**
 * Strict non-negative integer parse for numeric CLI flags (`--depth`, `--limit`).
 * Throws NavoriError (code "invalid-flag") on NaN / negative / non-integer input.
 *
 * Without this, `Number("abc")` yields NaN and slips through downstream: `??`
 * only catches null/undefined so `NaN ?? 4 === NaN` (→ `depth >= NaN` is always
 * false → unlimited scan), and `slice(0, NaN)` treats NaN as 0 (→ silently empty
 * list). See #283.
 */
export function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new NavoriError("invalid-flag", `--${flag} must be a non-negative integer, got '${raw}'`);
  }
  return n;
}

/**
 * Command-boundary wrapper for an optional numeric flag. Returns `fallback` when
 * the flag is absent; on invalid input prints a clean cancel and exits 1 (the
 * pattern commands already use for user errors), instead of letting citty dump a
 * raw stack trace or letting NaN through silently.
 */
export function intFlagOrExit(raw: unknown, flag: string, fallback?: number): number | undefined {
  if (raw === undefined || raw === null || raw === "") return fallback;
  try {
    return parsePositiveInt(String(raw), flag);
  } catch (err) {
    if (err instanceof NavoriError) {
      p.cancel(err.message);
      process.exit(1);
    }
    throw err;
  }
}
