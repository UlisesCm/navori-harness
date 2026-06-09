import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";

const ManagedEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
});

const ExternalToolSchema = z.object({
  name: z.string().min(1),
  checkCommand: z.string().optional(),
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
 * Known plugins shipped with navori-ai. Each entry maps a plugin id to its
 * npm package name. The CLI uses createRequire to resolve the package
 * regardless of whether we are in dev (workspace) or installed via npm.
 */
export const KNOWN_PLUGINS: Record<string, string> = {
  engram: "@navori/plugin-engram",
};

const require = createRequire(import.meta.url);

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
  return Object.keys(KNOWN_PLUGINS);
}

/**
 * Load a plugin by id. Throws PluginNotFoundError if id is unknown, or
 * PluginManifestError if plugin.json is malformed.
 */
export function loadPlugin(pluginId: string): LoadedPlugin {
  const packageName = KNOWN_PLUGINS[pluginId];
  if (!packageName) throw new PluginNotFoundError(pluginId);

  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve(`${packageName}/package.json`);
  } catch {
    throw new PluginManifestError(
      `Plugin package '${packageName}' not installed. Run 'pnpm install' or 'npm i'.`,
    );
  }

  const packageRoot = dirname(packageJsonPath);
  const manifestPath = resolve(packageRoot, "plugin.json");

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
  const managedAssets = manifest.managed.map((entry) => ({
    id: entry.id,
    absPath: resolve(packageRoot, entry.file),
  }));

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
