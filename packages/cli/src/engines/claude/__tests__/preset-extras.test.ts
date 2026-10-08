import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import { renderAgentsMdEngine } from "../../agents-md/index.ts";
import { computeManagedHash } from "../../../lib/render/marker.ts";
import type { NavoriConfig } from "../../../lib/config/config.ts";
import {
  effectiveConfigForWorkspace,
  enabledMonorepoWorkspaces,
} from "../../../lib/workspace/monorepo.ts";

/** Skills materialize in directory form (`<id>/SKILL.md`) — the shape Claude
 * Code auto-discovers (#166). Absolute path and repo-relative path helpers. */
const skFile = (cwd: string, id: string): string => join(cwd, ".claude/skills", id, "SKILL.md");
const skRel = (id: string): string => `.claude/skills/${id}/SKILL.md`;

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
    expect(existsSync(skFile(cwd, "verify-before-done"))).toBe(true);
    expect(existsSync(skFile(cwd, "debug-failure"))).toBe(true);

    // Preset extras land alongside
    expect(existsSync(skFile(cwd, "medusa-modules"))).toBe(true);
    expect(existsSync(skFile(cwd, "medusa-api-routes"))).toBe(true);

    const modulesContent = readFileSync(skFile(cwd, "medusa-modules"), "utf-8");
    expect(modulesContent).toContain('id="medusa-modules"');
    expect(modulesContent).toContain("Medusa Modules");
  });

  it("preset 'medusa' interpolates {{qualityGate.fast}} in extras", () => {
    const config = { ...BASE_CONFIG, preset: "medusa" } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, config);
    const content = readFileSync(skFile(cwd, "medusa-api-routes"), "utf-8");
    expect(content).toContain("pnpm typecheck");
    expect(content).not.toContain("{{qualityGate.fast}}");
  });

  // Covers: R29
  it("preset 'custom' is back-compat: no extras, only core skills render", () => {
    const config = { ...BASE_CONFIG, preset: "custom" } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, config);

    expect(existsSync(skFile(cwd, "verify-before-done"))).toBe(true);
    expect(existsSync(skFile(cwd, "debug-failure"))).toBe(true);
    expect(existsSync(skFile(cwd, "medusa-modules"))).toBe(false);
    expect(existsSync(skFile(cwd, "medusa-api-routes"))).toBe(false);
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
    expect(existsSync(skFile(cwd, "verify-before-done"))).toBe(true);
  });

  it("preset.extras files are reported in `written` and counted in `inspected`", () => {
    const config = { ...BASE_CONFIG, preset: "medusa" } as unknown as NavoriConfig;
    const r = renderClaudeEngine(cwd, config);
    expect(
      r.written
        .filter((w) => w.path.includes("medusa"))
        .map((w) => w.path)
        .sort(),
    ).toEqual([skRel("medusa-api-routes"), skRel("medusa-modules")]);
    // BASE_CONFIG (no plugins) renders: CLAUDE.md + settings + 8 agents
    // (orchestrator, implementer, reviewer, scout, auditor, publisher, scribe,
    // architect — spec 0032 R33 retired the `harness.architect` toggle, so it
    // always renders now)
    // + 7 core skills (spec 0026 T14 merges debug-error + loop-back-debug into
    // one debug-failure; spec 0029 T2 adds `secure-by-design`; #901 adds
    // `scoped-gate`) + 9 workflow skills (resolve-ticket, solution-design,
    // spec-bootstrap, dominio, follow-up-prs, and spec 0029 T2's
    // `quality-attributes`, plus `author-skill`, plus spec 0032's
    // `plan-simple`/`plan-advanced`) + 2 progress files + 2 medusa skills + 2 CLAUDE.md
    // managed blocks counted independently of the file + 1 guard hook +
    // 1 implementer-no-markdown hook (spec 0030, R3/R4) +
    // 1 subagent-no-background hook (#1003) + 1 session-start
    // hook + 1 lifecycle hook (subagent-stop; la de PreCompact se retiro en
    // #774) + 2 audit-mode hooks (trigger, close) + 1 managed-drift watcher
    // (#530) + 1 worktree-reclaim hook (#527) + 1 routing watcher (spec 0020)
    // + 1 PR routing hook (#705) + 1 comment-draft-confirm hook (spec 0026
    // E1) + 1 orchestrator block routed to `.claude/context/` (#573) + 2
    // session ceremonies + 1 agents index, same channel (#572) + 1
    // `planificacion` context block inspected-but-not-written (`harness.planTiers`
    // defaults `false`) + 1 `plan-maestro` context block inspected-but-not-written
    // (`harness.masterPlan` defaults `false`) + 2 Claude-only workflow skills +
    // 2 dormant Claude-only master-plan hooks + 1 general-purpose-confirm hook
    // (spec 0039 T35) + 1 Bash outcome watcher (spec 0039 T23) = 56.
    //
    // `architect` (spec 0032 R33) ahora suma siempre — ya no hay flag que lo
    // apague. Un conteo a mano en cinco sitios es justo lo que #703 dejo
    // anotado como deuda; mientras siga a mano, la enumeracion tiene que
    // cerrar con el numero.
    expect(r.inspected).toBe(56);
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
        // mantine-ui-patterns is a library skill (#1094), injected via the
        // detected `@mantine/core` dep -> project.libraries.
        project: { libraries: ["mantine-ui-patterns"] },
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
        // own skills. resolve-ticket + pr-create are always-on workflow skills.
        project: { libraries: ["mongoose", "zod-validation", "winston-logging"] },
        skills: [
          ".claude/skills/express-routes.md",
          ".claude/skills/mongoose.md",
          ".claude/skills/zod-validation.md",
          ".claude/skills/mongo-aggregations.md",
          ".claude/skills/winston-logging.md",
          ".claude/skills/new-resource.md",
          ".claude/skills/new-endpoint.md",
          ".claude/skills/resolve-ticket.md",
        ],
      },
    ];

    // Covers: R29 (the express-mongoose case below materializes
    // `.claude/skills/resolve-ticket.md`, the renamed always-on workflow skill)
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
          // The BUNDLED arrays document skills by their canonical `<id>.md`
          // name; on disk they materialize as `<id>/SKILL.md` directories.
          const id = basename(skill).replace(/\.md$/, "");
          expect(existsSync(skFile(cwd, id))).toBe(true);
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
      expect(existsSync(skFile(cwd, "mongoose"))).toBe(true);
    });

    it("is additive — several library skills render together (no exclusivity)", () => {
      // Library skills have no mutual exclusion: a repo materializes every skill
      // whose dependency is present, across concerns.
      renderClaudeEngine(cwd, withLibraries(["zod-validation", "winston-logging"]));
      expect(existsSync(skFile(cwd, "zod-validation"))).toBe(true);
      expect(existsSync(skFile(cwd, "winston-logging"))).toBe(true);
    });

    it("renders no library skill when project.libraries is empty", () => {
      renderClaudeEngine(cwd, withLibraries([]));
      expect(existsSync(skFile(cwd, "mongoose"))).toBe(false);
      expect(existsSync(skFile(cwd, "zod-validation"))).toBe(false);
      // The preset's own always-on skills still render.
      expect(existsSync(skFile(cwd, "express-routes"))).toBe(true);
    });

    it("ignores an unknown library id without crashing the render", () => {
      const r = renderClaudeEngine(cwd, withLibraries(["does-not-exist", "mongoose"]));
      expect(existsSync(skFile(cwd, "does-not-exist"))).toBe(false);
      expect(existsSync(skFile(cwd, "mongoose"))).toBe(true);
      expect(r.warnings.find((w) => w.includes("not found"))).toBeUndefined();
    });

    it("lists detected library skills in the prose skills index as '— library (detected)'", () => {
      // The Claude render has no skills index since #1273: the prose engines keep it.
      renderAgentsMdEngine(cwd, withLibraries(["winston-logging"], { localSkills: ["my-local"] }));
      const claudeMd = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
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
      renderAgentsMdEngine(cwd, withLibraries(["mongoose"]));
      const claudeMd = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
      expect(claudeMd).toContain("`mongoose` — library (detected)");
      // Core skills are listed too, and the project-local note is omitted (none declared).
      expect(claudeMd).toContain("`verify-before-done` — navori");
      expect(claudeMd).not.toContain("project-local");
    });

    it("migrates a preset-era FLAT skill to directory form — no stale duplicate", () => {
      // Migration guard: mongoose/zod/joi used to ship from the express-mongoose
      // preset as a FLAT `.claude/skills/mongoose.md` with managed-block
      // id="mongoose" (the bare id). They now ship from this library layer in
      // DIRECTORY form. The library managedId MUST equal the bare id so the
      // migration prune recognizes the flat twin by its marker and removes it;
      // a distinct id would leave the stale flat file beside the new directory
      // and the model would see the skill twice.
      const flatPath = join(cwd, ".claude/skills/mongoose.md");
      mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
      const oldBody = "OLD preset-era mongoose body";
      writeFileSync(
        flatPath,
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

      // The flat preset-era twin is pruned; the directory form carries the skill.
      expect(existsSync(flatPath)).toBe(false);
      const dirPath = skFile(cwd, "mongoose");
      expect(existsSync(dirPath)).toBe(true);
      const content = readFileSync(dirPath, "utf-8");
      // Exactly one managed block, fresh body, and never the "-lib" suffixed id.
      const openMarkers = content.match(/<!-- navori:managed id="mongoose"/g) ?? [];
      expect(openMarkers).toHaveLength(1);
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

      it("migrates a currently-selected library skill from flat to directory form", () => {
        // A selected lib rendered by an older navori exists as a flat file; this
        // render (re)writes the directory form and prunes the flat twin. The
        // skill survives — only its shape changes (not an orphan deletion).
        const flat = writeManagedSkill("zod-validation");
        renderClaudeEngine(cwd, withLibraries(["zod-validation"]));
        expect(existsSync(flat)).toBe(false);
        expect(existsSync(skFile(cwd, "zod-validation"))).toBe(true);
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

      it("never prunes a user's directory-form skill whose id is NOT a library id", () => {
        // The dir-form sweep is still scoped to the LIBRARY_SKILLS registry, so a
        // user's own `<id>/SKILL.md` under a non-library id is never a candidate —
        // and it carries no navori marker, so the marker gate protects it too.
        const dirSkill = join(cwd, ".claude/skills/custom/SKILL.md");
        mkdirSync(join(cwd, ".claude/skills/custom"), { recursive: true });
        writeFileSync(dirSkill, "# Custom directory skill\n", "utf-8");

        renderClaudeEngine(cwd, withLibraries([]));

        expect(existsSync(dirSkill)).toBe(true);
      });

      it("prunes a DESELECTED library skill left in directory form (dir orphan)", () => {
        // A lib rendered by THIS version orphans as `<id>/SKILL.md` once
        // deselected; §8.7 now sweeps the directory shape too, whole-dir when
        // SKILL.md is its only child.
        const skillDir = join(cwd, ".claude/skills/zod-validation");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          join(skillDir, "SKILL.md"),
          [
            "---",
            "name: zod-validation",
            "---",
            "",
            '<!-- navori:managed id="zod-validation" hash="x" version="0.0.1" source="@navori/core" -->',
            "OLD zod body",
            '<!-- /navori:managed id="zod-validation" -->',
            "",
          ].join("\n"),
          "utf-8",
        );

        renderClaudeEngine(cwd, withLibraries([]));

        expect(existsSync(skillDir)).toBe(false);
      });

      it("prunes only SKILL.md from a dir orphan that has user sibling files", () => {
        // Safety: a deselected lib dir that also holds the user's `references/`
        // loses only navori's SKILL.md, never the sibling assets.
        const skillDir = join(cwd, ".claude/skills/zod-validation");
        mkdirSync(join(skillDir, "references"), { recursive: true });
        writeFileSync(join(skillDir, "references", "notes.md"), "# mine\n", "utf-8");
        writeFileSync(
          join(skillDir, "SKILL.md"),
          [
            '<!-- navori:managed id="zod-validation" hash="x" version="0.0.1" source="@navori/core" -->',
            "OLD zod body",
            '<!-- /navori:managed id="zod-validation" -->',
            "",
          ].join("\n"),
          "utf-8",
        );

        renderClaudeEngine(cwd, withLibraries([]));

        expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
        expect(existsSync(join(skillDir, "references", "notes.md"))).toBe(true);
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

describe("mantine-ui-patterns preset -> library-skill transition (#1094)", () => {
  const configFor = (preset: string, libraries: string[]) =>
    ({
      ...BASE_CONFIG,
      preset,
      project: { libraries },
    }) as unknown as NavoriConfig;

  /** A skill file as an older navori (preset extra) rendered it, plus user text. */
  const writePresetEraSkill = (userTail: string): string => {
    const p = skFile(cwd, "mantine-ui-patterns");
    mkdirSync(join(cwd, ".claude/skills/mantine-ui-patterns"), { recursive: true });
    const oldBody = "OLD preset-era mantine body";
    writeFileSync(
      p,
      [
        "---",
        "name: mantine-ui-patterns",
        "---",
        "",
        `<!-- navori:managed id="mantine-ui-patterns" hash="${computeManagedHash(oldBody)}" version="0.0.1" source="@navori/core" -->`,
        oldBody,
        '<!-- /navori:managed id="mantine-ui-patterns" -->',
        userTail,
        "",
      ].join("\n"),
      "utf-8",
    );
    return p;
  };

  // Covers: A2 — same path, kept (not retired), user section preserved.
  it("vite-react-ts-mantine + @mantine/core keeps the skill at the same path with the user section", () => {
    const p = writePresetEraSkill("## Our rules\n\n- Never use inline styles here.");
    const r = renderClaudeEngine(cwd, configFor("vite-react-ts-mantine", ["mantine-ui-patterns"]));

    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("Never use inline styles here.");
    expect(content).not.toContain("OLD preset-era mantine body");
    // Ownership is marker-only and unchanged: same id, same source.
    expect(content).toMatch(/navori:managed id="mantine-ui-patterns" [^>]*source="@navori\/core"/);
    expect(
      r.written.some(
        (w) => w.path.includes("mantine-ui-patterns") && w.status === "removed-condition-false",
      ),
    ).toBe(false);
    expect(r.warnings.filter((w) => w.includes("mantine-ui-patterns"))).toEqual([]);
  });

  // Covers: A2 — the skill is no longer preset-exclusive.
  it("another preset + @mantine/core now receives the skill", () => {
    renderClaudeEngine(cwd, configFor("nextjs", ["mantine-ui-patterns"]));
    expect(existsSync(skFile(cwd, "mantine-ui-patterns"))).toBe(true);
  });

  // Covers: A4 — inverted: the preset implies the skill, so a stale/empty
  // project.libraries (no @mantine/core detected) must NOT retire it.
  it("vite-react-ts-mantine with libraries [] keeps the skill (preset implies it)", () => {
    const p = writePresetEraSkill("## Our rules\n\n- keep me");
    const r = renderClaudeEngine(cwd, configFor("vite-react-ts-mantine", []));
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf-8")).toContain("keep me");
    expect(r.written.some((w) => w.status === "removed-condition-false")).toBe(false);
  });

  // Covers: A2/A4 — switching away from the preset retires it via §8.7.
  it("switching to a preset without the lib retires the navori-owned skill", () => {
    const p = writePresetEraSkill("");
    const r = renderClaudeEngine(cwd, configFor("vite-react-ts", []));
    expect(existsSync(p)).toBe(false);
    expect(r.written.some((w) => w.path.includes("mantine-ui-patterns"))).toBe(true);
  });

  // Covers: A4 — C1: a declared preset that fails to load freezes retirement.
  it("a declared preset that is not found does not retire library skills", () => {
    const p = writePresetEraSkill("");
    renderClaudeEngine(cwd, configFor("ghost-preset", []));
    expect(existsSync(p)).toBe(true);
  });

  it("a user-authored file (no navori marker) at that path survives retirement", () => {
    const p = skFile(cwd, "mantine-ui-patterns");
    mkdirSync(join(cwd, ".claude/skills/mantine-ui-patterns"), { recursive: true });
    writeFileSync(p, "# my own mantine notes\n", "utf-8");
    renderClaudeEngine(cwd, configFor("vite-react-ts-mantine", []));
    expect(readFileSync(p, "utf-8")).toContain("my own mantine notes");
  });
});

describe("preset-implied library skills in a monorepo (#1094)", () => {
  // Covers: A4 — each workspace resolves ITS preset; no workspace.libraries needed.
  it("only the workspace whose preset implies the skill receives it", () => {
    const root = {
      ...BASE_CONFIG,
      monorepo: {
        enabled: true,
        tool: "pnpm",
        workspaces: [
          { name: "web", path: "apps/web", preset: "vite-react-ts-mantine" },
          { name: "api", path: "apps/api", preset: "vite-react-ts" },
        ],
      },
    } as unknown as NavoriConfig;
    const [web, api] = enabledMonorepoWorkspaces(root);
    for (const ws of [web!, api!]) {
      const wsCwd = join(cwd, ws.path);
      mkdirSync(wsCwd, { recursive: true });
      renderClaudeEngine(wsCwd, effectiveConfigForWorkspace(root, ws), {
        repoRoot: cwd,
        harnessScope: "minimal",
      });
    }
    expect(existsSync(skFile(join(cwd, "apps/web"), "mantine-ui-patterns"))).toBe(true);
    expect(existsSync(skFile(join(cwd, "apps/api"), "mantine-ui-patterns"))).toBe(false);
  });
});

describe("fastapi-python preset (#1103)", () => {
  const configFor = (libraries: string[]) =>
    ({
      ...BASE_CONFIG,
      preset: "fastapi-python",
      project: { libraries },
    }) as unknown as NavoriConfig;

  // Covers: A1 — stack block rendered; fastapi skill implied by the preset itself.
  it("renders its stack block and materializes the fastapi skill without detected libraries", () => {
    const r = renderClaudeEngine(cwd, configFor([]));
    expect(r.warnings.find((w) => w.includes("fastapi-python") && w.includes("not found"))).toBe(
      undefined,
    );
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf-8")).toContain('id="stack-fastapi-python"');
    expect(existsSync(skFile(cwd, "fastapi"))).toBe(true);
  });

  // Covers: A1 — pytest only when the dependency was detected.
  it("adds the pytest skill only when pytest is in project.libraries", () => {
    renderClaudeEngine(cwd, configFor([]));
    expect(existsSync(skFile(cwd, "pytest"))).toBe(false);
    renderClaudeEngine(cwd, configFor(["pytest"]));
    expect(existsSync(skFile(cwd, "pytest"))).toBe(true);
  });
});
