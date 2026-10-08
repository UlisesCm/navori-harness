/**
 * Session-state size surveillance (#1263) — the session-state file under
 * `progress/` is meant to hold the CURRENT state and the next step, but nothing
 * stops it from turning into an append-only log (38.8 KB measured in this
 * repo). The SessionStart hook delivers context under a fixed character
 * budget, so a fat file falls out of startup context instead of informing it.
 *
 * Read-only: doctor reports the size and the remedy (move checkpoints to the
 * history file); it never rewrites the file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROGRESS_SOFT_CAP_BYTES } from "../assets/doc-budgets.ts";

/** Fixed runtime path the session hook reads (`progress.currentFile` is deprecated, #779). */
export const PROGRESS_CURRENT_PATH = "progress/current.md";

/** Soft cap in bytes, shared with the hooks (see `PROGRESS_SOFT_CAP_BYTES`). */
export const DEFAULT_PROGRESS_THRESHOLD_BYTES = PROGRESS_SOFT_CAP_BYTES;

export interface ProgressSizeIssue {
  /** Repo-relative path of the measured file. */
  path: string;
  /** Size in bytes (UTF-8), matching the hooks' `wc -c`. */
  bytes: number;
  thresholdBytes: number;
}

/**
 * Report the session-state file when it exceeds `thresholdBytes`. A missing or
 * unreadable file is simply fine — never throws.
 */
export function scanProgressSize(
  cwd: string,
  thresholdBytes: number = DEFAULT_PROGRESS_THRESHOLD_BYTES,
): ProgressSizeIssue | null {
  let bytes: number;
  try {
    bytes = readFileSync(join(cwd, PROGRESS_CURRENT_PATH)).byteLength;
  } catch {
    return null;
  }
  if (bytes <= thresholdBytes) return null;
  return { path: PROGRESS_CURRENT_PATH, bytes, thresholdBytes };
}
