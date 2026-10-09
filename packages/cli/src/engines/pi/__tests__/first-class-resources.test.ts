import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/config/schema.ts";
import { renderCodexEngine } from "../../codex/index.ts";
import { renderPiEngine } from "../index.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(engines: string[], localSkills: string[]): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "pi-resources",
    preset: "custom",
    engines,
    branchBase: "main",
    qualityGate: { fast: "bun test", full: "bun test" },
    project: { localSkills },
  });
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-resources-"));
  dirs.push(dir);
  return dir;
}

function writeSource(cwd: string, id: string, description: string): string {
  const dir = join(cwd, ".claude/skills", id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(
    path,
    `---\nname: ${id}\ndescription: ${description}\n---\n\n## Body\n\nProse the pointer never copies.\n`,
  );
  return path;
}

const pointerPath = (cwd: string, id: string): string => join(cwd, `.agents/skills/${id}/SKILL.md`);
const pointerRel = (id: string): string => `.agents/skills/${id}/SKILL.md`;

describe("Pi local skill discovery", () => {
  // Covers: R9
  it("local skill discovery without duplicate body", () => {
    // Pi-only: a pointer to the user's source, never a copy of its body.
    const cwd = freshDir();
    const source = writeSource(cwd, "probe", "Use when probing Pi discovery.");
    const sourceBefore = readFileSync(source, "utf-8");
    const piOnly = config(["pi"], ["probe"]);
    const first = renderPiEngine(cwd, piOnly);
    const pointer = readFileSync(pointerPath(cwd, "probe"), "utf-8");
    expect(first.written.some((w) => w.path === pointerRel("probe"))).toBe(true);
    expect(pointer).toContain("name: probe");
    expect(pointer).toContain("Use when probing Pi discovery.");
    expect(pointer).toContain(".claude/skills/probe/SKILL.md");
    expect(pointer).not.toContain("Prose the pointer never copies.");
    expect(readFileSync(source, "utf-8")).toBe(sourceBefore);

    // Dry-run reports what apply writes and touches nothing.
    const dryDir = freshDir();
    writeSource(dryDir, "probe", "Use when probing Pi discovery.");
    const dry = renderPiEngine(dryDir, piOnly, { dryRun: true });
    expect(existsSync(pointerPath(dryDir, "probe"))).toBe(false);
    const applied = freshDir();
    writeSource(applied, "probe", "Use when probing Pi discovery.");
    const real = renderPiEngine(applied, piOnly);
    expect(dry.written.map((w) => w.path).sort()).toEqual(real.written.map((w) => w.path).sort());

    // Missing source: nothing is invented.
    const missing = freshDir();
    renderPiEngine(missing, config(["pi"], ["ghost"]));
    expect(existsSync(pointerPath(missing, "ghost"))).toBe(false);

    // Foreign destination: untouched and warned.
    const foreign = freshDir();
    writeSource(foreign, "mine", "Use when mine.");
    mkdirSync(join(foreign, ".agents/skills/mine"), { recursive: true });
    writeFileSync(pointerPath(foreign, "mine"), "user-owned skill\n");
    const foreignResult = renderPiEngine(foreign, config(["pi"], ["mine"]));
    expect(readFileSync(pointerPath(foreign, "mine"), "utf-8")).toBe("user-owned skill\n");
    expect(foreignResult.warnings.some((w) => w.includes(pointerRel("mine")))).toBe(true);

    // A plan skill with the same id wins over the local declaration.
    const collision = freshDir();
    writeSource(collision, "verify-before-done", "Local copy that must lose.");
    renderPiEngine(collision, config(["pi"], ["verify-before-done"]));
    const planSkill = readFileSync(pointerPath(collision, "verify-before-done"), "utf-8");
    expect(planSkill).not.toContain("Local copy that must lose.");
    expect(planSkill).not.toContain("-local-pointer");

    // Retired id: pointer pruned with a backup.
    const retired = freshDir();
    writeSource(retired, "retiring", "Use while declared.");
    renderPiEngine(retired, config(["pi"], ["retiring"]));
    expect(existsSync(pointerPath(retired, "retiring"))).toBe(true);
    const pruned = renderPiEngine(retired, config(["pi"], []));
    expect(existsSync(pointerPath(retired, "retiring"))).toBe(false);
    expect(pruned.backupPath).toBeTruthy();

    // Pi -> Pi+Codex -> Pi: one writer, byte-stable pointer.
    const transition = freshDir();
    writeSource(transition, "shared", "Use when shared across engines.");
    renderPiEngine(transition, config(["pi"], ["shared"]));
    const piBytes = readFileSync(pointerPath(transition, "shared"), "utf-8");
    const both = config(["pi", "codex"], ["shared"]);
    const piWithCodex = renderPiEngine(transition, both);
    expect(piWithCodex.written.some((w) => w.path.startsWith(".agents/skills/"))).toBe(false);
    renderCodexEngine(transition, both);
    expect(readFileSync(pointerPath(transition, "shared"), "utf-8")).toBe(piBytes);
    const backToPi = renderPiEngine(transition, config(["pi"], ["shared"]));
    expect(backToPi.written.some((w) => w.path === pointerRel("shared"))).toBe(false);
    expect(readFileSync(pointerPath(transition, "shared"), "utf-8")).toBe(piBytes);
  });
});
