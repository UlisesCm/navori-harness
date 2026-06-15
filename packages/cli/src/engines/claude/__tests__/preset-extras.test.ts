import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

const BASE_CONFIG = {
  name: "demo",
  engines: ["claude"],
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
} as unknown as NavoriConfig;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-preset-engine-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("renderClaudeEngine — preset.extras (spec 0001 fase 2)", () => {
  it("preset 'medusa' adds the 2 medusa skills on top of the 2 core skills", () => {
    const config = { ...BASE_CONFIG, preset: "medusa" } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, config);

    // Core skills always render
    expect(existsSync(join(cwd, ".claude/skills/verify-before-done.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/loop-back-debug.md"))).toBe(true);

    // Preset extras land alongside
    expect(existsSync(join(cwd, ".claude/skills/medusa-modules.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/medusa-api-routes.md"))).toBe(true);

    const modulesContent = readFileSync(join(cwd, ".claude/skills/medusa-modules.md"), "utf-8");
    expect(modulesContent).toContain('id="medusa-modules"');
    expect(modulesContent).toContain("Medusa Modules");
  });

  it("preset 'medusa' interpolates {{qualityGate.fast}} in extras", () => {
    const config = { ...BASE_CONFIG, preset: "medusa" } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, config);
    const content = readFileSync(join(cwd, ".claude/skills/medusa-api-routes.md"), "utf-8");
    expect(content).toContain("pnpm typecheck");
    expect(content).not.toContain("{{qualityGate.fast}}");
  });

  it("preset 'custom' is back-compat: no extras, only core skills render", () => {
    const config = { ...BASE_CONFIG, preset: "custom" } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, config);

    expect(existsSync(join(cwd, ".claude/skills/verify-before-done.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/loop-back-debug.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/medusa-modules.md"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/skills/medusa-api-routes.md"))).toBe(false);
  });

  it("preset with no matching file is silent (no warning, no error)", () => {
    const config = { ...BASE_CONFIG, preset: "ghost-preset" } as unknown as NavoriConfig;
    const r = renderClaudeEngine(cwd, config);
    expect(r.warnings.find((w) => w.includes("ghost-preset"))).toBeUndefined();
    expect(existsSync(join(cwd, ".claude/skills/verify-before-done.md"))).toBe(true);
  });

  it("preset.extras files are reported in `written` and counted in `inspected`", () => {
    const config = { ...BASE_CONFIG, preset: "medusa" } as unknown as NavoriConfig;
    const r = renderClaudeEngine(cwd, config);
    const medusaWritten = r.written.filter((w) => w.path.includes("medusa"));
    expect(medusaWritten).toHaveLength(2);
    // inspected covers core + preset extras (among others); must be >= 4 (2 core skills + 2 medusa)
    expect(r.inspected).toBeGreaterThanOrEqual(4);
  });
});
