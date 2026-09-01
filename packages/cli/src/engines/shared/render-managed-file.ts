import { readFileSync } from "node:fs";
import type { NavoriConfig } from "../../lib/config.ts";
import { injectManagedSection, type CommentStyle, type InjectResult } from "../../lib/marker.ts";
import { parseAsset } from "../claude/parse-asset.ts";
import { interpolate } from "../../lib/interpolate.ts";
import type { FallbackScope } from "../../lib/placeholders.ts";
import { expandHookIncludes } from "../../lib/hook-includes.ts";
import { mergeFrontmatter } from "../claude/frontmatter-merge.ts";

/**
 * Render one bundled asset against the current destination file. Pure-ish:
 * reads the asset from disk but does NOT write the destination — returns
 * the final content for the caller to write atomically (or skip in dry-run).
 *
 * Flow:
 *   1. Load asset, expand includes, apply the engine `transform` (if any),
 *      then parse it (frontmatter / managedBody / userTemplate).
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
  /** Absolute path to the source asset (used to read + infer commentStyle). */
  assetPath: string;
  /** Current content of the destination, or null if it doesn't exist. */
  existingContent: string | null;
  /** Managed-section id (e.g. "leader-base"). */
  managedId: string;
  /** Open-marker metadata (source package + version). */
  meta: { source: string; version: string };
  config: NavoriConfig;
  extraVars?: Record<string, string>;
  /**
   * Which scope answers an unresolved placeholder (Spec 0010 FB). The global
   * plugin render passes `global` so `{{qualityGate.*}}`, `{{branchBase}}` and
   * `{{prTarget}}` become the instruction to DERIVE them instead of a
   * `<not configured: …>` hint. Defaults to `repo`.
   */
  fallbackScope?: FallbackScope;
  /** Override comment style. Defaults: `.sh` → shell, anything else → html. */
  commentStyle?: CommentStyle;
  /**
   * Engine-specific rewrite applied to the whole asset text right after the
   * includes are expanded and BEFORE it is parsed — so frontmatter, managed
   * body and user template come out adapted from a single pass (#364).
   */
  transform?: (text: string) => string;
}

export interface RenderManagedFileResult {
  content: string;
  status: InjectResult["status"];
  details?: InjectResult["details"];
}

export function renderManagedFile(input: RenderManagedFileInput): RenderManagedFileResult {
  const commentStyle = input.commentStyle ?? inferCommentStyle(input.assetPath);
  // Inline any `# navori:include` shell partials before parsing/interpolating,
  // so a hook's shared boilerplate is a single source of truth yet the rendered
  // file stays fully standalone. No-op for assets without a directive.
  const expanded = expandHookIncludes(readFileSync(input.assetPath, "utf-8"));
  const raw = input.transform ? input.transform(expanded) : expanded;
  const asset = parseAsset(raw, commentStyle);

  const scope = input.fallbackScope;
  const interpolatedFmObj = interpolateFrontmatter(
    asset.frontmatter,
    input.config,
    input.extraVars,
    scope,
  );
  const interpolatedBody = interpolate(asset.managedBody, input.config, {
    extraVars: input.extraVars,
    fallbackScope: scope,
  });
  const interpolatedUserTpl = asset.userTemplate
    ? interpolate(asset.userTemplate, input.config, {
        extraVars: input.extraVars,
        fallbackScope: scope,
      })
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
  fallbackScope: FallbackScope | undefined,
): Record<string, string> {
  if (Object.keys(fm).length === 0) return {};
  const serialized = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const interp = interpolate(serialized, config, {
    extraVars,
    omitUnresolvedKeyLines: true,
    fallbackScope,
  });
  return parseKeyValueLines(interp);
}

const KEY_VALUE_LINE = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/;

/**
 * Parse `key: value` lines into a map; lines that don't match are dropped.
 * Shared by the asset-frontmatter and destination-frontmatter passes, which
 * parse the same shape.
 */
function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    // Both groups are mandatory in the pattern, so the guard only ever fires
    // on a non-matching line — it just also satisfies the index-access type.
    const [, key, value] = KEY_VALUE_LINE.exec(line) ?? [];
    if (key === undefined || value === undefined) continue;
    out[key] = value.trim();
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
  const fmBlock = Object.keys(fm).length > 0 ? serializeFrontmatter(fm) + "\n\n" : "";
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
  // Both groups are mandatory: when the file has frontmatter, `fmBlock` and
  // `afterFm` are both strings (`afterFm` may legitimately be ""), and when it
  // doesn't, both are undefined and the whole file is the body.
  const [, fmBlock, afterFm] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(existing) ?? [];
  const destFm = fmBlock === undefined ? {} : parseKeyValueLines(fmBlock);
  const restOfDest = afterFm ?? existing;

  const fmHeader =
    Object.keys(assetFm).length > 0 ? mergeFrontmatter(assetFm, destFm).serialized + "\n" : "";

  const inject = injectManagedSection(restOfDest, managedId, body, meta, commentStyle);
  const content = fmHeader + inject.output;

  // If injection said "unchanged" AND the frontmatter didn't shift, the
  // overall content is byte-identical to existing.
  const status: InjectResult["status"] =
    inject.status === "unchanged" && content === existing ? "unchanged" : inject.status;

  return { content, status, details: inject.details };
}

function serializeFrontmatter(fm: Record<string, string>): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return ["---", ...lines, "---"].join("\n");
}
