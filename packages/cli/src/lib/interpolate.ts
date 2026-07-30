import type { NavoriConfig } from "./config.ts";
import { placeholderFallback } from "./placeholders.ts";
import { shellSingleQuote } from "./shell-escape.ts";

/**
 * The single `{{path.to.value}}` interpolator for the whole render pipeline
 * (CLAUDE.md managed blocks in `render-plan`, plus skills/agents/settings in the
 * engine adapters). It lives in `lib/` because it's engine-agnostic — Claude,
 * Codex and the prose spine all use it (C3: consolidated the former
 * `interpolateTemplate` duplicate in `render-plan` into this one).
 *
 * Interpolates against the config and an optional `extraVars` map. Two modes:
 *
 *   default:                      unresolved placeholders fall back via
 *                                 `placeholderFallback` (prose for known-optional
 *                                 paths, else `<not configured: <path>>`).
 *   omitUnresolvedKeyLines:       lines of the form `key: {{x}}` with x
 *                                 unresolved are dropped entirely. Used for
 *                                 frontmatter (so an absent `models.X`
 *                                 doesn't break YAML with a broken value).
 *
 * SHELL-QUOTE MARKER (#197): a placeholder written `{{shq:path}}` shell-quotes
 * the resolved value via `shellSingleQuote` before substituting it, so config
 * that flows into a generated `.sh` hook (`base={{shq:branchBase}}`) can't break
 * out of its string context and inject a command. The marker is explicit at the
 * template call site (greppable, auditable) and emits its own surrounding
 * quotes, so the template must NOT add quotes of its own. Plain `{{path}}` is
 * unchanged — safe for the HTML/YAML/JSON contexts that make up the rest of the
 * pipeline, where single-quote wrapping would be wrong.
 */
export interface InterpolateOptions {
  extraVars?: Record<string, string>;
  omitUnresolvedKeyLines?: boolean;
}

// Optional `shq:` prefix marks a value that must be shell-quoted before it is
// substituted (see the SHELL-QUOTE MARKER note above). Group 1 = the marker (or
// undefined), group 2 = the config path.
const PLACEHOLDER_RE = /\{\{\s*(?:(shq):)?\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
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
  return content.replace(PLACEHOLDER_RE, (_match, marker: string | undefined, path: string) => {
    const value = resolvePath(path, config, extra);
    const resolved = value !== null ? value : placeholderFallback(path);
    // `{{shq:path}}` — shell-quote so untrusted config can't escape its string
    // context in a generated `.sh` file (#197). Quote the fallback too, so an
    // unresolved `shq` placeholder still lands as an inert literal.
    return marker === "shq" ? shellSingleQuote(resolved) : resolved;
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
