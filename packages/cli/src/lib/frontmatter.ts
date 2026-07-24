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

/** Parse simple `key: value` lines into a record (last write wins). Splitting on
 * `\r?\n` keeps a trailing CR off each line so CRLF-saved files parse. */
export function parseFrontmatterFields(frontmatter: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(FIELD_RE);
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return out;
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
