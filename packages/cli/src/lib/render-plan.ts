import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { injectManagedSection, removeManagedSection, resolveCondition, type InjectResult } from "./marker.ts";
import { loadPlugin, PluginNotFoundError, PluginManifestError } from "./plugins.ts";
import { getCoreRoot, readBundledCoreVersion } from "./bundled-assets.ts";
import type { NavoriConfig } from "./config.ts";

export const CORE_SOURCE_ID = "@navori/core" as const;

export type AssetLanguage = "es" | "en";

export interface CoreManagedAsset {
  id: string;
  relPath: string;
  condition?: string;
  availableLanguages?: readonly AssetLanguage[];
}

export const CORE_MANAGED_ASSETS: readonly CoreManagedAsset[] = [
  { id: "idioma-rol", relPath: "core-assets/managed/idioma-rol.md", availableLanguages: ["es"] },
  { id: "formato-respuesta", relPath: "core-assets/managed/formato-respuesta.md", availableLanguages: ["es"] },
  { id: "tipado-fuerte", relPath: "core-assets/managed/tipado-fuerte.md", availableLanguages: ["es"] },
  { id: "cierre-sesion", relPath: "core-assets/managed/cierre-sesion.md", availableLanguages: ["es"] },
] as const;

const CORE_VERSION = readBundledCoreVersion();

function resolveAssetPath(asset: CoreManagedAsset, language: AssetLanguage = "es"): { path: string; fallback: boolean } {
  const root = getCoreRoot();
  if (language === "es") {
    return { path: resolve(root, asset.relPath), fallback: false };
  }
  const langPath = asset.relPath.replace(/^core-assets\/managed\//, `core-assets/managed/${language}/`);
  const abs = resolve(root, langPath);
  if (existsSync(abs)) return { path: abs, fallback: false };
  return { path: resolve(root, asset.relPath), fallback: true };
}

export type AssetStatus =
  | InjectResult["status"]
  | "removed-condition-false";

export interface AssetPlanEntry {
  asset: CoreManagedAsset;
  /** "core" or the plugin id this asset comes from. */
  source: "core" | string;
  status: AssetStatus;
  details?: InjectResult["details"];
  /** New content from disk (or null when condition is falsy). */
  newContent: string | null;
}

export interface UpdateAvailable {
  id: string;
  source: string;
  fromVersion: string;
  toVersion: string;
}

export interface RenderPlan {
  existing: string;
  next: string;
  changed: boolean;
  entries: AssetPlanEntry[];
  /** Plugins declared as enabled in the config but missing on disk. */
  missingPlugins: Array<{ id: string; reason: string }>;
  /** Assets that fell back to Spanish because the requested language is not available. */
  languageFallbacks: string[];
  /** Markers whose existing version is older than the source package's current
   * version. Listed regardless of whether the content changed. */
  updatesAvailable: UpdateAvailable[];
}

/**
 * Compute the next content of the target file by walking CORE_MANAGED_ASSETS
 * + the managed entries declared by enabled plugins.
 *
 * Pure: does NOT touch disk for writing. Reads asset files from @navori/core
 * and from each plugin's package root.
 */
export function computeRenderPlan(existing: string, config: NavoriConfig): RenderPlan {
  let working = existing;
  const entries: AssetPlanEntry[] = [];
  const languageFallbacks: string[] = [];
  const updatesAvailable: UpdateAvailable[] = [];
  const configRecord = config as unknown as Record<string, unknown>;
  const language = config.language;

  // 1) Core assets
  for (const asset of CORE_MANAGED_ASSETS) {
    if (asset.condition) {
      const truthy = resolveCondition(configRecord, asset.condition);
      if (!truthy) {
        const before = working;
        working = removeManagedSection(working, asset.id);
        entries.push({
          asset,
          source: "core",
          status: before === working ? "unchanged" : "removed-condition-false",
          newContent: null,
        });
        continue;
      }
    }
    const resolved = resolveAssetPath(asset, language);
    if (resolved.fallback) languageFallbacks.push(asset.id);
    const content = readFileSync(resolved.path, "utf-8");
    const result = injectManagedSection(working, asset.id, content, {
      source: CORE_SOURCE_ID,
      version: CORE_VERSION,
    });
    if (result.details?.versionDrift && result.details.existingVersion) {
      updatesAvailable.push({
        id: asset.id,
        source: CORE_SOURCE_ID,
        fromVersion: result.details.existingVersion,
        toVersion: CORE_VERSION,
      });
    }
    entries.push({
      asset,
      source: "core",
      status: result.status,
      details: result.details,
      newContent: content,
    });
    working = result.output;
  }

  // 2) Plugins declared in config (enabled or disabled).
  // Loading the manifest even when disabled lets us strip its managed blocks.
  const missing: Array<{ id: string; reason: string }> = [];
  const declaredEntries = Object.entries(config.plugins ?? {});

  for (const [declaredId, settings] of declaredEntries) {
    let plugin;
    try {
      plugin = loadPlugin(declaredId);
    } catch (err) {
      if (err instanceof PluginNotFoundError) {
        missing.push({ id: declaredId, reason: "unknown plugin id" });
      } else if (err instanceof PluginManifestError) {
        missing.push({ id: declaredId, reason: err.message });
      } else {
        throw err;
      }
      continue;
    }

    const enabled = settings.enabled === true;

    if (enabled) {
      const pluginSource = `@navori/plugin-${plugin.manifest.id}`;
      for (const entry of plugin.managedAssets) {
        const content = readFileSync(entry.absPath, "utf-8");
        const result = injectManagedSection(working, entry.id, content, {
          source: pluginSource,
          version: plugin.manifest.version,
        });
        if (result.details?.versionDrift && result.details.existingVersion) {
          updatesAvailable.push({
            id: entry.id,
            source: pluginSource,
            fromVersion: result.details.existingVersion,
            toVersion: plugin.manifest.version,
          });
        }
        entries.push({
          asset: { id: entry.id, relPath: entry.absPath },
          source: plugin.manifest.id,
          status: result.status,
          details: result.details,
          newContent: content,
        });
        working = result.output;
      }
    } else {
      for (const entry of plugin.managedAssets) {
        const before = working;
        working = removeManagedSection(working, entry.id);
        entries.push({
          asset: { id: entry.id, relPath: entry.absPath },
          source: plugin.manifest.id,
          status: before === working ? "unchanged" : "removed-condition-false",
          newContent: null,
        });
      }
    }
  }

  return {
    existing,
    next: working,
    changed: working !== existing,
    entries,
    missingPlugins: missing,
    languageFallbacks,
    updatesAvailable,
  };
}

/**
 * Re-apply the same plan but skipping ids marked "user-modified-skipped".
 * Used by sync after the user resolved conflicts (decides to keep theirs).
 */
export function applyPlanWithSkips(
  existing: string,
  config: NavoriConfig,
  skipIds: ReadonlySet<string>,
): string {
  let working = existing;
  const configRecord = config as unknown as Record<string, unknown>;

  for (const asset of CORE_MANAGED_ASSETS) {
    if (skipIds.has(asset.id)) continue;
    if (asset.condition && !resolveCondition(configRecord, asset.condition)) {
      working = removeManagedSection(working, asset.id);
      continue;
    }
    const resolved = resolveAssetPath(asset, config.language);
    const content = readFileSync(resolved.path, "utf-8");
    const result = injectManagedSection(working, asset.id, content, {
      source: CORE_SOURCE_ID,
      version: CORE_VERSION,
    });
    working = result.output;
  }

  for (const [declaredId, settings] of Object.entries(config.plugins ?? {})) {
    let plugin;
    try {
      plugin = loadPlugin(declaredId);
    } catch {
      continue;
    }
    const enabled = settings.enabled === true;
    for (const entry of plugin.managedAssets) {
      if (skipIds.has(entry.id)) continue;
      if (enabled) {
        const content = readFileSync(entry.absPath, "utf-8");
        const result = injectManagedSection(working, entry.id, content, {
          source: `@navori/plugin-${plugin.manifest.id}`,
          version: plugin.manifest.version,
        });
        working = result.output;
      } else {
        working = removeManagedSection(working, entry.id);
      }
    }
  }

  return working;
}
