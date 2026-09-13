/**
 * #736 — a project-local skill whose `description` declares no activation
 * trigger.
 *
 * The host loads a skill on demand by reading its `description` and deciding
 * whether the situation matches. A description that only says WHAT the skill
 * does ("Automate browser interactions, test web pages…") gives it nothing to
 * match on, so the skill is installed, indexed, counted — and almost never
 * fires. That is not a broken skill, which is why this is a warning and never
 * flips doctor's verdict: it is a skill paying rent without working.
 *
 * WHAT COUNTS AS A TRIGGER — `hasTrigger` from `skill-meta.ts`, the criterion
 * spec 0003 §3.2.2 already defines and `skill-caps.test.ts` already enforces on
 * every bundled asset. Reusing it is the point: two definitions of "has a
 * trigger" would let a skill pass the check navori applies to its own assets and
 * fail this one, or the reverse.
 *
 * It accepts the natural trigger verbs in BOTH locales — `Use when…`,
 * `Use this…`, `Usar cuando…`, `Aplica al…`, `cuando…`, `antes de…`. Keeping the
 * Spanish half matters precisely here and nowhere else: every asset navori ships
 * is written in English, but navori renders CLAUDE.md in es and en, and a
 * project-local skill is written by the user, in the user's language. Narrowing
 * this to `/^use when/i` would flag every correctly-written Spanish skill.
 *
 * Passes (no warning):
 *   "Use when reviewing a diff (staged, branch or PR) — a checklist…"
 *   "Usar cuando toques el modelo de datos — convenciones de Mongoose…"
 *   "Rules for Astro Islands — client directives. Use when adding an island."
 * Flagged:
 *   "Automate browser interactions, test web pages and work with Playwright tests."
 *   no `description:` in the frontmatter at all
 *
 * Calibration, measured rather than assumed: across the 75 skill assets navori
 * bundles (core, lib-skills, presets, plugins) the criterion flags ZERO, and
 * across this repo's 16 installed skills it flags exactly one — `playwright-cli`,
 * the one the issue is about. No false positive on a 75-file corpus of
 * known-good descriptions.
 *
 * SCOPE — project-local only, for the same reason navori never rewrites those
 * files: their content belongs to the repo, so the remedy is a warning the owner
 * acts on, not an edit navori performs. Skills navori renders (core, preset,
 * library, plugin) are out of scope both because their description comes from an
 * asset the user did not write and because `skill-caps.test.ts` already blocks a
 * triggerless one from ever shipping. Warning about them would be noise about a
 * file the reader cannot fix.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasTrigger, parseSkillFrontmatter, resolveLocalSkillPath } from "./skill-meta.ts";

/** A project-local skill the host has no condition to load it on. */
export interface TriggerlessSkill {
  /** Skill id, as declared in `project.localSkills`. */
  id: string;
  /** Repo-relative path of the skill file. */
  path: string;
}

/**
 * Project-local skills whose `description` carries no activation trigger.
 *
 * `localSkills` are the ids declared in `project.localSkills` — the repo's own
 * definition of project-local, the same list `buildSkillRows` tags that way and
 * `doctor` already validates for a missing file. An id with no file on disk is
 * NOT reported here: that is `missingLocalSkills`' finding, and reporting one
 * defect twice trains people to skim both.
 */
export function scanTriggerlessLocalSkills(
  cwd: string,
  localSkills: readonly string[],
): TriggerlessSkill[] {
  const out: TriggerlessSkill[] = [];
  const seen = new Set<string>();
  for (const id of localSkills) {
    if (seen.has(id)) continue;
    seen.add(id);
    const rel = resolveLocalSkillPath(cwd, id);
    if (rel === null) continue; // missing file — a different check owns it
    let raw: string;
    try {
      raw = readFileSync(join(cwd, rel), "utf-8");
    } catch {
      continue; // unreadable — doctor never fails over a read
    }
    // An id can be BOTH declared local and rendered by navori: a team that
    // reclaims a deselected library skill keeps the file and lists the id (see
    // `preset-extras.test.ts`, "keeps a deselected library skill the user
    // reclaimed"). navori wrote that frontmatter, so its description is navori's
    // to fix, not the reader's — out of scope by the same rule as every other
    // rendered skill.
    if (raw.includes("<!-- navori:managed")) continue;
    if (hasTrigger(parseSkillFrontmatter(raw).meta.description)) continue;
    out.push({ id, path: rel });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
