/**
 * Workspace defaults — the "Workspace" layer of the 5-layer cascade
 * (Core → Preset → Workspace → Project config → Engine adapters).
 *
 * ASYMMETRY, BY DESIGN (#231). This layer is consulted in exactly ONE place:
 * `commands/init.ts`, when a repo is first initialized with `--workspace`. The
 * resolved values (branchBase, prTarget, language, engines, plugins, …) are
 * BAKED into that repo's `navori.config.json` at init time. From then on
 * `render`/`sync`/`update` read only the checked-in config — they never re-open
 * the workspace manifest. So the render-time cascade is 4 layers, while init's
 * is 5.
 *
 * Consequence: changing a workspace's policy (e.g. `navori workspace set-default
 * bonum branchBase=develop`) does NOT propagate to repos already initialized;
 * they keep the value frozen in their config. This is deliberate — the
 * checked-in `navori.config.json` is the single source of truth that travels
 * with the repo and reproduces the harness on any machine (the workspace
 * registry is machine-local and does not travel, see lib/registry.ts). A repo
 * whose config re-derived policy from a machine-local manifest on every render
 * would render differently per machine and per teammate, defeating that
 * guarantee.
 *
 * To adopt a changed workspace policy in an existing repo, edit its config
 * (`navori configure …`) or re-run init. A drift check (config ↔ current
 * workspace defaults) belongs in `doctor`, not here — tracked as a follow-up so
 * the divergence is at least *reported* even though it is never auto-applied.
 */
import { WorkspaceDefaultsSchema, type WorkspaceDefaults } from "./workspace.ts";

export interface ApplyDefaultResult {
  ok: boolean;
  defaults?: WorkspaceDefaults;
  error?: string;
}

/** Human-readable list of accepted keys, reused in error messages and help. */
export const VALID_DEFAULT_KEYS =
  "branchBase, prTarget, commits, language, engines, plugins.<id>.enabled";

function parseBool(value: string): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * Apply a single `key=value` default onto a workspace defaults object.
 *
 * Pure and side-effect free: returns a new, Zod-validated defaults object on
 * success, or an error message on failure. Callers persist the result via
 * writeWorkspace(), which re-validates the whole manifest.
 *
 * Supported keys: branchBase, prTarget, commits, language, engines
 * (comma-separated), and plugins.<id>.enabled (true|false).
 */
export function applyDefault(
  current: WorkspaceDefaults,
  key: string,
  rawValue: string,
): ApplyDefaultResult {
  const next: Record<string, unknown> = { ...current };

  const pluginMatch = key.match(/^plugins\.([a-z0-9][a-z0-9-]*)\.enabled$/);
  if (pluginMatch) {
    const id = pluginMatch[1]!;
    const enabled = parseBool(rawValue);
    if (enabled === null) {
      return {
        ok: false,
        error: `Value for '${key}' must be 'true' or 'false', got '${rawValue}'.`,
      };
    }
    next.plugins = { ...(current.plugins ?? {}), [id]: { enabled } };
  } else if (key === "engines") {
    // Comma-separated list, e.g. "claude,cursor". Trims and drops empties.
    next.engines = rawValue
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (
    key === "branchBase" ||
    key === "prTarget" ||
    key === "commits" ||
    key === "language"
  ) {
    next[key] = rawValue;
  } else {
    return { ok: false, error: `Unknown default key '${key}'. Valid keys: ${VALID_DEFAULT_KEYS}.` };
  }

  // Let Zod enforce enum/shape constraints so we never duplicate them here.
  const parsed = WorkspaceDefaultsSchema.safeParse(next);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Invalid value for '${key}': ${detail}` };
  }
  return { ok: true, defaults: parsed.data };
}
