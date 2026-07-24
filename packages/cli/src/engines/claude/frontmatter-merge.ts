/**
 * Merge the frontmatter of an asset (authoritative for its keys) with the
 * frontmatter currently in the destination file (which may carry user
 * additions). v1 rule (DT confirmed): the asset wins for any key it
 * declares; the destination keeps keys the asset does NOT declare.
 *
 * Returns both the merged object and its serialized form so the caller
 * can plug it back into the destination file without an extra pass.
 */

export interface MergeFrontmatterResult {
  merged: Record<string, string>;
  serialized: string;
}

export function mergeFrontmatter(
  assetFm: Record<string, string>,
  destFm: Record<string, string>,
): MergeFrontmatterResult {
  const merged: Record<string, string> = { ...destFm };
  for (const key of Object.keys(assetFm)) {
    merged[key] = assetFm[key];
  }
  return {
    merged,
    serialized: serialize(merged, assetFm),
  };
}

/**
 * Stable order: asset keys first (in their declared order), then the
 * leftover keys from the destination. Keeps the output predictable for
 * snapshot tests and reduces churn in diffs across renders.
 */
function serialize(merged: Record<string, string>, assetFm: Record<string, string>): string {
  const assetKeys = Object.keys(assetFm);
  const extras = Object.keys(merged).filter((k) => !assetKeys.includes(k));
  const ordered = [...assetKeys, ...extras];
  const lines = ordered.map((k) => `${k}: ${merged[k]}`);
  return ["---", ...lines, "---"].join("\n");
}
