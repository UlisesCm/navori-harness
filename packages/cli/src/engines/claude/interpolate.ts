import type { NavoriConfig } from "../../lib/config.ts";
import { placeholderFallback } from "../../lib/placeholders.ts";

/**
 * Interpolate `{{path.to.value}}` placeholders against the config and an
 * optional `extraVars` map. Two modes:
 *
 *   default:                      unresolved placeholders fall back via
 *                                 `placeholderFallback` (prose for known-optional
 *                                 paths, else `<not configured: <path>>`).
 *   omitUnresolvedKeyLines:       lines of the form `key: {{x}}` with x
 *                                 unresolved are dropped entirely. Used for
 *                                 frontmatter (so an absent `models.X`
 *                                 doesn't break YAML with a broken value).
 */
export interface InterpolateOptions {
  extraVars?: Record<string, string>;
  omitUnresolvedKeyLines?: boolean;
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const KEY_LINE_RE = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}\s*$/;

export function interpolate(
  content: string,
  config: NavoriConfig,
  options: InterpolateOptions = {},
): string {
  const extra = options.extraVars ?? {};
  if (!options.omitUnresolvedKeyLines) {
    return interpolateRaw(content, config, extra);
  }
  return content
    .split("\n")
    .map((line) => maybeInterpolateLine(line, config, extra))
    .filter((line): line is string => line !== null)
    .join("\n");
}

function maybeInterpolateLine(
  line: string,
  config: NavoriConfig,
  extra: Record<string, string>,
): string | null {
  const m = line.match(KEY_LINE_RE);
  if (m) {
    const resolved = resolvePath(m[2], config, extra);
    if (resolved === null) return null;
    return `${m[1]}: ${resolved}`;
  }
  return interpolateRaw(line, config, extra);
}

function interpolateRaw(
  content: string,
  config: NavoriConfig,
  extra: Record<string, string>,
): string {
  return content.replace(PLACEHOLDER_RE, (_match, path: string) => {
    const value = resolvePath(path, config, extra);
    return value !== null ? value : placeholderFallback(path);
  });
}

function resolvePath(
  path: string,
  config: NavoriConfig,
  extra: Record<string, string>,
): string | null {
  if (Object.prototype.hasOwnProperty.call(extra, path)) {
    return extra[path];
  }
  const segments = path.split(".");
  let cursor: unknown = config;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor === "string" || typeof cursor === "number" || typeof cursor === "boolean") {
    return String(cursor);
  }
  // Arrays of primitives (legacyPaths, criticalAreas, libraries) serialize to a
  // comma-joined list so template placeholders like `{{project.legacyPaths}}`
  // render the values instead of falling back to empty/`<not configured>`.
  // Arrays holding objects (e.g. libraryMigrations) have no meaningful inline
  // form — return null so the placeholder fallback fires rather than emitting
  // "[object Object]".
  if (Array.isArray(cursor)) {
    return cursor.every(isPrimitive) ? cursor.join(", ") : null;
  }
  return null;
}

/** True for values that serialize cleanly inline (string/number/boolean). */
function isPrimitive(value: unknown): boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}
