/**
 * Minimal semver comparison — no dependency. navori versions are plain
 * `MAJOR.MINOR.PATCH` (optionally with a `-prerelease` suffix we ignore for
 * ordering). Used to tell an *upgrade* from a *downgrade* when a managed block
 * or config was written by a different navori than the one running now.
 *
 * The contract is deliberately conservative: anything that doesn't parse as a
 * clean numeric semver returns `null` from {@link parseSemver}, and the
 * comparison/downgrade helpers treat an unparseable version as "unknown" —
 * never as a downgrade — so a malformed marker can't trip the anti-retroceso
 * guard and start skipping legitimate writes.
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Parse `X.Y.Z` (ignoring any `-prerelease`/`+build` suffix). Returns null
 * when the core `X.Y.Z` isn't three non-negative integers. */
export function parseSemver(version: string | null | undefined): Semver | null {
  if (typeof version !== "string") return null;
  const core = version.trim().split(/[-+]/, 1)[0]!;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(core);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Compare two versions. Returns -1 if `a < b`, 1 if `a > b`, 0 if equal.
 * Returns `null` when either side can't be parsed — the caller must decide
 * what "unknown ordering" means (both {@link isDowngrade} and the render
 * classifier treat it as "not a downgrade / not an upgrade").
 */
export function compareSemver(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/**
 * True when `existing` is strictly newer than `incoming` — i.e. writing
 * `incoming` over `existing` would roll the version back. Both must parse;
 * an unknown ordering is never a downgrade.
 */
export function isDowngrade(existing: string | null | undefined, incoming: string | null | undefined): boolean {
  return compareSemver(existing, incoming) === 1;
}
