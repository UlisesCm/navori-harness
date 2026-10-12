import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { renderClaudeEngine } from "../claude/index.ts";
import { renderAgentsMdEngine } from "../agents-md/index.ts";
import { renderCursorEngine } from "../cursor/index.ts";
import { renderCopilotEngine } from "../copilot/index.ts";
import { getCoreRoot } from "../../lib/render/bundled-assets.ts";
import type { NavoriConfig } from "../../lib/config/config.ts";

/**
 * #1273 — the always-on Claude file stops carrying doctrine only some roles
 * need (ticket-intake rules, SDD Structure/Tracking), while the prose engines
 * (no skill loading) keep the full text. The same asset feeds both: the
 * reserved `onClaude` key picks the form.
 */

const CONFIG = {
  name: "diet",
  engines: ["claude", "agents-md", "cursor", "copilot"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm test", full: "pnpm test" },
} as unknown as NavoriConfig;

const CORE_ASSETS = resolve(getCoreRoot(), "core-assets");
const readAsset = (rel: string): string => readFileSync(resolve(CORE_ASSETS, rel), "utf-8");

/** The four principle bullets of the intake block (source of truth: the block). */
const INTAKE_BULLETS = [
  "**The problem is the contract.**",
  "**The proposed solution is a suggestion, never the spec.**",
  "**Not every ticket proceeds.**",
  "**Size is measured, not assumed.**",
] as const;

const SKILL_POINTER = ".claude/skills/resolve-ticket/SKILL.md";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "navori-diet-"));
  dirs.push(d);
  return d;
}

describe("Claude CLAUDE.md — invariant + pointer instead of the full doctrine", () => {
  it("intake: keeps the ticket contract and points at the skill file, drops the bullets", () => {
    const cwd = tmp();
    renderClaudeEngine(cwd, CONFIG);
    const md = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
    expect(md).toContain("problem is the contract");
    expect(md).toContain(SKILL_POINTER);
    for (const bullet of INTAKE_BULLETS) expect(md).not.toContain(bullet);
    expect(md).not.toContain("navori:if");
  });

  it("sdd: keeps the trigger and the no-TaskCreate rule, drops Structure/Tracking prose", () => {
    const cwd = tmp();
    renderClaudeEngine(cwd, CONFIG);
    const md = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
    expect(md).toContain("When to PROPOSE a spec");
    expect(md).toContain("do NOT use `TaskCreate`");
    expect(md).not.toContain("**Structure:**");
    expect(md).not.toContain("Covers: R");
  });

  it("ships neither the skills index nor gh-protocol", () => {
    const cwd = tmp();
    renderClaudeEngine(cwd, { ...CONFIG, plugins: { gh: { enabled: true } } } as NavoriConfig);
    const md = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
    expect(md).not.toContain('id="skills-index"');
    expect(md).not.toContain('id="gh-protocol"');
  });
});

describe("prose engines keep the full intake and SDD text", () => {
  const renderers: ReadonlyArray<readonly [string, string, (cwd: string) => unknown]> = [
    ["agents-md", "AGENTS.md", (cwd) => renderAgentsMdEngine(cwd, CONFIG)],
    ["cursor", ".cursor/rules/navori.mdc", (cwd) => renderCursorEngine(cwd, CONFIG)],
    ["copilot", ".github/copilot-instructions.md", (cwd) => renderCopilotEngine(cwd, CONFIG)],
  ];

  for (const [engine, file, render] of renderers) {
    it(`${engine}: full intake bullets and SDD Structure/Tracking, no pointer, no markers`, () => {
      const cwd = tmp();
      render(cwd);
      const out = readFileSync(join(cwd, file), "utf-8");
      for (const bullet of INTAKE_BULLETS) expect(out).toContain(bullet);
      expect(out).not.toContain(SKILL_POINTER);
      expect(out).toContain("**Structure:**");
      expect(out).toContain("Covers: R");
      expect(out).not.toContain("navori:if");
    });
  }
});

describe("intake doctrine: two owners by engine, one wording", () => {
  // Covers: #1273
  it("every intake bullet in the block (prose engines) is verbatim in resolve-ticket (Claude)", () => {
    const block = readAsset("managed/intake-tickets.md");
    const skill = readAsset("skills/resolve-ticket.md");
    const bullets = block.split("\n").filter((l) => l.startsWith("- **"));
    expect(bullets).toHaveLength(INTAKE_BULLETS.length);
    for (const bullet of bullets) {
      expect(skill, `resolve-ticket lost the intake bullet "${bullet.slice(0, 40)}…"`).toContain(
        bullet,
      );
    }
  });

  // Covers: #1273
  it("the SDD threshold stays single-owner and spec-bootstrap owns the Covers convention", () => {
    expect(readAsset("managed/sdd.md")).toContain("~2 days");
    expect(readAsset("skills/spec-bootstrap.md")).not.toContain("~2 days");
    expect(readAsset("skills/spec-bootstrap.md")).toContain("// Covers: R<n>");
  });
});
