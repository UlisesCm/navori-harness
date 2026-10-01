import { closeSync, constants, fstatSync, lstatSync, openSync, writeSync } from "node:fs";
import { repoFromCwd, sessionLogPath } from "./paths.ts";

/** What a navori command reports about one decision it took. */
export interface CliEvent {
  /** Stable mechanism name, e.g. `plan-gate`. */
  name: string;
  /** Outcome, in the same vocabulary hooks use (`allow`, `block`, `skip`...). */
  verdict: string;
  /**
   * Why. MUST NOT carry command text, paths of user input or any free-form
   * user content: the caller guarantees it, this function does not scrub.
   */
  reason?: string;
}

/**
 * Appends a CLI decision to the audit log of the current Claude Code session.
 *
 * The session is `CLAUDE_CODE_SESSION_ID` (documented for Bash tool commands);
 * the log is the one `navori audit --start` created under the audit root of the
 * repo `cwd` belongs to. The log's EXISTENCE is the audit-mode switch, so with
 * no variable, no log, an unsafe id or any filesystem error nothing is written.
 *
 * The log must be a regular file, never a symlink: `existsSync` + a plain
 * append would follow a link and write outside the audit root. It is opened
 * with `O_NOFOLLOW | O_APPEND | O_WRONLY` (no `O_CREAT`, so a missing log is
 * simply an error) and the record goes through that fd, which also closes the
 * check-then-open race a bare `lstat` would leave. Where `O_NOFOLLOW` does not
 * exist (Windows) the `lstat` below is the guard.
 *
 * FAIL-OPEN: never throws. Observation must not change what the command does.
 * One `appendFileSync` of a complete line (O_APPEND), so concurrent writers
 * cannot interleave inside a record.
 *
 * @returns whether a record was written.
 */
export function appendCliEvent(cwd: string, event: CliEvent): boolean {
  try {
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID?.trim();
    if (!sessionId) return false;
    const logFile = sessionLogPath(repoFromCwd(cwd), sessionId);
    const st = lstatSync(logFile);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    const record = {
      tsMs: Date.now(),
      event: "cli",
      name: event.name,
      verdict: event.verdict,
      ...(event.reason ? { reason: event.reason } : {}),
    };
    const fd = openSync(
      logFile,
      constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if (!fstatSync(fd).isFile()) return false;
      writeSync(fd, `${JSON.stringify(record)}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}
