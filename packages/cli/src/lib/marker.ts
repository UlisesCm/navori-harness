import { createHash } from "node:crypto";

/**
 * Managed-section markers. Two syntaxes are supported:
 *   - `"html"` (default, back-compat): `<!-- navori:managed id="..." ... -->`
 *     used for Markdown files (CLAUDE.md, agents/*.md, skills/*.md).
 *   - `"shell"`: `# navori:managed start id="..." ...` / `# navori:managed end id="..."`
 *     used for shell scripts under `.claude/hooks/` and `.claude/scripts/`.
 *
 * The terminator differs between styles (HTML closes with `-->`, shell ends
 * at the line break) so the regex and emitted suffix are syntax-specific.
 * Everything else (hash, attribute order, content normalization, conflict
 * detection, orphan cleanup) is shared.
 */
export type CommentStyle = "html" | "shell";

interface MarkerSyntax {
  openPrefix: string;
  closePrefix: string;
  /** Suffix appended to the marker line (HTML: ` -->`, shell: empty). */
  suffix: string;
  /** Raw regex pattern that matches whatever comes after `id="..."` up to and
   * including the terminator. HTML: `[^>]*-->`, shell: `[^\n]*`. */
  attrsAndTerminatorPattern: string;
}

const HTML_SYNTAX: MarkerSyntax = {
  openPrefix: "<!-- navori:managed",
  closePrefix: "<!-- /navori:managed",
  suffix: " -->",
  attrsAndTerminatorPattern: `[^>]*-->`,
};

const SHELL_SYNTAX: MarkerSyntax = {
  openPrefix: "# navori:managed start",
  closePrefix: "# navori:managed end",
  suffix: "",
  attrsAndTerminatorPattern: `[^\\n]*`,
};

function syntaxFor(style: CommentStyle): MarkerSyntax {
  return style === "shell" ? SHELL_SYNTAX : HTML_SYNTAX;
}

/** Normalize content for hashing and storage:
 * - Convert CRLF / CR to LF so files written on Windows or repos with
 *   .gitattributes that normalize to CRLF don't produce phantom conflicts.
 * - Drop trailing whitespace/newlines. */
function normalize(content: string): string {
  return content.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

function hashContent(content: string): string {
  return createHash("sha1").update(normalize(content), "utf-8").digest("hex").slice(0, 8);
}

/**
 * Public helper for callers (doctor, sync) that have a managed block's body
 * and want to know the canonical hash to compare against the `hash=` attr
 * on the marker. Same algorithm injectManagedSection uses; same CRLF/LF
 * and trailing-whitespace normalization.
 */
export function computeManagedHash(body: string): string {
  return hashContent(body);
}

export interface MarkerMeta {
  /** Source package id (e.g. "@navori/core", "@navori/plugin-engram"). */
  source?: string;
  /** Version of the source package that wrote this block. */
  version?: string;
}

function openMarker(id: string, hash: string, meta: MarkerMeta, syntax: MarkerSyntax): string {
  const parts = [`${syntax.openPrefix} id="${id}"`, `hash="${hash}"`];
  if (meta.version) parts.push(`version="${meta.version}"`);
  if (meta.source) parts.push(`source="${meta.source}"`);
  return parts.join(" ") + syntax.suffix;
}

function closeMarker(id: string, syntax: MarkerSyntax): string {
  return `${syntax.closePrefix} id="${id}"${syntax.suffix}`;
}

interface MarkerMatch {
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
  existingHash: string | null;
  existingVersion: string | null;
  existingSource: string | null;
  content: string;
}

function extractAttr(open: string, name: string): string | null {
  const m = open.match(new RegExp(`${name}="([^"]+)"`));
  return m?.[1] ?? null;
}

function findMarker(existing: string, id: string, syntax: MarkerSyntax): MarkerMatch | null {
  // Match the entire open marker (attributes in any order)
  const openRegex = new RegExp(
    `${escapeRegex(syntax.openPrefix)}\\s+id="${escapeRegex(id)}"${syntax.attrsAndTerminatorPattern}`,
  );
  const openMatch = openRegex.exec(existing);
  if (!openMatch) return null;

  const close = closeMarker(id, syntax);
  const closeStart = existing.indexOf(close, openMatch.index + openMatch[0].length);
  if (closeStart < 0) return null;

  const openEnd = openMatch.index + openMatch[0].length;
  const contentRaw = existing.slice(openEnd, closeStart);
  // Normalize first (CRLF → LF + trim trailing whitespace), then strip the
  // leading newline that the writer always inserts after the open marker.
  const content = normalize(contentRaw).replace(/^\n/, "");

  return {
    openStart: openMatch.index,
    openEnd,
    closeStart,
    closeEnd: closeStart + close.length,
    existingHash: extractAttr(openMatch[0], "hash"),
    existingVersion: extractAttr(openMatch[0], "version"),
    existingSource: extractAttr(openMatch[0], "source"),
    content,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface InjectResult {
  output: string;
  status: "created" | "updated" | "unchanged" | "user-modified-skipped";
  details?: {
    existingHash: string | null;
    actualHash: string;
    newHash: string;
    existingVersion?: string | null;
    existingSource?: string | null;
    /** True when the existing marker declared a version distinct from the
     * one being injected. Useful to surface "update available" in sync. */
    versionDrift?: boolean;
  };
}

/**
 * Strip orphan open or close markers for a given id from the document.
 * An orphan open marker has no matching close, or vice versa — usually the
 * result of a user editing the file by hand and accidentally deleting one
 * half of a managed block. Left in place they would cause injectManagedSection
 * to append a new block AND leave the orphan, corrupting the document.
 *
 * Returns the cleaned string.
 */
function stripOrphanMarkers(existing: string, id: string, syntax: MarkerSyntax): string {
  const close = closeMarker(id, syntax);
  // Find every open and close marker for this id
  const openRegex = new RegExp(
    `${escapeRegex(syntax.openPrefix)}\\s+id="${escapeRegex(id)}"${syntax.attrsAndTerminatorPattern}`,
    "g",
  );
  const opens: number[] = [];
  for (const m of existing.matchAll(openRegex)) {
    if (m.index !== undefined) opens.push(m.index);
  }
  const closes: number[] = [];
  let from = 0;
  for (;;) {
    const idx = existing.indexOf(close, from);
    if (idx < 0) break;
    closes.push(idx);
    from = idx + close.length;
  }

  // The "good" pairs are the first N open/close pairs in document order that
  // are actually matching (open before close). The rest are orphans.
  let cleaned = existing;
  let pairedOpens = 0;
  let pairedCloses = 0;
  let oi = 0;
  let ci = 0;
  while (oi < opens.length && ci < closes.length) {
    if (closes[ci]! > opens[oi]!) {
      pairedOpens++;
      pairedCloses++;
      oi++;
      ci++;
    } else {
      // close before any open — definitely orphan
      ci++;
    }
  }

  const orphanOpens = opens.length - pairedOpens;
  const orphanCloses = closes.length - pairedCloses;
  if (orphanOpens === 0 && orphanCloses === 0) return existing;

  // Strip excess closes from the end, then excess opens from the end.
  // Working backwards keeps earlier indices valid.
  const allCloses = [...closes].reverse();
  for (let i = 0; i < orphanCloses; i++) {
    const idx = allCloses[i]!;
    cleaned = cleaned.slice(0, idx) + cleaned.slice(idx + close.length);
  }
  // Recompute opens against the cleaned string because closes removal may
  // have shifted them. The number of opens hasn't changed (we didn't touch
  // any), but their indices may differ if removed close was before them.
  // For simplicity: re-find opens in the cleaned string.
  const openMatchesAfter = [...cleaned.matchAll(openRegex)].map((m) => m.index ?? -1).filter((i) => i >= 0);
  const opensToStrip = openMatchesAfter.slice(-orphanOpens);
  for (let i = opensToStrip.length - 1; i >= 0; i--) {
    const idx = opensToStrip[i]!;
    // Find the full open marker length
    openRegex.lastIndex = 0;
    const matchHere = openRegex.exec(cleaned.slice(idx));
    const len = matchHere?.[0]?.length ?? 0;
    if (len > 0) cleaned = cleaned.slice(0, idx) + cleaned.slice(idx + len);
  }

  // Collapse triple newlines that may result from marker removal
  return cleaned.replace(/\n{3,}/g, "\n\n");
}

/**
 * Inject or update a managed block with the given id.
 *
 * Behavior:
 * - if no marker exists → append at end of file
 * - if marker exists and content matches expected hash → replace
 * - if user modified content (hash mismatch) AND new content equals current → only update hash
 * - if user modified content AND new content differs → SKIP (returns user-modified-skipped)
 *   The caller decides whether to prompt for conflict resolution.
 *
 * @param commentStyle "html" (default — Markdown/HTML files) or "shell"
 *   (shell scripts under `.claude/hooks/` and `.claude/scripts/`).
 */
export function injectManagedSection(
  existing: string,
  id: string,
  newContent: string,
  meta: MarkerMeta = {},
  commentStyle: CommentStyle = "html",
): InjectResult {
  const syntax = syntaxFor(commentStyle);

  // Clean any orphan markers for this id first so a half-deleted block
  // (open without close, or vice versa) doesn't cause us to append a
  // duplicate.
  existing = stripOrphanMarkers(existing, id, syntax);

  const newHash = hashContent(newContent);
  const match = findMarker(existing, id, syntax);
  const canonicalContent = normalize(newContent);

  if (!match) {
    const sep = existing.length === 0 || existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
        ? "\n"
        : "\n\n";
    const block = `${openMarker(id, newHash, meta, syntax)}\n${canonicalContent}\n${closeMarker(id, syntax)}\n`;
    return {
      output: existing + sep + block,
      status: "created",
      details: {
        existingHash: null,
        actualHash: newHash,
        newHash,
        existingVersion: null,
        existingSource: null,
      },
    };
  }

  const actualHash = hashContent(match.content);
  const expectedHash = match.existingHash;
  const userModified = expectedHash !== null && expectedHash !== actualHash;

  const versionDrift =
    match.existingVersion !== null &&
    meta.version !== undefined &&
    match.existingVersion !== meta.version;

  const details = {
    existingHash: expectedHash,
    actualHash,
    newHash,
    existingVersion: match.existingVersion,
    existingSource: match.existingSource,
    versionDrift,
  };

  if (canonicalContent === match.content) {
    const sameMeta =
      expectedHash === newHash &&
      match.existingVersion === (meta.version ?? null) &&
      match.existingSource === (meta.source ?? null);
    if (sameMeta) {
      return { output: existing, status: "unchanged", details };
    }
    const replaced =
      existing.slice(0, match.openStart) +
      openMarker(id, newHash, meta, syntax) +
      existing.slice(match.openEnd, match.closeEnd);
    return { output: replaced, status: "updated", details };
  }

  if (userModified) {
    return { output: existing, status: "user-modified-skipped", details };
  }

  const block = `${openMarker(id, newHash, meta, syntax)}\n${canonicalContent}\n${closeMarker(id, syntax)}`;
  const replaced =
    existing.slice(0, match.openStart) + block + existing.slice(match.closeEnd);
  return { output: replaced, status: "updated", details };
}

/**
 * Remove a managed block by id. No-op if the block doesn't exist.
 */
export function removeManagedSection(
  existing: string,
  id: string,
  commentStyle: CommentStyle = "html",
): string {
  const syntax = syntaxFor(commentStyle);
  const match = findMarker(existing, id, syntax);
  if (!match) return existing;
  // Drop the block + the trailing newline if present (avoid double-blank lines)
  let endCut = match.closeEnd;
  if (existing[endCut] === "\n") endCut++;
  return existing.slice(0, match.openStart) + existing.slice(endCut);
}

/**
 * Extract the current managed content for an id, if it exists.
 * Returns null when the marker is not present.
 */
export function extractManagedContent(
  existing: string,
  id: string,
  commentStyle: CommentStyle = "html",
): string | null {
  const syntax = syntaxFor(commentStyle);
  const match = findMarker(existing, id, syntax);
  return match ? match.content : null;
}

/**
 * Resolve a config path like "plugins.engram.enabled" against a config object
 * to a truthy/falsy value. Returns false if any segment is missing.
 */
export function resolveCondition(
  config: Record<string, unknown>,
  path: string,
): boolean {
  const segments = path.split(".");
  let cursor: unknown = config;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return Boolean(cursor);
}
