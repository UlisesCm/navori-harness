import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  opendirSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { codexHome } from "../codex/home.ts";
import {
  normalizeCodexIdentity,
  type CodexIdentity,
  type ChildSourceRegistration,
  type EvidenceReason,
  type AuditReadBudget,
  type AuditReadDiagnostics,
  type AuditLogView,
  createAuditReadBudget,
  normalizeAuditRecord,
  retainAuditFact,
  omitAuditFacts,
  retainAuditPath,
} from "./model.ts";
import {
  auditsRoot,
  encodeCwdToSlug,
  projectRootFromCwd,
  repoAuditDir,
  repoFromCwd,
  transcriptsRoot,
  readAuditJsonl,
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
  /** Private command transport, never serialized into SessionAudit or public reports. */
  auditLogRecords?: Record<string, unknown>[];
  auditReading?: AuditReadDiagnostics;
  auditNormalizationLoss?: number;
  readBudget?: AuditReadBudget;
  childSources?: RegisteredCodexChild[];
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

/** One bounded lazy filesystem/fact context is shared by all report cohorts. */
export interface AuditDiscoveryContext {
  budget: AuditReadBudget;
  /** Facts of the host-path scan; separate so it cannot starve parsing of the shared pool. */
  scanBudget: AuditReadBudget;
  indexedPaths: string[] | null;
  indexedRoots: Set<string>;
  metadata: Map<string, Record<string, unknown> | null>;
  logs: Map<string, AuditLogView>;
  repoRoots: Map<string, Set<string>>;
}

/** Create a report-local context, never a persistent host or permission cache. */
export function createAuditDiscoveryContext(
  budget = createAuditReadBudget(),
): AuditDiscoveryContext {
  return {
    budget,
    scanBudget: createAuditReadBudget(),
    indexedPaths: null,
    indexedRoots: new Set(),
    metadata: new Map(),
    logs: new Map(),
    repoRoots: new Map(),
  };
}

/** Whether discovery lost facts in either the shared pool or its own scan pool. */
function discoveryTruncated(context: AuditDiscoveryContext): boolean {
  return context.budget.diagnostics.truncated || context.scanBudget.diagnostics.truncated;
}

/** Retain a validated marker's checkout anchor without retaining out-of-range activity. */
function retainRootAnchor(
  context: AuditDiscoveryContext,
  repo: string,
  sessionId: string,
  record: Record<string, unknown>,
): void {
  if (
    record.event !== "start" ||
    typeof record.cwd !== "string" ||
    (record.sessionId !== undefined && record.sessionId !== sessionId) ||
    (record.repo !== undefined && record.repo !== repo)
  )
    return;
  const root = retainAuditPath(context.budget, projectRootFromCwd(record.cwd));
  if (!root) return;
  const known = context.repoRoots.get(repo);
  if (known?.has(root)) return;
  if (!retainAuditFact(context.budget, null, { repo, root })) return;
  const roots = known ?? new Set<string>();
  if (!known && !retainAuditFact(context.budget, null, roots)) return;
  roots.add(root);
  context.repoRoots.set(repo, roots);
}

/** Build one lazy, capped host-path index; a stopped walk never claims complete enumeration. */
function indexedSourcePaths(
  context: AuditDiscoveryContext,
  roots: readonly string[],
): readonly string[] {
  const paths: string[] = context.indexedPaths ?? [];
  context.indexedPaths = paths;
  let stopped = false;
  const walk = (directory: string, depth: number): void => {
    if (stopped) return;
    if (depth > ROLLOUT_MAX_DEPTH) {
      omitAuditFacts(context.budget, 0, true);
      return;
    }
    let dir: ReturnType<typeof opendirSync>;
    try {
      dir = opendirSync(directory);
    } catch {
      omitAuditFacts(context.budget, 0, true);
      return;
    }
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        const path = retainAuditPath(context.budget, join(directory, entry.name));
        if (!path) {
          stopped = true;
          omitAuditFacts(context.budget, 1, true);
          break;
        }
        if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
        else if (entry.isDirectory()) walk(path, depth + 1);
        else if (entry.isSymbolicLink()) omitAuditFacts(context.budget, 0, true);
        if (stopped) break;
      }
    } finally {
      dir.closeSync();
    }
  };
  for (const root of roots) {
    if (context.indexedRoots.has(root) || !existsSync(root)) continue;
    context.indexedRoots.add(root);
    walk(root, 0);
  }
  return paths;
}

/**
 * Records a Claude transcript may carry before its first identity record
 * (`last-prompt`, `ai-title`, `mode`, `permission-mode`, `queue-operation`,
 * `file-history-snapshot`…). Observed preludes are ≤ 9 records; the bound
 * keeps a foreign JSONL from being scanned to its end.
 */
const SOURCE_PRELUDE_MAX_RECORDS = 32;

/** Claude transcript record types that carry the session's `sessionId` + `cwd`. */
const CLAUDE_IDENTITY_TYPES: readonly string[] = [
  "user",
  "assistant",
  "system",
  "summary",
  "attachment",
];

/**
 * Whether a raw source record is host bookkeeping to skip on the way to the
 * identity record: no top-level `cwd` and not a Codex `session_meta`.
 */
function isSourcePrelude(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return rec.type !== "session_meta" && !("cwd" in rec);
}

/**
 * Visits the source's identity record: the first one that is not prelude,
 * within `SOURCE_PRELUDE_MAX_RECORDS`. Prelude records are never normalized
 * nor retained — they can hold a title or a prompt id.
 */
function readSourceIdentity(
  path: string,
  visit: (value: unknown) => void,
): ReturnType<typeof readAuditJsonl> {
  let seen = 0;
  return readAuditJsonl(path, (value) => {
    seen++;
    if (isSourcePrelude(value) && seen < SOURCE_PRELUDE_MAX_RECORDS) return;
    visit(value);
    return false;
  });
}

/** Cache only one normalized metadata fact per source, never its prompt/activity history. */
function indexedSourceMetadata(
  path: string,
  context: AuditDiscoveryContext,
): Record<string, unknown> | null {
  if (context.metadata.has(path)) return context.metadata.get(path) ?? null;
  if (!retainAuditPath(context.budget, path)) return null;
  let record: Record<string, unknown> | null = null;
  const reading = readSourceIdentity(path, (value) => {
    const normalized = normalizeAuditRecord(value, "metadata");
    if (normalized.omitted) omitAuditFacts(context.scanBudget, normalized.omitted);
    if (normalized.value && retainAuditFact(context.scanBudget, null, normalized.value))
      record = normalized.value;
  });
  if (reading.sourceStatus !== "observed") record = null;
  const entry = { path, record };
  if (retainAuditFact(context.scanBudget, null, entry)) context.metadata.set(path, record);
  return record;
}

/** Content-free source binding used only by explicit child capture. */
export interface CodexChildBinding {
  identity: CodexIdentity;
  sourcePath: string;
  sourceHeaderFingerprint: string;
}

/** Registration remains observed even if its currently selected source cannot be qualified. */
export interface RegisteredCodexChild {
  threadId: string;
  rootSessionId: string;
  parentThreadId: string;
  capturedAt: string;
  sourceStatus: "verified" | "missing" | "wrong-format" | "identity-conflict" | "unsupported";
  binding: CodexChildBinding | null;
  depth: number | null;
}

/** Fingerprint identity only: append, human metadata and physical paths do not change it. */
export function codexIdentityFingerprint(identity: CodexIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "codex-rollout",
        identity.sourceVersion,
        identity.threadId,
        identity.rootSessionId,
        identity.parentThreadId,
        identity.relation,
        identity.checkout,
      ]),
    )
    .digest("hex");
}

function metadataFromFd(fd: number): Record<string, unknown> | null {
  const buffer = Buffer.alloc(1024 * 1024);
  const bytes = readSync(fd, buffer, 0, buffer.length, 0);
  const end = buffer.subarray(0, bytes).indexOf(10);
  if (end < 0 && bytes === buffer.length) return null;
  const rec: unknown = JSON.parse(buffer.toString("utf-8", 0, end < 0 ? bytes : end));
  if (
    typeof rec !== "object" ||
    rec === null ||
    !("type" in rec) ||
    rec.type !== "session_meta" ||
    !("payload" in rec) ||
    typeof rec.payload !== "object" ||
    rec.payload === null ||
    Array.isArray(rec.payload)
  )
    return null;
  return rec.payload as Record<string, unknown>;
}

/** Reject symlink ancestors without repairing them; path checks are not portable openat containment. */
export function auditPathHasSafeAncestors(path: string): boolean {
  let current = resolve(path);
  for (;;) {
    const st = lstatSync(current);
    if (st.isSymbolicLink()) return false;
    if (
      st.isDirectory() &&
      (st.mode & 0o022) !== 0 &&
      !((st.mode & 0o1000) !== 0 && (st.uid === 0 || st.uid === process.getuid?.()))
    )
      return false;
    const parent = resolve(current, "..");
    if (parent === current) return true;
    current = parent;
  }
}

/**
 * Keep no-follow descriptors open through registration, validating exact lineage once.
 * Revalidation catches observed replacements; Node path checks leave a residual rename race.
 */
export function withCodexChildBinding<T>(
  cwd: string,
  rootSessionId: string,
  threadId: string,
  sourcePath: string,
  consume: (binding: CodexChildBinding, revalidate: () => boolean) => T,
  rejectConflict: () => void = () => {},
): T | null {
  const opened: Array<{
    fd: number;
    path: string;
    identity: CodexIdentity;
    dev: number;
    ino: number;
  }> = [];
  try {
    if (!constants.O_NOFOLLOW || typeof process.getuid !== "function") return null;
    const checkout = resolve(projectRootFromCwd(cwd));
    /** Read only the header through the fd that will be revalidated before append. */
    const open = (path: string, required = false): (typeof opened)[number] | null => {
      if (!auditPathHasSafeAncestors(path)) return null;
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      // The finally owns every opened descriptor, including failed fstat/header reads.
      const entry = {
        fd,
        path: resolve(path),
        identity: null as CodexIdentity | null,
        dev: 0,
        ino: 0,
      };
      try {
        const st = fstatSync(fd);
        entry.dev = st.dev;
        entry.ino = st.ino;
        if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) return null;
        const fields = metadataFromFd(fd);
        if (
          !fields ||
          typeof fields.cwd !== "string" ||
          resolve(projectRootFromCwd(fields.cwd)) !== checkout
        )
          return null;
        const decoded = normalizeCodexIdentity(fields, checkout);
        if (decoded.status !== "verified") {
          if (required && decoded.status === "identity-conflict") rejectConflict();
          return null;
        }
        if (decoded.identity.rootSessionId !== rootSessionId) {
          if (required) rejectConflict();
          return null;
        }
        entry.identity = decoded.identity;
        const valid = { ...entry, identity: decoded.identity };
        opened.push(valid);
        return valid;
      } finally {
        if (!entry.identity) closeSync(fd);
      }
    };
    const marker = findMarkedSessions(repoFromCwd(cwd), { session: rootSessionId }, false).find(
      (candidate) => candidate.sessionId === rootSessionId,
    );
    if (marker?.sourceStatus === "identity-conflict") rejectConflict();
    if (
      !marker ||
      marker.host !== "codex" ||
      marker.sourceStatus !== "verified" ||
      !marker.rollout ||
      !marker.cwd ||
      resolve(projectRootFromCwd(marker.cwd)) !== checkout
    )
      return null;
    const root = open(marker.rollout, true);
    const child = open(sourcePath, true);
    if (child && child.identity.threadId !== threadId) rejectConflict();
    if (
      !root ||
      root.identity.relation !== "root" ||
      root.identity.threadId !== rootSessionId ||
      !child ||
      child.identity.threadId !== threadId ||
      child.identity.relation !== "child"
    )
      return null;
    const candidates = new Map<string, (typeof opened)[number]>();
    candidates.set(rootSessionId, root);
    candidates.set(threadId, child);
    /** Metadata-only candidate index; names locate files but never supply owner IDs. */
    const scan = (dir: string, depth: number): void => {
      if (depth > ROLLOUT_MAX_DEPTH || !auditPathHasSafeAncestors(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) scan(path, depth + 1);
        else if (
          e.isFile() &&
          e.name.endsWith(".jsonl") &&
          !opened.some((entry) => entry.path === resolve(path))
        ) {
          const candidate = open(path);
          if (!candidate) continue;
          const previous = candidates.get(candidate.identity.threadId);
          if (
            previous &&
            codexIdentityFingerprint(previous.identity) !==
              codexIdentityFingerprint(candidate.identity)
          ) {
            rejectConflict();
            throw new Error("identity-conflict");
          }
          candidates.set(candidate.identity.threadId, candidate);
        }
      }
    };
    scan(join(codexHome(), "sessions"), 0);
    const seen = new Set<string>();
    let current = child;
    while (current.identity.threadId !== rootSessionId) {
      if (seen.has(current.identity.threadId)) {
        rejectConflict();
        return null;
      }
      if (current.identity.relation !== "child") return null;
      seen.add(current.identity.threadId);
      const parent = candidates.get(current.identity.parentThreadId ?? "");
      if (!parent) return null;
      current = parent;
    }
    const revalidate = (): boolean => {
      const currentMarker = findMarkedSessions(
        repoFromCwd(cwd),
        { session: rootSessionId },
        false,
      ).find((candidate) => candidate.sessionId === rootSessionId);
      if (
        currentMarker?.sourceStatus !== "verified" ||
        currentMarker.rollout !== marker.rollout ||
        currentMarker.logFile !== marker.logFile
      )
        return false;
      return opened.every((entry) => {
        if (!auditPathHasSafeAncestors(entry.path)) return false;
        const pathStat = lstatSync(entry.path);
        const fdStat = fstatSync(entry.fd);
        const fields = metadataFromFd(entry.fd);
        if (
          !fields ||
          pathStat.dev !== entry.dev ||
          pathStat.ino !== entry.ino ||
          fdStat.uid !== process.getuid?.() ||
          (fdStat.mode & 0o077) !== 0 ||
          !fdStat.isFile() ||
          typeof fields.cwd !== "string" ||
          resolve(projectRootFromCwd(fields.cwd)) !== checkout
        )
          return false;
        const decoded = normalizeCodexIdentity(fields, checkout);
        return (
          decoded.status === "verified" &&
          codexIdentityFingerprint(decoded.identity) === codexIdentityFingerprint(entry.identity)
        );
      });
    };
    return consume(
      {
        identity: child.identity,
        sourcePath: child.path,
        sourceHeaderFingerprint: codexIdentityFingerprint(child.identity),
      },
      revalidate,
    );
  } catch {
    return null;
  } finally {
    for (const entry of opened) closeSync(entry.fd);
  }
}

/** All complete physical bindings survive logical dedup, so revision retries remain idempotent. */
export function readChildSourceBindings(
  logFile: string,
  rootSessionId: string,
): ChildSourceRegistration[] {
  const budget = createAuditReadBudget();
  const records: Record<string, unknown>[] = [];
  const reading = readAuditJsonl(logFile, (value) => {
    const normalized = normalizeAuditRecord(value, "audit-log");
    if (!normalized.value) return;
    if (!retainAuditFact(budget, rootSessionId, normalized.value)) return false;
    records.push(normalized.value);
  });
  if (reading.stoppedEarly || reading.sourceStatus !== "observed")
    throw new Error("unqualified-registration-index");
  return childBindingsFromRecords(records, rootSessionId, budget);
}

/** Decode complete registration lines from the same root-log read used by command transport. */
function childBindingsFromRecords(
  records: readonly Record<string, unknown>[],
  rootSessionId: string,
  budget?: AuditReadBudget,
): ChildSourceRegistration[] {
  const registrations = new Map<string, ChildSourceRegistration>();
  // The writer's terminating newline is part of the capture contract, not just JSON syntax.
  for (const r of records) {
    if (
      r.event !== "child-source" ||
      r.schemaVersion !== 1 ||
      r.host !== "codex" ||
      r.rootSessionId !== rootSessionId ||
      r.sourceVersion !== "0.160.0" ||
      typeof r.threadId !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(r.threadId) ||
      typeof r.parentThreadId !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(r.parentThreadId) ||
      typeof r.sourcePath !== "string" ||
      !r.sourcePath ||
      typeof r.observedAt !== "string" ||
      !Number.isFinite(Date.parse(r.observedAt)) ||
      typeof r.sourceHeaderFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(r.sourceHeaderFingerprint)
    )
      continue;
    const key = JSON.stringify([r.threadId, r.sourceHeaderFingerprint, r.sourcePath]);
    if (!registrations.has(key)) {
      const registration: ChildSourceRegistration = {
        schemaVersion: 1,
        event: "child-source",
        host: "codex",
        rootSessionId,
        threadId: r.threadId,
        parentThreadId: r.parentThreadId,
        sourceVersion: "0.160.0",
        sourcePath: r.sourcePath,
        observedAt: r.observedAt,
        sourceHeaderFingerprint: r.sourceHeaderFingerprint,
      };
      if (!budget || retainAuditFact(budget, rootSessionId, registration))
        registrations.set(key, registration);
    }
  }
  return [...registrations.values()];
}

/** One logical capture per identity tuple, retaining its first observation across physical revisions. */
export function readChildSourceRegistrations(
  logFile: string,
  rootSessionId: string,
): ChildSourceRegistration[] {
  const logical = new Map<string, ChildSourceRegistration>();
  for (const record of readChildSourceBindings(logFile, rootSessionId)) {
    const key = `${record.threadId}:${record.sourceHeaderFingerprint}`;
    if (!logical.has(key)) logical.set(key, record);
  }
  return [...logical.values()];
}

export interface DiscoveryFilters {
  days?: number;
  since?: string;
  until?: string;
  /** Session id or unique prefix; "latest" picks the most recent. */
  session?: string;
  /** Fixed requested UTC window, independent of observed session extrema. */
  range?: { from: string; to: string };
}

/** One metadata-only lineage index for all registered descendants; report never registers a source. */
function qualifyRegisteredChildren(markers: MarkedSession[], context: AuditDiscoveryContext): void {
  const paths = new Set<string>();
  const registrations = new Map<MarkedSession, ChildSourceRegistration[]>();
  for (const marker of markers) {
    if (marker.host !== "codex" || !marker.cwd) continue;
    const records = childBindingsFromRecords(
      marker.auditLogRecords ?? [],
      marker.sessionId,
      marker.readBudget,
    );
    if (!records.length) continue;
    registrations.set(marker, records);
    if (marker.rollout && retainAuditPath(context.budget, marker.rollout))
      paths.add(marker.rollout);
    for (const record of records)
      if (retainAuditPath(context.budget, record.sourcePath)) paths.add(record.sourcePath);
  }
  if (!registrations.size) return;
  // Filenames only locate candidates: graph ownership still requires validated metadata.
  for (const path of indexedSourcePaths(context, [join(codexHome(), "sessions")])) paths.add(path);
  type Candidate = {
    status: RegisteredCodexChild["sourceStatus"];
    binding: CodexChildBinding | null;
  };
  const sources = new Map<string, Candidate>();
  const graph = new Map<string, CodexChildBinding[]>();
  const key = (identity: CodexIdentity): string =>
    JSON.stringify([identity.checkout, identity.rootSessionId, identity.threadId]);
  for (const path of paths) {
    let candidate: Candidate = { status: "missing", binding: null };
    try {
      const st = lstatSync(path);
      if (
        !st.isFile() ||
        !auditPathHasSafeAncestors(path) ||
        typeof process.getuid !== "function" ||
        st.uid !== process.getuid()
      )
        throw new Error("unsafe-source");
      const rec: unknown = indexedSourceMetadata(path, context);
      if (
        typeof rec !== "object" ||
        rec === null ||
        !("type" in rec) ||
        rec.type !== "session_meta" ||
        !("payload" in rec) ||
        typeof rec.payload !== "object" ||
        rec.payload === null ||
        Array.isArray(rec.payload)
      )
        throw new Error("wrong-format");
      const fields = rec.payload as Record<string, unknown>;
      const decoded = normalizeCodexIdentity(
        fields,
        typeof fields.cwd === "string" ? resolve(projectRootFromCwd(fields.cwd)) : "",
      );
      if (decoded.status !== "verified") candidate = { status: decoded.status, binding: null };
      else {
        const binding: CodexChildBinding = {
          identity: decoded.identity,
          sourcePath: resolve(path),
          sourceHeaderFingerprint: codexIdentityFingerprint(decoded.identity),
        };
        candidate = { status: "verified", binding };
        const group = graph.get(key(binding.identity)) ?? [];
        group.push(binding);
        graph.set(key(binding.identity), group);
      }
    } catch {
      candidate = { status: existsSync(path) ? "wrong-format" : "missing", binding: null };
    }
    sources.set(resolve(path), candidate);
  }
  for (const [marker, records] of registrations) {
    const grouped = new Map<string, ChildSourceRegistration[]>();
    for (const record of records) {
      const group = grouped.get(record.threadId) ?? [];
      group.push(record);
      grouped.set(record.threadId, group);
    }
    const checkout = resolve(projectRootFromCwd(marker.cwd!));
    marker.childSources = [...grouped].map(([threadId, group]): RegisteredCodexChild => {
      const first = group[0]!;
      const child: RegisteredCodexChild = {
        threadId,
        rootSessionId: marker.sessionId,
        parentThreadId: first.parentThreadId,
        capturedAt: first.observedAt,
        sourceStatus: "missing",
        binding: null,
        depth: null,
      };
      if (new Set(group.map((r) => r.sourceHeaderFingerprint)).size !== 1) {
        child.sourceStatus = "identity-conflict";
        return child;
      }
      const found = group
        .map((r) => sources.get(resolve(r.sourcePath)))
        .filter((c): c is Candidate => !!c);
      const bindings = found.flatMap((c) => (c.binding ? [c.binding] : []));
      if (found.some((c) => c.status !== "missing" && c.status !== "verified")) {
        child.sourceStatus = found.find(
          (c) => c.status !== "missing" && c.status !== "verified",
        )!.status;
        return child;
      }
      if (!bindings.length) return child;
      if (
        bindings.some(
          (b) =>
            b.sourceHeaderFingerprint !== first.sourceHeaderFingerprint ||
            b.identity.checkout !== checkout ||
            b.identity.threadId !== threadId ||
            b.identity.rootSessionId !== marker.sessionId ||
            b.identity.parentThreadId !== first.parentThreadId,
        )
      ) {
        child.sourceStatus = "identity-conflict";
        return child;
      }
      let current = bindings[0]!;
      const root = marker.rollout ? sources.get(resolve(marker.rollout))?.binding : null;
      if (marker.sourceStatus !== "verified" || !root || root.identity.relation !== "root")
        return child;
      const seen = new Set<string>();
      let depth = 0;
      while (current.identity.threadId !== root.identity.threadId) {
        if (seen.has(current.identity.threadId)) {
          child.sourceStatus = "identity-conflict";
          return child;
        }
        seen.add(current.identity.threadId);
        if (current.identity.relation !== "child" || !current.identity.parentThreadId) return child;
        const parents =
          graph.get(
            JSON.stringify([checkout, marker.sessionId, current.identity.parentThreadId]),
          ) ?? [];
        if (!parents.length) return child;
        if (new Set(parents.map((p) => p.sourceHeaderFingerprint)).size !== 1) {
          child.sourceStatus = "identity-conflict";
          return child;
        }
        current = parents[0]!;
        depth++;
      }
      if (root.sourceHeaderFingerprint !== current.sourceHeaderFingerprint) return child;
      child.sourceStatus = "verified";
      child.binding = bindings[0]!;
      child.depth = depth;
      return child;
    });
  }
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
function readHeader(
  logFile: string,
  sessionId: string,
  repoName: string,
  suppliedRecords?: readonly Record<string, unknown>[],
): LogHeader {
  let cwd: string | null = null;
  let markedAt = "";
  let transcript: string | null = null;
  let seenHeader = false;
  let host: LogHeader["host"] = "unknown";
  let identityConflict = false;
  try {
    const local: Record<string, unknown>[] = [];
    const records = suppliedRecords ?? local;
    if (!suppliedRecords)
      readAuditJsonl(logFile, (value) => {
        const normalized = normalizeAuditRecord(value, "audit-log");
        if (normalized.value) local.push(normalized.value);
        return records.length < 100_000;
      });
    for (const rec of records) {
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

/** At most the root-metadata record past the prelude; later prompt/tool records stay unread. */
function sourceMetadataLine(file: string): string | null {
  let result: string | null = null;
  const reading = readSourceIdentity(file, (raw) => {
    const normalized = normalizeAuditRecord(raw, "metadata");
    if (normalized.value && normalized.omitted === 0) result = JSON.stringify(normalized.value);
  });
  return reading.sourceStatus === "observed" ? result : null;
}

/** Read only versioned identity fields; never inspect prompts or tool payloads. */
function inspectSource(
  file: string | null,
  host: "claude" | "codex",
  sessionId: string,
  cwd: string | null,
  context?: AuditDiscoveryContext,
): SourceIdentity {
  if (!file) return { host, status: "missing" };
  try {
    if (!lstatSync(file).isFile()) return { host, status: "wrong-format" };
    const cached = context ? indexedSourceMetadata(file, context) : null;
    const line = context ? (cached ? JSON.stringify(cached) : null) : sourceMetadataLine(file);
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
      if (host === "codex" && fields.cli_version === "0.160.0") {
        const decoded = normalizeCodexIdentity(
          fields,
          resolve(projectRootFromCwd(String(fields.cwd))),
        );
        if (decoded.status !== "verified") return { host, status: "identity-conflict" };
        if (decoded.identity.relation === "unknown") return { host, status: "wrong-format" };
      } else if (
        host === "codex" &&
        fields.id !== undefined &&
        fields.session_id !== undefined &&
        fields.id !== fields.session_id
      ) {
        return { host, status: "identity-conflict" };
      }
      if (host === "claude" && !CLAUDE_IDENTITY_TYPES.includes(String(record.type)))
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
  context = createAuditDiscoveryContext(),
): string | null {
  // Recorded by the hook from the payload: an exact path beats both guesses.
  // Still verified on disk — a transcript can be moved or pruned.
  if (recorded && existsSync(recorded)) return retainAuditPath(context.budget, recorded);

  const root = transcriptsRoot();
  if (!existsSync(root)) return null;

  if (cwd) {
    const direct = join(root, encodeCwdToSlug(cwd), `${sessionId}.jsonl`);
    if (existsSync(direct)) return retainAuditPath(context.budget, direct);
  }

  return (
    indexedSourcePaths(context, [root]).find(
      (path) => path.startsWith(`${root}/`) && basename(path) === `${sessionId}.jsonl`,
    ) ?? null
  );
}

/** Depth-bounded walk: `sessions/YYYY/MM/DD/` is three levels; one spare. */
const ROLLOUT_MAX_DEPTH = 5;

/**
 * Locates a Codex session's rollout (spec 0041 R24): the path the hook payload
 * recorded when it still exists, else `codexHome()/sessions/**` matching
 * `rollout-*-<sessionId>.jsonl`. Never throws — a bad `CODEX_HOME` or an
 * unreadable tree is "not found".
 */
export function resolveCodexRollout(
  sessionId: string,
  recorded?: string | null,
  context = createAuditDiscoveryContext(),
): string | null {
  if (recorded && existsSync(recorded)) return retainAuditPath(context.budget, recorded);
  try {
    const root = join(codexHome(), "sessions");
    if (!existsSync(root)) return null;
    return (
      indexedSourcePaths(context, [root]).find(
        (path) =>
          path.startsWith(`${root}/`) &&
          basename(path).startsWith("rollout-") &&
          path.endsWith(`-${sessionId}.jsonl`),
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** Normalize date inputs to a half-open UTC window once per command. */
export function requestedRange(
  filters: DiscoveryFilters,
  now: Date = new Date(),
): { from: string; to: string } {
  if (filters.range) return filters.range;
  const from = filters.since
    ? Date.parse(filters.since)
    : filters.days !== undefined
      ? now.getTime() - filters.days * 86400000
      : 0;
  const to = filters.until
    ? Date.parse(filters.until) + (/^\d{4}-\d{2}-\d{2}$/.test(filters.until) ? 86400000 : 0)
    : now.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
    throw new Error("invalid-audit-range");
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

function withinRange(markedAt: string, filters: DiscoveryFilters): boolean {
  const at = Date.parse(markedAt);
  if (!Number.isFinite(at))
    return !filters.range && !filters.since && !filters.until && filters.days === undefined;
  const range = requestedRange(filters);
  return at >= Date.parse(range.from) && at < Date.parse(range.to);
}

/** Lists the marked sessions of a repo that match the filters. */
export function markerEnumeration(
  repoName: string,
  context = createAuditDiscoveryContext(),
): {
  state: "observed" | "unavailable";
  reason: "unreadable" | null;
  files: string[];
} {
  const dir = repoAuditDir(repoName);
  try {
    const files: string[] = [];
    const stream = opendirSync(dir);
    try {
      for (let entry = stream.readSync(); entry; entry = stream.readSync()) {
        if (!retainAuditPath(context.budget, join(dir, entry.name))) {
          omitAuditFacts(context.budget, 1, true);
          break;
        }
        if (entry.name.startsWith("session-") && entry.name.endsWith(".log"))
          files.push(entry.name);
      }
    } finally {
      stream.closeSync();
    }
    return { state: "observed", reason: null, files };
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    return code === "ENOENT"
      ? { state: "observed", reason: null, files: [] }
      : { state: "unavailable", reason: "unreadable", files: [] };
  }
}

/** Lists markers only when their directory could actually be enumerated. */
export function findMarkedSessions(
  repoName: string,
  filters: DiscoveryFilters = {},
  includeChildren = true,
  context = createAuditDiscoveryContext(),
): MarkedSession[] {
  const dir = repoAuditDir(repoName);
  const enumeration = markerEnumeration(repoName, context);
  if (enumeration.state !== "observed") return [];

  const sessions: MarkedSession[] = [];
  for (const file of enumeration.files) {
    if (!file.startsWith("session-") || !file.endsWith(".log")) continue;
    const sessionId = basename(file)
      .replace(/^session-/, "")
      .replace(/\.log$/, "");
    const logFile = join(dir, file);
    if (sessions.length >= context.budget.diagnostics.limits.sessionsPerReport) {
      omitAuditFacts(context.budget, 1, true);
      break;
    }
    if (filters.session && filters.session !== "latest" && !sessionId.startsWith(filters.session))
      continue;
    const cachedLog = context.logs.get(logFile);
    const auditLogRecords: Record<string, unknown>[] = cachedLog?.records ?? [];
    let auditNormalizationLoss = cachedLog?.normalizationLoss ?? 0;
    let excluded = false;
    /** Reject old activity only after its verified source also falls outside the cohort. */
    const outsideCohort = (records: readonly Record<string, unknown>[]): boolean => {
      if (filters.session) return false;
      const header = readHeader(logFile, sessionId, repoName, records);
      if (withinRange(header.markedAt, filters) || header.identityConflict || !header.cwd)
        return false;
      const hosts = header.host === "unknown" ? (["claude", "codex"] as const) : [header.host];
      let verified = 0;
      for (const host of hosts) {
        const source =
          host === "codex"
            ? resolveCodexRollout(sessionId, header.transcript, context)
            : resolveTranscript(sessionId, header.cwd, header.transcript, context);
        if (inspectSource(source, host, sessionId, header.cwd, context).status !== "verified")
          continue;
        verified++;
        const metadata = source ? indexedSourceMetadata(source, context) : null;
        const payload = metadata?.payload;
        const timestamp =
          host === "codex" && typeof payload === "object" && payload !== null
            ? ((payload as Record<string, unknown>).timestamp ?? metadata?.timestamp)
            : metadata?.timestamp;
        if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return false;
        if (withinRange(timestamp, filters)) return false;
      }
      return verified === 1;
    };
    let seenStart = auditLogRecords.some((record) => record.event === "start");
    const auditReading =
      cachedLog?.reading ??
      readAuditJsonl(logFile, (value) => {
        const normalized = normalizeAuditRecord(value, "audit-log");
        auditNormalizationLoss += normalized.omitted;
        if (normalized.omitted) omitAuditFacts(context.budget, normalized.omitted);
        if (!normalized.value) return;
        const record = normalized.value;
        if (!seenStart && record.event === "start") {
          seenStart = true;
          retainRootAnchor(context, repoName, sessionId, record);
        }
        if (
          record.event === "start" &&
          typeof record.ts === "string" &&
          Number.isFinite(Date.parse(record.ts)) &&
          !filters.session &&
          !withinRange(record.ts, filters) &&
          outsideCohort([...auditLogRecords, record])
        ) {
          excluded = true;
          if (retainAuditFact(context.budget, null, record)) auditLogRecords.push(record);
          return false;
        }
        if (!retainAuditFact(context.budget, sessionId, record)) return false;
        auditLogRecords.push(record);
      });
    if (!cachedLog) {
      const view = {
        records: auditLogRecords,
        reading: auditReading,
        normalizationLoss: auditNormalizationLoss,
        budget: context.budget,
      };
      // Account for the cache entry without recursively reserving the shared context itself.
      if (retainAuditFact(context.budget, sessionId, { path: logFile }))
        context.logs.set(logFile, view);
    }
    if (excluded || (cachedLog && outsideCohort(auditLogRecords))) continue;
    if (auditReading.stoppedEarly) omitAuditFacts(context.budget, 0, true);
    const { cwd, markedAt, transcript, host, identityConflict, present } = readHeader(
      logFile,
      sessionId,
      repoName,
      auditLogRecords,
    );
    // A Codex hook payload's `transcript_path` is the rollout, not a Claude
    // transcript: it must never reach `parseSession`.
    const claudeFile =
      host !== "codex" ? resolveTranscript(sessionId, cwd, transcript, context) : null;
    const codexFile =
      host !== "claude" ? resolveCodexRollout(sessionId, transcript, context) : null;
    const claudeSource =
      host !== "codex" ? inspectSource(claudeFile, "claude", sessionId, cwd, context) : null;
    const codexSource =
      host !== "claude" ? inspectSource(codexFile, "codex", sessionId, cwd, context) : null;
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
      auditLogRecords,
      auditReading,
      auditNormalizationLoss,
      readBudget: context.budget,
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

  if (includeChildren) qualifyRegisteredChildren(sessions, context);

  sessions.sort((a, b) => b.markedAt.localeCompare(a.markedAt));

  if (filters.session === "latest") return sessions.slice(0, 1);
  if (filters.session) {
    const prefix = filters.session;
    return sessions.filter((s) => s.sessionId.startsWith(prefix));
  }
  return sessions.filter((s) => {
    if (withinRange(s.markedAt, filters)) return true;
    if (s.sourceStatus !== "verified" || !s.source) return false;
    try {
      const rec: unknown = indexedSourceMetadata(s.source, context);
      if (typeof rec !== "object" || rec === null) return false;
      const record = rec as Record<string, unknown>;
      const payload =
        typeof record.payload === "object" && record.payload !== null
          ? (record.payload as Record<string, unknown>)
          : null;
      const ts = s.host === "codex" ? (payload?.timestamp ?? record.timestamp) : record.timestamp;
      return typeof ts === "string" && withinRange(ts, filters);
    } catch {
      return false;
    }
  });
}

/** One audited repo: how much of the host's activity its audit log covers. */
export interface RepoCoverage {
  /** Directory name under the audit root (the repo's basename). */
  repo: string;
  /** Distinct project roots the session logs of this directory recorded. */
  roots: string[];
  /** Sessions with an audit log in the period. */
  audited: number | null;
  /** Host sessions in the period, or null when no root is known to look under. */
  host: number | null;
  captured?: number | null;
  ratio?: number | null;
  reason?: EvidenceReason | null;
  activation?: {
    observed: number | null;
    root: number | null;
    child: number | null;
    unknown: number | null;
    markerOnly: number | null;
  };
  populations?: Array<{
    host: "claude" | "codex";
    relation: "root" | "child" | "unknown";
    denominator: number | null;
    captured: number | null;
    ratio: number | null;
    reason: EvidenceReason | null;
  }>;
}

interface HostMember {
  key: string;
  host: "claude" | "codex";
  relation: "root" | "child" | "unknown";
  startedAt: string;
}

/** Enumerate authoritative metadata only; unreadable/invalid sources keep N unknown. */
function hostPopulation(
  roots: readonly string[],
  filters: DiscoveryFilters,
  context = createAuditDiscoveryContext(),
): {
  members: HostMember[];
  allMembers: HostMember[];
  complete: boolean;
  byHost: Record<"claude" | "codex", boolean>;
  identityConflict: boolean;
} {
  const members = new Map<string, HostMember>();
  let complete = roots.length > 0;
  const byHost = { claude: roots.length > 0, codex: roots.length > 0 };
  const files = new Set<string>();
  const codexFiles = new Set<string>();
  let identityConflict = false;
  try {
    if (!existsSync(transcriptsRoot())) byHost.claude = false;
    const codexRoot = join(codexHome(), "sessions");
    if (!existsSync(codexRoot)) byHost.codex = false;
    for (const file of indexedSourcePaths(context, [transcriptsRoot(), codexRoot])) {
      if (file.startsWith(`${codexRoot}/`)) {
        files.add(file);
        codexFiles.add(file);
      } else if (file.startsWith(`${transcriptsRoot()}/`) && !file.includes("/subagents/"))
        files.add(file);
    }
    if (discoveryTruncated(context)) complete = false;
  } catch {
    complete = false;
  }
  for (const file of files) {
    const expectedHost = codexFiles.has(file) ? "codex" : "claude";
    try {
      const record: unknown = indexedSourceMetadata(file, context);
      if (typeof record !== "object" || record === null) {
        byHost[expectedHost] = false;
        continue;
      }
      const rec = record as Record<string, unknown>;
      const host = rec.type === "session_meta" ? "codex" : "claude";
      if (
        host !== expectedHost ||
        (host === "claude" && !CLAUDE_IDENTITY_TYPES.includes(String(rec.type)))
      ) {
        byHost[expectedHost] = false;
        continue;
      }
      const meta = host === "codex" ? rec.payload : rec;
      if (typeof meta !== "object" || meta === null) {
        byHost[host] = false;
        continue;
      }
      const fields = meta as Record<string, unknown>;
      if (typeof fields.cwd !== "string") {
        byHost[host] = false;
        continue;
      }
      if (
        !roots.some((root) => resolve(projectRootFromCwd(fields.cwd as string)) === resolve(root))
      )
        continue;
      const id = host === "codex" ? (fields.id ?? fields.session_id) : fields.sessionId;
      const ts = host === "codex" ? (fields.timestamp ?? rec.timestamp) : rec.timestamp;
      if (typeof id !== "string" || typeof ts !== "string" || !Number.isFinite(Date.parse(ts))) {
        byHost[host] = false;
        continue;
      }
      const identity = inspectSource(file, host, id, fields.cwd, context);
      if (identity.status !== "verified") {
        byHost[host] = false;
        identityConflict ||= identity.status === "identity-conflict";
        continue;
      }
      const relation =
        typeof fields.parent_thread_id === "string" ||
        typeof fields.parentSessionId === "string" ||
        fields.isSidechain === true
          ? "child"
          : fields.isSidechain === false ||
              fields.parent_thread_id === null ||
              fields.parentSessionId === null
            ? "root"
            : "unknown";
      const key = `${host}:${id}`;
      const member: HostMember = { key, host, relation, startedAt: new Date(ts).toISOString() };
      const previous = members.get(key);
      if (
        previous &&
        (previous.startedAt !== member.startedAt || previous.relation !== member.relation)
      ) {
        complete = false;
        members.set(key, { ...member, relation: "unknown" });
        continue;
      }
      members.set(key, member);
    } catch {
      byHost[expectedHost] = false;
    }
  }
  if (!complete) {
    byHost.claude = false;
    byHost.codex = false;
  }
  return {
    members: [...members.values()].filter((m) => withinRange(m.startedAt, filters)),
    allMembers: [...members.values()],
    complete: complete && byHost.claude && byHost.codex,
    byHost,
    identityConflict,
  };
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
): number | null {
  const population = hostPopulation(roots, filters);
  return population.complete ? population.members.length : null;
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
  rootHint?: string,
  context = createAuditDiscoveryContext(),
): { row: RepoCoverage; warning: string | null } {
  const sessions = findMarkedSessions(repo, filters, true, context);
  const roots = rootsOf(sessions);
  for (const root of context.repoRoots.get(repo) ?? []) if (!roots.includes(root)) roots.push(root);
  if (rootHint && !roots.includes(projectRootFromCwd(rootHint)))
    roots.push(projectRootFromCwd(rootHint));
  const population = hostPopulation(roots, filters, context);
  const marked = new Set(
    sessions
      .filter((s) => s.host !== "unknown" && s.sourceStatus !== "identity-conflict")
      .map((s) => `${s.host}:${s.sessionId}`),
  );
  const identityConflict =
    population.identityConflict || sessions.some((s) => s.sourceStatus === "identity-conflict");
  const activations = sessions.filter((m) => withinRange(m.markedAt, filters));
  const markerComplete =
    markerEnumeration(repo, context).state === "observed" &&
    !discoveryTruncated(context) &&
    sessions.every((s) => Number.isFinite(Date.parse(s.markedAt)));
  const captureComplete = markerComplete && !identityConflict;
  const captured = captureComplete
    ? population.members.filter((m) => marked.has(m.key)).length
    : null;
  const host = population.complete ? population.members.length : null;
  const reason: EvidenceReason | null = identityConflict
    ? "identity-conflict"
    : !population.complete || !markerComplete
      ? "incomplete-enumeration"
      : host === 0
        ? "empty-population"
        : null;
  const populations: NonNullable<RepoCoverage["populations"]> = [];
  for (const engine of ["claude", "codex"] as const)
    for (const relation of ["root", "child", "unknown"] as const) {
      const cohort = population.members.filter((m) => m.host === engine && m.relation === relation);
      const n = captureComplete ? cohort.filter((m) => marked.has(m.key)).length : null;
      populations.push({
        host: engine,
        relation,
        denominator: population.byHost[engine] ? cohort.length : null,
        captured: n,
        ratio: population.byHost[engine] && cohort.length && n !== null ? n / cohort.length : null,
        reason: identityConflict
          ? "identity-conflict"
          : !population.byHost[engine] || !markerComplete
            ? "incomplete-enumeration"
            : cohort.length === 0
              ? "empty-population"
              : null,
      });
    }
  const activation: NonNullable<RepoCoverage["activation"]> = {
    observed: markerComplete ? activations.length : null,
    root: markerComplete ? 0 : null,
    child: markerComplete ? 0 : null,
    unknown: markerComplete ? 0 : null,
    markerOnly: markerComplete ? 0 : null,
  };
  for (const m of markerComplete ? activations : []) {
    const member = population.allMembers.find((p) => p.key === `${m.host}:${m.sessionId}`);
    const relation =
      m.sourceStatus === "identity-conflict" ? "unknown" : (member?.relation ?? "unknown");
    activation[relation] = (activation[relation] ?? 0) + 1;
    if (!member) activation.markerOnly = (activation.markerOnly ?? 0) + 1;
  }
  return {
    row: {
      repo,
      roots,
      audited: markerComplete ? activations.length : null,
      host,
      captured,
      ratio: host && captured !== null ? captured / host : null,
      reason,
      activation,
      populations,
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
export function listAuditedRepos(
  filters: DiscoveryFilters = {},
  context = createAuditDiscoveryContext(),
): AuditedRepos {
  const root = auditsRoot();
  const repos: RepoCoverage[] = [];
  const warnings: string[] = [];
  if (!existsSync(root)) return { repos, warnings };

  const directory = opendirSync(root);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      const repo = entry.name;
      if (!retainAuditPath(context.budget, join(root, repo))) {
        omitAuditFacts(context.budget, 1, true);
        break;
      }
      const dir = join(root, repo);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const enumeration = markerEnumeration(repo, context);
      if (enumeration.state === "observed" && enumeration.files.length === 0) continue;
      const { row, warning } = repoCoverage(repo, filters, undefined, context);
      repos.push(row);
      if (warning) warnings.push(warning);
    }
  } finally {
    directory.closeSync();
  }
  repos.sort((a, b) => a.repo.localeCompare(b.repo));
  return { repos, warnings };
}

/**
 * Coverage of the period as flat range metrics (R62): audited sessions against
 * the host's, summed over `rows`. Rows with no known root have no denominator
 * and are left out of BOTH sides, so a repo the host cannot be looked up for
 * does not read as a gap in coverage. `null` when no row has one.
 */
export function coverageMetrics(rows: readonly RepoCoverage[]): Record<string, number | null> {
  const audited = rows.every((r) => r.audited !== null)
    ? rows.reduce((n, r) => n + (r.audited ?? 0), 0)
    : null;
  const complete = rows.length > 0 && rows.every((r) => r.host !== null);
  const host = complete ? rows.reduce((n, r) => n + (r.host ?? 0), 0) : null;
  const captured = rows.every((r) => r.captured !== null)
    ? rows.reduce((n, r) => n + (r.captured ?? r.audited ?? 0), 0)
    : null;
  return {
    "coverage.sessions.audited": audited,
    "coverage.sessions.host": host,
    "coverage.sessions.captured": captured,
    "coverage.pct":
      host && captured !== null && captured <= host
        ? Math.round((1000 * captured) / host) / 10
        : null,
  };
}
