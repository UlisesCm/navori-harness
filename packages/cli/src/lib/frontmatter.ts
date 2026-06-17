/**
 * Single source for YAML-frontmatter splitting and field reads.
 *
 * Three call sites each carried their own `^---\n...---\n` regex — issue #11:
 * parse-asset.ts (full asset parse), the engine's local stripFrontmatter, and
 * skill-meta.ts. This module is the shared implementation they delegate to.
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
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
  return { frontmatter: m[1]!, body: raw.slice(m[0].length) };
}

/** Parse simple `key: value` lines into a record (last write wins). */
export function parseFrontmatterFields(frontmatter: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const kv = line.match(FIELD_RE);
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return out;
}

/** Read a single frontmatter field, or null when absent. */
export function getFrontmatterField(frontmatter: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = frontmatter.match(new RegExp(`^${escaped}:\\s*(.*)$`, "m"));
  return line ? line[1]!.trim() : null;
}

/** Strip the frontmatter and return the trimmed body. */
export function stripFrontmatter(raw: string): string {
  return splitFrontmatter(raw).body.trim();
}
