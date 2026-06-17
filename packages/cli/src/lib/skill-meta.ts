/**
 * Skill output discipline — spec 0003 §3.2.1.
 *
 * Every generated SKILL.md declares a `type` in frontmatter. Each type carries
 * a word cap on its body so skills stay lean (tokens are spent every time a
 * skill is loaded). A skill may raise its cap with an explicit `maxWords`
 * override when the length is justified — the override is loud, not silent.
 */

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

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/** Split a SKILL.md into its frontmatter metadata and its body. */
export function parseSkillFrontmatter(raw: string): { meta: SkillMeta; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  const fm = m ? m[1]! : "";
  const body = m ? raw.slice(m[0].length) : raw;

  const get = (key: string): string | null => {
    const line = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return line ? line[1]!.trim() : null;
  };

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
