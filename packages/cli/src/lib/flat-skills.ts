import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeHomedir } from "./home.ts";

/**
 * #626 — a `.md` sitting loose in a `skills/` directory is not a skill.
 *
 * Claude Code discovers skills in ONE shape. Its "Choose where skills load"
 * table lists five locations — personal, project, nested, `--add-dir`, plugin —
 * and every single one is `<skill-name>/SKILL.md`. The flat `<name>.md` form
 * belongs to `.claude/commands/`, a different feature that navori's prose used
 * to conflate with skills.
 *
 * The comparable projects agree, which is how we know this is the convention
 * and not a doc quirk: gentle-ai's registry scans `<root>/<skill>/SKILL.md` and
 * calls it "the Agent Skills layout"; obra/superpowers, a library of nothing
 * but skills, ships zero loose `.md` in its skills root.
 *
 * A flat file there fails SILENTLY — no warning, no error, the skill simply
 * never exists. Four skills sat in `~/.claude/skills/` that way for ~3 months
 * and nothing said a word; worse, one was a diverged copy of a navori asset, so
 * the invalid format hid the divergence: nobody could notice two definitions of
 * one name when one of them never loaded.
 *
 * What this does NOT flag, both learned from reading real skill libraries:
 *   - `.md` files INSIDE a skill directory. superpowers ships several
 *     (`brainstorming/visual-companion.md`) and they are legitimate support material,
 *     referenced by the SKILL.md next to them.
 *   - `README.md` in the skills root: conventional documentation for the
 *     folder, not a failed skill. Flagging it would be technically true and
 *     practically noise.
 */

/** A loose `.md` in a skills root, which Claude Code will never load. */
export interface FlatSkill {
  /** Display path of the offending file (repo-relative, or `~/…` for personal). */
  path: string;
  /** The id it was probably meant to have. */
  id: string;
  /** Where it should live instead. */
  suggested: string;
}

/** Files that live in a skills root without being a failed skill. */
const NOT_A_SKILL = new Set(["README.md"]);

/** Loose `.md` directly inside one skills root. `dir` must already exist. */
function flatSkillsIn(dir: string, display: string): FlatSkill[] {
  const out: FlatSkill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // unreadable — doctor never fails over a readdir
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md") || NOT_A_SKILL.has(entry)) continue;
    try {
      // Only direct children: a `.md` one level down is support material for
      // the skill whose directory holds it.
      if (statSync(join(dir, entry)).isDirectory()) continue;
    } catch {
      continue;
    }
    const id = entry.slice(0, -".md".length);
    out.push({
      path: `${display}/${entry}`,
      id,
      suggested: `${display}/${id}/SKILL.md`,
    });
  }
  return out;
}

/**
 * Loose `.md` files in the skills roots this repo can reach: its own
 * `.claude/skills/` and the machine-wide `~/.claude/skills/`.
 *
 * The personal root is included because its skills apply to EVERY project on
 * the machine — a broken one there is broken everywhere, and no repo-scoped
 * check would ever surface it.
 */
export function scanFlatSkills(cwd: string): FlatSkill[] {
  const roots: Array<[string, string]> = [[join(cwd, ".claude", "skills"), ".claude/skills"]];
  const home = safeHomedir();
  if (home !== "") roots.push([join(home, ".claude", "skills"), "~/.claude/skills"]);

  const found: FlatSkill[] = [];
  for (const [dir, display] of roots) {
    if (!existsSync(dir)) continue;
    found.push(...flatSkillsIn(dir, display));
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
