import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import { readCliVersion } from "../../lib/render/bundled-assets.ts";

/** Stable identity shared by the Claude and Codex plugin script placements. */
export function pluginScriptManagedId(pluginId: string, dest: string): string {
  const slug = dest
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${pluginId}-script-${slug}`;
}

/** Source and provenance for one engine-specific managed plugin script. */
export function pluginScriptPlacements(plugin: LoadedPlugin, engine: "claude" | "codex") {
  return plugin.scriptAssets.map((script) => ({
    ...script,
    destRelPath: `.${engine}/scripts/${script.dest}`,
    managedId: pluginScriptManagedId(plugin.manifest.id, script.dest),
    meta: { source: `@navori/plugin-${plugin.manifest.id}`, version: readCliVersion() },
  }));
}

/** A destination claimed twice has no safe Codex owner. */
export function pluginScriptCollisions(plugins: readonly LoadedPlugin[]): Set<string> {
  const owners = new Map<string, string>();
  const collisions = new Set<string>();
  for (const plugin of plugins) {
    for (const script of plugin.scriptAssets) {
      const owner = owners.get(script.dest);
      if (owner) collisions.add(script.dest);
      else owners.set(script.dest, plugin.manifest.id);
    }
  }
  return collisions;
}
