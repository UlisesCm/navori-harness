import type { NavoriConfig } from "./config.ts";

export type MonorepoWorkspace = NonNullable<
  NonNullable<NavoriConfig["monorepo"]>["workspaces"]
>[number];

/**
 * Build the effective NavoriConfig for a single monorepo workspace.
 *
 * The workspace inherits every field from the root config and may only
 * override the two fields declared on `MonorepoWorkspaceSchema`:
 *   - `preset`     → swaps the preset name used in template interpolation
 *   - `qualityGate`→ swaps the qg commands → drives the pre-commit hook
 *
 * `monorepo` itself is stripped from the effective config so a nested
 * render never tries to recurse on its parent (the engine reads
 * `config.monorepo` only at the root level).
 */
export function effectiveConfigForWorkspace(
  root: NavoriConfig,
  workspace: MonorepoWorkspace,
): NavoriConfig {
  const { monorepo: _monorepo, ...rest } = root;
  const merged: NavoriConfig = { ...rest };
  if (workspace.preset !== undefined) {
    merged.preset = workspace.preset;
  }
  if (workspace.qualityGate !== undefined) {
    merged.qualityGate = workspace.qualityGate;
  }
  return merged;
}
