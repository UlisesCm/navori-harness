import type { NavoriConfig } from "./config.ts";

export type MonorepoWorkspace = NonNullable<
  NonNullable<NavoriConfig["monorepo"]>["workspaces"]
>[number];

/**
 * Monorepo facts a workspace render needs to describe its place in the tree.
 * Built by `buildMonorepoContext` from the root `config.monorepo`; the root
 * render reads `config.monorepo` directly instead.
 */
export interface MonorepoRenderContext {
  /** Monorepo tool (turbo/pnpm/…), for the scoped-task hint. */
  tool?: string;
  /** Current workspace's package name. */
  currentName: string;
  /** Current workspace's path relative to the repo root (POSIX). */
  currentPath: string;
  /** The other workspaces, for the "siblings" list. */
  siblings: Array<{ name: string; path: string; preset?: string }>;
}

/**
 * Build the monorepo context handed to a workspace render: the current app's
 * name/path + the other workspaces (siblings), so the workspace's "## Monorepo"
 * block can situate itself in the tree. Shared by `render` and `sync` so both
 * emit the same block (otherwise sync strips what render wrote).
 */
export function buildMonorepoContext(
  config: NavoriConfig,
  current: MonorepoWorkspace,
): MonorepoRenderContext {
  const all = config.monorepo?.workspaces ?? [];
  return {
    tool: config.monorepo?.tool,
    currentName: current.name,
    currentPath: current.path,
    siblings: all
      .filter((w) => w.path !== current.path)
      .map((w) => ({ name: w.name, path: w.path, preset: w.preset })),
  };
}

/**
 * Build the effective NavoriConfig for a single monorepo workspace.
 *
 * The workspace inherits every field from the root config and may only
 * override the fields declared on `MonorepoWorkspaceSchema`:
 *   - `preset`            → swaps the preset name used in template interpolation
 *   - `qualityGate`       → swaps the qg commands → drives the pre-commit hook
 *   - `libraries`         → scopes library skills to the workspace's own deps
 *   - `libraryMigrations` → scopes migration rules to the workspace's own deps
 *
 * Library skills + migrations are ALWAYS scoped to the workspace, never
 * inherited from the root: in a monorepo the root carries only root-level libs
 * (not an aggregate of every app's), so an absent per-workspace list means "this
 * app ships none" — inheriting the root's would re-introduce the cross-app spray
 * this scoping exists to prevent. `update`/`scan` re-home libs onto the
 * workspaces, so a legacy config's aggregated root list is migrated, not lost.
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
  const project = { ...(merged.project ?? {}) } as NonNullable<NavoriConfig["project"]>;
  project.libraries = workspace.libraries ?? [];
  project.libraryMigrations = workspace.libraryMigrations ?? [];
  merged.project = project;
  return merged;
}
