import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface CoreManagedAsset {
  /** Marker id (kebab-case). Goes into `<!-- navori:managed id="..." -->`. */
  id: string;
  /** Relative path from the package root. */
  relPath: string;
  /** Optional condition (config path that must resolve truthy for the asset to render). */
  condition?: string;
}

export const CORE_MANAGED_ASSETS: readonly CoreManagedAsset[] = [
  { id: "idioma-rol", relPath: "core-assets/managed/idioma-rol.md" },
  { id: "formato-respuesta", relPath: "core-assets/managed/formato-respuesta.md" },
  { id: "tipado-fuerte", relPath: "core-assets/managed/tipado-fuerte.md" },
  { id: "cierre-sesion", relPath: "core-assets/managed/cierre-sesion.md" },
] as const;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveAssetPath(asset: CoreManagedAsset): string {
  return resolve(PACKAGE_ROOT, asset.relPath);
}
