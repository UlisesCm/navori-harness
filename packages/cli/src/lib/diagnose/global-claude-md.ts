/**
 * Global `~/.claude/CLAUDE.md` size surveillance (#1270) — Claude Code loads
 * the user-level file into every session on top of the repo's context, and
 * nothing else measures it. Read-only: doctor reports the size and the remedy;
 * it never writes the file.
 */
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { claudeUserDir } from "../../engines/claude/user-scope.ts";
import { GLOBAL_CLAUDE_MD_SOFT_CAP_CHARS } from "../assets/doc-budgets.ts";
import { safeHomedir } from "../primitives/home.ts";

export interface GlobalClaudeMdIssue {
  /** Resolved path of the measured file, with the home directory shortened to `~`. */
  path: string;
  /** Size in characters. */
  chars: number;
  thresholdChars: number;
}

/** Shorten a leading home directory to `~`; a path outside home stays as is. */
function displayPath(file: string): string {
  try {
    const home = safeHomedir();
    if (file.startsWith(home + sep)) return `~${file.slice(home.length)}`;
  } catch {
    // unresolvable home: show the full path
  }
  return file;
}

/**
 * Report the user-level CLAUDE.md (under `CLAUDE_CONFIG_DIR` when set, else
 * `~/.claude`) when it exceeds `thresholdChars`. A missing or unreadable file
 * (or an unresolvable home) is simply fine — never throws.
 */
export function scanGlobalClaudeMd(
  thresholdChars: number = GLOBAL_CLAUDE_MD_SOFT_CAP_CHARS,
): GlobalClaudeMdIssue | null {
  let file: string;
  let chars: number;
  try {
    file = join(claudeUserDir(), "CLAUDE.md");
    chars = readFileSync(file, "utf8").length;
  } catch {
    return null;
  }
  if (chars <= thresholdChars) return null;
  return { path: displayPath(file), chars, thresholdChars };
}
