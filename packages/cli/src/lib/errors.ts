/**
 * Typed error base — spec 0003 §3.4.5.
 *
 * Every navori domain error carries a stable `code` (machine-readable, stable
 * even if the message wording changes) so callers can branch on it without
 * string-matching. `name` is derived from the subclass automatically.
 *
 * Note: DriftError from the spec is intentionally NOT defined here — drift is
 * data, not an exception. RenderWriteError exists because the engines' write
 * loops DO throw on I/O failure and must carry the backup path (#77).
 */
export class NavoriError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** HOME env var is empty or not absolute — see safeHomedir(). */
export class HomeError extends NavoriError {
  constructor(message: string) {
    super("home-unresolved", message);
  }
}

/**
 * An engine write failed mid-render. Writes are atomic per file but not
 * transactional across files, so the tree may be partial; the message and
 * `backupPath` carry the pre-write backup dir (when one was taken) as the
 * recovery breadcrumb — the engine's return value never reaches the caller
 * on a throw (#77).
 */
export class RenderWriteError extends NavoriError {
  readonly backupPath: string | null;
  constructor(message: string, backupPath: string | null) {
    super("render-write-failed", message);
    this.backupPath = backupPath;
  }
}

/** External-tool install failed (timeout, killed by signal, non-zero exit). */
export class InstallError extends NavoriError {
  constructor(message: string) {
    super("install-failed", message);
  }
}
