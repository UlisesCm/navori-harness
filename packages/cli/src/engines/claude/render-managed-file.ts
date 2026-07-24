import { readFileSync } from "node:fs";
import type { NavoriConfig } from "../../lib/config.ts";
import {
  injectManagedSection,
  type CommentStyle,
  type InjectResult,
} from "../../lib/marker.ts";
import { parseAsset } from "./parse-asset.ts";
import { interpolate, interpolateFrontmatterBlock } from "./interpolate.ts";
import { mergeFrontmatter } from "./frontmatter-merge.ts";
import { parseFrontmatterBlocks, type ParsedFrontmatterBlocks } from "../../lib/frontmatter.ts";

/**
 * Render one bundled asset against the current destination file. Pure-ish:
 * reads the asset from disk but does NOT write the destination — returns
 * the final content for the caller to write atomically (or skip in dry-run).
 *
 * Flow:
 *   1. Load + parse asset (frontmatter / managedBody / userTemplate).
 *   2. Interpolate frontmatter at block granularity so a missing
 *      `{{models.X}}` drops the WHOLE key block (key line + continuations)
 *      instead of breaking YAML or leaving orphaned continuation lines.
 *   3. Interpolate managedBody and userTemplate in default mode (unresolved
 *      placeholders surface as `<not configured: x>` so the user can see them).
 *   4a. First render (destination doesn't exist): assemble
 *       frontmatter + injectManagedSection("", ...) + userTemplate.
 *   4b. Re-render: split destination into frontmatter + rest, merge
 *       frontmatter (asset wins), inject managed section into rest. Status
 *       comes from injectManagedSection (created / updated / unchanged /
 *       user-modified-skipped).
 */

export interface RenderManagedFileInput {
  /** Absolute path to the source asset (used to read + infer commentStyle).
   * Ignored for reading when `rawContent` is supplied (features synthesize the
   * SKILL.md source from the manifest + FEATURE.md in memory), but still used
   * for commentStyle inference. */
  assetPath: string;
  /** Pre-composed source content. When set, skips reading `assetPath` from disk
   * and renders this string as the asset instead. */
  rawContent?: string;
  /** Current content of the destination, or null if it doesn't exist. */
  existingContent: string | null;
  /** Managed-section id (e.g. "leader-base"). */
  managedId: string;
  /** Open-marker metadata (source package + version). */
  meta: { source: string; version: string };
  config: NavoriConfig;
  extraVars?: Record<string, string>;
  /** Override comment style. Defaults: `.sh` → shell, anything else → html. */
  commentStyle?: CommentStyle;
}

export interface RenderManagedFileResult {
  content: string;
  status: InjectResult["status"];
  details?: InjectResult["details"];
}

export function renderManagedFile(input: RenderManagedFileInput): RenderManagedFileResult {
  const commentStyle = input.commentStyle ?? inferCommentStyle(input.assetPath);
  const raw = input.rawContent ?? readFileSync(input.assetPath, "utf-8");
  const asset = parseAsset(raw, commentStyle);

  const interpolatedFm = interpolateFrontmatter(asset.frontmatterText, input.config, input.extraVars);
  const interpolatedBody = interpolate(asset.managedBody, input.config, {
    extraVars: input.extraVars,
  });
  const interpolatedUserTpl = asset.userTemplate
    ? interpolate(asset.userTemplate, input.config, { extraVars: input.extraVars })
    : null;

  if (input.existingContent === null) {
    return assembleFresh(
      interpolatedFm,
      interpolatedBody,
      interpolatedUserTpl,
      input.managedId,
      input.meta,
      commentStyle,
    );
  }

  return rerender(
    input.existingContent,
    interpolatedFm,
    interpolatedBody,
    input.managedId,
    input.meta,
    commentStyle,
  );
}

function inferCommentStyle(path: string): CommentStyle {
  return path.endsWith(".sh") ? "shell" : "html";
}

/**
 * Interpolate the asset's RAW frontmatter text at BLOCK granularity: parse
 * the verbatim text into per-key blocks FIRST (key line + any indented
 * continuation lines), then interpolate each block as a unit via
 * `interpolateFrontmatterBlock`. A `key: {{x}}` block with x unresolved is
 * dropped ENTIRELY — key line and continuations together — instead of
 * breaking YAML with a broken value. Parsing into blocks before
 * interpolating (rather than interpolating line-by-line and parsing after)
 * is what keeps a dropped key's continuation lines from surviving as
 * orphans that `parseFrontmatterBlocks` would otherwise reattach to the
 * previous key. Working on the verbatim per-block text — not a
 * re-serialized flat map — is also what makes the round-trip an identity
 * for any shape the flat map can't represent (folded `>` scalars, nested
 * maps, tab indentation): an unmodified key's raw block is re-emitted
 * byte-for-byte at serialization time.
 */
function interpolateFrontmatter(
  fmText: string,
  config: NavoriConfig,
  extraVars: Record<string, string> | undefined,
): ParsedFrontmatterBlocks {
  if (fmText.trim() === "") return { values: {}, raws: {} };
  const blocks = parseFrontmatterBlocks(fmText);
  const survivingRaws: string[] = [];
  for (const key of Object.keys(blocks.raws)) {
    const interpolated = interpolateFrontmatterBlock(blocks.raws[key]!, config, extraVars ?? {});
    if (interpolated !== null) survivingRaws.push(interpolated);
  }
  return parseFrontmatterBlocks(survivingRaws.join("\n"));
}

function assembleFresh(
  fm: ParsedFrontmatterBlocks,
  body: string,
  userTpl: string | null,
  managedId: string,
  meta: { source: string; version: string },
  commentStyle: CommentStyle,
): RenderManagedFileResult {
  const inject = injectManagedSection("", managedId, body, meta, commentStyle);
  const fmBlock = Object.keys(fm.raws).length > 0
    ? serializeFrontmatter(fm.raws) + "\n\n"
    : "";
  const userTail = userTpl ? "\n" + userTpl.trimEnd() + "\n" : "";
  const content = fmBlock + inject.output.trimEnd() + "\n" + userTail;
  return { content, status: "created", details: inject.details };
}

function rerender(
  existing: string,
  assetFm: ParsedFrontmatterBlocks,
  body: string,
  managedId: string,
  meta: { source: string; version: string },
  commentStyle: CommentStyle,
): RenderManagedFileResult {
  const fmMatch = existing.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  let destFm: ParsedFrontmatterBlocks = { values: {}, raws: {} };
  let restOfDest: string;
  if (fmMatch) {
    destFm = parseFrontmatterBlocks(fmMatch[1]);
    restOfDest = fmMatch[2];
  } else {
    restOfDest = existing;
  }

  const fmHeader = Object.keys(assetFm.values).length > 0
    ? mergeFrontmatter(assetFm.values, destFm.values, { assetRaws: assetFm.raws, destRaws: destFm.raws }).serialized +
      "\n"
    : "";

  const inject = injectManagedSection(restOfDest, managedId, body, meta, commentStyle);
  const content = fmHeader + inject.output;

  // If injection said "unchanged" AND the frontmatter didn't shift, the
  // overall content is byte-identical to existing. When only the frontmatter
  // shifted (asset-wins merge, e.g. a feature description change) the managed
  // body is untouched but the file still needs a write — report "updated", or
  // the caller would treat the render as a noop and drop the change.
  const status: InjectResult["status"] =
    inject.status === "unchanged" ? (content === existing ? "unchanged" : "updated") : inject.status;

  return { content, status, details: inject.details };
}

/** Assemble the fence block from verbatim per-key raw blocks (identity
 * round-trip — no value re-synthesis; see ParsedFrontmatterBlocks). */
function serializeFrontmatter(raws: Record<string, string>): string {
  return ["---", ...Object.values(raws), "---"].join("\n");
}
