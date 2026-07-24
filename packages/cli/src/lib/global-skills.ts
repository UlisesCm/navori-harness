import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getCoreRoot } from "./bundled-assets.ts";
import { parseSkillFrontmatter } from "./skill-meta.ts";

/**
 * The global skills catalog (spec 0005) — the fixed set of skills `navori
 * global init` may install into the persona target as
 * `~/.claude/skills/<id>/SKILL.md`. Two provenances:
 *
 *   - "core-skill": one of the flat `.md` skills already bundled under
 *     `core-assets/skills/` for the repo target (verify-before-done,
 *     pr-create, …). Rendered here in DIRECTORY form since the persona target
 *     has no flat-skill convention.
 *   - "global-skill-dir": a skill promoted from the maintainer's personal
 *     `~/.claude/skills/<id>/` into `core-assets/global-skills/<id>/`,
 *     content kept verbatim. These never render at repo scope — only here.
 *
 * This list IS the catalog: intentionally fixed (no config-driven discovery),
 * so adding/removing a global skill is a code change, not a data migration.
 */
export type GlobalSkillSource = "core-skill" | "global-skill-dir";

export interface GlobalSkillCatalogEntry {
  id: string;
  source: GlobalSkillSource;
}

export const GLOBAL_SKILLS_CATALOG: readonly GlobalSkillCatalogEntry[] = [
  { id: "verify-before-done", source: "core-skill" },
  { id: "loop-back-debug", source: "core-skill" },
  { id: "review-diff", source: "core-skill" },
  { id: "pr-create", source: "core-skill" },
  { id: "ticket-intake", source: "core-skill" },
  { id: "spec-bootstrap", source: "core-skill" },
  { id: "work-unit-commits", source: "global-skill-dir" },
  { id: "branch-pr", source: "global-skill-dir" },
  { id: "chained-pr", source: "global-skill-dir" },
  { id: "pr-comments", source: "global-skill-dir" },
  { id: "issue-creation", source: "global-skill-dir" },
  { id: "comment-writer", source: "global-skill-dir" },
  { id: "judgment-day", source: "global-skill-dir" },
  { id: "cognitive-doc-design", source: "global-skill-dir" },
  { id: "ship-docs", source: "global-skill-dir" },
  { id: "app-ia", source: "global-skill-dir" },
  { id: "dashboard-ia", source: "global-skill-dir" },
  { id: "skill-creator", source: "global-skill-dir" },
  { id: "skill-improver", source: "global-skill-dir" },
];

export function listGlobalSkillIds(): string[] {
  return GLOBAL_SKILLS_CATALOG.map((e) => e.id);
}

export function isKnownGlobalSkillId(id: string): boolean {
  return GLOBAL_SKILLS_CATALOG.some((e) => e.id === id);
}

export function globalSkillSource(id: string): GlobalSkillSource | undefined {
  return GLOBAL_SKILLS_CATALOG.find((e) => e.id === id)?.source;
}

/** Managed-block marker `source` for a catalog skill. A core-skill shares
 * `@navori/core`'s provenance (it's the same bundled content the repo target
 * renders); a promoted skill gets its own id-scoped source — mirrors
 * `featureSource()` in lib/features.ts (`@navori/feature-<id>`) so drift and
 * ownership attribute correctly per skill. */
export function globalSkillMarkerSource(id: string): string {
  return globalSkillSource(id) === "core-skill" ? "@navori/core" : `@navori/global-skill-${id}`;
}

export interface GlobalSkillAssetLocation {
  /** Absolute dir the skill's files live in. */
  dir: string;
  /** Filename of the primary doc, relative to `dir` (`"<id>.md"` or `"SKILL.md"`). */
  entryFile: string;
}

/** Where a catalog skill's primary doc lives on disk, or null for an id
 * outside the catalog (a stale/unknown config entry — the caller skips it). */
export function resolveGlobalSkillAsset(id: string): GlobalSkillAssetLocation | null {
  const source = globalSkillSource(id);
  if (!source) return null;
  const coreAssets = resolve(getCoreRoot(), "core-assets");
  if (source === "core-skill") {
    return { dir: join(coreAssets, "skills"), entryFile: `${id}.md` };
  }
  return { dir: join(coreAssets, "global-skills", id), entryFile: "SKILL.md" };
}

/** Aux files (siblings of the entry file, e.g. `references/*.md`) a promoted
 * skill ships alongside its SKILL.md. Always empty for a core-skill (flat
 * file, no siblings) or an unknown id. Paths are relative to the skill's
 * `dir`, OS-native separators (matches how callers join them onto destRelPath). */
export function globalSkillAuxFiles(id: string): string[] {
  if (globalSkillSource(id) !== "global-skill-dir") return [];
  const loc = resolveGlobalSkillAsset(id);
  if (!loc) return [];
  const out: string[] = [];
  collectAuxFiles(loc.dir, loc.dir, loc.entryFile, out);
  return out;
}

function collectAuxFiles(root: string, dir: string, entryFile: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      collectAuxFiles(root, abs, entryFile, out);
      continue;
    }
    const rel = abs.slice(root.length + sep.length);
    if (rel === entryFile) continue;
    out.push(rel);
  }
}

/** Truncate text to ~`max` chars for the init multiselect hint, breaking at a
 * word boundary when one is reasonably close so the hint never looks chopped
 * mid-word. */
export function truncateForHint(text: string, max = 90): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max * 0.4 ? cut.slice(0, lastSpace) : cut;
  return base.trimEnd() + "…";
}

/** Read a catalog skill's frontmatter `description` for the `global init`
 * multiselect hint. Falls back to the id itself when the asset can't be read
 * (unknown id, or a dev checkout missing the file) — defensive, never throws
 * from a prompt-rendering path. */
export function globalSkillPromptHint(id: string): string {
  const loc = resolveGlobalSkillAsset(id);
  if (!loc) return id;
  let raw: string;
  try {
    raw = readFileSync(join(loc.dir, loc.entryFile), "utf-8");
  } catch {
    return id;
  }
  const { meta } = parseSkillFrontmatter(raw);
  const description = unquote(meta.description ?? "");
  return description ? truncateForHint(description) : id;
}

/** A frontmatter value captured as raw text may still carry its YAML
 * double-quoted-scalar quoting (the promoted skills all write `description`
 * this way). Unquote via JSON.parse (double-quoted YAML flow scalars are
 * valid JSON strings); anything that doesn't parse is returned as-is. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  return value;
}
