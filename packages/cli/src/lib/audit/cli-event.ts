import { closeSync, constants, fstatSync, lstatSync, openSync, writeSync } from "node:fs";
import { findMarkedSessions } from "./discovery.ts";
import {
  auditsRoot,
  projectRootFromCwd,
  repoAuditDir,
  repoFromCwd,
  sessionLogPath,
} from "./paths.ts";
import { resolve } from "node:path";

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

interface AuditContext {
  host: "claude" | "codex";
  sessionId: string;
}

function contextFromEnv(): AuditContext | null {
  const host = process.env.NAVORI_AUDIT_HOST?.trim();
  const sessionId = process.env.NAVORI_AUDIT_SESSION_ID?.trim();
  if (host !== undefined || sessionId !== undefined) {
    if ((host !== "claude" && host !== "codex") || !sessionId) return null;
    return { host, sessionId };
  }
  const claude = process.env.CLAUDE_CODE_SESSION_ID?.trim();
  if (claude) return { host: "claude", sessionId: claude };
  const codexSession = process.env.CODEX_SESSION_ID?.trim();
  const codexThread = process.env.CODEX_THREAD_ID?.trim();
  if (codexSession && codexThread && codexSession !== codexThread) return null;
  const codex = codexSession || codexThread;
  return codex ? { host: "codex", sessionId: codex } : null;
}

/**
 * Appends a CLI decision to the exact validated audit session.
 *
 * A complete `NAVORI_AUDIT_HOST`/`NAVORI_AUDIT_SESSION_ID` pair wins, then
 * Claude's documented session variable, then Codex's verified session/thread
 * variable. A partial pair or conflicting identities never falls back. The
 * log is the one `navori audit --start` created under the audit root of the
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
 * One `writeSync` of a complete line (O_APPEND), so concurrent writers
 * cannot interleave inside a record.
 *
 * @returns whether a record was written.
 */
export function appendCliEvent(cwd: string, event: CliEvent): boolean {
  try {
    const context = contextFromEnv();
    if (!context) return false;
    const { host, sessionId } = context;
    if (host !== "claude" && host !== "codex") return false;
    if (
      host === "claude" &&
      (process.env.CODEX_SESSION_ID?.trim() || process.env.CODEX_THREAD_ID?.trim())
    )
      return false;
    if (host === "codex" && process.env.CLAUDE_CODE_SESSION_ID?.trim()) return false;
    if (
      host === "claude" &&
      process.env.CLAUDE_CODE_SESSION_ID?.trim() &&
      process.env.CLAUDE_CODE_SESSION_ID?.trim() !== sessionId
    )
      return false;
    if (
      host === "codex" &&
      [process.env.CODEX_SESSION_ID, process.env.CODEX_THREAD_ID].some(
        (id) => id?.trim() && id.trim() !== sessionId,
      )
    )
      return false;
    const repo = repoFromCwd(cwd);
    // Do not traverse a replaced audit root or repo directory, even if the
    // final log itself is regular and O_NOFOLLOW would accept it.
    if (!lstatSync(auditsRoot()).isDirectory() || !lstatSync(repoAuditDir(repo)).isDirectory())
      return false;
    const logFile = sessionLogPath(repo, sessionId);
    const st = lstatSync(logFile);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    // TODO(perf): use a direct exact-header lookup when audited repos exceed
    // ~100 logs; T8 owns range indexing, not this low-volume CLI event path.
    const marker = findMarkedSessions(repo, { session: sessionId }).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (
      !marker ||
      marker.host !== host ||
      !marker.cwd ||
      resolve(projectRootFromCwd(marker.cwd)) !== resolve(projectRootFromCwd(cwd))
    )
      return false;
    if (marker.sourceStatus === "identity-conflict") return false;
    if (host === "codex" && marker.sourceStatus !== "verified") return false;
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
