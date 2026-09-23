import type { NavoriConfig } from "./config.ts";
import { resolveLang } from "./i18n.ts";
import { placeholderFallback, type FallbackScope } from "./placeholders.ts";
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
 *
 * ESCAPE MARKER (#439): a placeholder written `{{raw:token}}` is NOT resolved —
 * it emits `{{token}}` verbatim. It exists for assets that must SHOW `{{...}}`
 * as text: the i18next lib-skill documents a library whose own interpolation
 * syntax is `{{count}}`, which has exactly the shape of a config path, so the
 * skill that teaches i18next rendered `<not configured: count>` and taught a
 * syntax that doesn't exist. JSX examples (`style={{...}}`, `{{ marginTop: 16 }}`)
 * need no marker — they don't start with a letter, so `PLACEHOLDER_RE` already
 * lets them through. Like `shq:`, the marker is explicit in the asset and
 * greppable; intent is DECLARED, never guessed from the token's spelling (an
 * allowlist of "known literal" tokens breaks silently on the next library whose
 * syntax collides).
 */
export interface InterpolateOptions {
  extraVars?: Record<string, string>;
  omitUnresolvedKeyLines?: boolean;
  /**
   * Which scope's fallbacks answer an unresolved placeholder (Spec 0010 FB).
   * `global` renders the same asset for `~/.claude/skills/navori/`, where
   * `qualityGate.*`, `branchBase` and `prTarget` describe a repo that is not
   * there — see `GLOBAL_FALLBACKS`. Defaults to `repo`, so the repo render is
   * byte-identical to before (§2.4).
   */
  fallbackScope?: FallbackScope;
}

/**
 * Sanitize an untrusted `project.*` config value before it lands VERBATIM
 * inside a managed CLAUDE.md block, which the agents read as trusted navori
 * doctrine (#198). `navori.config.json` is checked-in and editable via PR, so a
 * hostile contributor who only edits config could otherwise (a) inject prompt
 * instructions across a line break, or (b) embed an HTML-comment marker token
 * (`<!-- navori:managed … -->`) to truncate/corrupt the managed region and
 * neutralize a security block. We defuse both:
 *   - collapse every line break to a single space — these fields are one-line
 *     rule fragments, so a newline can only be a smuggled bullet / instruction;
 *   - drop HTML-comment delimiters so no managed/user-zone marker can be forged
 *     inside the value (the bare `navori:managed` text is inert without them —
 *     marker.ts only recognizes the full HTML-comment form).
 */
export function sanitizeProjectValue(value: string): string {
  return value
    .replaceAll("<!--", "")
    .replaceAll("-->", "")
    .replace(/[\r\n\t ]+/g, " ")
    .trim();
}

/** Resolve a path and sanitize it when it is an untrusted `project.*` field. */
function resolveSanitized(
  path: string,
  config: NavoriConfig,
  extra: Record<string, string>,
): string | null {
  const value = resolvePath(path, config, extra);
  if (value === null) return null;
  // Sanitization can itself empty a value (a `project.*` field of pure
  // whitespace/newlines collapses to ""), so re-apply the blank rule after it.
  return nonBlank(path.startsWith("project.") ? sanitizeProjectValue(value) : value);
}

// Optional marker prefix: `shq:` shell-quotes the resolved value (#197), `raw:`
// suppresses resolution and emits the braces verbatim (#439). See the notes
// above. Group 1 = the marker (or undefined), group 2 = the config path.
// The path must start with a letter: `[a-zA-Z0-9_.]+` alone also matched a token
// of pure dots, so a JSX example like `style={{...}}` was consumed as a
// placeholder and corrupted to `<not configured: ...>` (#272). Every real
// config path starts with a letter, so this is a no-op for legitimate paths.
const PLACEHOLDER_RE = /\{\{\s*(?:(shq|raw):)?\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g;
const KEY_LINE_RE = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}\s*$/;

export function interpolate(
  content: string,
  config: NavoriConfig,
  options: InterpolateOptions = {},
): string {
  const extra = options.extraVars ?? {};
  const scope = options.fallbackScope ?? "repo";
  if (!options.omitUnresolvedKeyLines) {
    return interpolateRaw(content, config, extra, scope);
  }
  return content
    .split("\n")
    .map((line) => maybeInterpolateLine(line, config, extra, scope))
    .filter((line): line is string => line !== null)
    .join("\n");
}

function maybeInterpolateLine(
  line: string,
  config: NavoriConfig,
  extra: Record<string, string>,
  scope: FallbackScope,
): string | null {
  // Both groups are mandatory in KEY_LINE_RE, so either the line is a key line
  // and both are present, or there was no match at all.
  const [, key, path] = line.match(KEY_LINE_RE) ?? [];
  if (key !== undefined && path !== undefined) {
    const resolved = resolveSanitized(path, config, extra);
    if (resolved === null) return null;
    return `${key}: ${resolved}`;
  }
  return interpolateRaw(line, config, extra, scope);
}

function interpolateRaw(
  content: string,
  config: NavoriConfig,
  extra: Record<string, string>,
  scope: FallbackScope,
): string {
  return content.replace(PLACEHOLDER_RE, (_match, marker: string | undefined, path: string) => {
    // `{{raw:token}}` — the asset wants the braces as TEXT (#439). Emit them and
    // resolve nothing; this is the one marker that never touches the config.
    if (marker === "raw") return `{{${path}}}`;
    const value = resolveSanitized(path, config, extra);
    // The fallback is prose the reader of the rendered file sees, so it follows
    // the repo's language like the rest of the published copy (#445).
    const resolved =
      value !== null ? value : placeholderFallback(path, resolveLang(config.language), scope);
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
    const value = extra[path];
    // An own key holding `undefined` (only reachable from an untyped caller)
    // serializes to nothing, so it counts as UNRESOLVED like a blank one.
    return value === undefined ? null : nonBlank(value);
  }
  const segments = path.split(".");
  let cursor: unknown = config;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") return null;
    // Own properties only. The segment comes from an asset, so an inherited
    // member must not resolve: `{{constructor}}` would otherwise walk into
    // `Object.prototype`. Nothing leaks today — every reachable member is a
    // function, and the type gate below drops those — but that makes the
    // guarantee incidental, resting on a rule stated far from here (and on
    // `PLACEHOLDER_RE` requiring a leading letter, which is what keeps
    // `__proto__` out). Widening either would quietly reopen the walk, so the
    // rule is stated where it applies (#447).
    if (!Object.hasOwn(cursor, seg)) return null;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor === "string" || typeof cursor === "number" || typeof cursor === "boolean") {
    return nonBlank(String(cursor));
  }
  // Arrays of primitives (legacyPaths, criticalAreas, libraries) serialize to a
  // comma-joined list so template placeholders like `{{project.legacyPaths}}`
  // render the values instead of falling back to empty/`<not configured>`.
  // Arrays holding objects (e.g. libraryMigrations) have no meaningful inline
  // form — return null so the placeholder fallback fires rather than emitting
  // "[object Object]".
  if (Array.isArray(cursor)) {
    if (!cursor.every(isPrimitive)) return null;
    // Blank entries carry no content but do carry a separator: `["", "auth"]`
    // would render ", auth" and `[""]` a lone comma. Drop them first, so the
    // blank rule below sees an all-blank array as the empty value it is.
    const items = cursor.map(String).filter((item) => item.trim() !== "");
    return nonBlank(items.join(", "));
  }
  return null;
}

/**
 * A value that serializes to nothing counts as UNRESOLVED (#375). Emitting ""
 * does not leave a neutral gap: it silently deletes the value from the prose
 * wrapped around it, and the surrounding words keep asserting a value is there.
 * `project.criticalAreas` defaults to `[]`, so every repo that declares no
 * critical areas rendered "· a `` area ·" in the R2-architectural signal list.
 * Returning `null` hands the placeholder to `placeholderFallback`, which has a
 * readable default for the known-optional paths.
 *
 * Covers the empty array, an array whose join is blank (`[""]`) and a
 * blank/whitespace-only string — all indistinguishable in the rendered output.
 */
function nonBlank(value: string): string | null {
  return value.trim() === "" ? null : value;
}

/** True for values that serialize cleanly inline (string/number/boolean). */
function isPrimitive(value: unknown): boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}
