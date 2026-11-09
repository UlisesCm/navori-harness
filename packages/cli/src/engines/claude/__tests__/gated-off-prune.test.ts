import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import type { NavoriConfig } from "../../../lib/config/config.ts";

/**
 * #1484: Claude Code discovers skills and agents by walking the directory, so a
 * unit whose opt-in flag is off must not linger from a render that had it on.
 * Same marker-gated, pristine-only removal as the native retirements (§8.7e).
 */

const BASE = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

const ON = {
  ...BASE,
  harness: { scribeOwnsMarkdown: true, planTiers: true, authoring: true },
  hooks: { modelAdvisor: true },
} as unknown as NavoriConfig;

const SKILL = ".claude/skills/dominio/SKILL.md";
const PLAN_SKILL = ".claude/skills/plan-simple/SKILL.md";
const AGENT = ".claude/agents/scribe.md";
const HOOK = ".claude/hooks/model-advisor.sh";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-gated-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("render — poda unidades tras un flag opt-in apagado (#1484)", () => {
  it("renders the gated units only with their flag", () => {
    renderClaudeEngine(cwd, BASE);
    for (const rel of [SKILL, PLAN_SKILL, AGENT, HOOK])
      expect(existsSync(join(cwd, rel))).toBe(false);
    renderClaudeEngine(cwd, ON);
    for (const rel of [SKILL, PLAN_SKILL, AGENT, HOOK])
      expect(existsSync(join(cwd, rel))).toBe(true);
  });

  it("removes a pristine gated-off skill, agent and hook; flag back on re-renders them", () => {
    renderClaudeEngine(cwd, ON);
    renderClaudeEngine(cwd, BASE);
    for (const rel of [SKILL, PLAN_SKILL, AGENT, HOOK])
      expect(existsSync(join(cwd, rel))).toBe(false);
    const settings = readFileSync(join(cwd, ".claude/settings.json"), "utf-8");
    expect(settings).not.toContain("model-advisor");
    renderClaudeEngine(cwd, ON);
    for (const rel of [SKILL, PLAN_SKILL, AGENT, HOOK])
      expect(existsSync(join(cwd, rel))).toBe(true);
  });

  it("keeps an edited copy", () => {
    renderClaudeEngine(cwd, ON);
    const skill = join(cwd, SKILL);
    writeFileSync(skill, `${readFileSync(skill, "utf-8")}\nnota del usuario\n`, "utf-8");
    renderClaudeEngine(cwd, BASE);
    expect(existsSync(skill)).toBe(true);
    expect(existsSync(join(cwd, PLAN_SKILL))).toBe(false);
  });

  it("keeps a skill the user reclaimed through project.localSkills", () => {
    renderClaudeEngine(cwd, ON);
    renderClaudeEngine(cwd, { ...BASE, project: { localSkills: ["dominio"] } } as NavoriConfig);
    expect(existsSync(join(cwd, SKILL))).toBe(true);
    expect(existsSync(join(cwd, PLAN_SKILL))).toBe(false);
  });
});
