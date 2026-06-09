#!/usr/bin/env node
// Copy assets from workspace deps into dist/assets so the published tarball
// is self-contained.
import { cpSync, mkdirSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(CLI_ROOT, "../..");
const DIST = resolve(CLI_ROOT, "dist");
const ASSETS_DIR = resolve(DIST, "assets");

// Plugins to bundle. Source of truth = packages/plugins/* directories.
const PLUGINS_DIR = resolve(REPO_ROOT, "packages/plugins");
const plugins = readdirSync(PLUGINS_DIR).filter((entry) => {
  try {
    return statSync(join(PLUGINS_DIR, entry)).isDirectory();
  } catch {
    return false;
  }
});

if (existsSync(ASSETS_DIR)) rmSync(ASSETS_DIR, { recursive: true, force: true });
mkdirSync(ASSETS_DIR, { recursive: true });

// Core
const coreSrc = resolve(REPO_ROOT, "packages/core");
const coreDest = resolve(ASSETS_DIR, "core");
mkdirSync(coreDest, { recursive: true });
cpSync(resolve(coreSrc, "package.json"), resolve(coreDest, "package.json"));
cpSync(resolve(coreSrc, "core-assets"), resolve(coreDest, "core-assets"), {
  recursive: true,
});

// Plugins
const pluginsDest = resolve(ASSETS_DIR, "plugins");
mkdirSync(pluginsDest, { recursive: true });
for (const id of plugins) {
  const src = resolve(PLUGINS_DIR, id);
  const dest = resolve(pluginsDest, id);
  mkdirSync(dest, { recursive: true });
  cpSync(resolve(src, "plugin.json"), resolve(dest, "plugin.json"));
  const managedSrc = resolve(src, "managed");
  if (existsSync(managedSrc)) {
    cpSync(managedSrc, resolve(dest, "managed"), { recursive: true });
  }
}

console.log(`✓ Bundled assets to ${ASSETS_DIR}`);
console.log(`  - core (1 package)`);
console.log(`  - plugins (${plugins.length}): ${plugins.join(", ")}`);
