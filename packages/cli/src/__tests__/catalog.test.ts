import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec 0003 §3.1.6 — catalog count enforcement.
 * `package.json#features` declares how much navori bundles (plugins, presets,
 * core agents/skills). This test counts what's actually on disk and fails when
 * the declared numbers drift — so docs/marketing counts stay honest and adding
 * an asset forces an explicit bump.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..", ".."); // packages/cli
const coreAssets = resolve(cliRoot, "..", "core", "core-assets");
const pluginsDir = resolve(cliRoot, "..", "plugins");

const features = JSON.parse(readFileSync(resolve(cliRoot, "package.json"), "utf-8"))
  .features as Record<string, number>;

function countFiles(dir: string, ext: string): number {
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(ext))
    .length;
}

/** A plugin is a directory under packages/plugins/ that carries a plugin.json. */
function countPlugins(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && existsSync(resolve(dir, e.name, "plugin.json")),
  ).length;
}

describe("catalog count enforcement (spec 0003 §3.1.6)", () => {
  it("package.json declares a features count block", () => {
    expect(features).toBeDefined();
    for (const key of ["plugins", "presets", "coreAgents", "coreSkills"]) {
      expect(typeof features[key]).toBe("number");
    }
  });

  it("plugin count matches packages/plugins/*", () => {
    expect(countPlugins(pluginsDir)).toBe(features.plugins);
  });

  it("preset count matches core-assets/presets/*.json", () => {
    expect(countFiles(resolve(coreAssets, "presets"), ".json")).toBe(features.presets);
  });

  it("core agent count matches core-assets/agents/*.md", () => {
    expect(countFiles(resolve(coreAssets, "agents"), ".md")).toBe(features.coreAgents);
  });

  it("core skill count matches core-assets/skills/*.md", () => {
    expect(countFiles(resolve(coreAssets, "skills"), ".md")).toBe(features.coreSkills);
  });

  it("library skill count matches core-assets/lib-skills/*.md", () => {
    expect(countFiles(resolve(coreAssets, "lib-skills"), ".md")).toBe(features.librarySkills);
  });
});
