import { readFileSync, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { bundledPluginManifestPath, getPluginPath, listBundledPluginIds } from "./bundled-assets.ts";

const AGENT_ROLES = [
  "leader",
  "implementer",
  "reviewer",
  "researcher",
  "ticket-audit",
  "commit-pr-pilot",
  "explorer",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

const ManagedEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  /** Agent that the plugin recommends for this skill/protocol. */
  recommendedAgent: z.enum(AGENT_ROLES).optional(),
});

const ExternalToolSchema = z.object({
  name: z.string().min(1),
  /** Binary name to look up in PATH. Safer than checkCommand because it
   * never spawns a shell — we walk PATH directories manually. */
  checkBinary: z.string().regex(/^[a-zA-Z0-9_\-.]+$/, "binary name must be alphanumeric").optional(),
  install: z.record(z.string(), z.string()).optional(),
  postInstall: z.string().optional(),
});

const PluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "plugin id must be kebab-case"),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  managed: z.array(ManagedEntrySchema).default([]),
  externalTool: ExternalToolSchema.optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginManagedEntry = z.infer<typeof ManagedEntrySchema>;
export type PluginExternalTool = z.infer<typeof ExternalToolSchema>;

/** Resolved manifest with its package root and computed asset paths. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Absolute path to the plugin package root (where plugin.json lives). */
  packageRoot: string;
  /** Resolved absolute paths for each managed entry. */
  managedAssets: Array<{ id: string; absPath: string }>;
}

/**
 * Known plugins shipped with navori. Each entry maps a plugin id to its
 * npm package name. The CLI uses createRequire to resolve the package
 * regardless of whether we are in dev (workspace) or installed via npm.
 */
export const KNOWN_PLUGINS: Record<string, string> = {
  engram: "@navori/plugin-engram",
  acli: "@navori/plugin-acli",
  gh: "@navori/plugin-gh",
  jscpd: "@navori/plugin-jscpd",
  semgrep: "@navori/plugin-semgrep",
  cognitive: "@navori/plugin-cognitive",
};

export class PluginNotFoundError extends Error {
  readonly pluginId: string;
  constructor(pluginId: string) {
    super(`Unknown plugin: '${pluginId}'`);
    this.name = "PluginNotFoundError";
    this.pluginId = pluginId;
  }
}

export class PluginManifestError extends Error {
  readonly issues?: z.ZodIssue[];
  constructor(message: string, issues?: z.ZodIssue[]) {
    super(message);
    this.name = "PluginManifestError";
    this.issues = issues;
  }
}

export function listKnownPluginIds(): string[] {
  // Bundled assets win when present (published CLI); fall back to the static map.
  const bundled = listBundledPluginIds();
  return bundled.length > 0 ? bundled : Object.keys(KNOWN_PLUGINS);
}

/**
 * Load a plugin by id. Throws PluginNotFoundError if id is unknown, or
 * PluginManifestError if plugin.json is malformed.
 *
 * Resolution: first try bundled assets in dist/assets/plugins/<id>/; if not
 * present (dev mode without build), fall back to the workspace package root.
 */
export function loadPlugin(pluginId: string): LoadedPlugin {
  if (!KNOWN_PLUGINS[pluginId] && !listBundledPluginIds().includes(pluginId)) {
    throw new PluginNotFoundError(pluginId);
  }

  const packageRoot = getPluginPath(pluginId);
  const manifestPath = bundledPluginManifestPath(pluginId);

  if (!existsSync(manifestPath)) {
    throw new PluginManifestError(`plugin.json not found at ${manifestPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    throw new PluginManifestError(`Invalid JSON in ${manifestPath}: ${(err as Error).message}`);
  }

  const result = PluginManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new PluginManifestError(`Invalid plugin manifest in ${manifestPath}`, result.error.issues);
  }

  const manifest = result.data;
  // Containment check: a malicious or buggy plugin.json could declare
  // 'file: "../../../etc/passwd"'. Reject anything that escapes the
  // package root, so plugin content can never read arbitrary files.
  const rootPrefix = packageRoot.endsWith(sep) ? packageRoot : packageRoot + sep;
  const managedAssets = manifest.managed.map((entry) => {
    const absPath = resolve(packageRoot, entry.file);
    if (absPath !== packageRoot && !absPath.startsWith(rootPrefix)) {
      throw new PluginManifestError(
        `Plugin '${pluginId}' declared managed.file '${entry.file}' that resolves outside the package root.`,
      );
    }
    return { id: entry.id, absPath };
  });

  return { manifest, packageRoot, managedAssets };
}

/**
 * Load all plugins that are enabled in the config (plugins[id].enabled === true).
 * Skips entries whose package is not installed (returns them in `missing` for doctor to report).
 */
export interface PluginsLoadResult {
  loaded: LoadedPlugin[];
  missing: Array<{ id: string; reason: string }>;
}

export function loadEnabledPlugins(
  pluginsConfig: Record<string, { enabled: boolean }> | undefined,
): PluginsLoadResult {
  const enabled = Object.entries(pluginsConfig ?? {})
    .filter(([, v]) => v.enabled === true)
    .map(([k]) => k);

  const loaded: LoadedPlugin[] = [];
  const missing: Array<{ id: string; reason: string }> = [];

  for (const id of enabled) {
    try {
      loaded.push(loadPlugin(id));
    } catch (err) {
      if (err instanceof PluginNotFoundError) {
        missing.push({ id, reason: "unknown plugin id" });
      } else if (err instanceof PluginManifestError) {
        missing.push({ id, reason: err.message });
      } else {
        throw err;
      }
    }
  }

  return { loaded, missing };
}
