/**
 * Typed error base — spec 0003 §3.4.5.
 *
 * Every navori domain error carries a stable `code` (machine-readable, stable
 * even if the message wording changes) so callers can branch on it without
 * string-matching. `name` is derived from the subclass automatically.
 *
 * Note: RenderError / DriftError from the spec are intentionally NOT defined
 * here — there is no throw site for them today (the render reports status, it
 * doesn't throw; drift is data, not an exception). Add them when a real throw
 * appears, not speculatively.
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

/** External-tool install failed (timeout, killed by signal, non-zero exit). */
export class InstallError extends NavoriError {
  constructor(message: string) {
    super("install-failed", message);
  }
}
