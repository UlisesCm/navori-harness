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
  const merged: Record<string, string> = { ...destFm, ...assetFm };
  // `tools:` is the one key with a THIRD writer. The asset owns the native
  // list, but a plugin GRANTS its MCP server by appending `mcp__<id>__*` to
  // the rendered file (`withAgentMcpTools`) — the asset never carries those,
  // on purpose: the grant is derived per-repo from which plugins are enabled.
  // Plain asset-wins therefore strips the grant on every re-render, and the
  // plugin pass re-adds it: an infinite updated/updated churn (surfaced when
  // the rerender status collapse was fixed for spec 0020 — before that, the
  // strip was computed and silently thrown away). Asset wins for the native
  // list; dest-only `mcp__*` entries survive.
  if (assetFm.tools !== undefined && destFm.tools !== undefined) {
    const assetList = assetFm.tools.split(",").map((t) => t.trim());
    const grants = destFm.tools
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.startsWith("mcp__") && !assetList.includes(t));
    if (grants.length > 0) merged.tools = [...assetList, ...grants].join(", ");
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
