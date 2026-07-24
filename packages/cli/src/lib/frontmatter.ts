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
const FIELD_RE = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/;

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
 * A frontmatter parsed per top-level key into TWO views of the same lines:
 *
 *   values — flat `key → value` (single-line value, or the continuation lines
 *            newline-joined for a nested/multi-line key). What interpolation
 *            and merge COMPARISONS read.
 *   raws   — `key → verbatim source block`: the `key: …` line plus every
 *            continuation line, byte-for-byte. What serialization re-emits.
 *
 * Raw preservation is the whole point: an unmodified key's block round-trips
 * as identity BY CONSTRUCTION, so YAML shapes a line-based value heuristic
 * can't reconstruct — folded/literal block scalars (`description: >` — the
 * bare `>` must stay on the key line), nested maps, tab indentation, blank
 * lines inside a block — all survive untouched. Only keys a caller actually
 * synthesizes/overwrites go through `frontmatterLine`.
 */
export interface ParsedFrontmatterBlocks {
  values: Record<string, string>;
  raws: Record<string, string>;
}

/** Parse frontmatter into per-key blocks (see ParsedFrontmatterBlocks).
 *
 * Line rules, in order:
 *   - `key: value` at column 0 starts a new block (last write wins per key).
 *   - An INDENTED line (spaces or tabs) attaches to the current key's block —
 *     nested map entries, block-scalar lines, even `key: value`-shaped lines
 *     (FIELD_RE is column-0 anchored, so they can never become top-level).
 *   - A BLANK line attaches only when a later line continues the same block
 *     (blank paragraph break inside a folded scalar); a trailing blank before
 *     the next key or EOF does not.
 *   - Anything else at column 0 (comments, stray text like a bare `>` left by
 *     a pre-raw-preservation serializer) is ignored, same as always. */
export function parseFrontmatterBlocks(frontmatter: string): ParsedFrontmatterBlocks {
  const values: Record<string, string> = {};
  const raws: Record<string, string> = {};
  const lines = frontmatter.split(/\r?\n/);
  let lastKey: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kv = line.match(FIELD_RE);
    if (kv) {
      lastKey = kv[1]!;
      values[lastKey] = kv[2]!.trim();
      raws[lastKey] = line;
      continue;
    }
    if (lastKey === null) continue;
    const indented = /^[ \t]+\S/.test(line);
    const blankInsideBlock = /^[ \t]*$/.test(line) && nextNonBlankIsIndented(lines, i + 1);
    if (indented || blankInsideBlock) {
      raws[lastKey] += `\n${line}`;
      values[lastKey] = values[lastKey] ? `${values[lastKey]}\n${line}` : line;
    }
  }
  return { values, raws };
}

/** Whether the next non-blank line (if any) is indented — i.e. a blank line
 * at the current position sits INSIDE a continuation block, not after it. */
function nextNonBlankIsIndented(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    if (/^[ \t]*$/.test(lines[i]!)) continue;
    return /^[ \t]/.test(lines[i]!);
  }
  return false;
}

/** Parse simple `key: value` lines into a record (last write wins) — the flat
 * `values` view of `parseFrontmatterBlocks` (see it for the line rules).
 * Splitting on `\r?\n` keeps a trailing CR off each line so CRLF-saved files
 * parse. */
export function parseFrontmatterFields(frontmatter: string): Record<string, string> {
  return parseFrontmatterBlocks(frontmatter).values;
}

/** Read a single frontmatter field, or null when absent. The value capture stops
 * at the line's CR/LF so a CRLF frontmatter reads the same as LF (`.trim()`
 * cleans any residual whitespace). */
export function getFrontmatterField(frontmatter: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = frontmatter.match(new RegExp(`^${escaped}:[ \\t]*([^\\r\\n]*)`, "m"));
  return line ? line[1]!.trim() : null;
}

/** Strip the frontmatter and return the trimmed body. */
export function stripFrontmatter(raw: string): string {
  return splitFrontmatter(raw).body.trim();
}

/** One frontmatter line for a key/value pair, the write-side counterpart of
 * `parseFrontmatterFields`' nested-block capture. A value captured with an
 * embedded newline (e.g. `metadata:` → `"  author: x\n  version: y"`) is a
 * raw, already-indented multi-line block — emit it as-is under its own
 * `key:` line rather than collapsing it onto one line. Shared by every
 * frontmatter write path (render-managed-file.ts's fresh/rerender assembly,
 * frontmatter-merge.ts's asset-wins merge) so nesting round-trips the same
 * way everywhere. */
export function frontmatterLine(key: string, value: string): string {
  return value.includes("\n") ? `${key}:\n${value}` : `${key}: ${value}`;
}
