import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { NavoriError } from "../primitives/errors.ts";
import { safeHomedir } from "../primitives/home.ts";
import { AUDIT_READ_LIMITS, type AuditReadDiagnostics } from "./model.ts";

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
  if (override) {
    if (!isAbsolute(override))
      throw new NavoriError("invalid-audit-root", "Audit root must be absolute.");
    return resolve(override);
  }
  return join(safeHomedir(), ".navori", "audits");
}

export type PrivateAuditReason =
  | "unsafe"
  | "changed"
  | "missing"
  | "exists"
  | "incomplete-tail"
  | "short-write"
  | "limit"
  | "unsupported"
  | "io";
export type PrivateAuditResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: PrivateAuditReason; partial: boolean };
export interface PrivateAuditOptions {
  /** Default: audit-owned root. null explicitly selects ordinary user ancestors. */
  ownedRoot?: string | null;
}

class PrivateAuditFault extends Error {
  constructor(readonly reason: PrivateAuditReason) {
    super(reason);
  }
}
interface AuditIdentity {
  path: string;
  stat: Stats;
}

/** Permit only the standard macOS system aliases before the owned boundary. */
function systemAuditPath(path: string): string {
  for (const prefix of ["/var", "/tmp"]) {
    if (path === prefix || path.startsWith(prefix + sep)) {
      try {
        if (realpathSync(prefix) === "/private" + prefix) return "/private" + path;
      } catch {
        /* Normal validation will refuse unavailable ancestors. */
      }
    }
  }
  return path;
}

/** Content-free refusal; a mutation attempt may leave a private partial artifact. */
function refused<T>(error: unknown, partial = false): PrivateAuditResult<T> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return {
    ok: false,
    reason:
      error instanceof PrivateAuditFault
        ? error.reason
        : code === "EEXIST"
          ? "exists"
          : code === "ENOENT"
            ? "missing"
            : "io",
    partial,
  };
}
function sameAuditIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
}
function auditUid(): number {
  if (typeof process.getuid !== "function" || !constants.O_NOFOLLOW)
    throw new PrivateAuditFault("unsupported");
  return process.getuid();
}
function regularAuditFile(stat: Stats, privateFile = true): void {
  if (!stat.isFile() || stat.uid !== auditUid() || (privateFile && (stat.mode & 0o177) !== 0))
    throw new PrivateAuditFault("unsafe");
}

/** Validate every observed ancestor; ordinary user ancestors are never chmodded.
 * Local trusted writers are assumed: Node path rechecks are not portable openat
 * containment and cannot eliminate the remaining ancestor TOCTOU window. */
function auditParents(
  path: string,
  options: PrivateAuditOptions,
  create: boolean,
): AuditIdentity[] {
  path = systemAuditPath(path);
  if (!isAbsolute(path) || resolve(path) !== path) throw new PrivateAuditFault("unsafe");
  const rawOwned = options.ownedRoot === undefined ? auditsRoot() : options.ownedRoot;
  const owned = rawOwned === null ? null : systemAuditPath(rawOwned);
  if (owned !== null && (!isAbsolute(owned) || (path !== owned && !path.startsWith(owned + sep))))
    throw new PrivateAuditFault("unsafe");
  const dirs: string[] = [];
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  const identities: AuditIdentity[] = [];
  for (const dir of dirs) {
    let stat: Stats;
    try {
      stat = lstatSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create)
        throw new PrivateAuditFault("missing");
      recheckAuditParents(identities);
      mkdirSync(dir, { mode: 0o700 });
      stat = lstatSync(dir);
    }
    const isOwned = owned !== null && (dir === owned || dir.startsWith(owned + sep));
    if (!stat.isDirectory() || (isOwned && (stat.uid !== auditUid() || (stat.mode & 0o077) !== 0)))
      throw new PrivateAuditFault("unsafe");
    identities.push({ path: dir, stat });
  }
  return identities;
}
function recheckAuditParents(identities: readonly AuditIdentity[]): void {
  for (const identity of identities)
    if (!sameAuditIdentity(identity.stat, lstatSync(identity.path)))
      throw new PrivateAuditFault("changed");
}

/** Rebind the descriptor to its current path immediately before each operation. */
function auditGuard(
  path: string,
  fd: number,
  identity: Stats,
  parents: readonly AuditIdentity[],
  privateFile = true,
): void {
  recheckAuditParents(parents);
  const stat = fstatSync(fd);
  regularAuditFile(stat, privateFile);
  if (!sameAuditIdentity(identity, stat) || !sameAuditIdentity(stat, lstatSync(path)))
    throw new PrivateAuditFault("changed");
}

/** Create only missing owned directories, refusing insecure history unchanged. */
export function ensurePrivateAuditDirectory(
  path: string,
  options: PrivateAuditOptions = {},
): PrivateAuditResult<void> {
  try {
    auditParents(join(path, ".directory-check"), options, true);
    return { ok: true, value: undefined };
  } catch (error) {
    return refused(error);
  }
}

/** Exclusive 0600 artifact creation, never overwriting or repairing history. */
export function createPrivateAuditFile(
  path: string,
  data: string | Uint8Array,
  options: PrivateAuditOptions = {},
): PrivateAuditResult<number> {
  let fd: number | undefined;
  let partial = false;
  try {
    if (existsSync(path)) throw new PrivateAuditFault("exists");
    const parents = auditParents(path, options, true);
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    partial = true;
    const identity = fstatSync(fd);
    auditGuard(path, fd, identity, parents);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    if (writeSync(fd, bytes) !== bytes.byteLength) throw new PrivateAuditFault("short-write");
    auditGuard(path, fd, identity, parents);
    return { ok: true, value: bytes.byteLength };
  } catch (error) {
    return refused(error, partial);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Append one complete JSONL batch to the validated fd, preserving any partial
 * suffix on short write. Never truncate/repair; subsequent writers refuse it. */
export function appendPrivateAuditFile(
  path: string,
  data: string | Uint8Array | ((fd: number) => string | Uint8Array),
  options: PrivateAuditOptions = {},
): PrivateAuditResult<number> {
  let fd: number | undefined;
  let partial = false;
  try {
    const parents = auditParents(path, options, false);
    const expected = lstatSync(path);
    regularAuditFile(expected);
    fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    auditGuard(path, fd, expected, parents);
    const stat = fstatSync(fd);
    if (stat.size) {
      const tail = Buffer.alloc(1);
      if (readSync(fd, tail, 0, 1, stat.size - 1) !== 1 || tail[0] !== 10)
        throw new PrivateAuditFault("incomplete-tail");
    }
    const content = typeof data === "function" ? data(fd) : data;
    const bytes = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    if (bytes.byteLength && bytes[bytes.byteLength - 1] !== 10)
      throw new PrivateAuditFault("incomplete-tail");
    auditGuard(path, fd, expected, parents);
    if (bytes.byteLength === 0) return { ok: true, value: 0 };
    partial = true;
    if (writeSync(fd, bytes) !== bytes.byteLength) throw new PrivateAuditFault("short-write");
    auditGuard(path, fd, expected, parents);
    return { ok: true, value: bytes.byteLength };
  } catch (error) {
    return refused(error, partial);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Checked bounded read. Public numeric legacy snapshots may opt out of file
 * privacy, never of no-follow, regularity, owner or ancestor identity checks. */
export function readPrivateAuditFile(
  path: string,
  options: PrivateAuditOptions & { maxBytes?: number; privateFile?: boolean } = {},
): PrivateAuditResult<Buffer> {
  let fd: number | undefined;
  try {
    if (options.ownedRoot === null && options.privateFile === false)
      path = join(realpathSync(dirname(path)), basename(path));
    const parents = auditParents(path, options, false);
    const identity = lstatSync(path);
    regularAuditFile(identity, options.privateFile !== false);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    auditGuard(path, fd, identity, parents, options.privateFile !== false);
    const max = options.maxBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(max) || max < 0 || identity.size > max)
      throw new PrivateAuditFault("limit");
    const bytes = Buffer.alloc(identity.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!count) throw new PrivateAuditFault("changed");
      offset += count;
    }
    auditGuard(path, fd, identity, parents, options.privateFile !== false);
    if (fstatSync(fd).size !== identity.size) throw new PrivateAuditFault("changed");
    return { ok: true, value: bytes };
  } catch (error) {
    return refused(error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Replace only generated artifacts via a checked exclusive sibling. Never use
 * this for historical JSONL logs; append is intentionally non-transactional. */
export function replacePrivateAuditFile(
  path: string,
  data: string | Uint8Array,
  options: PrivateAuditOptions = {},
): PrivateAuditResult<number> {
  const temporary = join(dirname(path), `.audit-${randomUUID()}.tmp`);
  let staged: Stats | undefined;
  let fd: number | undefined;
  try {
    const parents = auditParents(path, options, true);
    let target: Stats | undefined;
    try {
      target = lstatSync(path);
      regularAuditFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    staged = fstatSync(fd);
    auditGuard(temporary, fd, staged, parents);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    if (writeSync(fd, bytes) !== bytes.byteLength) throw new PrivateAuditFault("short-write");
    auditGuard(temporary, fd, staged, parents);
    recheckAuditParents(parents);
    if (target) {
      regularAuditFile(lstatSync(path));
      if (!sameAuditIdentity(target, lstatSync(path))) throw new PrivateAuditFault("changed");
    } else {
      try {
        lstatSync(path);
        throw new PrivateAuditFault("changed");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!staged || !sameAuditIdentity(staged, lstatSync(temporary)))
      throw new PrivateAuditFault("changed");
    renameSync(temporary, path);
    staged = undefined;
    return { ok: true, value: bytes.byteLength };
  } catch (error) {
    return refused(error);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (staged) {
      try {
        if (sameAuditIdentity(staged, lstatSync(temporary))) unlinkSync(temporary);
      } catch {
        /* Do not clean an unverified replacement. */
      }
    }
  }
}

/** Stream from a validated source fd to an exclusive private destination. */
export function copyPrivateAuditFile(
  source: string,
  destination: string,
  options: {
    source?: PrivateAuditOptions;
    destination?: PrivateAuditOptions;
    maxBytes?: number;
  } = {},
): PrivateAuditResult<number> {
  let input: number | undefined;
  let output: number | undefined;
  let partial = false;
  try {
    const sourceParents = auditParents(source, options.source ?? {}, false);
    const identity = lstatSync(source);
    regularAuditFile(identity);
    input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    auditGuard(source, input, identity, sourceParents);
    const max = options.maxBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(max) || max < 0 || identity.size > max)
      throw new PrivateAuditFault("limit");
    const parents = auditParents(destination, options.destination ?? {}, true);
    output = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    partial = true;
    const target = fstatSync(output);
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < identity.size) {
      auditGuard(source, input, identity, sourceParents);
      auditGuard(destination, output, target, parents);
      const count = readSync(
        input,
        buffer,
        0,
        Math.min(buffer.length, identity.size - offset),
        offset,
      );
      if (!count) throw new PrivateAuditFault("changed");
      if (writeSync(output, buffer.subarray(0, count)) !== count)
        throw new PrivateAuditFault("short-write");
      offset += count;
    }
    auditGuard(source, input, identity, sourceParents);
    auditGuard(destination, output, target, parents);
    if (fstatSync(input).size !== identity.size) throw new PrivateAuditFault("changed");
    return { ok: true, value: offset };
  } catch (error) {
    return refused(error, partial);
  } finally {
    if (input !== undefined) closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

/** Remove an explicitly selected private artifact only after fd/path checks.
 * The caller owns lifecycle authorization; no cached lookup authorizes unlink. */
export function removePrivateAuditFile(
  path: string,
  options: PrivateAuditOptions & {
    expectedIdentity?: Readonly<{ dev: number; ino: number; size: number }>;
  } = {},
): PrivateAuditResult<void> {
  let fd: number | undefined;
  try {
    const parents = auditParents(path, options, false);
    const identity = lstatSync(path);
    regularAuditFile(identity);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    auditGuard(path, fd, identity, parents);
    if (options.expectedIdentity) {
      const expected = options.expectedIdentity;
      for (const current of [fstatSync(fd), lstatSync(path)]) {
        if (
          current.dev !== expected.dev ||
          current.ino !== expected.ino ||
          current.size !== expected.size
        )
          throw new PrivateAuditFault("changed");
      }
    }
    unlinkSync(path);
    return { ok: true, value: undefined };
  } catch (error) {
    return refused(error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Stream complete UTF-8 JSONL records without retaining a whole source. Host
 * inputs may be nonprivate; audit-owned artifacts require explicit private
 * policy. Oversize bytes are discarded before decoding, not after allocation.
 * Active files may grow; descriptor identity is not content-integrity proof. */
export function readAuditJsonl(
  path: string,
  visit: (value: unknown, lineBytes: number) => boolean | void,
  options: {
    maxLineBytes?: number;
    maxEvents?: number;
    privateArtifact?: boolean;
    ownedRoot?: string;
  } = {},
): AuditReadDiagnostics {
  const out: AuditReadDiagnostics = {
    bytesRead: 0,
    lines: 0,
    completeLines: 0,
    malformedJson: 0,
    invalidUtf8: 0,
    oversizedLines: 0,
    incompleteTail: false,
    stoppedEarly: false,
    omitted: 0,
    omittedLowerBound: 0,
    sourceStatus: "observed",
    reason: null,
  };
  let fd: number | undefined;
  try {
    if (!isAbsolute(path)) throw new PrivateAuditFault("unsafe");
    if (!options.privateArtifact) path = join(realpathSync(dirname(path)), basename(path));
    const parents = auditParents(
      path,
      { ownedRoot: options.privateArtifact ? options.ownedRoot : null },
      false,
    );
    const identity = lstatSync(path);
    regularAuditFile(identity, options.privateArtifact === true);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const guard = (): void =>
      auditGuard(path, fd!, identity, parents, options.privateArtifact === true);
    guard();
    const maxLine = options.maxLineBytes ?? AUDIT_READ_LIMITS.maxLineBytes;
    const maxEvents = options.maxEvents ?? AUDIT_READ_LIMITS.eventsPerSession;
    if (
      !Number.isSafeInteger(maxLine) ||
      maxLine < 1 ||
      maxLine > AUDIT_READ_LIMITS.maxLineBytes ||
      !Number.isSafeInteger(maxEvents) ||
      maxEvents < 1 ||
      maxEvents > AUDIT_READ_LIMITS.eventsPerSession
    )
      throw new PrivateAuditFault("unsafe");
    const chunk = Buffer.alloc(65536);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let fragments: Buffer[] = [];
    let length = 0;
    let overflow = false;
    let events = 0;
    const drop = (): void => {
      out.omitted = (out.omitted ?? 0) + 1;
      out.omittedLowerBound++;
    };
    const complete = (): boolean => {
      if (!length) return true;
      out.lines++;
      out.completeLines++;
      if (overflow) {
        out.oversizedLines++;
        drop();
        return true;
      }
      let text: string;
      try {
        text = decoder.decode(Buffer.concat(fragments, length));
      } catch {
        out.invalidUtf8++;
        drop();
        return true;
      }
      if (!text.trim()) return true;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        out.malformedJson++;
        drop();
        return true;
      }
      if (++events > maxEvents || visit(value, length + 1) === false) {
        out.stoppedEarly = true;
        out.omitted = null;
        out.omittedLowerBound++;
        return false;
      }
      return true;
    };
    let running = true;
    while (running) {
      guard();
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      out.bytesRead += count;
      let start = 0;
      for (let i = 0; i <= count; i++) {
        if (i !== count && chunk[i] !== 10) continue;
        const part = chunk.subarray(start, i);
        length += part.length;
        if (length > maxLine) {
          overflow = true;
          fragments = [];
        } else if (!overflow && part.length) fragments.push(Buffer.from(part));
        if (i < count) {
          if (!complete()) {
            running = false;
            break;
          }
          fragments = [];
          length = 0;
          overflow = false;
        }
        start = i + 1;
      }
    }
    if (!out.stoppedEarly && length) {
      out.lines++;
      out.incompleteTail = true;
      if (overflow) out.oversizedLines++;
      drop();
    }
    guard();
  } catch (error) {
    const failure = refused(error);
    if (!failure.ok) {
      out.sourceStatus =
        failure.reason === "unsafe" || failure.reason === "changed" ? "invalid" : "unavailable";
      out.reason =
        failure.reason === "missing"
          ? "missing"
          : failure.reason === "unsafe"
            ? "unsafe"
            : failure.reason === "changed"
              ? "changed"
              : "unreadable";
    }
    out.omitted = null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return out;
}

/**
 * Directory-entry markers checked, in order, while walking up from a cwd to
 * find its project root. `navori.config.json` comes first: it's this domain's
 * OWN root marker, placed deliberately only where a project actually adopted
 * navori, so it can't be fooled by an unrelated `.git` that happens to sit
 * closer to the cwd (e.g. a docs-only sub-repo vendored inside a monorepo).
 * `.git` is the fallback, since it covers every git repo navori runs
 * against even without navori config — but in a worktree checkout `.git` is
 * a FILE (a `gitdir:` pointer), not a directory, so the check below must
 * accept either and not assume a directory entry.
 */
const PROJECT_ROOT_MARKERS = ["navori.config.json", ".git"];

/**
 * Walks up from `startDir` (inclusive) for the nearest ancestor containing
 * one of `PROJECT_ROOT_MARKERS`. Returns `undefined` when none is found
 * before reaching the filesystem root, so the caller can fall back instead
 * of misattributing an unrelated ancestor.
 */
function findProjectRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolves the audit repo name from a working directory path.
 *
 * Two steps, in this order:
 * 1. If `cwd` is inside an agent worktree (`/.claude/worktrees/<agent-id>`),
 *    the path is truncated at `/.claude/worktrees` to attribute the session
 *    to the parent repository rather than creating a phantom repo directory
 *    named after the agent (#764). This runs FIRST because a worktree
 *    checkout can carry its own root marker (its own `.git` file), which
 *    would otherwise stop the walk below one level too early.
 * 2. From the truncated cwd, walk up to the nearest project root marker
 *    (see `findProjectRoot`) so a session opened from ANY subdirectory —
 *    not just the worktree case — is attributed to the project root instead
 *    of that subdirectory's own basename (#897). When no marker is found
 *    (a cwd outside any project), fall back to today's behavior: the
 *    basename of the cwd itself.
 */
export function repoFromCwd(cwd: string): string {
  return basename(projectRootFromCwd(cwd));
}

/**
 * The absolute project root `repoFromCwd` names by basename: the directory the
 * audit store attributes a session to. Discovery needs the PATH, not just the
 * name, to derive the host's transcript slug for the coverage denominator
 * (R62) and to tell two repos that share a basename apart.
 */
export function projectRootFromCwd(cwd: string): string {
  const cleanCwd = resolve(cwd.replace(/[/\\]\.claude[/\\]worktrees(?:[/\\].*)?$/, ""));
  return findProjectRoot(cleanCwd) ?? cleanCwd;
}

/**
 * Directory under the audit root that holds artifacts spanning every repo
 * (`--all-repos` snapshots). It is not a repo: it never carries a session log,
 * so discovery — which lists a repo only when it does — ignores it, and no
 * repo name appears in its path.
 */
export const ALL_REPOS_DIR = "_all-repos";

/** A snapshot name is one path segment: it names a file under the audit root. */
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Where a range snapshot lives: `<range report dir>/snapshot-<name>.json`.
 *
 * `repo` is the audited repo, or `null` for an `--all-repos` snapshot, which
 * lands under `_all-repos/` so that no repo name is written next to it. Both go
 * through `rangeReportDir`, so the "every write lands under the audit root"
 * contract of `commands/audit.ts` holds; the name is validated HERE because
 * this is the function that turns user input into a file name (#503).
 */
export function snapshotPath(repo: string | null, name: string, from: string, to: string): string {
  if (!SNAPSHOT_NAME_RE.test(name) || name.includes("..")) {
    throw new NavoriError(
      "invalid-snapshot-name",
      `Invalid snapshot name '${name}': start with a letter or digit and use only letters, digits, '.', '_' and '-'. ` +
        `It names a file under the audit root.`,
    );
  }
  return join(rangeReportDir(repo ?? ALL_REPOS_DIR, from, to), `snapshot-${name}.json`);
}

/**
 * Per-repo audit directory, e.g. `~/.navori/audits/navori-harness`.
 *
 * `repoName` is ONE path segment, never a path: today's callers derive it from
 * `repoFromCwd(cwd)`, so a separator can't reach here — the guard is for
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

/**
 * Where `SessionStart` hooks park their records until a log exists (#778).
 *
 * `--start` is what creates the session log and it runs from UserPromptSubmit,
 * so every SessionStart hook fires before there is anywhere to write. Its
 * records land here and `--start` folds them in; a session that is never marked
 * leaves a file that the next `--start` in the repo sweeps.
 *
 * Same id validation as the log itself, and for the same reason — this is a
 * second function that turns a session id into a path, which is exactly how
 * #503 would come back.
 */
export function pendingSpoolPath(repoName: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new NavoriError(
      "invalid-session-id",
      `Invalid session id '${sessionId}': only letters, digits, '-' and '_' are allowed. ` +
        `The spool file is named after it, and every write must stay under the audit root.`,
    );
  }
  return join(repoAuditDir(repoName), `pending-${sessionId}.jsonl`);
}

/** Filename shape of a spool file, for the sweep that drops stale ones. */
export const PENDING_SPOOL_RE = /^pending-[A-Za-z0-9_-]+\.jsonl$/;

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
