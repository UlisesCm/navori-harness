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

  it("preset declared in config but missing on disk surfaces a warning", () => {
    // The medusa-v2 vs medusa.json mismatch in moonar silently rendered the
    // backend workspace with no preset extras. Loud-fail prevents that.
    const config = { ...BASE_CONFIG, preset: "ghost-preset" } as unknown as NavoriConfig;
    const r = renderClaudeEngine(cwd, config);
    const found = r.warnings.find((w) => w.includes("ghost-preset"));
    expect(found).toBeDefined();
    expect(found).toContain("not found");
    // Core baseline still renders normally
    expect(existsSync(join(cwd, ".claude/skills/verify-before-done.md"))).toBe(true);
  });

  it("preset.extras files are reported in `written` and counted in `inspected`", () => {
    const config = { ...BASE_CONFIG, preset: "medusa" } as unknown as NavoriConfig;
    const r = renderClaudeEngine(cwd, config);
    expect(r.written.filter((w) => w.path.includes("medusa")).map((w) => w.path).sort()).toEqual([
      ".claude/skills/medusa-api-routes.md",
      ".claude/skills/medusa-modules.md",
    ]);
    // BASE_CONFIG (no plugins) renders: CLAUDE.md + settings + 7 agents + 3 core
    // skills + 2 progress files + 2 medusa skills + 2 CLAUDE.md managed blocks
    // counted independently of the file + 1 always-on guard hook = 18 inspected.
    expect(r.inspected).toBe(18);
  });

  describe("bundled stack presets (B4)", () => {
    // Each B4 preset should render its skills without errors. The skill
    // contents themselves are validated by skills-assets.test.ts.
    const BUNDLED = [
      {
        id: "nextjs",
        skills: [".claude/skills/nextjs-app-router.md", ".claude/skills/nextjs-data-fetching.md"],
      },
      {
        id: "nestjs",
        skills: [".claude/skills/nestjs-modules.md", ".claude/skills/nestjs-dtos-validation.md"],
      },
      {
        id: "vite-react-ts-mantine",
        skills: [".claude/skills/mantine-ui-patterns.md", ".claude/skills/new-feature.md"],
      },
      {
        id: "astro",
        skills: [".claude/skills/astro-islands.md"],
      },
      {
        id: "background-worker",
        skills: [
          ".claude/skills/worker-lifecycle.md",
          ".claude/skills/job-scheduling.md",
          ".claude/skills/queue-consumers.md",
        ],
      },
      {
        id: "express-mongoose",
        // zod-validation is conditional on project.zodValidation; set it so the
        // validation skill renders alongside the always-on ones.
        project: { zodValidation: true },
        skills: [
          ".claude/skills/express-routes.md",
          ".claude/skills/mongoose.md",
          ".claude/skills/zod-validation.md",
          ".claude/skills/mongo-aggregations.md",
          ".claude/skills/winston-logging.md",
          ".claude/skills/new-resource.md",
          ".claude/skills/new-endpoint.md",
          ".claude/skills/ticket-intake.md",
          ".claude/skills/pr-create.md",
        ],
      },
    ];

    for (const preset of BUNDLED) {
      it(`preset '${preset.id}' renders ${preset.skills.length} skill(s) without warnings`, () => {
        const config = {
          ...BASE_CONFIG,
          preset: preset.id,
          ...((preset as { project?: unknown }).project ? { project: (preset as { project?: unknown }).project } : {}),
        } as unknown as NavoriConfig;
        const r = renderClaudeEngine(cwd, config);

        // No 'preset not found' warning
        const missing = r.warnings.find((w) => w.includes(preset.id) && w.includes("not found"));
        expect(missing).toBeUndefined();

        for (const skill of preset.skills) {
          expect(existsSync(join(cwd, skill))).toBe(true);
        }
      });
    }
  });

  describe("conditional preset extras (zod vs joi validation)", () => {
    const expressConfig = (project: Record<string, unknown>) =>
      ({ ...BASE_CONFIG, preset: "express-mongoose", project }) as unknown as NavoriConfig;

    it("renders zod-validation (not joi) when project.zodValidation is set", () => {
      renderClaudeEngine(cwd, expressConfig({ zodValidation: true }));
      expect(existsSync(join(cwd, ".claude/skills/zod-validation.md"))).toBe(true);
      expect(existsSync(join(cwd, ".claude/skills/joi-validation.md"))).toBe(false);
    });

    it("renders joi-validation (not zod) when project.joiValidation is set", () => {
      renderClaudeEngine(cwd, expressConfig({ joiValidation: true }));
      expect(existsSync(join(cwd, ".claude/skills/joi-validation.md"))).toBe(true);
      expect(existsSync(join(cwd, ".claude/skills/zod-validation.md"))).toBe(false);
    });

    it("renders neither validation skill when no validator flag is set", () => {
      renderClaudeEngine(cwd, expressConfig({}));
      expect(existsSync(join(cwd, ".claude/skills/zod-validation.md"))).toBe(false);
      expect(existsSync(join(cwd, ".claude/skills/joi-validation.md"))).toBe(false);
      // The always-on express skills still render.
      expect(existsSync(join(cwd, ".claude/skills/express-routes.md"))).toBe(true);
    });

    it("lists the active validation skill in the skills index, not the inactive one", () => {
      // The skills index is only emitted when the repo declares project-local
      // skills; add one so the index renders and we can assert on it.
      renderClaudeEngine(cwd, expressConfig({ joiValidation: true, localSkills: ["my-local"] }));
      const claudeMd = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
      // Assert on the index row format (`<name>` — preset) — the stack.md block
      // mentions both names in prose on purpose, so a bare substring won't do.
      expect(claudeMd).toContain("`joi-validation` — preset");
      expect(claudeMd).not.toContain("`zod-validation` — preset");
    });
  });
});
