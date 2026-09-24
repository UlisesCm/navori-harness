import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Spec 0033 D2, F03 (R11, R12) — the render-level half of the local-skills
 * pointer: a declared id with no source is named as missing, and a destination
 * the user wrote by hand is left byte-identical and reported, never silently
 * adopted or pruned. `local-skills.test.ts` (`engines/codex/__tests__`) pins
 * the same rules at the adapter level; this file pins them through the full
 * `runRender` path the CLI actually calls.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

const { runRender } = await import("../render.ts");
const { writeConfig } = await import("../../lib/config/config.ts");

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-render-local-skills-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeConfigWithLocalSkill(id: string, engines: string[] = ["codex"]): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines,
    preset: "custom",
    project: { localSkills: [id] },
  });
}

function countOccurrences(warnings: string[], id: string): number {
  return warnings.filter((w) => w.includes(id)).length;
}

function writeSource(id: string): void {
  const dir = join(cwd, ".claude/skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: Use when testing render-level warnings.\n---\n\nBody.\n`,
  );
}

function codexWarnings(result: ReturnType<typeof runRender>): string[] {
  return result.extraEngines?.find((e) => e.engine === "codex")?.warnings ?? [];
}

describe("runRender — local skills, missing (R11)", () => {
  // Covers: R11
  it("names the missing id and creates no destination (codex configured)", () => {
    writeConfigWithLocalSkill("ghost");

    const result = runRender(cwd, false);

    expect(result.ok).toBe(true);
    expect(existsSync(join(cwd, ".agents/skills/ghost"))).toBe(false);
    expect(codexWarnings(result).some((w) => w.includes("ghost"))).toBe(true);
  });

  // Covers: R11
  it("names the missing id exactly once in a claude-only repo — R9 scopes the pointer destination to Codex, not this warning", () => {
    writeConfigWithLocalSkill("ghost-claude-only", ["claude"]);

    const result = runRender(cwd, false);

    expect(result.ok).toBe(true);
    const allWarnings = [
      ...(result.engineResult?.warnings ?? []),
      ...(result.extraEngines?.flatMap((e) => e.warnings) ?? []),
    ];
    expect(countOccurrences(allWarnings, "ghost-claude-only")).toBe(1);
  });

  // Covers: R11
  it("names the missing id exactly once when both claude and codex are configured", () => {
    writeConfigWithLocalSkill("ghost-both", ["claude", "codex"]);

    const result = runRender(cwd, false);

    expect(result.ok).toBe(true);
    const allWarnings = [
      ...(result.engineResult?.warnings ?? []),
      ...(result.extraEngines?.flatMap((e) => e.warnings) ?? []),
    ];
    expect(countOccurrences(allWarnings, "ghost-both")).toBe(1);
  });
});

describe("runRender — local skills, foreign destination (R12)", () => {
  // Covers: R12
  it("leaves a hand-written destination byte-identical and reports the exact warning", () => {
    writeConfigWithLocalSkill("mine");
    writeSource("mine");
    const destDir = join(cwd, ".agents/skills/mine");
    mkdirSync(destDir, { recursive: true });
    const handWritten = "# Written by hand, not by navori.\nname: mine\n";
    writeFileSync(join(destDir, "SKILL.md"), handWritten);

    const result = runRender(cwd, false);

    expect(result.ok).toBe(true);
    // Byte-identical: apply never touched it.
    expect(readFileSync(join(destDir, "SKILL.md"), "utf-8")).toBe(handWritten);
    // Never reported as written or removed.
    const codex = result.extraEngines?.find((e) => e.engine === "codex");
    expect(codex?.written.some((w) => w.path.includes("mine"))).toBe(false);
    // The exact foreign warning, naming the path.
    expect(
      codexWarnings(result).some(
        (w) => w.includes(".agents/skills/mine/SKILL.md") && w.includes("navori"),
      ),
    ).toBe(true);
  });
});
