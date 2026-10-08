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
import { SESSION_CONTEXT_DELIVERY_BUDGET_CHARS } from "../assets/doc-budgets.ts";

/** Fixed runtime path the session hook reads (`progress.currentFile` is deprecated, #779). */
export const PROGRESS_CURRENT_PATH = "progress/current.md";

/** Half the session-start delivery budget — leaves room for the other context files. */
export const DEFAULT_PROGRESS_THRESHOLD_CHARS = SESSION_CONTEXT_DELIVERY_BUDGET_CHARS / 2;

export interface ProgressSizeIssue {
  /** Repo-relative path of the measured file. */
  path: string;
  /** Length in characters (not bytes), matching the hook's `${#body}`. */
  chars: number;
  thresholdChars: number;
}

/**
 * Report the session-state file when it exceeds `thresholdChars`. A missing or
 * unreadable file is simply fine — never throws.
 */
export function scanProgressSize(
  cwd: string,
  thresholdChars: number = DEFAULT_PROGRESS_THRESHOLD_CHARS,
): ProgressSizeIssue | null {
  let chars: number;
  try {
    chars = readFileSync(join(cwd, PROGRESS_CURRENT_PATH), "utf-8").length;
  } catch {
    return null;
  }
  if (chars <= thresholdChars) return null;
  return { path: PROGRESS_CURRENT_PATH, chars, thresholdChars };
}
