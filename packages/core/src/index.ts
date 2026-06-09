import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export const CORE_SOURCE_ID = "@navori/core" as const;

export type AssetLanguage = "es" | "en";

export interface CoreManagedAsset {
  /** Marker id (kebab-case). Goes into `<!-- navori:managed id="..." -->`. */
  id: string;
  /** Relative path from the package root (Spanish version, always required). */
  relPath: string;
  /** Optional condition (config path that must resolve truthy for the asset to render). */
  condition?: string;
  /** Languages for which a localized version exists. Defaults to ["es"]. */
  availableLanguages?: readonly AssetLanguage[];
}

export const CORE_MANAGED_ASSETS: readonly CoreManagedAsset[] = [
  { id: "idioma-rol", relPath: "core-assets/managed/idioma-rol.md", availableLanguages: ["es"] },
  { id: "formato-respuesta", relPath: "core-assets/managed/formato-respuesta.md", availableLanguages: ["es"] },
  { id: "tipado-fuerte", relPath: "core-assets/managed/tipado-fuerte.md", availableLanguages: ["es"] },
  { id: "cierre-sesion", relPath: "core-assets/managed/cierre-sesion.md", availableLanguages: ["es"] },
] as const;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function getCoreVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Resolve the absolute path to an asset, trying the requested language first
 * with a fallback to Spanish. Returns the resolved path and whether the
 * fallback was used (callers can warn).
 */
export function resolveAssetPath(
  asset: CoreManagedAsset,
  language: AssetLanguage = "es",
): { path: string; fallback: boolean } {
  if (language === "es") {
    return { path: resolve(PACKAGE_ROOT, asset.relPath), fallback: false };
  }
  // Try language-specific variant: managed/<lang>/<basename>
  // Convention: replace "managed/" → "managed/<lang>/" in the relPath.
  const langPath = asset.relPath.replace(/^core-assets\/managed\//, `core-assets/managed/${language}/`);
  const abs = resolve(PACKAGE_ROOT, langPath);
  if (existsSync(abs)) return { path: abs, fallback: false };
  // Fallback to Spanish
  return { path: resolve(PACKAGE_ROOT, asset.relPath), fallback: true };
}
