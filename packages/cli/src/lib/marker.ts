import { createHash } from "node:crypto";
import { isDowngrade } from "./semver.ts";
import { tc, SUPPORTED_LANGS, DEFAULT_LANG, type Lang } from "./i18n.ts";

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

/**
 * Build the marker block body. Spec 0003 §3.2.4 — an empty managed section
 * collapses its blank body to save tokens:
 *   - HTML markers carry their own terminator (` -->`) so open and close can
 *     share one line: `<!-- ...start... --><!-- ...end... -->`.
 *   - Shell markers terminate at the line break, so they stay on two lines
 *     (open, then close) — but still drop the empty body line.
 * Non-empty sections keep the canonical `open / content / close` shape.
 */
function buildBlock(
  id: string,
  hash: string,
  meta: MarkerMeta,
  syntax: MarkerSyntax,
  canonicalContent: string,
): string {
  const open = openMarker(id, hash, meta, syntax);
  const close = closeMarker(id, syntax);
  if (canonicalContent === "") {
    return syntax.suffix === "" ? `${open}\n${close}` : `${open}${close}`;
  }
  return `${open}\n${canonicalContent}\n${close}`;
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

/**
 * Locate the managed block with the given id — THE parser of the WRITE path
 * (`injectManagedSection`, `removeManagedSection`, `extractManagedContent`).
 *
 * Code-fence aware via `proseLines`, the same mechanism `locateManagedBlocks`
 * and doctor's `listMarkers` walk. Scanning the raw text instead made render
 * read (and then WRITE) the copy a doc quotes verbatim inside a ```fence```
 * ahead of the real block with that id: when the quoted copy carried a hash
 * consistent with its own body — the normal case, since a doc pastes the block
 * with its `hash=` attribute — the write landed on the documented example and
 * left the real block duplicated (#452). #285 and #432 closed the same
 * discrepancy on the READ path; this is the write half.
 */
function findMarker(existing: string, id: string, style: CommentStyle): MarkerMatch | null {
  const syntax = syntaxFor(style);
  // Matches the entire open marker (attributes in any order). Line-scoped by
  // construction — exec'd against ONE prose line, like `openRegexFor`.
  const openRegex = new RegExp(
    `${escapeRegex(syntax.openPrefix)}\\s+id="${escapeRegex(id)}"${syntax.attrsAndTerminatorPattern}`,
  );
  const close = closeMarker(id, syntax);

  for (const line of proseLines(existing, [style])) {
    const openMatch = openRegex.exec(line.text);
    if (!openMatch || openMatch.index === undefined) continue;
    const openStart = line.offset + openMatch.index;
    const openEnd = openStart + openMatch[0].length;
    const closeStart = existing.indexOf(close, openEnd);
    if (closeStart < 0) continue; // orphan open — left to stripOrphanMarkers

    const contentRaw = existing.slice(openEnd, closeStart);
    // Normalize first (CRLF → LF + trim trailing whitespace), then strip the
    // leading newline that the writer always inserts after the open marker.
    const content = normalize(contentRaw).replace(/^\n/, "");

    return {
      openStart,
      openEnd,
      closeStart,
      closeEnd: closeStart + close.length,
      existingHash: extractAttr(openMatch[0], "hash"),
      existingVersion: extractAttr(openMatch[0], "version"),
      existingSource: extractAttr(openMatch[0], "source"),
      content,
    };
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface InjectResult {
  output: string;
  status: "created" | "updated" | "unchanged" | "user-modified-skipped" | "downgrade-skipped";
  details?: {
    existingHash: string | null;
    actualHash: string;
    newHash: string;
    existingVersion?: string | null;
    existingSource?: string | null;
    /** True when the existing marker declared a version distinct from the
     * one being injected. Useful to surface "update available" in sync. */
    versionDrift?: boolean;
    /** True when the existing marker was written by a STRICTLY NEWER navori
     * than the one injecting (anti-retroceso, issue #79). When set and the
     * caller didn't force, the block is preserved as-is (`downgrade-skipped`)
     * so an older CLI never silently overwrites newer content. */
    downgrade?: boolean;
  };
}

/**
 * Strip orphan open or close markers for a given id from the document.
 * An orphan open marker has no matching close, or vice versa — usually the
 * result of a user editing the file by hand and accidentally deleting one
 * half of a managed block. Left in place they would cause injectManagedSection
 * to append a new block AND leave the orphan, corrupting the document.
 *
 * Code-fence aware via `proseLines` — the same mechanism `findMarker` walks, so
 * a marker QUOTED inside a ```fence``` is documentation and is never stripped
 * out of the user's prose (#452).
 *
 * Returns the cleaned string.
 */
function stripOrphanMarkers(existing: string, id: string, style: CommentStyle): string {
  const syntax = syntaxFor(style);
  const close = closeMarker(id, syntax);
  const openRegex = new RegExp(
    `${escapeRegex(syntax.openPrefix)}\\s+id="${escapeRegex(id)}"${syntax.attrsAndTerminatorPattern}`,
    "g",
  );
  const lines = proseLines(existing, [style]);

  // Pair each PROSE-LEVEL open with the first close that follows it — exactly
  // the pairing `findMarker` performs, so the two can never disagree on which
  // halves are orphans. Closes that belong to a pair need no lookup here:
  // `proseLines` walks past a block's body, so a paired close is not a prose
  // line at all (except in the collapsed empty-block shape, where open and
  // close share one line — hence the explicit `pairedCloses` set).
  const orphanSpans: { index: number; length: number }[] = [];
  const pairedCloses = new Set<number>();
  for (const line of lines) {
    for (const m of line.text.matchAll(openRegex)) {
      if (m.index === undefined) continue;
      const index = line.offset + m.index;
      const closeStart = existing.indexOf(close, index + m[0].length);
      if (closeStart < 0) orphanSpans.push({ index, length: m[0].length });
      else pairedCloses.add(closeStart);
    }
  }

  // Any remaining prose-level close is an orphan. Tracking the SPECIFIC
  // unpaired indices (not just counting them) matters:
  //   - an orphan close in the middle (`open close close-orphan open close`) must
  //     be the one removed, not the last close, which is a valid pair;
  //   - an orphan count of exactly 0 for one half must never be treated as
  //     "strip everything" — the `slice(-0)` trap that destroyed a valid block
  //     when a stray extra close sat below it (#265).
  for (const line of lines) {
    for (let at = line.text.indexOf(close); at >= 0; at = line.text.indexOf(close, at + 1)) {
      const index = line.offset + at;
      if (!pairedCloses.has(index)) orphanSpans.push({ index, length: close.length });
    }
  }

  // Remove every orphan span in a single pass over the ORIGINAL string, highest
  // index first so earlier offsets stay valid.
  if (orphanSpans.length === 0) return existing;

  orphanSpans.sort((a, b) => b.index - a.index);
  let cleaned = existing;
  for (const span of orphanSpans) {
    cleaned = cleaned.slice(0, span.index) + cleaned.slice(span.index + span.length);
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
  /**
   * When true, overwrite the block even if the user edited it (hash mismatch)
   * — i.e. the "accept new" resolution of `sync --interactive`. Default false
   * keeps the safe behavior: a user-modified block is never silently clobbered.
   */
  forceOverwrite = false,
): InjectResult {
  const syntax = syntaxFor(commentStyle);

  // Clean any orphan markers for this id first so a half-deleted block
  // (open without close, or vice versa) doesn't cause us to append a
  // duplicate.
  existing = stripOrphanMarkers(existing, id, commentStyle);

  const newHash = hashContent(newContent);
  const match = findMarker(existing, id, commentStyle);
  const canonicalContent = normalize(newContent);

  if (!match) {
    const details = {
      existingHash: null,
      actualHash: newHash,
      newHash,
      existingVersion: null,
      existingSource: null,
    };
    const block = buildBlock(id, newHash, meta, syntax, canonicalContent);
    // A brand-new block goes right AFTER the last existing managed block (any
    // id), not at the end of the file. Appending at the end would leave user
    // prose written below the managed region permanently interleaved between
    // blocks, blocking reorderManagedBlocks forever (#77). When the last block
    // already sits at the end of the file this produces the same bytes as the
    // plain append below.
    const siblings = locateManagedBlocks(existing, commentStyle);
    if (siblings.length > 0) {
      const last = siblings[siblings.length - 1]!;
      const head = existing.slice(0, last.closeEnd);
      const tailRaw = existing.slice(last.closeEnd);
      const tail = tailRaw.startsWith("\n") ? tailRaw : "\n" + tailRaw;
      return { output: head + "\n\n" + block + tail, status: "created", details };
    }
    const sep =
      existing.length === 0 || existing.endsWith("\n\n")
        ? ""
        : existing.endsWith("\n")
          ? "\n"
          : "\n\n";
    return { output: existing + sep + block + "\n", status: "created", details };
  }

  const actualHash = hashContent(match.content);
  const expectedHash = match.existingHash;
  const userModified = expectedHash !== null && expectedHash !== actualHash;

  const versionDrift =
    match.existingVersion !== null &&
    meta.version !== undefined &&
    match.existingVersion !== meta.version;

  // Anti-retroceso (#79): the block on disk was written by a strictly newer
  // navori. Writing our (older) content/metadata over it would silently
  // downgrade the harness — the exact failure mode a teammate on a stale CLI
  // hits running `update`/`sync`. Detect it here, at the one primitive every
  // managed block flows through, so CLAUDE.md, agents, skills, hooks and
  // scripts are all covered.
  const downgrade = isDowngrade(match.existingVersion, meta.version);

  const details = {
    existingHash: expectedHash,
    actualHash,
    newHash,
    existingVersion: match.existingVersion,
    existingSource: match.existingSource,
    versionDrift,
    downgrade,
  };

  if (canonicalContent === match.content) {
    const sameMeta =
      expectedHash === newHash &&
      match.existingVersion === (meta.version ?? null) &&
      match.existingSource === (meta.source ?? null);
    if (sameMeta) {
      return { output: existing, status: "unchanged", details };
    }
    // Content is identical but metadata differs. On a downgrade, keep the
    // newer marker (don't stamp its version down) so future runs still see
    // "written by a newer navori"; nothing meaningful is lost.
    if (downgrade && !forceOverwrite) {
      return { output: existing, status: "unchanged", details };
    }
    const replaced =
      existing.slice(0, match.openStart) +
      openMarker(id, newHash, meta, syntax) +
      existing.slice(match.openEnd, match.closeEnd) +
      existing.slice(match.closeEnd);
    return { output: replaced, status: "updated", details };
  }

  // Preserve the newer block untouched — the caller surfaces the downgrade.
  if (downgrade && !forceOverwrite) {
    return { output: existing, status: "downgrade-skipped", details };
  }

  if (userModified && !forceOverwrite) {
    return { output: existing, status: "user-modified-skipped", details };
  }

  const block = buildBlock(id, newHash, meta, syntax, canonicalContent);
  const replaced = existing.slice(0, match.openStart) + block + existing.slice(match.closeEnd);
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
  const match = findMarker(existing, id, commentStyle);
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
  const match = findMarker(existing, id, commentStyle);
  return match ? match.content : null;
}

interface LocatedBlock {
  id: string;
  openStart: number;
  closeEnd: number;
}

/** Matches a ```` ``` ```` / `~~~` code-fence delimiter line (Markdown fence). */
const FENCE_LINE_RE = /^\s*(```|~~~)/;

/** Open-marker regex for a syntax: the prefix, the mandatory `id="…"` and the
 *  rest of the marker up to its terminator. Line-scoped by construction — every
 *  caller execs it against ONE line. */
function openRegexFor(syntax: MarkerSyntax): RegExp {
  return new RegExp(
    `${escapeRegex(syntax.openPrefix)}\\s+id="([^"]+)"${syntax.attrsAndTerminatorPattern}`,
  );
}

/** A line that lives at PROSE level: outside every markdown code fence and
 *  outside every managed block's (opaque) body. */
export interface ProseLine {
  /** Line text, without its trailing newline. */
  text: string;
  /** 0-based line number in the original document. */
  index: number;
  /** Character offset of the line's first char within the document. */
  offset: number;
}

/**
 * THE fence mechanism — the single place navori decides whether a line can carry
 * a real managed marker. Every marker scan (here and in `health.ts`) walks this
 * so `doctor` and `render` can never disagree on what a marker is (#285, #432).
 *
 * A line is prose-level when it is neither a fence delimiter, nor inside a
 * ```fenced``` block (a repo whose docs QUOTE navori's own marker syntax is
 * documenting it, not declaring a block), nor inside a managed block's body.
 * Managed content is opaque on purpose: we jump straight past a block's close,
 * so a fence INSIDE managed content (e.g. a skill documenting shell) can never
 * desync the scan and drop a later real block.
 *
 * @param styles marker syntaxes whose blocks count as opaque bodies. Pass the
 *   one style the caller parses; the default covers both.
 */
export function proseLines(
  content: string,
  styles: readonly CommentStyle[] = ["html", "shell"],
): ProseLine[] {
  // The close prefix carries an extra "/" (html) or says "end" (shell), so an
  // open regex never matches a close.
  const opens = styles.map((style) => {
    const syntax = syntaxFor(style);
    return { syntax, re: openRegexFor(syntax) };
  });
  const out: ProseLine[] = [];
  const lines = content.split("\n");
  let offset = 0;
  let inFence = false;
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li]!;
    const lineStart = offset;
    offset += text.length + 1; // +1 for the "\n" split removed
    if (FENCE_LINE_RE.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue; // quoted prose — never a real marker
    out.push({ text, index: li, offset: lineStart });
    // If this line opens a managed block, skip every line through its close.
    let bodyEnd = -1;
    for (const { syntax, re } of opens) {
      const m = re.exec(text);
      if (!m || m.index === undefined) continue;
      const close = closeMarker(m[1]!, syntax);
      const closeStart = content.indexOf(close, lineStart + m.index + m[0].length);
      // No close: an orphan open, not a body — nothing to skip (the line itself
      // was already emitted, so the caller still sees the marker).
      if (closeStart >= 0) bodyEnd = Math.max(bodyEnd, closeStart + close.length);
    }
    while (offset <= bodyEnd && li < lines.length - 1) {
      li++;
      offset += lines[li]!.length + 1;
    }
  }
  return out;
}

/**
 * Enumerate every managed block (any id) in document order, with its bounds.
 *
 * Code-fence aware via `proseLines`: a marker QUOTED inside a ```fenced``` block
 * in the user's prose is NOT a real managed block, so it never becomes the anchor
 * `splitUserSection` slices on (which used to sweep the real user zone into
 * `managed` and inject a duplicate `user-start`, #285).
 */
function locateManagedBlocks(content: string, style: CommentStyle): LocatedBlock[] {
  const syntax = syntaxFor(style);
  const openRegex = openRegexFor(syntax);
  const blocks: LocatedBlock[] = [];
  for (const line of proseLines(content, [style])) {
    const m = openRegex.exec(line.text);
    if (!m || m.index === undefined) continue;
    const id = m[1]!;
    const openStart = line.offset + m.index;
    const close = closeMarker(id, syntax);
    const closeStart = content.indexOf(close, openStart + m[0].length);
    if (closeStart < 0) continue; // orphan open — leave to stripOrphanMarkers
    blocks.push({ id, openStart, closeEnd: closeStart + close.length });
  }
  return blocks;
}

export interface ReorderResult {
  output: string;
  /** True when the block order actually changed. */
  reordered: boolean;
  /** True when reordering was skipped because the user wrote prose between two
   * managed blocks (moving the blocks would orphan it). */
  blockedByInterleaving: boolean;
}

/**
 * Reorder the managed blocks in `content` so their order matches
 * `canonicalOrder` (managed-block ids in canonical emission order).
 *
 * Why: `injectManagedSection` appends a NEW block at the end of an existing
 * file, so a freshly-added block (e.g. a new "centre of gravity" section) lands
 * last instead of in its canonical slot. This pass restores the canonical order
 * — both for newly-appended blocks and for files that drifted out of order
 * (hand edits, a repo onboarded before this existed).
 *
 * Idempotent: returns `content` byte-for-byte when the blocks are already in
 * canonical order, so an already-ordered file produces no spurious diff.
 *
 * Safety — the managed region must be CONTIGUOUS. Content before the first
 * block (a user preamble) and after the last (the user-section / project rules)
 * is preserved verbatim. But if the user wrote prose BETWEEN two managed blocks,
 * reordering would orphan it, so we leave everything untouched and report
 * `blockedByInterleaving` for `doctor` to surface.
 *
 * Ids present in the document but absent from `canonicalOrder` keep their
 * relative order and sort after all known ids (defensive: never drop a block).
 */
export function reorderManagedBlocks(
  content: string,
  canonicalOrder: readonly string[],
  commentStyle: CommentStyle = "html",
): ReorderResult {
  const blocks = locateManagedBlocks(content, commentStyle);
  if (blocks.length < 2) {
    return { output: content, reordered: false, blockedByInterleaving: false };
  }

  const rank = new Map<string, number>();
  canonicalOrder.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const unknownBase = canonicalOrder.length;

  // Stable sort by canonical rank; unknown ids keep document order, after the
  // known ones.
  const desired = blocks
    .map((b, i) => ({ b, i, key: rank.has(b.id) ? rank.get(b.id)! : unknownBase + i }))
    .sort((a, z) => a.key - z.key || a.i - z.i)
    .map((x) => x.b);

  if (desired.every((b, i) => b === blocks[i])) {
    return { output: content, reordered: false, blockedByInterleaving: false };
  }

  // Only whitespace may sit between consecutive blocks, or moving them would
  // orphan user prose.
  for (let i = 0; i < blocks.length - 1; i++) {
    const gap = content.slice(blocks[i]!.closeEnd, blocks[i + 1]!.openStart);
    if (gap.trim() !== "") {
      return { output: content, reordered: false, blockedByInterleaving: true };
    }
  }

  const first = blocks[0]!;
  const last = blocks[blocks.length - 1]!;
  const preamble = content.slice(0, first.openStart);
  const suffix = content.slice(last.closeEnd);
  const body = desired.map((b) => content.slice(b.openStart, b.closeEnd)).join("\n\n");
  const pre = preamble === "" ? "" : preamble.replace(/\n*$/, "\n\n");

  return { output: pre + body + suffix, reordered: true, blockedByInterleaving: false };
}

/**
 * Explicit delimiters for the user-authored zone in CLAUDE.md. Unlike managed
 * blocks, navori NEVER writes content between these — it only guarantees the
 * zone survives verbatim across renders and always sits after the managed
 * region. This replaces the old purely-positional inference (preserve whatever
 * trails the last marker), which lost the domain when a later release added or
 * reordered managed blocks around it (the zone got reubicated/swallowed).
 */
export const USER_SECTION_START = "<!-- navori:user-start -->";
export const USER_SECTION_END = "<!-- navori:user-end -->";

/** Legacy positional hint navori used to emit above the domain; dropped on
 * migration so it isn't duplicated once we wrap the zone in real markers. */
const LEGACY_USER_HINT_RE = /<!--\s*Zona de proyecto \(no-managed\)[\s\S]*?-->/g;

/** The placeholder for a locale — emitted into a fresh CLAUDE.md's user zone. */
function userSectionPlaceholder(lang: Lang): string {
  return tc(lang).common.userSectionPlaceholder;
}

/**
 * All localized placeholders. `extractUserProse` filters ALL of them (not just
 * the active locale) so a repo whose language flipped after its CLAUDE.md was
 * written doesn't preserve the stale placeholder as if it were real user prose.
 */
const USER_SECTION_PLACEHOLDERS: readonly string[] = SUPPORTED_LANGS.map(userSectionPlaceholder);

export interface UserSectionSplit {
  /** Document with the user zone removed — safe to run managed inject/reorder on. */
  managed: string;
  /** The user-authored body (trimmed), or null when there is nothing to preserve. */
  userBody: string | null;
  /** True when explicit user markers were present (even if the body was just the
   * placeholder). Lets the caller re-emit the zone on every render — keeping an
   * already-delimited file byte-for-byte idempotent — without re-adding the zone
   * to a managed repo that never had one. */
  hadMarkers: boolean;
}

/**
 * Strip the structural user-zone tokens from a raw trailing region and return
 * the real prose. Removal is line-oriented AND code-fence aware:
 *   - Only LINES that are exactly a marker / placeholder are removed, so a user
 *     who quotes a marker token as a SUBSTRING inside their own prose keeps it.
 *   - Lines INSIDE a ```fenced``` code block are kept verbatim even when the
 *     whole line is a marker — natural in a repo whose docs describe navori's
 *     own marker system. Without this, a fenced `<!-- navori:user-start -->`
 *     on its own line was silently dropped (#285).
 * The legacy positional hint (a whole HTML comment) is dropped so it isn't
 * duplicated once the zone is wrapped in real markers.
 */
function extractUserProse(raw: string): string {
  const withoutLegacy = normalize(raw).replace(LEGACY_USER_HINT_RE, "");
  let inFence = false;
  return withoutLegacy
    .split("\n")
    .filter((line) => {
      if (FENCE_LINE_RE.test(line)) {
        inFence = !inFence;
        return true; // keep the fence delimiter itself
      }
      if (inFence) return true; // fenced content survives verbatim
      const t = line.trim();
      return (
        t !== USER_SECTION_START && t !== USER_SECTION_END && !USER_SECTION_PLACEHOLDERS.includes(t)
      );
    })
    .join("\n")
    .trim();
}

/**
 * Split a CLAUDE.md into its managed region and the user-authored zone so the
 * render pipeline can operate on the managed region alone and re-emit the user
 * zone verbatim at the end (see `emitUserSection`).
 *
 * The user zone is the prose TRAILING the last managed block — whether wrapped
 * in explicit markers or raw (a repo onboarded before the markers existed, which
 * is auto-migrated). Anchoring on the last managed block means extraction can
 * never swallow a managed block into the user zone (they all precede it), so
 * stray/duplicate/unclosed markers or a hand-moved block never corrupt the
 * managed region: at worst a marker sits between blocks and reorder reports it
 * as interleaving (same as doctor — the two stay consistent).
 *
 * A file with no managed blocks isn't navori-managed yet; the caller owns the
 * coexist/replace decision, so we return it untouched.
 */
export function splitUserSection(
  content: string,
  commentStyle: CommentStyle = "html",
): UserSectionSplit {
  const blocks = locateManagedBlocks(content, commentStyle);
  if (blocks.length === 0) {
    return { managed: content, userBody: null, hadMarkers: content.includes(USER_SECTION_START) };
  }
  const last = blocks[blocks.length - 1]!;
  const managed = content.slice(0, last.closeEnd);
  const trailing = content.slice(last.closeEnd);
  const hadMarkers = trailing.includes(USER_SECTION_START);
  const body = extractUserProse(trailing);
  return { managed, userBody: body === "" ? null : body, hadMarkers };
}

/**
 * Re-emit the managed document with the user zone appended after the last
 * managed block, wrapped in explicit markers so the next render preserves it
 * regardless of block reordering/insertion. Called at the very end of a render.
 * When `userBody` is null, emits the zone with a placeholder hint (used on a
 * fresh CLAUDE.md so the contract is visible from day one). `lang` localizes
 * that placeholder; the claude adapter threads `resolveLang(config.language)`,
 * and it defaults to es so any other call site keeps compiling.
 */
export function emitUserSection(
  managed: string,
  userBody: string | null,
  lang: Lang = DEFAULT_LANG,
): string {
  const base = managed.replace(/\s+$/, "");
  const inner =
    userBody === null || userBody.trim() === "" ? userSectionPlaceholder(lang) : userBody.trim();
  return `${base}\n\n${USER_SECTION_START}\n\n${inner}\n\n${USER_SECTION_END}\n`;
}

/**
 * Resolve a config path like "plugins.engram.enabled" against a config object
 * to a truthy/falsy value. Returns false if any segment is missing.
 */
export function resolveCondition(config: Record<string, unknown>, path: string): boolean {
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
