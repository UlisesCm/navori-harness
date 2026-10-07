import { fstatSync, lstatSync, readSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  findMarkedSessions,
  readChildSourceBindings,
  withCodexChildBinding,
  type MarkedSession,
} from "./discovery.ts";
import {
  canonicalAuditMetadata,
  isHookReason,
  normalizeOutcome,
  AUDIT_READ_LIMITS,
  type ChildSourceRegistration,
  type AuditReadDiagnostics,
  type OutcomePayload,
} from "./model.ts";
import {
  appendPrivateAuditFile,
  createPrivateAuditFile,
  readPrivateAuditFile,
  readAuditJsonl,
  removePrivateAuditFile,
  auditsRoot,
  projectRootFromCwd,
  repoAuditDir,
  repoFromCwd,
  sessionLogPath,
} from "./paths.ts";
import { isAbsolute, join, resolve } from "node:path";

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

/** Explicit session identity, e.g. the hook payload's `session_id`; checked against every ambient variable. */
export interface AuditContext {
  host: "claude" | "codex";
  sessionId: string;
}

/** Explicit capture diagnostics never expose the private path or identity fingerprint. */
export interface ChildCaptureResult {
  ok: boolean;
  state: "observed" | "unavailable" | "partial" | "invalid";
  registered: number;
  skipped: number;
  conflicted: number;
  reason:
    | "registered"
    | "already-registered"
    | "unsafe-target"
    | "binding-unverified"
    | "binding-conflict"
    | "short-write";
}

/** Shared fd append; success requires one complete UTF-8 line, never a partial write. */
function appendRecord(
  logFile: string,
  record: object,
  validate: (fd: number) => boolean,
): "written" | "refused" | "short-write" {
  const result = appendPrivateAuditFile(logFile, (fd: number): string => {
    if (!validate(fd)) throw new Error("binding-unverified");
    return `${JSON.stringify(record)}\n`;
  });
  return result.ok ? "written" : result.reason === "short-write" ? "short-write" : "refused";
}

/** Refuse insecure targets without chmod or creation; nonprivate ancestors are never repaired. */
function privateCaptureTarget(cwd: string, rootSessionId: string): string | null {
  const log = sessionLogPath(repoFromCwd(cwd), rootSessionId);
  const checked = appendPrivateAuditFile(log, "");
  return checked.ok ? log : null;
}

/**
 * Register exact child ownership in an opted-in root log, independent of ambient host aliases.
 * Source descriptors and marker binding are rechecked immediately before append. Path checks
 * detect observed replacements, but cannot provide portable openat race-proof containment.
 */
export function captureCodexChild(
  cwd: string,
  rootSessionId: string,
  threadId: string,
  sourcePath: string,
): ChildCaptureResult {
  const result = (reason: ChildCaptureResult["reason"]): ChildCaptureResult => ({
    ok: reason === "registered" || reason === "already-registered",
    state:
      reason === "short-write"
        ? "partial"
        : reason === "binding-conflict"
          ? "invalid"
          : reason === "registered" || reason === "already-registered"
            ? "observed"
            : "unavailable",
    registered: reason === "registered" ? 1 : 0,
    skipped: reason === "already-registered" ? 1 : 0,
    conflicted: reason === "binding-conflict" ? 1 : 0,
    reason,
  });
  try {
    const log = privateCaptureTarget(cwd, rootSessionId);
    if (!log) return result("unsafe-target");
    const originalLog = lstatSync(log);
    let conflict = false;
    return (
      withCodexChildBinding(
        cwd,
        rootSessionId,
        threadId,
        sourcePath,
        (binding, revalidate) => {
          const previous = readChildSourceBindings(log, rootSessionId).filter(
            (event) => event.threadId === threadId,
          );
          if (
            previous.some(
              (event) => event.sourceHeaderFingerprint !== binding.sourceHeaderFingerprint,
            )
          )
            return result("binding-conflict");
          if (previous.some((event) => event.sourcePath === binding.sourcePath))
            return result(
              revalidate() && privateCaptureTarget(cwd, rootSessionId) === log
                ? "already-registered"
                : "binding-unverified",
            );
          const record: ChildSourceRegistration = {
            schemaVersion: 1,
            event: "child-source",
            host: "codex",
            rootSessionId,
            threadId,
            parentThreadId: binding.identity.parentThreadId!,
            sourceVersion: "0.160.0",
            sourcePath: binding.sourcePath,
            observedAt: new Date().toISOString(),
            sourceHeaderFingerprint: binding.sourceHeaderFingerprint,
          };
          const written = appendRecord(log, record, (fd) => {
            const currentLog = fstatSync(fd);
            if (currentLog.dev !== originalLog.dev || currentLog.ino !== originalLog.ino)
              return false;
            // Never repair or append onto a partial tail: it cannot form a complete event line.
            const lastByte = Buffer.alloc(1);
            if (
              currentLog.size === 0 ||
              readSync(fd, lastByte, 0, 1, currentLog.size - 1) !== 1 ||
              lastByte[0] !== 10
            )
              return false;
            if (privateCaptureTarget(cwd, rootSessionId) !== log || !revalidate()) return false;
            const buffer = Buffer.alloc(1024 * 1024);
            const bytes = readSync(fd, buffer, 0, buffer.length, 0);
            const line = buffer.toString("utf-8", 0, bytes).split("\n")[0];
            const header: unknown = JSON.parse(line ?? "");
            if (typeof header !== "object" || header === null) return false;
            const h = header as Record<string, unknown>;
            const marker = findMarkedSessions(repoFromCwd(cwd), { session: rootSessionId }).find(
              (m: MarkedSession): boolean => m.sessionId === rootSessionId,
            );
            return (
              h.event === "start" &&
              h.host === "codex" &&
              h.sessionId === rootSessionId &&
              h.repo === repoFromCwd(cwd) &&
              typeof h.cwd === "string" &&
              resolve(projectRootFromCwd(h.cwd)) === resolve(projectRootFromCwd(cwd)) &&
              marker?.sourceStatus === "verified" &&
              marker.host === "codex"
            );
          });
          return result(
            written === "written"
              ? "registered"
              : written === "short-write"
                ? "short-write"
                : "binding-unverified",
          );
        },
        () => {
          conflict = true;
        },
      ) ?? result(conflict ? "binding-conflict" : "binding-unverified")
    );
  } catch {
    return result("unsafe-target");
  }
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

interface AuditTarget {
  host: "claude" | "codex";
  sessionId: string;
  repo: string;
  logFile: string;
}

/** Cheap exact-context resolution shared by the writer and `hasAuditTarget`; throws on filesystem errors. */
function auditTarget(cwd: string, explicit?: AuditContext): AuditTarget | null {
  const context = explicit ?? contextFromEnv();
  if (!context) return null;
  const { host, sessionId } = context;
  if (host !== "claude" && host !== "codex") return null;
  if (explicit) {
    // An explicit identity never overrides the ambient one: any contradiction writes nothing.
    const pairHost = process.env.NAVORI_AUDIT_HOST?.trim();
    const pairSession = process.env.NAVORI_AUDIT_SESSION_ID?.trim();
    if (
      (pairHost !== undefined || pairSession !== undefined) &&
      (pairHost !== host || pairSession !== sessionId)
    )
      return null;
  }
  if (
    host === "claude" &&
    (process.env.CODEX_SESSION_ID?.trim() || process.env.CODEX_THREAD_ID?.trim())
  )
    return null;
  if (host === "codex" && process.env.CLAUDE_CODE_SESSION_ID?.trim()) return null;
  if (
    host === "claude" &&
    process.env.CLAUDE_CODE_SESSION_ID?.trim() &&
    process.env.CLAUDE_CODE_SESSION_ID?.trim() !== sessionId
  )
    return null;
  if (
    host === "codex" &&
    [process.env.CODEX_SESSION_ID, process.env.CODEX_THREAD_ID].some(
      (id) => id?.trim() && id.trim() !== sessionId,
    )
  )
    return null;
  const repo = repoFromCwd(cwd);
  // Do not traverse a replaced audit root or repo directory, even if the
  // final log itself is regular and O_NOFOLLOW would accept it.
  if (!lstatSync(auditsRoot()).isDirectory() || !lstatSync(repoAuditDir(repo)).isDirectory())
    return null;
  const logFile = sessionLogPath(repo, sessionId);
  const st = lstatSync(logFile);
  if (!st.isFile() || st.isSymbolicLink()) return null;
  return { host, sessionId, repo, logFile };
}

/** `sha256(repo + NUL + feature)`: the only form in which a feature slug appears in an outcome event. */
export function outcomeFeatureKey(cwd: string, feature: string): string {
  return createHash("sha256")
    .update(`${repoFromCwd(cwd)}\0${feature}`)
    .digest("hex");
}

/**
 * Whether a CLI event for `cwd` could be written: the exact context resolves
 * to a regular session log. Callers check this BEFORE computing anything for
 * an event, so a session without audit context costs nothing. The header and
 * Codex source binding are still verified by `appendCliEvent`, so a `true`
 * here can still end in a refused write.
 */
export function hasAuditTarget(cwd: string, context?: AuditContext): boolean {
  try {
    return auditTarget(cwd, context) !== null;
  } catch {
    return false;
  }
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
 * An explicit `context` (the hook payload's session) replaces the ambient
 * lookup but is still checked against every ambient variable and the header.
 *
 * An `outcome` adds the closed review/receipt/dispatch-outcome payload (`normalizeOutcome`); an
 * invalid payload or a record over 2,048 B writes nothing.
 *
 * @returns whether a record was written.
 */
export function appendCliEvent(
  cwd: string,
  event: CliEvent,
  outcome?: OutcomePayload,
  context?: AuditContext,
): boolean {
  try {
    const target = auditTarget(cwd, context);
    if (!target) return false;
    const { host, sessionId, repo, logFile } = target;
    const header = exactHeader(logFile);
    if (!header || !matchesAuditHeaderIdentity(header, host, sessionId, repo, cwd)) return false;
    /** Re-read bounded source identity; report caches must never authorize a live append. */
    const sourceBinding = (): MarkedSession | undefined =>
      findMarkedSessions(repo, { session: sessionId }, false).find(
        (marker: MarkedSession): boolean =>
          marker.sessionId === sessionId &&
          marker.host === host &&
          marker.sourceStatus === "verified" &&
          marker.cwd !== null &&
          resolve(projectRootFromCwd(marker.cwd)) === resolve(projectRootFromCwd(cwd)),
      );
    const binding = host === "codex" ? sourceBinding() : undefined;
    if (host === "codex" && !binding) return false;
    const payload =
      outcome === undefined
        ? undefined
        : normalizeOutcome({ ...outcome, name: event.name, verdict: event.verdict });
    if (outcome !== undefined && payload === null) return false;
    const record = {
      tsMs: Date.now(),
      event: "cli",
      name: technicalCategory(event.name),
      verdict: METADATA_VERDICTS.has(event.verdict) ? event.verdict : "unknown",
      ...(event.reason ? { reason: event.reason === "stale" ? "stale" : "unspecified" } : {}),
      ...(payload ?? {}),
    };
    if (Buffer.byteLength(JSON.stringify(record)) > 2048) return false;
    return (
      appendRecord(logFile, record, (fd: number): boolean => {
        const header = readAuditHeaderFromFd(fd);
        if (header === null || !matchesAuditHeaderIdentity(header, host, sessionId, repo, cwd))
          return false;
        if (host !== "codex") return true;
        const current = sourceBinding();
        return (
          current !== undefined &&
          current.source === binding?.source &&
          current.sourceVersion === binding?.sourceVersion
        );
      }) === "written"
    );
  } catch {
    return false;
  }
}

/** Explicit bounded bridge input; ambient runtime variables cannot authorize it. */
export interface AuditMetadataRequest {
  host: "claude" | "codex";
  rootSessionId: string;
  repo: string;
  auditRoot: string;
  event: unknown;
}
export interface MetadataRecordResult {
  status: "recorded" | "spooled" | "skipped" | "invalid" | "unavailable" | "partial";
  reason:
    | "recorded"
    | "spooled"
    | "already-recorded"
    | "invalid-metadata"
    | "unsafe-target"
    | "unmarked"
    | "incomplete-source"
    | "identity-conflict"
    | "short-write";
  recorded: number;
  skipped: number;
  conflicted: number;
}
export interface MetadataAbsorbResult extends MetadataRecordResult {
  fullyAbsorbed: boolean;
}
type MetadataScalars = Record<string, string | number>;

const METADATA_PHASES = new Set([
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "UserPromptSubmit",
  "PreCompact",
  "unknown",
]);
const METADATA_VERDICTS = new Set([
  "allow",
  "ask",
  "block",
  "deny",
  "skip",
  "noop",
  "clean",
  "dirty",
  "inject",
  "repeat",
  "partial",
  "compact-advice",
  "gate-started",
  "gate-killed",
  "approved",
  "changes-requested",
  "ok",
  "findings",
  "error",
  "unknown",
]);
const METADATA_TOOLS = new Set(["Bash", "Edit", "Read", "Write", "Agent", "Task", "NotebookEdit"]);
const METADATA_CLOSE_REASONS = new Set([
  "clear",
  "logout",
  "prompt_input_exit",
  "bypass_permissions_disabled",
  "other",
]);
const METADATA_NAMES = new Set([
  "plan-gate",
  "guard-destructive",
  "quality-gate-pre-commit",
  "managed-drift-watch",
  "session-start-context",
  "subagent-stop-handoff",
  "worktree-reclaim",
  "stop-verify-reminder",
  "check-jscpd",
  "check-semgrep",
  "model-advisor",
  "routing-watch",
  "role-guard",
  "implementer-no-markdown",
  "engram-write-guard",
  "master-plan-context",
  "master-accept-confirm",
  "master-advance",
  "master-part-accept",
  "master-close",
  "comment-draft-confirm",
  "general-purpose-confirm",
  "pr-publisher-confirm",
  "subagent-no-background",
  "bash-outcome-watch",
  "review-outcome",
  "receipt-outcome",
  "dispatch-outcome",
  "test",
]);

/** Unknown technical labels are bounded opaque categories, never caller content. */
function technicalCategory(value: string): string {
  return METADATA_NAMES.has(value) || /^unknown-[a-f0-9]{12}$/.test(value)
    ? value
    : `unknown-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}
function metadataObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function metadataId(value: unknown): value is string {
  return (
    typeof value === "string" && Buffer.byteLength(value) <= 256 && /^[A-Za-z0-9_-]+$/.test(value)
  );
}
function metadataInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Closed scalar DTO normalization rejects extra keys before any filesystem call. */
function metadataEvent(value: unknown): MetadataScalars | null {
  if (!metadataObject(value)) return null;
  const common = ["event", "tsMs", "agentId"];
  const event = value.event;
  const allowed =
    event === "hook"
      ? [
          ...common,
          "name",
          "phase",
          "verdict",
          "source",
          "ms",
          "toolUseId",
          "kind",
          "tool",
          "reason",
        ]
      : event === "prompt"
        ? [...common, "kind", "length"]
        : event === "session-end"
          ? [...common, "reason"]
          : [];
  if (!allowed.length || Object.keys(value).some((key: string): boolean => !allowed.includes(key)))
    return null;
  if (!metadataInteger(value.tsMs) || (value.agentId !== undefined && !metadataId(value.agentId)))
    return null;
  const out: MetadataScalars = { event: event as string, tsMs: value.tsMs };
  if (value.agentId !== undefined) out.agentId = value.agentId as string;
  if (event === "prompt") {
    if (value.kind !== "user" || !metadataInteger(value.length)) return null;
    out.kind = "user";
    out.length = value.length;
  } else if (event === "session-end") {
    if (typeof value.reason !== "string" || !METADATA_CLOSE_REASONS.has(value.reason)) return null;
    out.reason = value.reason;
  } else {
    if (
      typeof value.name !== "string" ||
      Buffer.byteLength(value.name) > 256 ||
      typeof value.phase !== "string" ||
      !METADATA_PHASES.has(value.phase) ||
      typeof value.verdict !== "string" ||
      !METADATA_VERDICTS.has(value.verdict) ||
      !metadataInteger(value.ms) ||
      typeof value.source !== "string" ||
      Buffer.byteLength(value.source) > 256
    )
      return null;
    out.name = technicalCategory(value.name);
    out.phase = value.phase;
    out.verdict = value.verdict;
    out.ms = value.ms;
    out.source = [
      "core",
      "plugin:semgrep",
      "plugin:jscpd",
      "plugin:engram",
      "plugin:codegraph",
      "plugin:tgrep",
    ].includes(value.source)
      ? value.source
      : "unknown";
    if (value.toolUseId !== undefined) {
      if (!metadataId(value.toolUseId)) return null;
      out.toolUseId = value.toolUseId;
    }
    if (value.kind !== undefined) {
      if (typeof value.kind !== "string" || !["hard", "ask", "advisory"].includes(value.kind))
        return null;
      out.kind = value.kind;
    }
    if (value.tool !== undefined) {
      if (typeof value.tool !== "string" || !METADATA_TOOLS.has(value.tool)) return null;
      out.tool = value.tool;
    }
    if (value.reason !== undefined) {
      if (!isHookReason(value.reason)) return null;
      out.reason = value.reason;
    }
  }
  return Buffer.byteLength(JSON.stringify(out)) <= 2048 ? out : null;
}

/** Read only the first bounded line on the same descriptor used for append. */
export function readAuditHeaderFromFd(fd: number): Record<string, unknown> | null {
  const buffer = Buffer.alloc(1_048_576);
  const count = readSync(fd, buffer, 0, buffer.length, 0);
  const newline = buffer.subarray(0, count).indexOf(10);
  if (newline < 0) return null;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline)),
    );
    return metadataObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Direct lookup never enumerates sibling markers or creates report/lineage context. */
function exactHeader(path: string, ownedRoot = auditsRoot()): Record<string, unknown> | null {
  let header: Record<string, unknown> | null = null;
  const checked = appendPrivateAuditFile(
    path,
    (fd: number): string => {
      header = readAuditHeaderFromFd(fd);
      return "";
    },
    { ownedRoot },
  );
  return checked.ok ? header : null;
}
/** Match bounded explicit marker identity; absence alone selects legacy Claude. */
export function matchesAuditHeaderIdentity(
  header: Record<string, unknown>,
  host: "claude" | "codex",
  id: string,
  repo: string,
  cwd?: string,
): boolean {
  const aliases = [header.sessionId, header.session_id, header.id].filter(
    (value: unknown): boolean => value !== undefined,
  );
  if (
    header.event !== "start" ||
    (header.host === undefined ? "claude" : header.host) !== host ||
    !aliases.length ||
    aliases.some((value: unknown): boolean => value !== id) ||
    (header.repo !== undefined && header.repo !== repo) ||
    typeof header.cwd !== "string" ||
    !isAbsolute(header.cwd) ||
    Buffer.byteLength(header.cwd) > AUDIT_READ_LIMITS.pathBytes ||
    repoFromCwd(header.cwd) !== repo
  )
    return false;
  return (
    cwd === undefined ||
    resolve(projectRootFromCwd(header.cwd)) === resolve(projectRootFromCwd(cwd))
  );
}
function metadataTarget(request: Omit<AuditMetadataRequest, "event">): string | null {
  if (
    (request.host !== "claude" && request.host !== "codex") ||
    !metadataId(request.rootSessionId) ||
    !/^[A-Za-z0-9_.-]{1,256}$/.test(request.repo) ||
    request.repo === "." ||
    request.repo === ".." ||
    !isAbsolute(request.auditRoot)
  )
    return null;
  return join(request.auditRoot, request.repo, `session-${request.rootSessionId}.log`);
}
function metadataResult(
  status: MetadataRecordResult["status"],
  reason: MetadataRecordResult["reason"],
  recorded = 0,
  skipped = 0,
  conflicted = 0,
): MetadataRecordResult {
  return { status, reason, recorded, skipped, conflicted };
}

/** Original metadata writer assigns identity once before append or private spool creation. */
export function recordAuditMetadata(request: AuditMetadataRequest): MetadataRecordResult {
  try {
    const event = metadataEvent(request.event);
    const target = metadataTarget(request);
    if (!event || !target) return metadataResult("invalid", "invalid-metadata");
    const record = {
      wireVersion: 1,
      eventId: randomUUID(),
      host: request.host,
      rootSessionId: request.rootSessionId,
      ...event,
    };
    if (Buffer.byteLength(JSON.stringify(record)) > 2048)
      return metadataResult("invalid", "invalid-metadata");
    const header = exactHeader(target, request.auditRoot);
    if (header) {
      if (!matchesAuditHeaderIdentity(header, request.host, request.rootSessionId, request.repo))
        return metadataResult("invalid", "identity-conflict");
      const appended = appendPrivateAuditFile(
        target,
        (fd: number): string => {
          const current = readAuditHeaderFromFd(fd);
          if (
            !current ||
            !matchesAuditHeaderIdentity(current, request.host, request.rootSessionId, request.repo)
          )
            throw new Error("identity-conflict");
          return `${JSON.stringify(record)}\n`;
        },
        { ownedRoot: request.auditRoot },
      );
      return appended.ok
        ? metadataResult("recorded", "recorded", 1)
        : metadataResult(
            appended.partial ? "partial" : "unavailable",
            appended.reason === "short-write" ? "short-write" : "unsafe-target",
          );
    }
    // Existing unsafe/invalid markers cannot redirect capture into a startup spool.
    try {
      lstatSync(target);
      return metadataResult("unavailable", "unsafe-target");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return metadataResult("unavailable", "unsafe-target");
    }
    if (event.event !== "hook" || event.phase !== "SessionStart")
      return metadataResult("skipped", "unmarked");
    const arm = readPrivateAuditFile(join(request.auditRoot, request.repo, ".armed"), {
      ownedRoot: request.auditRoot,
      maxBytes: 2048,
    });
    if (!arm.ok) return metadataResult("unavailable", "unsafe-target");
    try {
      const value: unknown = JSON.parse(arm.value.toString("utf-8"));
      if (
        !metadataObject(value) ||
        typeof value.cwd !== "string" ||
        repoFromCwd(value.cwd) !== request.repo
      )
        return metadataResult("invalid", "identity-conflict");
    } catch {
      return metadataResult("invalid", "invalid-metadata");
    }
    const spool = join(request.auditRoot, request.repo, `pending-${request.rootSessionId}.jsonl`);
    const line = `${JSON.stringify(record)}\n`;
    let exists = true;
    try {
      lstatSync(spool);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
      else return metadataResult("unavailable", "unsafe-target");
    }
    const stored = exists
      ? appendPrivateAuditFile(spool, line, { ownedRoot: request.auditRoot })
      : createPrivateAuditFile(spool, line, { ownedRoot: request.auditRoot });
    return stored.ok
      ? metadataResult("spooled", "spooled", 1)
      : metadataResult(
          stored.partial ? "partial" : "unavailable",
          stored.reason === "short-write" ? "short-write" : "unsafe-target",
        );
  } catch {
    return metadataResult("unavailable", "unsafe-target");
  }
}

/** Reject malformed wire input without repairing, relabeling or inventing replay IDs. */
function persistedMetadata(
  value: unknown,
  request: Omit<AuditMetadataRequest, "event">,
): { id: string; canonical: string } | null {
  if (
    !metadataObject(value) ||
    value.host !== request.host ||
    value.rootSessionId !== request.rootSessionId ||
    !metadataId(value.eventId)
  )
    return null;
  const canonical = canonicalAuditMetadata(value);
  if (!canonical) return null;
  const payload: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value))
    if (!["wireVersion", "eventId", "host", "rootSessionId"].includes(key)) payload[key] = entry;
  const normalized = metadataEvent(payload);
  if (!normalized) return null;
  const sanitized = canonicalAuditMetadata({
    wireVersion: 1,
    eventId: value.eventId,
    host: value.host,
    rootSessionId: value.rootSessionId,
    ...normalized,
  });
  return sanitized === canonical ? { id: value.eventId, canonical } : null;
}
function completeMetadataSource(reading: AuditReadDiagnostics): boolean {
  return (
    reading.sourceStatus === "observed" &&
    !reading.stoppedEarly &&
    !reading.incompleteTail &&
    !reading.malformedJson &&
    !reading.invalidUtf8 &&
    !reading.oversizedLines
  );
}

/** Stream checked spools, preserve original IDs and retain sources on any uncertainty.
 * Same-ID contradictions are detected over both full bounded views before appending.
 * Append is not transactional; partial suffixes remain for explicit manual recovery.
 */
export function absorbAuditMetadataSpool(
  request: Omit<AuditMetadataRequest, "event">,
): MetadataAbsorbResult {
  const finish = (result: MetadataRecordResult, fullyAbsorbed = false): MetadataAbsorbResult => ({
    ...result,
    fullyAbsorbed,
  });
  try {
    const target = metadataTarget(request);
    if (!target) return finish(metadataResult("invalid", "invalid-metadata"));
    const header = exactHeader(target, request.auditRoot);
    if (
      !header ||
      !matchesAuditHeaderIdentity(header, request.host, request.rootSessionId, request.repo)
    )
      return finish(metadataResult("unavailable", "unsafe-target"));
    const spool = join(request.auditRoot, request.repo, `pending-${request.rootSessionId}.jsonl`);
    let identity: ReturnType<typeof lstatSync>;
    try {
      identity = lstatSync(spool);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? finish(metadataResult("skipped", "already-recorded"), true)
        : finish(metadataResult("unavailable", "unsafe-target"));
    }
    const rootIdentity = lstatSync(target);
    const rootIds = new Map<string, string>();
    const pending = new Map<string, string>();
    const conflicts = new Set<string>();
    let malformed = false;
    let cap = false;
    const retain = (
      map: Map<string, string>,
      record: { id: string; canonical: string },
    ): boolean => {
      const previous = rootIds.get(record.id) ?? pending.get(record.id);
      if (previous !== undefined && previous !== record.canonical) conflicts.add(record.id);
      if (!map.has(record.id)) {
        if (rootIds.size + pending.size >= 100_000) {
          cap = true;
          return false;
        }
        map.set(record.id, record.canonical);
      } else if (map.get(record.id) !== record.canonical) conflicts.add(record.id);
      return true;
    };
    const rootReading = readAuditJsonl(
      target,
      (value: unknown): boolean | void => {
        if (!metadataObject(value) || value.wireVersion === undefined) return;
        const record = persistedMetadata(value, request);
        if (!record) {
          malformed = true;
          return;
        }
        return retain(rootIds, record);
      },
      { privateArtifact: true, ownedRoot: request.auditRoot },
    );
    const spoolReading = readAuditJsonl(
      spool,
      (value: unknown): boolean | void => {
        const record = persistedMetadata(value, request);
        if (!record) {
          malformed = true;
          return;
        }
        return retain(pending, record);
      },
      { privateArtifact: true, ownedRoot: request.auditRoot, maxLineBytes: 2048 },
    );
    if (conflicts.size)
      return finish(metadataResult("invalid", "identity-conflict", 0, 0, conflicts.size));
    if (
      malformed ||
      cap ||
      !completeMetadataSource(rootReading) ||
      !completeMetadataSource(spoolReading)
    )
      return finish(metadataResult("partial", "incomplete-source"));
    const currentSpool = lstatSync(spool);
    const currentRoot = lstatSync(target);
    if (
      currentSpool.dev !== identity.dev ||
      currentSpool.ino !== identity.ino ||
      currentSpool.size !== identity.size ||
      currentRoot.dev !== rootIdentity.dev ||
      currentRoot.ino !== rootIdentity.ino ||
      currentRoot.size !== rootIdentity.size
    )
      return finish(metadataResult("unavailable", "unsafe-target"));
    let recorded = 0;
    let skipped = 0;
    let expectedSize = rootIdentity.size;
    for (const [id, canonical] of pending) {
      if (rootIds.get(id) === canonical) {
        skipped++;
        continue;
      }
      const result = appendPrivateAuditFile(
        target,
        (fd: number): string => {
          const stat = fstatSync(fd);
          if (
            stat.dev !== rootIdentity.dev ||
            stat.ino !== rootIdentity.ino ||
            stat.size !== expectedSize
          )
            throw new Error("changed");
          const current = readAuditHeaderFromFd(fd);
          if (
            !current ||
            !matchesAuditHeaderIdentity(current, request.host, request.rootSessionId, request.repo)
          )
            throw new Error("identity-conflict");
          return `${canonical}\n`;
        },
        { ownedRoot: request.auditRoot },
      );
      if (!result.ok)
        return finish(
          metadataResult(
            result.partial ? "partial" : "unavailable",
            result.reason === "short-write" ? "short-write" : "unsafe-target",
            recorded,
            skipped,
          ),
        );
      expectedSize += result.value;
      recorded++;
    }
    const removed = removePrivateAuditFile(spool, {
      ownedRoot: request.auditRoot,
      expectedIdentity: { dev: identity.dev, ino: identity.ino, size: identity.size },
    });
    return removed.ok
      ? finish(
          metadataResult(
            recorded ? "recorded" : "skipped",
            recorded ? "recorded" : "already-recorded",
            recorded,
            skipped,
          ),
          true,
        )
      : finish(metadataResult("partial", "incomplete-source", recorded, skipped));
  } catch {
    return finish(metadataResult("unavailable", "unsafe-target"));
  }
}
