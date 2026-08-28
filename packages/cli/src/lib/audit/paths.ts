import { join, resolve } from "node:path";
import { NavoriError } from "../errors.ts";
import { safeHomedir } from "../home.ts";

/** Env var that redirects the whole audit store (logs AND generated reports). */
const AUDITS_ROOT_ENV = "NAVORI_AUDITS_ROOT";

/**
 * Session ids are opaque host tokens (Claude Code sends a UUID), so anything
 * path-shaped is rejected instead of being pasted into a filename.
 *
 * `join` normalizes, and the `session-` prefix only glues to the FIRST segment:
 * `session-a/../../x` collapses to `../x` relative to the repo dir, so from the
 * second `..` on the log lands outside the audit root the command promises to
 * stay inside (#503).
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Where audit logs and reports live: `$NAVORI_AUDITS_ROOT` when set, else
 * `~/.navori/audits`.
 *
 * Same rationale as the backup store (`lib/backup.ts`): the home-derived path
 * is a machine-global side effect, so a sandboxed run — every in-process test
 * included — must be able to redirect it instead of writing into the
 * developer's real `~/.navori/audits`.
 *
 * Lazy so importing this module never throws when HOME isn't set: the throw
 * belongs to whoever actually performs an audit operation.
 */
export function auditsRoot(): string {
  const override = process.env[AUDITS_ROOT_ENV]?.trim();
  // resolve(): a relative override would hang off the process CWD and silently
  // move the store when the caller chdirs — see safeHomedir().
  if (override) return resolve(override);
  return join(safeHomedir(), ".navori", "audits");
}

/**
 * Per-repo audit directory, e.g. `~/.navori/audits/navori-harness`.
 *
 * `repoName` is ONE path segment, never a path: today's callers derive it from
 * `basename(resolve(cwd))`, so a separator can't reach here — the guard is for
 * the next caller, since a `..` or a `/` would move the whole per-repo store
 * out of the audit root (same class of defect as #503, one call up).
 */
export function repoAuditDir(repoName: string): string {
  if (!repoName || repoName === "." || repoName === ".." || /[/\\]/.test(repoName)) {
    throw new NavoriError(
      "invalid-repo-name",
      `Invalid repo name '${repoName}' for the audit store: expected a single path segment ` +
        `(no separators, not '.' or '..').`,
    );
  }
  return join(auditsRoot(), repoName);
}

/**
 * The append-only event log for one session.
 *
 * One file per session, named by session id. It is written exclusively with
 * O_APPEND by the hooks and NEVER rewritten: reports are separate derived
 * files, so a crashed session still leaves a valid (merely shorter) log.
 *
 * The id is validated HERE and not at the call site: this is the function that
 * turns it into a filesystem path, so a guard anywhere else leaves the next
 * caller writing outside the audit root (#503).
 */
export function sessionLogPath(repoName: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new NavoriError(
      "invalid-session-id",
      `Invalid session id '${sessionId}': only letters, digits, '-' and '_' are allowed. ` +
        `The audit log is named after it, and every write must stay under the audit root.`,
    );
  }
  return join(repoAuditDir(repoName), `session-${sessionId}.log`);
}

/** Root of Claude Code's transcript store. Read-only for navori, always. */
export function transcriptsRoot(): string {
  const override = process.env.NAVORI_TRANSCRIPTS_ROOT?.trim();
  if (override) return resolve(override);
  return join(safeHomedir(), ".claude", "projects");
}

/**
 * Claude Code's encoding of a working directory into a transcript folder name.
 *
 * Observed transformation (verified against real transcript dirs): every
 * character that isn't alphanumeric, `-` or `_` becomes `-`. A path with
 * spaces therefore collapses two ways at once, e.g.
 * `/Users/u/Dev - Docs/navori-harness` → `-Users-u-Dev---Docs-navori-harness`.
 *
 * This is a heuristic over an undocumented format, so callers must fall back
 * to scanning transcript dirs by their recorded `cwd` field when it misses.
 */
export function encodeCwdToSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Where one session's artifacts live: `sessions/<YYYY-MM-DD>-<id8>/`.
 *
 * A directory per session rather than loose files sharing a prefix (spec 0013,
 * R15). The old layout named reports by RANGE, so two runs covering different
 * ranges left overlapping pairs that nothing ever reconciled — four of them had
 * accumulated in this repo's own store before anyone noticed.
 *
 * The id is validated by the same rule `sessionLogPath` applies, and for the
 * same reason: this is a function that turns an opaque host token into a
 * filesystem path (#503).
 */
export function sessionReportDir(repoName: string, day: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new NavoriError(
      "invalid-session-id",
      `Invalid session id '${sessionId}': only letters, digits, '-' and '_' are allowed. ` +
        `The report directory is named after it, and every write must stay under the audit root.`,
    );
  }
  if (!DAY_RE.test(day)) {
    throw new NavoriError(
      "invalid-audit-day",
      `Invalid day '${day}': expected YYYY-MM-DD. It composes the report directory name.`,
    );
  }
  // Short id: the directory is for a human to open, and the date already
  // disambiguates. The FULL id stays inside the log's own `start` event.
  return join(repoAuditDir(repoName), "sessions", `${day}-${sessionId.slice(0, 8)}`);
}

/** Where a multi-session report lives: `ranges/<from>--<to>/` (R16). */
export function rangeReportDir(repoName: string, from: string, to: string): string {
  for (const day of [from, to]) {
    if (!DAY_RE.test(day)) {
      throw new NavoriError(
        "invalid-audit-day",
        `Invalid day '${day}': expected YYYY-MM-DD. It composes the report directory name.`,
      );
    }
  }
  return join(repoAuditDir(repoName), "ranges", `${from}--${to}`);
}

/** `YYYY-MM-DD`, the only shape allowed to compose a directory name. Anything
 *  else — an empty range from a session with no timestamps included — would
 *  produce a nameless or traversing path. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
