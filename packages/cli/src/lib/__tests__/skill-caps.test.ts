import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSkillFrontmatter,
  countWords,
  skillWordCap,
  hasTrigger,
  SKILL_TYPE_CAPS,
} from "../skill-meta.ts";

/**
 * Spec 0003 §3.2.1 — every bundled SKILL.md must declare a recognized `type`
 * and stay within its word cap (or carry an explicit `maxWords` override).
 * Guards against a skill silently ballooning and spending tokens on every load.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..", "..", ".."); // packages/cli
const coreAssets = resolve(cliRoot, "..", "core", "core-assets");
const pluginsDir = resolve(cliRoot, "..", "plugins");

function mdFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => resolve(dir, f));
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => resolve(dir, e.name));
}

function collectSkillFiles(): string[] {
  const files = [
    ...mdFilesIn(resolve(coreAssets, "skills")),
    ...mdFilesIn(resolve(coreAssets, "lib-skills")),
  ];
  for (const preset of subdirs(resolve(coreAssets, "presets"))) {
    files.push(...mdFilesIn(resolve(preset, "skills")));
  }
  for (const plugin of subdirs(pluginsDir)) {
    files.push(...mdFilesIn(resolve(plugin, "skills")));
  }
  return files.sort();
}

const files = collectSkillFiles();

describe("skill output discipline (spec 0003 §3.2.1)", () => {
  it("finds the bundled skills", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.split("/").slice(-1)[0]!, f] as const))(
    "%s declares a valid type and respects its word cap",
    (_name, file) => {
      const { meta, body } = parseSkillFrontmatter(readFileSync(file, "utf-8"));
      expect(
        meta.type,
        `${file} must declare a valid 'type' (${Object.keys(SKILL_TYPE_CAPS).join("|")})`,
      ).not.toBeNull();

      const cap = skillWordCap(meta)!;
      const words = countWords(body);
      expect(
        words <= cap,
        `${file}: ${words} words exceeds cap ${cap} (type=${meta.type}${
          meta.maxWords ? `, maxWords=${meta.maxWords}` : ""
        }) — tighten the skill or add an explicit maxWords override`,
      ).toBe(true);
    },
  );

  // Spec 0003 §3.2.2 — descriptions must carry an activation trigger so the
  // skill loads on-demand, not always-on.
  it.each(files.map((f) => [f.split("/").slice(-1)[0]!, f] as const))(
    "%s has an activation trigger in its description",
    (_name, file) => {
      const { meta } = parseSkillFrontmatter(readFileSync(file, "utf-8"));
      expect(meta.description, `${file} is missing a description`).not.toBeNull();
      expect(
        hasTrigger(meta.description),
        `${file}: description has no activation trigger (e.g. "Aplica al…", "Usar cuando…", "Use when…") — needed for on-demand loading`,
      ).toBe(true);
    },
  );
});
