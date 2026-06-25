import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import { computeManagedHash } from "../../../lib/marker.ts";
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
        // mongoose + zod-validation are now library skills (detected deps),
        // injected via project.libraries alongside the preset's own skills.
        project: { libraries: ["mongoose", "zod-validation"] },
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

  describe("library skills (dependency-detected, cross-preset)", () => {
    const withLibraries = (libraries: string[], extra: Record<string, unknown> = {}) =>
      ({
        ...BASE_CONFIG,
        preset: "express-mongoose",
        project: { libraries, ...extra },
      }) as unknown as NavoriConfig;

    it("materializes a library skill when its id is in project.libraries", () => {
      renderClaudeEngine(cwd, withLibraries(["mongoose"]));
      expect(existsSync(join(cwd, ".claude/skills/mongoose.md"))).toBe(true);
    });

    it("is additive — zod AND joi can render together (no XOR exclusivity)", () => {
      // The old validator mechanism was zod-XOR-joi; library skills are additive.
      renderClaudeEngine(cwd, withLibraries(["zod-validation", "joi-validation"]));
      expect(existsSync(join(cwd, ".claude/skills/zod-validation.md"))).toBe(true);
      expect(existsSync(join(cwd, ".claude/skills/joi-validation.md"))).toBe(true);
    });

    it("renders no library skill when project.libraries is empty", () => {
      renderClaudeEngine(cwd, withLibraries([]));
      expect(existsSync(join(cwd, ".claude/skills/mongoose.md"))).toBe(false);
      expect(existsSync(join(cwd, ".claude/skills/zod-validation.md"))).toBe(false);
      // The preset's own always-on skills still render.
      expect(existsSync(join(cwd, ".claude/skills/express-routes.md"))).toBe(true);
    });

    it("ignores an unknown library id without crashing the render", () => {
      const r = renderClaudeEngine(cwd, withLibraries(["does-not-exist", "mongoose"]));
      expect(existsSync(join(cwd, ".claude/skills/does-not-exist.md"))).toBe(false);
      expect(existsSync(join(cwd, ".claude/skills/mongoose.md"))).toBe(true);
      expect(r.warnings.find((w) => w.includes("not found"))).toBeUndefined();
    });

    it("lists detected library skills in the skills index as '— library (detected)'", () => {
      renderClaudeEngine(cwd, withLibraries(["joi-validation"], { localSkills: ["my-local"] }));
      const claudeMd = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
      // Assert on the index row format — stack.md mentions both names in prose
      // on purpose, so a bare substring would false-positive.
      expect(claudeMd).toContain("`joi-validation` — library (detected)");
      expect(claudeMd).not.toContain("`zod-validation` — library (detected)");
    });

    it("indexes detected library skills even when the repo declares no local skills", () => {
      // Discoverability: the skills index used to render only when project.localSkills
      // was non-empty, so a repo with detected library skills but no local skills got
      // the .md files but no index row. The index now renders whenever there's
      // anything to list (core skills are always present).
      renderClaudeEngine(cwd, withLibraries(["mongoose"]));
      const claudeMd = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
      expect(claudeMd).toContain('navori:managed id="skills-index"');
      expect(claudeMd).toContain("`mongoose` — library (detected)");
      // Core skills are listed too, and the project-local note is omitted (none declared).
      expect(claudeMd).toContain("`verify-before-done` — navori");
      expect(claudeMd).not.toContain("project-local");
    });

    it("upgrades a preset-era skill file in place — no duplicate managed block", () => {
      // Migration guard: mongoose/zod/joi used to ship from the express-mongoose
      // preset with managed-block id="mongoose" (the bare id). They now ship from
      // this library layer. The library managedId MUST equal the bare id so an
      // existing preset-era file is recognized and updated in place; a distinct
      // id would append a second block and duplicate the skill content.
      const skillPath = join(cwd, ".claude/skills/mongoose.md");
      mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
      // Realistic preset-era file: a navori-owned block whose hash matches its
      // body, so the engine recognizes it as its own (not user-modified) and
      // updates it in place rather than skipping it.
      const oldBody = "OLD preset-era mongoose body";
      writeFileSync(
        skillPath,
        [
          "---",
          "name: mongoose",
          "---",
          "",
          `<!-- navori:managed id="mongoose" hash="${computeManagedHash(oldBody)}" version="0.0.1" source="@navori/core" -->`,
          oldBody,
          '<!-- /navori:managed id="mongoose" -->',
          "",
        ].join("\n"),
        "utf-8",
      );

      renderClaudeEngine(cwd, withLibraries(["mongoose"]));

      const content = readFileSync(skillPath, "utf-8");
      // Count only OPEN markers (the close prefix is `<!-- /navori:managed`).
      const openMarkers = content.match(/<!-- navori:managed id="mongoose"/g) ?? [];
      expect(openMarkers).toHaveLength(1);
      // The stale preset-era body was replaced, not left behind beside a new block.
      expect(content).not.toContain("OLD preset-era mongoose body");
      expect(content).not.toContain('id="mongoose-lib"');
    });
  });
});
