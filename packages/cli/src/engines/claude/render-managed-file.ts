import { readFileSync } from "node:fs";
import type { NavoriConfig } from "../../lib/config.ts";
import {
  injectManagedSection,
  type CommentStyle,
  type InjectResult,
} from "../../lib/marker.ts";
import { parseAsset } from "./parse-asset.ts";
import { interpolate } from "./interpolate.ts";
import { mergeFrontmatter } from "./frontmatter-merge.ts";

/**
 * Render one bundled asset against the current destination file. Pure-ish:
 * reads the asset from disk but does NOT write the destination — returns
 * the final content for the caller to write atomically (or skip in dry-run).
 *
 * Flow:
 *   1. Load + parse asset (frontmatter / managedBody / userTemplate).
 *   2. Interpolate frontmatter with `omitUnresolvedKeyLines` so missing
 *      `{{models.X}}` drops the line instead of breaking YAML.
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

  const interpolatedFmObj = interpolateFrontmatter(asset.frontmatter, input.config, input.extraVars);
  const interpolatedBody = interpolate(asset.managedBody, input.config, {
    extraVars: input.extraVars,
  });
  const interpolatedUserTpl = asset.userTemplate
    ? interpolate(asset.userTemplate, input.config, { extraVars: input.extraVars })
    : null;

  if (input.existingContent === null) {
    return assembleFresh(
      interpolatedFmObj,
      interpolatedBody,
      interpolatedUserTpl,
      input.managedId,
      input.meta,
      commentStyle,
    );
  }

  return rerender(
    input.existingContent,
    interpolatedFmObj,
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
 * Interpolate the asset frontmatter with omitUnresolvedKeyLines and parse
 * the result back into a map. We serialize → interpolate → parse so the
 * `omitUnresolvedKeyLines` rule (which operates on string lines) can fire.
 */
function interpolateFrontmatter(
  fm: Record<string, string>,
  config: NavoriConfig,
  extraVars: Record<string, string> | undefined,
): Record<string, string> {
  if (Object.keys(fm).length === 0) return {};
  const serialized = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  const interp = interpolate(serialized, config, { extraVars, omitUnresolvedKeyLines: true });
  const out: Record<string, string> = {};
  for (const line of interp.split("\n")) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function assembleFresh(
  fm: Record<string, string>,
  body: string,
  userTpl: string | null,
  managedId: string,
  meta: { source: string; version: string },
  commentStyle: CommentStyle,
): RenderManagedFileResult {
  const inject = injectManagedSection("", managedId, body, meta, commentStyle);
  const fmBlock = Object.keys(fm).length > 0
    ? serializeFrontmatter(fm) + "\n\n"
    : "";
  const userTail = userTpl ? "\n" + userTpl.trimEnd() + "\n" : "";
  const content = fmBlock + inject.output.trimEnd() + "\n" + userTail;
  return { content, status: "created", details: inject.details };
}

function rerender(
  existing: string,
  assetFm: Record<string, string>,
  body: string,
  managedId: string,
  meta: { source: string; version: string },
  commentStyle: CommentStyle,
): RenderManagedFileResult {
  const fmMatch = existing.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const destFm: Record<string, string> = {};
  let restOfDest: string;
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
      if (kv) destFm[kv[1]] = kv[2].trim();
    }
    restOfDest = fmMatch[2];
  } else {
    restOfDest = existing;
  }

  const fmHeader = Object.keys(assetFm).length > 0
    ? mergeFrontmatter(assetFm, destFm).serialized + "\n"
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

function serializeFrontmatter(fm: Record<string, string>): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return ["---", ...lines, "---"].join("\n");
}
