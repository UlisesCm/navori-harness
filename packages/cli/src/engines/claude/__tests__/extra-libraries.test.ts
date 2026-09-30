import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import type { NavoriConfig } from "../../../lib/config/config.ts";

// #1104 — `project.extraLibraries` is user-owned: rendered like a detected lib
// and never retired by the orphan sweep (§8.7), which deletes managed files.

const BASE = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm test", full: "pnpm test" },
} as unknown as NavoriConfig;

const cfg = (project: Record<string, unknown>): NavoriConfig =>
  ({ ...BASE, project }) as unknown as NavoriConfig;
const skill = (cwd: string): string => join(cwd, ".claude/skills/zod-validation/SKILL.md");

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-extra-libs-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("renderClaudeEngine — project.extraLibraries (#1104)", () => {
  // Covers: A2
  it("materializes an extra library skill even when detection found nothing", () => {
    renderClaudeEngine(cwd, cfg({ libraries: [], extraLibraries: ["zod-validation"] }));
    expect(existsSync(skill(cwd))).toBe(true);
  });

  // Covers: A2
  it("the orphan sweep does NOT retire an extra that was rendered before", () => {
    renderClaudeEngine(cwd, cfg({ libraries: ["zod-validation"] }));
    expect(existsSync(skill(cwd))).toBe(true);

    // Detection no longer reports it, but the user keeps it as an extra.
    renderClaudeEngine(cwd, cfg({ libraries: [], extraLibraries: ["zod-validation"] }));
    expect(existsSync(skill(cwd))).toBe(true);

    // Control: dropping the extra too does retire it.
    renderClaudeEngine(cwd, cfg({ libraries: [], extraLibraries: [] }));
    expect(existsSync(skill(cwd))).toBe(false);
  });

  // Covers: A2
  it("labels the skills-index row as 'library (extra)'", () => {
    renderClaudeEngine(cwd, cfg({ libraries: [], extraLibraries: ["zod-validation"] }));
    const files = readdirSync(cwd, { recursive: true, encoding: "utf-8" }).filter(
      (f) => f.endsWith(".md") && statSync(join(cwd, f)).isFile(),
    );
    const hit = files.some((f) => readFileSync(join(cwd, f), "utf-8").includes("library (extra)"));
    expect(hit).toBe(true);
  });

  // Covers: A2
  it("warns about an unknown extra id", () => {
    const r = renderClaudeEngine(cwd, cfg({ libraries: [], extraLibraries: ["ghost-lib"] }));
    expect(r.warnings.some((w) => w.includes("ghost-lib"))).toBe(true);
  });
});
