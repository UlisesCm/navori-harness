/**
 * Skill output discipline — spec 0003 §3.2.1.
 *
 * Every generated SKILL.md declares a `type` in frontmatter. Each type carries
 * a word cap on its body so skills stay lean (tokens are spent every time a
 * skill is loaded). A skill may raise its cap with an explicit `maxWords`
 * override when the length is justified — the override is loud, not silent.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitFrontmatter, getFrontmatterField } from "./frontmatter.ts";

/** File that marks a skill DIRECTORY (`.claude/skills/<id>/SKILL.md`). Shared so
 * `resolveLocalSkillPath` and `claude-infra`'s `listSkillDirs` agree on the
 * convention. */
export const SKILL_DIR_ENTRY = "SKILL.md";

/**
 * Resolve where a project-local skill lives on disk. navori supports two shapes:
 *   - a single file:     `.claude/skills/<id>.md`
 *   - a skill DIRECTORY: `.claude/skills/<id>/SKILL.md` (with sibling refs/assets)
 *
 * The directory form lets a repo keep a large, curated skill (a SKILL.md plus a
 * `references/` tree) as a project-local skill without flattening it into one
 * file. Returns the repo-relative path that exists, preferring the flat file,
 * or null when neither is present.
 *
 * A skill id is a flat slug: any path separator or `..` traversal is rejected up
 * front so a config-supplied id can never resolve outside `.claude/skills/`.
 */
export function resolveLocalSkillPath(cwd: string, id: string): string | null {
  if (
    id === "" ||
    id !== id.trim() ||
    /[\\/]/.test(id) ||
    id.split(/[\\/]/).includes("..") ||
    id.includes("..")
  ) {
    return null;
  }
  const fileRel = `.claude/skills/${id}.md`;
  const dirRel = `.claude/skills/${id}/${SKILL_DIR_ENTRY}`;
  if (existsSync(join(cwd, fileRel))) return fileRel;
  if (existsSync(join(cwd, dirRel))) return dirRel;
  return null;
}

export const SKILL_TYPE_CAPS = {
  /** Dictates how the agent behaves (e.g. tdd-workflow). Keep it tight. */
  behavior: 200,
  /** Documents a pattern/stack (e.g. mantine-patterns). */
  reference: 500,
  /** Wraps an external tool (e.g. bun-runtime). */
  tool: 300,
} as const;

export type SkillType = keyof typeof SKILL_TYPE_CAPS;

export interface SkillMeta {
  name: string | null;
  description: string | null;
  /** Declared `type`, or null when absent/unrecognized. */
  type: SkillType | null;
  /** Explicit cap override from frontmatter, or null. */
  maxWords: number | null;
}

/** Split a SKILL.md into its frontmatter metadata and its body. */
export function parseSkillFrontmatter(raw: string): { meta: SkillMeta; body: string } {
  const { frontmatter, body } = splitFrontmatter(raw);
  const get = (key: string): string | null => getFrontmatterField(frontmatter, key);

  const typeRaw = get("type");
  const type = typeRaw && typeRaw in SKILL_TYPE_CAPS ? (typeRaw as SkillType) : null;
  const maxRaw = get("maxWords");
  const maxWords = maxRaw && /^\d+$/.test(maxRaw) ? Number(maxRaw) : null;

  return { meta: { name: get("name"), description: get("description"), type, maxWords }, body };
}

/** Count words in a skill body the way the cap check measures them. */
export function countWords(body: string): number {
  const trimmed = body.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Resolve the effective word cap for a skill: the explicit `maxWords` override
 * wins, else the per-type default. Returns null when no type is declared (the
 * caller treats that as a violation — every skill must declare a type).
 */
export function skillWordCap(meta: SkillMeta): number | null {
  if (meta.maxWords !== null) return meta.maxWords;
  if (meta.type !== null) return SKILL_TYPE_CAPS[meta.type];
  return null;
}

/**
 * Spec 0003 §3.2.2 — a skill `description` must carry an explicit activation
 * trigger so Claude Code can load it on-demand instead of always-on. We accept
 * the natural trigger verbs in both locales (es/en); the harness language is
 * Spanish so "Aplica … / cuando / antes de" are the common forms.
 */
const TRIGGER_RE = /\b(aplica|us[aá]r?|use\s+(when|this)|para cuando|cuando|antes de)\b/i;

export function hasTrigger(description: string | null): boolean {
  return description !== null && TRIGGER_RE.test(description);
}

/** Max length of a one-line trigger in the skills index (H8). Keeps the
 * always-on index lean — a full multi-sentence `description` would inflate the
 * token floor. */
const TRIGGER_MAX = 120;

/**
 * Condense a skill `description` to a single-line activation trigger for the
 * skills index (issue #166 H8). Engines without native autoload
 * (Cursor/Copilot/AGENTS.md) rely on this "when to reach for it" line. Takes the
 * first clause (up to the first sentence break or em-dash — the "when", not the
 * full behavioral note) and caps the length. Returns null when there's no
 * description to summarize.
 */
export function summarizeTrigger(description: string | null): string | null {
  if (!description) return null;
  const flat = description.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  let cut = flat.length;
  for (const sep of [". ", " — ", " – ", "; "]) {
    const at = flat.indexOf(sep);
    if (at > 0 && at < cut) cut = at;
  }
  let out = flat
    .slice(0, cut)
    .trim()
    .replace(/[.;,]$/, "");
  if (out.length > TRIGGER_MAX) out = `${out.slice(0, TRIGGER_MAX - 1).trimEnd()}…`;
  return out === "" ? null : out;
}

/**
 * Read a skill asset and return its one-line trigger (see `summarizeTrigger`).
 * Returns null when the asset is unreadable or declares no `description`, so the
 * index degrades to a bare name row. Used by both skills-index builders (Claude
 * CLAUDE.md and the prose engines).
 */
export function readSkillTrigger(assetPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(assetPath, "utf-8");
  } catch {
    return null;
  }
  return summarizeTrigger(parseSkillFrontmatter(raw).meta.description);
}
