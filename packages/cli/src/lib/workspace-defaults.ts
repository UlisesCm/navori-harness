import { WorkspaceDefaultsSchema, type WorkspaceDefaults } from "./workspace.ts";

export interface ApplyDefaultResult {
  ok: boolean;
  defaults?: WorkspaceDefaults;
  error?: string;
}

/** Human-readable list of accepted keys, reused in error messages and help. */
export const VALID_DEFAULT_KEYS = "branchBase, commits, language, engines, plugins.<id>.enabled";

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
 * Supported keys: branchBase, commits, language, engines (comma-separated),
 * and plugins.<id>.enabled (true|false).
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
      return { ok: false, error: `Value for '${key}' must be 'true' or 'false', got '${rawValue}'.` };
    }
    next.plugins = { ...(current.plugins ?? {}), [id]: { enabled } };
  } else if (key === "engines") {
    // Comma-separated list, e.g. "claude,cursor". Trims and drops empties.
    next.engines = rawValue
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (key === "branchBase" || key === "commits" || key === "language") {
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
