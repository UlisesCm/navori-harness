/**
 * Unfilled skill user-sections (#369).
 *
 * Several core skills ship a managed body plus an empty user-section for the
 * repo's own rules. The skill says so itself: "without the rules specific to
 * your stack (below), the review only covers the universal layer". Measured in
 * the field on the most obvious security ticket imaginable, `security-guidance`
 * contributed nothing, because its stack section was still the blank template.
 *
 * That is worse than not installing the skill: it costs a read and buys a false
 * sense of coverage. Filling it is each repo's job — but navori can SEE that
 * nobody did, and visible debt is the difference between a gap and a surprise.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SKILL_DIR_ENTRY } from "./skill-meta.ts";

export interface EmptyUserSection {
  /** Skill id (directory or flat file name without the extension). */
  id: string;
  /** Repo-relative path of the rendered skill. */
  path: string;
}

/** Everything after the managed block's closing marker — the user's half. */
function userHalf(content: string): string | null {
  const close = content.lastIndexOf("<!-- /navori:managed");
  if (close === -1) return null;
  const eol = content.indexOf("\n", close);
  return eol === -1 ? "" : content.slice(eol + 1);
}

/**
 * True when the user half carries nothing but the scaffolding navori rendered:
 * headings and the `<!-- user: … -->` guidance comment. One line of real prose
 * — a bullet, a sentence, a code fence — is enough to count as filled; judging
 * whether it's GOOD content is not doctor's business.
 */
function isUntouched(half: string): boolean {
  const stripped = half
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t !== "" && !t.startsWith("#");
    });
  return stripped.length === 0;
}

/** Rendered skill files under `dir`, in both shapes navori emits. */
function skillFiles(dir: string): Array<{ id: string; file: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; file: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) {
        const file = join(full, SKILL_DIR_ENTRY);
        if (existsSync(file)) out.push({ id: entry, file });
      } else if (entry.endsWith(".md")) {
        out.push({ id: entry.replace(/\.md$/, ""), file: full });
      }
    } catch {
      // unreadable entry — doctor never fails over a stat
    }
  }
  return out;
}

/**
 * Installed skills whose user-section is still the rendered template. A skill
 * with NO user-section at all is not reported: it declares no repo-specific
 * half, so there is nothing to fill.
 */
export function scanEmptyUserSections(
  cwd: string,
  skillsDirs: readonly string[],
): EmptyUserSection[] {
  const out: EmptyUserSection[] = [];
  for (const rel of skillsDirs) {
    for (const { id, file } of skillFiles(join(cwd, rel))) {
      let content: string;
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      const half = userHalf(content);
      if (half === null || half.trim() === "") continue; // no user-section declared
      if (isUntouched(half))
        out.push({ id, path: `${rel}/${file.slice(join(cwd, rel).length + 1)}` });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
