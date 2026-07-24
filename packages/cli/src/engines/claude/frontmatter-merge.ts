/**
 * Merge the frontmatter of an asset (authoritative for its keys) with the
 * frontmatter currently in the destination file (which may carry user
 * additions). v1 rule (DT confirmed): the asset wins for any key it
 * declares; the destination keeps keys the asset does NOT declare.
 *
 * Returns both the merged object and its serialized form so the caller
 * can plug it back into the destination file without an extra pass.
 *
 * Serialization prefers each key's VERBATIM raw block when the caller
 * supplies them (`opts.assetRaws` for asset-owned keys, `opts.destRaws` for
 * dest-only extras) — the raw-line-preservation contract that keeps YAML
 * shapes a flat map can't re-synthesize (folded `>` scalars, nested maps)
 * byte-identical across renders. Only a key with no raw block available
 * falls back to `frontmatterLine` (single-line synthesis).
 */

import { frontmatterLine } from "../../lib/frontmatter.ts";

export interface MergeFrontmatterResult {
  merged: Record<string, string>;
  serialized: string;
}

export interface MergeFrontmatterRaws {
  /** Verbatim raw block per asset key (asset wins → asset raw wins). */
  assetRaws?: Record<string, string>;
  /** Verbatim raw block per destination key (used for dest-only extras). */
  destRaws?: Record<string, string>;
}

export function mergeFrontmatter(
  assetFm: Record<string, string>,
  destFm: Record<string, string>,
  opts: MergeFrontmatterRaws = {},
): MergeFrontmatterResult {
  const merged: Record<string, string> = { ...destFm };
  for (const key of Object.keys(assetFm)) {
    merged[key] = assetFm[key];
  }
  return {
    merged,
    serialized: serialize(merged, assetFm, opts),
  };
}

/**
 * Stable order: asset keys first (in their declared order), then the
 * leftover keys from the destination. Keeps the output predictable for
 * snapshot tests and reduces churn in diffs across renders.
 */
function serialize(
  merged: Record<string, string>,
  assetFm: Record<string, string>,
  opts: MergeFrontmatterRaws,
): string {
  const assetKeys = Object.keys(assetFm);
  const extras = Object.keys(merged).filter((k) => !assetKeys.includes(k));
  const lines = [
    ...assetKeys.map((k) => opts.assetRaws?.[k] ?? frontmatterLine(k, merged[k]!)),
    ...extras.map((k) => opts.destRaws?.[k] ?? frontmatterLine(k, merged[k]!)),
  ];
  return ["---", ...lines, "---"].join("\n");
}
