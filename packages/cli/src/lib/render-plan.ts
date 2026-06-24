import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { injectManagedSection, removeManagedSection, resolveCondition, type InjectResult } from "./marker.ts";
import { loadPlugin, PluginNotFoundError, PluginManifestError } from "./plugins.ts";
import { getCoreRoot, readBundledCoreVersion } from "./bundled-assets.ts";
import { loadPreset, PresetError } from "./presets.ts";
import { placeholderFallback } from "./placeholders.ts";
import { effectiveConfig, type NavoriConfig } from "./config.ts";

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
  { id: "tipado-fuerte", relPath: "core-assets/managed/tipado-fuerte.md", availableLanguages: ["es"], condition: "project.typedLanguage" },
  { id: "operaciones-seguras", relPath: "core-assets/managed/operaciones-seguras.md", availableLanguages: ["es"] },
  { id: "arranque-sesion", relPath: "core-assets/managed/arranque-sesion.md", availableLanguages: ["es"] },
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

/**
 * Replace `{{path.to.value}}` placeholders in an asset's content using values
 * from the config. Missing values fall back to a friendly literal so the
 * generated CLAUDE.md never ships a raw `{{...}}` to the user.
 */
function interpolateTemplate(content: string, config: NavoriConfig): string {
  const configRecord = config as unknown as Record<string, unknown>;
  return content.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, path: string) => {
    const segments = path.split(".");
    let cursor: unknown = configRecord;
    for (const seg of segments) {
      if (cursor === null || cursor === undefined || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[seg];
    }
    if (cursor === undefined || cursor === null) {
      // Readable hint instead of the raw {{...}}; prose for known-optional paths.
      return placeholderFallback(path);
    }
    if (typeof cursor === "string" || typeof cursor === "number" || typeof cursor === "boolean") {
      return String(cursor);
    }
    return match;
  });
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
export function computeRenderPlan(
  existing: string,
  inputConfig: NavoriConfig,
  /** Repo root where `.navori/presets/` lives (resolves local presets). */
  repoRoot: string,
  options: { skipIds?: ReadonlySet<string>; forceIds?: ReadonlySet<string> } = {},
): RenderPlan {
  // Fill in render-only derived values (prTarget, project.typedLanguage) so
  // managed-block conditions resolve the same whether called from the engine
  // or from sync. Idempotent.
  const config = effectiveConfig(inputConfig);
  const skipIds = options.skipIds ?? new Set<string>();
  // forceIds: blocks the user chose "accept new" for in sync --interactive —
  // overwrite even though they were hand-edited.
  const forceIds = options.forceIds ?? new Set<string>();
  let working = existing;
  const entries: AssetPlanEntry[] = [];
  const languageFallbacks: string[] = [];
  const updatesAvailable: UpdateAvailable[] = [];
  const configRecord = config as unknown as Record<string, unknown>;
  const language = config.language;

  // 1) Core assets
  for (const asset of CORE_MANAGED_ASSETS) {
    if (skipIds.has(asset.id)) {
      // The caller asked us to leave this block alone (user-modified that
      // they chose to keep during conflict resolution).
      continue;
    }
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
    const rawContent = readFileSync(resolved.path, "utf-8");
    const content = interpolateTemplate(rawContent, config);
    const result = injectManagedSection(working, asset.id, content, {
      source: CORE_SOURCE_ID,
      version: CORE_VERSION,
    }, "html", forceIds.has(asset.id));
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

  // 1.5) Preset extras — managed blocks the active preset contributes on top
  // of the core baseline. Same inject/conflict semantics as core; source is
  // `@navori/preset-<id>` so version drift / future updates can be tracked
  // independently. A missing preset file is silent (preset = "custom" or a
  // stack with no extras yet); a malformed preset throws and surfaces.
  const presetMissing: Array<{ id: string; reason: string }> = [];
  if (config.preset && config.preset !== "custom") {
    let loaded = null;
    try {
      loaded = loadPreset(config.preset, repoRoot);
    } catch (err) {
      if (err instanceof PresetError) {
        presetMissing.push({ id: config.preset, reason: err.message });
      } else {
        throw err;
      }
    }
    if (!loaded && presetMissing.length === 0) {
      // Surface missing preset (not just malformed). Silent-skip masked the
      // medusa-v2/medusa.json mismatch and the workspace silently rendered
      // with no preset extras.
      presetMissing.push({
        id: config.preset,
        reason: `preset '${config.preset}' not found (no .navori/presets/${config.preset}/ nor bundled)`,
      });
    }
    if (loaded) {
      // relPath resolve against the preset's own asset root: the preset folder
      // for a local preset, core-assets/ for a bundled one.
      for (const extra of loaded.def.extras.managed) {
        if (skipIds.has(extra.id)) continue;
        const absPath = resolve(loaded.assetRoot, extra.relPath);
        const rawContent = readFileSync(absPath, "utf-8");
        const content = interpolateTemplate(rawContent, config);
        const result = injectManagedSection(working, extra.id, content, {
          source: CORE_SOURCE_ID,
          version: CORE_VERSION,
        }, "html", forceIds.has(extra.id));
        if (result.details?.versionDrift && result.details.existingVersion) {
          updatesAvailable.push({
            id: extra.id,
            source: CORE_SOURCE_ID,
            fromVersion: result.details.existingVersion,
            toVersion: CORE_VERSION,
          });
        }
        entries.push({
          asset: { id: extra.id, relPath: extra.relPath },
          source: loaded.def.id,
          status: result.status,
          details: result.details,
          newContent: content,
        });
        working = result.output;
      }
    }
  }

  // 2) Plugins declared in config (enabled or disabled).
  // Loading the manifest even when disabled lets us strip its managed blocks.
  const missing: Array<{ id: string; reason: string }> = presetMissing;
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
        if (skipIds.has(entry.id)) continue;
        const rawContent = readFileSync(entry.absPath, "utf-8");
        const content = interpolateTemplate(rawContent, config);
        const result = injectManagedSection(working, entry.id, content, {
          source: pluginSource,
          version: plugin.manifest.version,
        }, "html", forceIds.has(entry.id));
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
        if (skipIds.has(entry.id)) continue;
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
 * Re-render the same plan but skipping ids marked "user-modified-skipped".
 * Used by sync after the user resolved conflicts (decides to keep theirs).
 *
 * Thin wrapper around computeRenderPlan with skipIds option — keeps a
 * single source of truth for the inject/remove logic, including plugin
 * error visibility, template interpolation and version drift tracking.
 */
export function applyPlanWithSkips(
  existing: string,
  config: NavoriConfig,
  repoRoot: string,
  skipIds: ReadonlySet<string>,
): string {
  return computeRenderPlan(existing, config, repoRoot, { skipIds }).next;
}
