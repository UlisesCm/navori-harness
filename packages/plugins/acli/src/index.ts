import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const PLUGIN_ID = "acli" as const;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function getPluginRoot(): string {
  return PACKAGE_ROOT;
}

export function getManifestPath(): string {
  return resolve(PACKAGE_ROOT, "plugin.json");
}
