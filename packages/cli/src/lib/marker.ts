import { createHash } from "node:crypto";

const MARKER_OPEN_PREFIX = "<!-- navori:managed";
const MARKER_CLOSE_PREFIX = "<!-- /navori:managed";
const MARKER_SUFFIX = "-->";

/** Normalize content for hashing and storage: drop trailing whitespace/newlines. */
function normalize(content: string): string {
  return content.replace(/\s+$/, "");
}

function hashContent(content: string): string {
  return createHash("sha1").update(normalize(content), "utf-8").digest("hex").slice(0, 8);
}

function openMarker(id: string, hash: string): string {
  return `${MARKER_OPEN_PREFIX} id="${id}" hash="${hash}" ${MARKER_SUFFIX}`;
}

function closeMarker(id: string): string {
  return `${MARKER_CLOSE_PREFIX} id="${id}" ${MARKER_SUFFIX}`;
}

interface MarkerMatch {
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
  existingHash: string | null;
  content: string;
}

function findMarker(existing: string, id: string): MarkerMatch | null {
  const openRegex = new RegExp(
    `${escapeRegex(MARKER_OPEN_PREFIX)}\\s+id="${escapeRegex(id)}"(?:\\s+hash="([a-f0-9]+)")?\\s*${escapeRegex(MARKER_SUFFIX)}`,
  );
  const openMatch = openRegex.exec(existing);
  if (!openMatch) return null;

  const close = closeMarker(id);
  const closeStart = existing.indexOf(close, openMatch.index + openMatch[0].length);
  if (closeStart < 0) return null;

  const openEnd = openMatch.index + openMatch[0].length;
  const contentRaw = existing.slice(openEnd, closeStart);
  // strip leading \n (we always write one) and any trailing whitespace
  const content = normalize(contentRaw.replace(/^\n/, ""));

  return {
    openStart: openMatch.index,
    openEnd,
    closeStart,
    closeEnd: closeStart + close.length,
    existingHash: openMatch[1] ?? null,
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
  };
}

/**
 * Inject or update a managed block with the given id.
 *
 * Behavior matches DESIGN §14.5:
 * - if no marker exists → append at end of file
 * - if marker exists and content matches expected hash → replace
 * - if user modified content (hash mismatch) AND new content equals current → only update hash
 * - if user modified content AND new content differs → SKIP (returns user-modified-skipped)
 *   The caller decides whether to prompt for conflict resolution.
 */
export function injectManagedSection(
  existing: string,
  id: string,
  newContent: string,
): InjectResult {
  const newHash = hashContent(newContent);
  const match = findMarker(existing, id);

  const canonicalContent = normalize(newContent);

  if (!match) {
    // First adoption: append at end
    const sep = existing.length === 0 || existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
        ? "\n"
        : "\n\n";
    const block = `${openMarker(id, newHash)}\n${canonicalContent}\n${closeMarker(id)}\n`;
    return {
      output: existing + sep + block,
      status: "created",
      details: { existingHash: null, actualHash: newHash, newHash },
    };
  }

  const actualHash = hashContent(match.content);
  const expectedHash = match.existingHash;
  const userModified = expectedHash !== null && expectedHash !== actualHash;

  if (canonicalContent === match.content) {
    if (expectedHash === newHash) {
      // Already in sync
      return {
        output: existing,
        status: "unchanged",
        details: { existingHash: expectedHash, actualHash, newHash },
      };
    }
    // Same content but hash drifted (or first time we add a hash) — refresh marker hash only
    const replaced =
      existing.slice(0, match.openStart) +
      openMarker(id, newHash) +
      existing.slice(match.openEnd, match.closeEnd);
    return {
      output: replaced,
      status: "updated",
      details: { existingHash: expectedHash, actualHash, newHash },
    };
  }

  if (userModified) {
    // Conflict: user changed content + new content differs from theirs
    return {
      output: existing,
      status: "user-modified-skipped",
      details: { existingHash: expectedHash, actualHash, newHash },
    };
  }

  // Normal update: content matches old hash (or never had hash) → replace silently
  const block = `${openMarker(id, newHash)}\n${canonicalContent}\n${closeMarker(id)}`;
  const replaced =
    existing.slice(0, match.openStart) + block + existing.slice(match.closeEnd);
  return {
    output: replaced,
    status: "updated",
    details: { existingHash: expectedHash, actualHash, newHash },
  };
}

/**
 * Remove a managed block by id. No-op if the block doesn't exist.
 */
export function removeManagedSection(existing: string, id: string): string {
  const match = findMarker(existing, id);
  if (!match) return existing;
  // Drop the block + the trailing newline if present (avoid double-blank lines)
  let endCut = match.closeEnd;
  if (existing[endCut] === "\n") endCut++;
  return existing.slice(0, match.openStart) + existing.slice(endCut);
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
