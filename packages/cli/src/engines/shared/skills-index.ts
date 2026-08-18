import { basename, join } from "node:path";
import type { NavoriConfig } from "../../lib/config.ts";
import { sanitizeProjectValue } from "../../lib/interpolate.ts";
import { loadPreset } from "../../lib/presets.ts";
import { librarySkillById } from "../../lib/library-skills.ts";
import { readSkillTrigger, resolveLocalSkillPath } from "../../lib/skill-meta.ts";
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
 * A managed row's trigger comes from the navori-owned asset (deterministic
 * across checkouts), never the user's on-disk copy, so the managed block never
 * drifts. Project-local rows are the one exception (#327): navori doesn't own
 * those files, so their trigger is read from `localSkillsRoot` and degrades to
 * the bare path when the skill isn't on disk.
 * Returns the rows only; each engine wraps them with its own header (Claude
 * references `.claude/skills/<id>/SKILL.md`, the prose engines don't).
 */
export function buildSkillRows(
  config: NavoriConfig,
  repoRoot: string,
  coreAssets: string,
  localSkills: readonly string[] = [],
  /** Directory holding `.claude/skills/` for the project-local rows. Differs
   * from `repoRoot` on a monorepo WORKSPACE render, where the CLAUDE.md (and
   * its skills) live in the workspace dir while presets resolve from the root. */
  localSkillsRoot: string = repoRoot,
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
        // `config.preset` is untrusted config interpolated into this managed row;
        // sanitize so it can't forge a marker / smuggle a newline (#264).
        const preset = sanitizeProjectValue(config.preset);
        rows.push(row(name, `preset (\`${preset}\`)`, join(loaded!.assetRoot, e.relPath)));
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
    if (listed.has(name)) continue;
    // `localSkills` is untrusted config (`z.array(z.string())`, no regex) landing
    // verbatim in a managed block — sanitize so a hostile id can't forge a marker
    // or smuggle a newline into the skills index (#264).
    const safeName = sanitizeProjectValue(name);
    // Project-local skills carry the knowledge navori can't derive, so the index
    // must say WHEN to reach for them — a name plus a path forces opening the
    // file to find out, which is what the index exists to avoid (#327). Their
    // `description` is read from disk (navori owns neither the file nor its
    // frontmatter) and sanitized like any untrusted value; when the skill isn't
    // on disk — or declares no description — the row degrades to the path, which
    // is also what a checkout without `.claude/skills/` renders.
    const rel = resolveLocalSkillPath(localSkillsRoot, name);
    const trigger = rel ? readSkillTrigger(join(localSkillsRoot, rel)) : null;
    const safeTrigger = trigger ? sanitizeProjectValue(trigger) : "";
    rows.push(
      safeTrigger !== ""
        ? `- \`${safeName}\` — project-local · ${safeTrigger}`
        : `- \`${safeName}\` — project-local (\`.claude/skills/${safeName}\`)`,
    );
    listed.add(name);
  }
  return rows;
}
