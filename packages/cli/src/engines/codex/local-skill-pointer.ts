import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getFrontmatterField, splitFrontmatter } from "../../lib/render/frontmatter.ts";
import { resolveLocalSkillPath } from "../../lib/assets/skill-meta.ts";
import { navoriAuthorship } from "../../lib/render/removable.ts";
import { sanitizeProjectValue } from "../../lib/render/interpolate.ts";

/**
 * Skills locales en Codex — spec 0033 D2 (R9-R12).
 *
 * `.claude/skills/<id>/SKILL.md` is the only source. Codex discovers skills
 * from `.agents/skills/`, so a `project.localSkills` id needs a DESTINATION
 * there — a generated pointer, not a copy, so the source's own body and its
 * relative `references/` links keep working unmodified (R10). This module is
 * the ONE place that classifies each declared id and builds that pointer's
 * text; three consumers (the Codex adapter, `render`, `doctor`) read its
 * result instead of re-deriving the same question with a different criterion.
 */

/** Managed id for a local skill's generated Codex pointer (distinct from a
 *  library/plugin skill's own `managedId`, so the two can never collide). */
export function localSkillPointerMarkerId(id: string): string {
  return `${id}-local-pointer`;
}

/** Where the generated pointer for `id` lives, repo-relative. */
export function localSkillPointerDestRel(id: string): string {
  return `.agents/skills/${id}/SKILL.md`;
}

/** The three disjoint sets a declared `project.localSkills` id can fall into. */
export interface ClassifiedLocalSkills {
  /** Source exists; the destination is absent or is navori's own pointer for
   *  this id — safe to (re)write. */
  emit: readonly string[];
  /** No source under `.claude/skills/<id>/` (R11) — no destination is written,
   *  and any previous pointer for it is pruned (falls out of the caller's
   *  `desired` set). */
  missing: readonly string[];
  /** Source exists, but the destination exists and isn't navori's pointer for
   *  this id (R12) — never written, never pruned. */
  foreign: readonly string[];
}

/**
 * Classify every id declared in `project.localSkills`. An id already claimed
 * by `plan.skills` (a library/plugin skill of the same id) is skipped
 * entirely — the plan's own skill wins, the same rule `buildSkillRows` uses.
 */
export function classifyLocalSkills(
  cwd: string,
  ids: readonly string[],
  planSkillIds: ReadonlySet<string>,
): ClassifiedLocalSkills {
  const emit: string[] = [];
  const missing: string[] = [];
  const foreign: string[] = [];

  for (const id of ids) {
    if (planSkillIds.has(id)) continue;
    if (resolveLocalSkillPath(cwd, id) === null) {
      missing.push(id);
      continue;
    }
    const destAbs = join(cwd, localSkillPointerDestRel(id));
    const isForeign =
      existsSync(destAbs) && navoriAuthorship(destAbs, localSkillPointerMarkerId(id)) === "foreign";
    if (isForeign) foreign.push(id);
    else emit.push(id);
  }

  return { emit, missing, foreign };
}

/** Fallback body when the source declares no `description` at all — `doctor`
 *  already flags a triggerless skill separately (`scanTriggerlessLocalSkills`);
 *  this only keeps the pointer's YAML valid. */
function defaultDescription(id: string): string {
  return `Project-local skill at .claude/skills/${id}/SKILL.md.`;
}

/** Strip a single layer of matching quotes — `getFrontmatterField` returns the
 *  raw text after the colon, quotes included when the source already quoted
 *  its value. */
function unquote(value: string): string {
  const isQuoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return isQuoted ? value.slice(1, -1) : value;
}

/**
 * Build the full replacement text for a local skill's Codex pointer, from the
 * SOURCE's already-read text (see `renderManagedFile`'s `transform` — the
 * caller reads `.claude/skills/<id>/SKILL.md` once and hands it here). `name`
 * and `description` come from the source's own frontmatter, sanitized against
 * the same `<!--`/newline injection `sanitizeProjectValue` defuses elsewhere,
 * and re-emitted as a JSON string so a hostile value can't break the YAML.
 *
 * The body never touches `adaptHarnessTextForCodex`: that function rewrites
 * `.claude/skills/<id>/SKILL.md` mentions into `.agents/skills/<id>/SKILL.md`
 * — exactly the self-reference this pointer's body deliberately names.
 */
export function buildLocalSkillPointerContent(sourceText: string, id: string): string {
  const { frontmatter } = splitFrontmatter(sourceText);
  const rawName = getFrontmatterField(frontmatter, "name");
  const name = sanitizeProjectValue(unquote(rawName ?? id)) || id;
  const rawDescription = getFrontmatterField(frontmatter, "description");
  const description = rawDescription
    ? sanitizeProjectValue(unquote(rawDescription))
    : defaultDescription(id);
  const sourceRel = `.claude/skills/${id}/SKILL.md`;
  const body =
    `Project-local skill, maintained in \`${sourceRel}\` (relative to the directory that ` +
    `holds \`.agents/\`). Read that file before acting; its supporting files resolve ` +
    `relative to its directory. This entry only makes it discoverable here.\n`;
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
}

/** Absolute path to the source SKILL.md for a `project.localSkills` id, or
 *  null when it doesn't exist. Thin wrapper so callers don't repeat the
 *  `resolveLocalSkillPath` + `join` pair. */
export function localSkillSourceAbs(cwd: string, id: string): string | null {
  const rel = resolveLocalSkillPath(cwd, id);
  return rel === null ? null : join(cwd, rel);
}

/** Read straight off the local skill's own source frontmatter — mirrors the
 *  Codex adapter's `isManualOnlySkill` for plan skills, so a local skill's
 *  `disable-model-invocation` gets the same `agents/openai.yaml` sidecar. */
export function isManualOnlyLocalSkill(sourceAbs: string): boolean {
  const { frontmatter } = splitFrontmatter(readFileSync(sourceAbs, "utf-8"));
  return getFrontmatterField(frontmatter, "disable-model-invocation") === "true";
}
