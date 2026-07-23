import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getCoreRoot } from "./bundled-assets.ts";
import { LIBRARY_SKILLS } from "./library-skills.ts";
import { loadPreset } from "./presets.ts";
import type { NavoriConfig } from "./config.ts";

function addPresetSkills(ids: Set<string>, presetId: string, repoRoot: string): void {
  try {
    const loaded = loadPreset(presetId, repoRoot);
    for (const extra of loaded?.def.extras.skills ?? []) {
      ids.add(basename(extra.destRelPath).replace(/\.md$/, ""));
    }
  } catch {
    // Preset problems are surfaced elsewhere; the catalog degrades gracefully.
  }
}

/**
 * The set of skill ids navori materializes for THIS repo given its ACTIVE preset:
 *   - core + workflow skills   (`core-assets/skills/*.md` basenames)
 *   - library skills           (`LIBRARY_SKILLS`, dependency-detected)
 *   - active preset skills     (`loadPreset(config.preset).extras.skills`)
 *   - project-local skills     (`config.project.localSkills`, user-owned)
 *
 * This is what the repo actually gets rendered. The feature "external skills"
 * check uses it to tell a skill that is ALREADY present here from one that,
 * while bundled by navori, only ships under a preset that isn't active.
 */
export function activeSkillIds(config: NavoriConfig, repoRoot: string): Set<string> {
  const ids = new Set<string>();

  // Core + workflow skills both live flat in core-assets/skills/*.md.
  const coreSkillsDir = resolve(getCoreRoot(), "core-assets/skills");
  if (existsSync(coreSkillsDir)) {
    try {
      for (const entry of readdirSync(coreSkillsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          ids.add(entry.name.replace(/\.md$/, ""));
        }
      }
    } catch {
      // best-effort — a missing core dir just yields a smaller catalog
    }
  }

  for (const skill of LIBRARY_SKILLS) ids.add(skill.id);

  if (config.preset && config.preset !== "custom") {
    addPresetSkills(ids, config.preset, repoRoot);
  }

  for (const id of config.project?.localSkills ?? []) ids.add(id);

  return ids;
}

/**
 * The set of skill ids navori bundles AT ALL — a superset of {@link activeSkillIds}
 * that also unions the skills of EVERY bundled preset (expo-runtime, astro-islands,
 * …), not just the active one.
 *
 * Per spec 0004, a feature phase skill is "external" only when navori doesn't
 * ship it under ANY preset. Counting the active preset alone (the old behavior)
 * made a custom-preset repo trip ~20 false "external" warnings for skills navori
 * bundles under other presets. This is the reference the truly-external check
 * subtracts from; skills in this set but NOT in `activeSkillIds` are the softer
 * "bundled under an inactive preset" bucket.
 */
export function bundledSkillIds(config: NavoriConfig, repoRoot: string): Set<string> {
  const ids = activeSkillIds(config, repoRoot);

  // Union every bundled preset's skills so "external" means "not bundled at all".
  const presetsDir = resolve(getCoreRoot(), "core-assets/presets");
  if (existsSync(presetsDir)) {
    try {
      for (const entry of readdirSync(presetsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          addPresetSkills(ids, entry.name.replace(/\.json$/, ""), repoRoot);
        }
      }
    } catch {
      // best-effort — a missing presets dir just yields a smaller catalog
    }
  }

  return ids;
}
