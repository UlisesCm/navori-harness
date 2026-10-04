import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
  type Dirent,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { codexHome } from "../codex/home.ts";
import {
  auditsRoot,
  encodeCwdToSlug,
  projectRootFromCwd,
  repoAuditDir,
  transcriptsRoot,
} from "./paths.ts";

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
  /** Host that recorded the `start` event; `"codex"` sessions have no Claude transcript. */
  host: "claude" | "codex" | "unknown";
  /** Explicit marker or a read-only recovery from matching source metadata. */
  hostProvenance: "declared" | "recovered:rollout" | "recovered:transcript" | "unknown";
  sourceStatus: "verified" | "missing" | "wrong-format" | "identity-conflict";
  /** Adapter is selected only after source shape and root identity verify. */
  adapter: "claude-transcript" | "codex-rollout" | null;
  source: string | null;
  sourceVersion: string | null;
  sourceReason: string | null;
  versionReason: "not-observed" | null;
  /** Codex rollout path (spec 0041 R24), `null` for Claude sessions or when not found. */
  rollout: string | null;
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
  host: MarkedSession["host"];
  identityConflict: boolean;
  present: boolean;
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
function readHeader(logFile: string, sessionId: string, repoName: string): LogHeader {
  let cwd: string | null = null;
  let markedAt = "";
  let transcript: string | null = null;
  let seenHeader = false;
  let host: LogHeader["host"] = "unknown";
  let identityConflict = false;
  try {
    const raw = readFileSync(logFile, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj: unknown = JSON.parse(line);
        if (typeof obj !== "object" || obj === null) continue;
        const rec = obj as Record<string, unknown>;
        if (!seenHeader) {
          if (rec.event !== "start") continue;
          cwd = typeof rec.cwd === "string" ? rec.cwd : null;
          markedAt = typeof rec.ts === "string" ? rec.ts : "";
          if (rec.host === "codex" || rec.host === "claude") host = rec.host;
          else if (rec.host !== undefined) identityConflict = true;
          if (rec.sessionId !== undefined && rec.sessionId !== sessionId) identityConflict = true;
          if (rec.repo !== undefined && rec.repo !== repoName) identityConflict = true;
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
  return { cwd, markedAt, transcript, host, identityConflict, present: seenHeader };
}

interface SourceIdentity {
  host: "claude" | "codex";
  status: MarkedSession["sourceStatus"];
  version?: string;
}

/** At most the first root-metadata line; later prompt/tool records stay unread. */
function sourceMetadataLine(file: string): string | null {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytes).indexOf(10);
    if (end < 0 && bytes === buffer.length) return null;
    return buffer.toString("utf-8", 0, end >= 0 ? end : bytes);
  } finally {
    closeSync(fd);
  }
}

/** Read only versioned identity fields; never inspect prompts or tool payloads. */
function inspectSource(
  file: string | null,
  host: "claude" | "codex",
  sessionId: string,
  cwd: string | null,
): SourceIdentity {
  if (!file) return { host, status: "missing" };
  try {
    if (!lstatSync(file).isFile()) return { host, status: "wrong-format" };
    const line = sourceMetadataLine(file);
    if (line?.trim()) {
      const rec: unknown = JSON.parse(line);
      if (typeof rec !== "object" || rec === null) return { host, status: "wrong-format" };
      const record = rec as Record<string, unknown>;
      const meta = host === "codex" ? record.payload : record;
      if (host === "codex" && record.type !== "session_meta")
        return { host, status: "wrong-format" };
      if (typeof meta !== "object" || meta === null) return { host, status: "wrong-format" };
      const fields = meta as Record<string, unknown>;
      const id = host === "codex" ? (fields.id ?? fields.session_id) : fields.sessionId;
      if (
        host === "codex" &&
        fields.id !== undefined &&
        fields.session_id !== undefined &&
        fields.id !== fields.session_id
      )
        return { host, status: "identity-conflict" };
      if (
        host === "claude" &&
        !["user", "assistant", "system", "summary"].includes(String(record.type))
      )
        return { host, status: "wrong-format" };
      if (typeof id !== "string") return { host, status: "wrong-format" };
      if (typeof fields.cwd !== "string") return { host, status: "wrong-format" };
      if (
        id !== sessionId ||
        (cwd && resolve(projectRootFromCwd(fields.cwd)) !== resolve(projectRootFromCwd(cwd)))
      )
        return { host, status: "identity-conflict" };
      const version = host === "codex" ? fields.cli_version : fields.version;
      return {
        host,
        status: "verified",
        ...(typeof version === "string" && version ? { version } : {}),
      };
    }
    return { host, status: "wrong-format" };
  } catch {
    return { host, status: existsSync(file) ? "wrong-format" : "missing" };
  }
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

/** Depth-bounded walk: `sessions/YYYY/MM/DD/` is three levels; one spare. */
const ROLLOUT_MAX_DEPTH = 5;

function findRolloutIn(dir: string, suffix: string, depth: number): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(suffix)) {
      return join(dir, e.name);
    }
  }
  if (depth >= ROLLOUT_MAX_DEPTH) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findRolloutIn(join(dir, e.name), suffix, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Locates a Codex session's rollout (spec 0041 R24): the path the hook payload
 * recorded when it still exists, else `codexHome()/sessions/**` matching
 * `rollout-*-<sessionId>.jsonl`. Never throws — a bad `CODEX_HOME` or an
 * unreadable tree is "not found".
 */
export function resolveCodexRollout(sessionId: string, recorded?: string | null): string | null {
  if (recorded && existsSync(recorded)) return recorded;
  try {
    const root = join(codexHome(), "sessions");
    if (!existsSync(root)) return null;
    return findRolloutIn(root, `-${sessionId}.jsonl`, 0);
  } catch {
    return null;
  }
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
    const { cwd, markedAt, transcript, host, identityConflict, present } = readHeader(
      logFile,
      sessionId,
      repoName,
    );
    // A Codex hook payload's `transcript_path` is the rollout, not a Claude
    // transcript: it must never reach `parseSession`.
    const claudeFile = host !== "codex" ? resolveTranscript(sessionId, cwd, transcript) : null;
    const codexFile = host !== "claude" ? resolveCodexRollout(sessionId, transcript) : null;
    const claudeSource =
      host !== "codex" ? inspectSource(claudeFile, "claude", sessionId, cwd) : null;
    const codexSource =
      host !== "claude" ? inspectSource(codexFile, "codex", sessionId, cwd) : null;
    const recovered =
      host === "unknown"
        ? [claudeSource, codexSource].filter((source) => source?.status === "verified")
        : [];
    const resolvedHost =
      host !== "unknown"
        ? host
        : recovered.length === 1
          ? (recovered[0]?.host ?? "unknown")
          : "unknown";
    const sourceStatus =
      !present || !cwd
        ? "wrong-format"
        : identityConflict || recovered.length > 1
          ? "identity-conflict"
          : resolvedHost === "claude"
            ? (claudeSource?.status ?? "missing")
            : resolvedHost === "codex"
              ? (codexSource?.status ?? "missing")
              : claudeSource?.status === "identity-conflict" ||
                  codexSource?.status === "identity-conflict"
                ? "identity-conflict"
                : claudeSource?.status === "wrong-format" || codexSource?.status === "wrong-format"
                  ? "wrong-format"
                  : "missing";
    const selectedSource = resolvedHost === "codex" ? codexSource : claudeSource;
    const source =
      resolvedHost === "codex" ? codexFile : resolvedHost === "claude" ? claudeFile : null;
    sessions.push({
      sessionId,
      logFile,
      cwd,
      markedAt,
      host: resolvedHost,
      hostProvenance:
        host !== "unknown"
          ? "declared"
          : resolvedHost === "codex"
            ? "recovered:rollout"
            : resolvedHost === "claude"
              ? "recovered:transcript"
              : "unknown",
      sourceStatus,
      adapter:
        sourceStatus === "verified"
          ? resolvedHost === "codex"
            ? "codex-rollout"
            : "claude-transcript"
          : null,
      source,
      sourceVersion: sourceStatus === "verified" ? (selectedSource?.version ?? null) : null,
      sourceReason: sourceStatus === "verified" ? null : sourceStatus,
      versionReason:
        sourceStatus === "verified" && !selectedSource?.version ? "not-observed" : null,
      transcript: resolvedHost === "claude" ? claudeFile : null,
      rollout: resolvedHost === "codex" ? codexFile : null,
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

/** One audited repo: how much of the host's activity its audit log covers. */
export interface RepoCoverage {
  /** Directory name under the audit root (the repo's basename). */
  repo: string;
  /** Distinct project roots the session logs of this directory recorded. */
  roots: string[];
  /** Sessions with an audit log in the period. */
  audited: number;
  /** Host sessions in the period, or null when no root is known to look under. */
  host: number | null;
}

export interface AuditedRepos {
  repos: RepoCoverage[];
  /** Basename collisions and any other caveat on the rows. */
  warnings: string[];
}

/**
 * Transcript directories that belong to one project root: its own slug plus the
 * slugs of its agent worktrees. Claude Code stores a worktree session under
 * `<slug>--claude-worktrees-<name>` (`/.claude` encodes to `--claude`), so a
 * denominator built from the repo slug alone would drop every delegated session
 * and read as a coverage better than it is (R62).
 */
function hostSlugDirs(root: string, transcripts: string): string[] {
  if (!existsSync(transcripts)) return [];
  const slug = encodeCwdToSlug(root);
  const worktreePrefix = `${slug}--claude-worktrees-`;
  return readdirSync(transcripts)
    .filter((d) => d === slug || d.startsWith(worktreePrefix))
    .map((d) => join(transcripts, d));
}

/**
 * Host sessions of the given project roots inside the period: the `*.jsonl`
 * files (sessions; subagent transcripts live in nested directories and do not
 * count) whose last-modified day passes the filters. The mtime is the last
 * activity of the session, so one that crossed midnight lands on its last day —
 * acceptable for a denominator, and the only timestamp that costs no file read.
 */
export function countHostSessions(
  roots: readonly string[],
  filters: DiscoveryFilters = {},
): number {
  const transcripts = transcriptsRoot();
  const seen = new Set<string>();
  for (const root of roots) {
    for (const dir of hostSlugDirs(root, transcripts)) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".jsonl")) continue;
        const path = join(dir, file);
        try {
          if (!withinRange(new Date(statSync(path).mtimeMs).toISOString(), filters)) continue;
        } catch {
          continue;
        }
        seen.add(path);
      }
    }
  }
  return seen.size;
}

/** Distinct project roots recorded by a set of session logs. */
function rootsOf(sessions: readonly MarkedSession[]): string[] {
  const roots = new Set<string>();
  for (const s of sessions) if (s.cwd) roots.add(projectRootFromCwd(s.cwd));
  return [...roots].sort();
}

/**
 * The coverage row of ONE audit directory, plus the collision warning when two
 * different project roots were recorded under its basename: the store merged two
 * repos, and every figure of that row mixes them. Reported, not guessed at.
 */
export function repoCoverage(
  repo: string,
  filters: DiscoveryFilters = {},
): { row: RepoCoverage; warning: string | null } {
  const sessions = findMarkedSessions(repo);
  const roots = rootsOf(sessions);
  return {
    row: {
      repo,
      roots,
      audited: sessions.filter((m) => withinRange(m.markedAt, filters)).length,
      host: roots.length === 0 ? null : countHostSessions(roots, filters),
    },
    warning:
      roots.length > 1
        ? `basename collision: '${repo}' holds sessions of ${roots.length} different project roots (${roots.join(", ")}); its row mixes them`
        : null,
  };
}

/**
 * Every repo under the audit root, one row each (R61), with its coverage: the
 * sessions that have an audit log against the host's sessions for the same
 * project in the same period (R62).
 *
 * A directory is a repo only if it holds at least one session log, which keeps
 * `_all-repos/` (snapshots) and stray folders out.
 */
export function listAuditedRepos(filters: DiscoveryFilters = {}): AuditedRepos {
  const root = auditsRoot();
  const repos: RepoCoverage[] = [];
  const warnings: string[] = [];
  if (!existsSync(root)) return { repos, warnings };

  for (const repo of readdirSync(root).sort()) {
    const dir = join(root, repo);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!readdirSync(dir).some((f) => f.startsWith("session-") && f.endsWith(".log"))) continue;
    const { row, warning } = repoCoverage(repo, filters);
    repos.push(row);
    if (warning) warnings.push(warning);
  }
  return { repos, warnings };
}

/**
 * Coverage of the period as flat range metrics (R62): audited sessions against
 * the host's, summed over `rows`. Rows with no known root have no denominator
 * and are left out of BOTH sides, so a repo the host cannot be looked up for
 * does not read as a gap in coverage. `null` when no row has one.
 */
export function coverageMetrics(rows: readonly RepoCoverage[]): Record<string, number | null> {
  const measurable = rows.filter((r) => r.host !== null);
  if (measurable.length === 0) {
    return {
      "coverage.sessions.audited": null,
      "coverage.sessions.host": null,
      "coverage.pct": null,
    };
  }
  const audited = measurable.reduce((n, r) => n + r.audited, 0);
  const host = measurable.reduce((n, r) => n + (r.host ?? 0), 0);
  return {
    "coverage.sessions.audited": audited,
    "coverage.sessions.host": host,
    "coverage.pct": host === 0 ? null : Math.round((1000 * audited) / host) / 10,
  };
}
