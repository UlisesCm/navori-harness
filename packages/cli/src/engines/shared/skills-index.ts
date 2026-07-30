import { basename, join } from "node:path";
import type { NavoriConfig } from "../../lib/config.ts";
import { loadPreset } from "../../lib/presets.ts";
import { librarySkillById } from "../../lib/library-skills.ts";
import { readSkillTrigger } from "../../lib/skill-meta.ts";
import { CORE_SKILLS, WORKFLOW_SKILLS, extraConditionMet } from "./harness-assets.ts";

/**
 * Build the `- <id> — <tag> · <trigger>` rows for the "Available skills" index,
 * shared by the Claude engine and the prose spine (C4: the two builders had
 * drifted — the prose one skipped ALL conditional preset skills and never
 * listed project-local ones). One source of the row set now:
 *
 *   - core + workflow skills (always),
 *   - preset skills whose `condition` is met against the config
 *     (`extraConditionMet` — deterministic from config, so the prose engines can
 *     include them too, not just Claude),
 *   - auto-detected library skills,
 *   - project-local skills (only when the caller passes them — prose engines
 *     have no `.claude/skills/` so they pass none).
 *
 * Each row's trigger comes from the navori-owned asset (deterministic across
 * checkouts), never the user's on-disk copy, so the managed block never drifts.
 * Returns the rows only; each engine wraps them with its own header (Claude
 * references `.claude/skills/<id>/SKILL.md`, the prose engines don't).
 */
export function buildSkillRows(
  config: NavoriConfig,
  repoRoot: string,
  coreAssets: string,
  localSkills: readonly string[] = [],
): string[] {
  const rows: string[] = [];
  const listed = new Set<string>();
  const row = (id: string, tag: string, assetPath: string): string => {
    const trigger = readSkillTrigger(assetPath);
    return trigger ? `- \`${id}\` — ${tag} · ${trigger}` : `- \`${id}\` — ${tag}`;
  };

  for (const id of CORE_SKILLS) {
    rows.push(row(id, "navori", join(coreAssets, `skills/${id}.md`)));
    listed.add(id);
  }
  for (const id of WORKFLOW_SKILLS) {
    rows.push(row(id, "navori (workflow)", join(coreAssets, `skills/${id}.md`)));
    listed.add(id);
  }
  if (config.preset && config.preset !== "custom") {
    try {
      const loaded = loadPreset(config.preset, repoRoot);
      for (const e of loaded?.def.extras.skills ?? []) {
        if (!extraConditionMet(e, config)) continue;
        const name = basename(e.destRelPath).replace(/\.md$/, "");
        if (listed.has(name)) continue;
        rows.push(row(name, `preset (\`${config.preset}\`)`, join(loaded!.assetRoot, e.relPath)));
        listed.add(name);
      }
    } catch {
      // Preset problems are surfaced elsewhere; the index degrades gracefully.
    }
  }
  for (const id of config.project?.libraries ?? []) {
    if (listed.has(id) || !librarySkillById(id)) continue;
    rows.push(row(id, "library (detected)", join(coreAssets, `lib-skills/${id}.md`)));
    listed.add(id);
  }
  for (const name of localSkills) {
    // Deterministic from config: point at the skills root, not a concrete file —
    // whether the skill is a flat `<id>.md` or a `<id>/SKILL.md` directory is an
    // on-disk detail (the header explains both). Resolving it here (or reading a
    // trigger) would make the managed block depend on filesystem state and drift
    // between checkouts; doctor is where the on-disk existence check belongs.
    if (listed.has(name)) continue;
    rows.push(`- \`${name}\` — project-local (\`.claude/skills/${name}\`)`);
    listed.add(name);
  }
  return rows;
}
