import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { encodeCwdToSlug, repoAuditDir, transcriptsRoot } from "./paths.ts";

/**
 * Finds which sessions to audit, and where their transcripts live.
 *
 * Only sessions explicitly MARKED with audit-mode are eligible: the marker log
 * written by the hooks is the index. Sessions that were never marked are
 * ignored even though their transcripts exist — auditing is opt-in per
 * session, by design.
 */

export interface MarkedSession {
  sessionId: string;
  /** The append-only log the hooks wrote for this session. */
  logFile: string;
  /** Working directory recorded at activation time. */
  cwd: string | null;
  /** Activation timestamp (ISO), used for range filtering. */
  markedAt: string;
  /** Resolved transcript path, or null when it could not be located. */
  transcript: string | null;
}

export interface DiscoveryFilters {
  days?: number;
  since?: string;
  until?: string;
  /** Session id or unique prefix; "latest" picks the most recent. */
  session?: string;
}

interface LogHeader {
  cwd: string | null;
  markedAt: string;
  /** Transcript path as reported by the hook payload, when the log has one. */
  transcript: string | null;
}

/**
 * Reads the activation record, plus the transcript path if the log carries one.
 *
 * `cwd`/`markedAt` come from the first well-formed line (the `start` event).
 * The transcript path cannot: only the hook payload states it, so it is
 * recorded on the first `prompt` event and this keeps scanning until it finds
 * one. Worth the extra pass — it replaces a guess at Claude Code's
 * undocumented directory encoding with the path Claude Code itself reported.
 */
function readHeader(logFile: string): LogHeader {
  let cwd: string | null = null;
  let markedAt = "";
  let transcript: string | null = null;
  let seenHeader = false;
  try {
    const raw = readFileSync(logFile, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj: unknown = JSON.parse(line);
        if (typeof obj !== "object" || obj === null) continue;
        const rec = obj as Record<string, unknown>;
        if (!seenHeader) {
          cwd = typeof rec.cwd === "string" ? rec.cwd : null;
          markedAt = typeof rec.ts === "string" ? rec.ts : "";
          seenHeader = true;
        }
        if (!transcript && typeof rec.transcript === "string" && rec.transcript) {
          transcript = rec.transcript;
          break; // Nothing left to learn from the rest of the log.
        }
      } catch {
        // Skip malformed lines; a truncated log is still a valid log.
      }
    }
  } catch {
    // Unreadable log: treat as headerless rather than failing discovery.
  }
  return { cwd, markedAt, transcript };
}

/**
 * Locates a session's transcript.
 *
 * Primary strategy encodes the cwd into Claude Code's folder name. That
 * encoding is undocumented, so a fallback scans every transcript directory for
 * a file matching the session id — which is exact regardless of encoding.
 */
export function resolveTranscript(
  sessionId: string,
  cwd: string | null,
  recorded?: string | null,
): string | null {
  // Recorded by the hook from the payload: an exact path beats both guesses.
  // Still verified on disk — a transcript can be moved or pruned.
  if (recorded && existsSync(recorded)) return recorded;

  const root = transcriptsRoot();
  if (!existsSync(root)) return null;

  if (cwd) {
    const direct = join(root, encodeCwdToSlug(cwd), `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }

  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function withinRange(markedAt: string, filters: DiscoveryFilters): boolean {
  if (!markedAt) return true;
  const day = markedAt.slice(0, 10);
  if (filters.since && day < filters.since) return false;
  if (filters.until && day > filters.until) return false;
  if (filters.days !== undefined) {
    const cutoff = Date.now() - filters.days * 24 * 60 * 60 * 1000;
    const at = Date.parse(markedAt);
    if (Number.isFinite(at) && at < cutoff) return false;
  }
  return true;
}

/** Lists the marked sessions of a repo that match the filters. */
export function findMarkedSessions(
  repoName: string,
  filters: DiscoveryFilters = {},
): MarkedSession[] {
  const dir = repoAuditDir(repoName);
  if (!existsSync(dir)) return [];

  const sessions: MarkedSession[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.startsWith("session-") || !file.endsWith(".log")) continue;
    const sessionId = basename(file)
      .replace(/^session-/, "")
      .replace(/\.log$/, "");
    const logFile = join(dir, file);
    const { cwd, markedAt, transcript } = readHeader(logFile);
    sessions.push({
      sessionId,
      logFile,
      cwd,
      markedAt,
      transcript: resolveTranscript(sessionId, cwd, transcript),
    });
  }

  sessions.sort((a, b) => b.markedAt.localeCompare(a.markedAt));

  if (filters.session === "latest") return sessions.slice(0, 1);
  if (filters.session) {
    const prefix = filters.session;
    return sessions.filter((s) => s.sessionId.startsWith(prefix));
  }
  return sessions.filter((s) => withinRange(s.markedAt, filters));
}
