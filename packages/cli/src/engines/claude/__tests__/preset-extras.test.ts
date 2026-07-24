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
    expect(
      r.written
        .filter((w) => w.path.includes("medusa"))
        .map((w) => w.path)
        .sort(),
    ).toEqual([".claude/skills/medusa-api-routes.md", ".claude/skills/medusa-modules.md"]);
    // BASE_CONFIG (no plugins) renders: CLAUDE.md + settings + 8 agents + 5 core
    // skills + 3 workflow skills (ticket-intake, pr-create, spec-bootstrap) +
    // 2 progress files + 2 medusa skills + 2 CLAUDE.md managed blocks counted
    // independently of the file + 1 always-on guard hook = 24.
    expect(r.inspected).toBe(24);
  });

  describe("bundled stack presets (B4)", () => {
    // Each B4 preset should render its skills without errors. The skill
    // contents themselves are validated by skills-assets.test.ts.
    const BUNDLED = [
      {
        id: "nextjs",
        skills: [
          ".claude/skills/nextjs-app-router.md",
          ".claude/skills/nextjs-data-fetching.md",
          ".claude/skills/new-resource.md",
        ],
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
        id: "react-native-expo",
        skills: [".claude/skills/rn-performance.md", ".claude/skills/expo-runtime.md"],
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
        // mongoose + zod-validation + winston-logging are now library skills
        // (detected deps), injected via project.libraries alongside the preset's
        // own skills. ticket-intake + pr-create are always-on workflow skills.
        project: { libraries: ["mongoose", "zod-validation", "winston-logging"] },
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
          ...((preset as { project?: unknown }).project
            ? { project: (preset as { project?: unknown }).project }
            : {}),
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

    it("is additive — several library skills render together (no exclusivity)", () => {
      // Library skills have no mutual exclusion: a repo materializes every skill
      // whose dependency is present, across concerns.
      renderClaudeEngine(cwd, withLibraries(["zod-validation", "winston-logging"]));
      expect(existsSync(join(cwd, ".claude/skills/zod-validation.md"))).toBe(true);
      expect(existsSync(join(cwd, ".claude/skills/winston-logging.md"))).toBe(true);
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
      renderClaudeEngine(cwd, withLibraries(["winston-logging"], { localSkills: ["my-local"] }));
      const claudeMd = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
      // Assert on the index row format — stack.md mentions both names in prose
      // on purpose, so a bare substring would false-positive.
      expect(claudeMd).toContain("`winston-logging` — library (detected)");
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

    it("prunes a stale REMOVED library skill navori used to own (tombstone)", () => {
      // formik/joi-validation were retired from the registry. A repo rendered
      // before the removal still has the navori-owned file on disk; render deletes
      // it so agents stop seeing the legacy skill.
      const stale = join(cwd, ".claude/skills/formik.md");
      mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
      writeFileSync(
        stale,
        [
          "---",
          "name: formik",
          "---",
          "",
          '<!-- navori:managed id="formik" hash="x" version="0.0.1" source="@navori/core" -->',
          "OLD formik body",
          '<!-- /navori:managed id="formik" -->',
          "",
        ].join("\n"),
        "utf-8",
      );

      const r = renderClaudeEngine(cwd, withLibraries([]));

      expect(existsSync(stale)).toBe(false);
      expect(r.written.some((w) => w.path.endsWith("skills/formik.md"))).toBe(true);
    });

    it("does NOT prune a user's hand-written skill of the same name (no navori marker)", () => {
      // Safety: the tombstone only removes files carrying navori's marker for that
      // id. A user who wrote their own formik.md keeps it.
      const userOwned = join(cwd, ".claude/skills/joi-validation.md");
      mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
      writeFileSync(userOwned, "# My own joi notes — not navori's\n", "utf-8");

      renderClaudeEngine(cwd, withLibraries([]));

      expect(existsSync(userOwned)).toBe(true);
      expect(readFileSync(userOwned, "utf-8")).toContain("My own joi notes");
    });

    describe("orphaned managed skills (§8.7 — preset-dropped / deselected)", () => {
      // Write a navori-owned managed skill file on disk, as a prior render would.
      const writeManagedSkill = (id: string) => {
        const p = join(cwd, ".claude/skills", `${id}.md`);
        mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
        writeFileSync(
          p,
          [
            "---",
            `name: ${id}`,
            "---",
            "",
            `<!-- navori:managed id="${id}" hash="x" version="0.0.1" source="@navori/core" -->`,
            `OLD ${id} body`,
            `<!-- /navori:managed id="${id}" -->`,
            "",
          ].join("\n"),
          "utf-8",
        );
        return p;
      };

      it("prunes a managed skill the current config no longer renders (deselected/preset-dropped)", () => {
        // The real bug: express-mongoose once shipped zod-validation; the current
        // preset doesn't, and the repo doesn't select it. zod-validation is a valid
        // registry lib (NOT in REMOVED_LIB_SKILLS), so §8.6 never touches it.
        const stale = writeManagedSkill("zod-validation");

        const r = renderClaudeEngine(cwd, withLibraries([]));

        expect(existsSync(stale)).toBe(false);
        expect(r.written.some((w) => w.path.endsWith("skills/zod-validation.md"))).toBe(true);
      });

      it("keeps a currently-selected library skill (not an orphan)", () => {
        writeManagedSkill("zod-validation");
        renderClaudeEngine(cwd, withLibraries(["zod-validation"]));
        expect(existsSync(join(cwd, ".claude/skills/zod-validation.md"))).toBe(true);
      });

      it("never prunes a project-local skill (declared + no navori marker)", () => {
        // Safety: a user's own skill carries no navori marker and is listed in
        // project.localSkills — both guards must protect it.
        const local = join(cwd, ".claude/skills/my-local.md");
        mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
        writeFileSync(local, "# My own workflow — not navori's\n", "utf-8");

        renderClaudeEngine(cwd, withLibraries([], { localSkills: ["my-local"] }));

        expect(existsSync(local)).toBe(true);
        expect(readFileSync(local, "utf-8")).toContain("My own workflow");
      });

      it("never prunes a directory-form skill (<id>/SKILL.md)", () => {
        // Directory-form skills are user-owned by construction; the sweep is
        // scoped to the flat library-skill registry, never subdirectories.
        const dirSkill = join(cwd, ".claude/skills/custom/SKILL.md");
        mkdirSync(join(cwd, ".claude/skills/custom"), { recursive: true });
        writeFileSync(dirSkill, "# Custom directory skill\n", "utf-8");

        renderClaudeEngine(cwd, withLibraries([]));

        expect(existsSync(dirSkill)).toBe(true);
      });

      it("never prunes a managed file whose id is NOT a known library skill", () => {
        // Scope guard: the sweep iterates the LIBRARY_SKILLS registry, so a
        // preset-extra or any other managed skill file (id not a library id) is
        // never a candidate — even carrying navori's marker and absent from the
        // render set. This is what makes a preset-load failure unable to trigger a
        // false-positive deletion (covers the dir-scan hazard the review flagged).
        const notALib = writeManagedSkill("some-preset-skill");
        renderClaudeEngine(cwd, withLibraries([]));
        expect(existsSync(notALib)).toBe(true);
      });

      it("keeps a deselected library skill the user reclaimed as a local skill", () => {
        // A user who declares a library-named id in project.localSkills keeps their
        // file even without selecting the library.
        const reclaimed = writeManagedSkill("zod-validation");
        renderClaudeEngine(cwd, withLibraries([], { localSkills: ["zod-validation"] }));
        expect(existsSync(reclaimed)).toBe(true);
      });
    });
  });
});
