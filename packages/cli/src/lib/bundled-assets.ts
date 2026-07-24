import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

/**
 * Locate the bundled assets directory. After build, dist/assets/ contains
 * the materialized copies of @navori/core and @navori/plugin-*. In dev
 * (running TS sources directly via Node), we fall back to the workspace
 * package roots so the CLI keeps working without a build.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

// Candidate 1: bundled (dist/assets/ next to the running JS file)
const BUNDLED_ASSETS = resolve(HERE, "assets");

// Candidate 2: dev mode — going up from src/lib to packages/
const DEV_PACKAGES = resolve(HERE, "..", "..", "..");

function isBundled(): boolean {
  return existsSync(resolve(BUNDLED_ASSETS, "core", "package.json"));
}

export function getCoreRoot(): string {
  if (isBundled()) return resolve(BUNDLED_ASSETS, "core");
  return resolve(DEV_PACKAGES, "core");
}

export function getPluginAssetsRoot(): string {
  if (isBundled()) return resolve(BUNDLED_ASSETS, "plugins");
  return resolve(DEV_PACKAGES, "plugins");
}

export function getPluginPath(pluginId: string): string {
  return resolve(getPluginAssetsRoot(), pluginId);
}

export function readBundledCoreVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(getCoreRoot(), "package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The navori CLI's own release version (e.g. "0.2.9"). This is the version that
 * actually bumps every release — unlike `@navori/core`, which is versioned
 * statically. Managed-block markers stamp THIS so the anti-retroceso guard
 * (#79) has a per-release signal to compare: a block written by a newer navori
 * is never silently overwritten by an older one. The `name === "navori"` guard
 * avoids reading a nested package.json (@navori/core) by mistake.
 */
export function readCliVersion(): string {
  for (const candidate of [
    resolve(HERE, "..", "package.json"), // bundled: dist/../package.json
    resolve(HERE, "..", "..", "package.json"), // dev: src/lib/../../package.json
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.version && pkg.name === "navori") return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return "0.0.0";
}

export function resolveBundledCoreAssetPath(relPath: string): string {
  return resolve(getCoreRoot(), relPath);
}

export function bundledPluginManifestPath(pluginId: string): string {
  return resolve(getPluginPath(pluginId), "plugin.json");
}

/** Returns true if running from the published/built CLI (dist/assets/ exists). */
export function isUsingBundledAssets(): boolean {
  return isBundled();
}

/** Names of plugins shipped with the CLI bundle. */
export function listBundledPluginIds(): string[] {
  const root = getPluginAssetsRoot();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root).filter((entry) => {
      try {
        return statSync(join(root, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
