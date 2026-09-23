/**
 * Single source for YAML-frontmatter splitting and field reads.
 *
 * Three call sites each carried their own `^---\n...---\n` regex — issue #11:
 * parse-asset.ts (full asset parse), the engine's local stripFrontmatter, and
 * skill-meta.ts. This module is the shared implementation they delegate to.
 */

// CRLF-tolerant (`\r?\n`): a file saved on Windows must strip the same as LF.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
// A real frontmatter block has at least one `key:`-shaped line. Requiring it
// stops a document that OPENS with a horizontal-rule `---` (no frontmatter) from
// having its first `---…---` section swallowed as if it were metadata.
const FM_KEY_LINE = /^[ \t]*[A-Za-z_][A-Za-z0-9_.-]*:/m;
/**
 * #662 — the key charset must match `FM_KEY_LINE` above, which has always
 * admitted `.` and `-`. It did not: this extractor stopped at `[A-Za-z0-9_]`,
 * so a HYPHENATED key was detected as frontmatter and then dropped on the way
 * out. The keys that shape belongs to are the host's own — Claude Code
 * documents `disable-model-invocation` and `user-invocable` as skill
 * frontmatter — so a user adding one to a rendered skill lost it on the next
 * `render --apply`, silently.
 *
 * The drop was double-masked until now: the status collapse in `rerender`
 * meant a frontmatter-only change was never written at all, so the loss rarely
 * reached disk. Fixing propagation opened the window, which is why this lands
 * with it.
 */
const FIELD_RE = /^([a-zA-Z_][a-zA-Z0-9_.-]*):\s*(.*)$/;

export interface SplitResult {
  /** Raw YAML text between the `---` fences (empty string when none). */
  frontmatter: string;
  /** Everything after the closing fence (the whole input when no fence). */
  body: string;
}

/** Separate the frontmatter block from the body. */
export function splitFrontmatter(raw: string): SplitResult {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: "", body: raw };
  // Guard: only treat the fenced block as frontmatter when it actually carries a
  // `key:` line — otherwise a leading horizontal rule (`---\nsome prose\n---`)
  // would be mistaken for metadata and eaten from the body.
  if (!FM_KEY_LINE.test(m[1]!)) return { frontmatter: "", body: raw };
  return { frontmatter: m[1]!, body: raw.slice(m[0].length) };
}

/**
 * Parse `key: value` lines into a record (last write wins). Splitting on
 * `\r?\n` keeps a trailing CR off each line so CRLF-saved files parse.
 *
 * A key with NO inline value (e.g. `metadata:`) absorbs every following
 * INDENTED line as part of its value, verbatim, prefixed with a leading `\n`
 * — that is the one nested shape navori's own frontmatter needs (the host's
 * `metadata:` map, #810), and it is what lets a block-style map survive this
 * flat `Record<string, string>` model instead of being silently dropped: the
 * nested lines never matched `FIELD_RE` on their own (they don't start a line
 * with a bare key), so without this they were invisible to every reader and
 * every re-serialize.
 *
 * The leading `\n` is deliberate, not decorative: an inline scalar's value
 * (`kv[2]!.trim()`) can never start with one, so it is what tells
 * `formatFrontmatterField` a value came from a block even when that block has
 * exactly ONE line — `metadata:\n  type: reference` must not collapse into
 * `metadata:   type: reference` on the next render just because there was
 * nothing to distinguish it from a plain inline value once joined.
 */
export function parseFrontmatterFields(frontmatter: string): Record<string, string> {
  const out: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentLines: string[] = [];
  let currentIsBlock = false;

  const flush = (): void => {
    if (currentKey === null) return;
    const joined = currentLines.join("\n");
    out[currentKey] = currentIsBlock ? `\n${joined}` : joined;
  };

  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(FIELD_RE);
    if (kv) {
      flush();
      currentKey = kv[1]!;
      const inline = kv[2]!.trim();
      currentIsBlock = inline === "";
      currentLines = currentIsBlock ? [] : [inline];
    } else if (currentKey !== null && /^[ \t]/.test(line)) {
      currentLines.push(line);
    }
    // A blank/comment/unindented line outside any key's block is decoration
    // (or a horizontal rule) — not part of any field, so it's dropped rather
    // than misfiled onto whichever key came before it.
  }
  flush();
  return out;
}

/** Read a single frontmatter field, or null when absent. The value capture stops
 * at the line's CR/LF so a CRLF frontmatter reads the same as LF (`.trim()`
 * cleans any residual whitespace). For a key with a nested block value (see
 * `parseFrontmatterFields`), this returns only the inline part — empty string
 * for `metadata:` — since a single line is exactly what a caller asking for
 * "the value on this line" wants; the full block reads through
 * `parseFrontmatterFields` instead. */
export function getFrontmatterField(frontmatter: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = frontmatter.match(new RegExp(`^${escaped}:[ \\t]*([^\\r\\n]*)`, "m"));
  return line ? line[1]!.trim() : null;
}

/**
 * Serialize one `key: value` frontmatter line, the counterpart to
 * `parseFrontmatterFields`'s block-value read: a value that starts with `\n`
 * (a nested map, e.g. `metadata` — see the leading-`\n` marker documented
 * there) is written as `key:` followed by its lines verbatim, never squashed
 * onto one line with the key.
 */
export function formatFrontmatterField(key: string, value: string): string {
  return value.startsWith("\n") ? `${key}:${value}` : `${key}: ${value}`;
}

/** Strip the frontmatter and return the trimmed body. */
export function stripFrontmatter(raw: string): string {
  return splitFrontmatter(raw).body.trim();
}

/**
 * Read a scalar out of a nested map field, e.g. `metadata:` followed by
 * indented `key: value` lines — the shape navori's own skill fields
 * (`type`/`maxWords`/`maxWordsComposed`) use under the host's `metadata` map
 * (#810). Plain string ops rather than a `fieldKey`-derived `new RegExp`
 * (flagged by `detect-non-literal-regexp`, rightly — a caller-supplied key
 * reaching the regex engine unescaped is exactly that shape) — the block has
 * few, flat entries, so a split-and-compare is just as simple.
 *
 * Returns null when the map key is absent or the field isn't inside it.
 */
export function getFrontmatterMapField(
  frontmatter: string,
  mapKey: string,
  fieldKey: string,
): string | null {
  const block = parseFrontmatterFields(frontmatter)[mapKey];
  if (block === undefined) return null;
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    if (trimmed.slice(0, colon).trim() === fieldKey) return trimmed.slice(colon + 1).trim();
  }
  return null;
}

/**
 * Drop one top-level frontmatter field (and its nested block, if it has one),
 * leaving every other field, order, and the body untouched.
 *
 * #823: a field can be real for one rendering surface and meaningless for
 * another — Claude Code's `disable-model-invocation` has no bearing on the
 * Codex render, which expresses the same intent through a sidecar file
 * instead. Rebuilding via `parseFrontmatterFields`/`formatFrontmatterField`
 * (rather than a line-skip regex) reuses the same block-aware parse the rest
 * of this module already trusts, so a multi-line value under the dropped key
 * can never leave orphaned indented lines behind.
 *
 * Returns `raw` unchanged when there is no frontmatter or the key is absent —
 * the common case, so a caller can call this unconditionally per render.
 */
export function removeFrontmatterField(raw: string, key: string): string {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === "") return raw;
  const fields = parseFrontmatterFields(frontmatter);
  if (!(key in fields)) return raw;
  const rebuilt = Object.entries(fields)
    .filter(([k]) => k !== key)
    .map(([k, v]) => formatFrontmatterField(k, v))
    .join("\n");
  return `---\n${rebuilt}\n---\n${body}`;
}
