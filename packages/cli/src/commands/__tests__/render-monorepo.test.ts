import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../lib/config.ts";
import { runRender } from "../render.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-render-monorepo-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("runRender — monorepo iteration (spec 0001 fase 1)", () => {
  it("renders root + each workspace when config.monorepo.workspaces[] is non-empty", () => {
    // pre-create workspace dirs so the engine can write into them
    mkdirSync(join(cwd, "apps/backend"), { recursive: true });
    mkdirSync(join(cwd, "apps/storefront"), { recursive: true });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "monorepo-demo",
      engines: ["claude"],
      preset: "monorepo-turbopnpm",
      qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
      monorepo: {
        enabled: true,
        tool: "turbo",
        workspaces: [
          {
            name: "backend",
            path: "apps/backend",
            qualityGate: { fast: "pnpm -F backend lint", full: "pnpm -F backend test" },
          },
          { name: "storefront", path: "apps/storefront" },
        ],
      },
    });

    const result = runRender(cwd);

    // Root render is included
    expect(result.ok).toBe(true);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/hooks/quality-gate-pre-commit.sh"))).toBe(true);

    // Both workspaces rendered
    expect(result.workspaces).toHaveLength(2);
    const names = result.workspaces.map((w) => w.workspaceName).sort();
    expect(names).toEqual(["backend", "storefront"]);

    expect(existsSync(join(cwd, "apps/backend/CLAUDE.md"))).toBe(true);
    expect(existsSync(join(cwd, "apps/backend/.claude/settings.json"))).toBe(true);
    expect(existsSync(join(cwd, "apps/storefront/CLAUDE.md"))).toBe(true);
    expect(existsSync(join(cwd, "apps/storefront/.claude/settings.json"))).toBe(true);

    // qualityGate override applied per workspace: backend embeds its own command,
    // storefront inherits the root one.
    const backendHook = readFileSync(join(cwd, "apps/backend/.claude/hooks/quality-gate-pre-commit.sh"), "utf-8");
    expect(backendHook).toContain("pnpm -F backend lint");
    expect(backendHook).not.toContain("pnpm -w lint");
    // Defensive wrapping (spec 0003 §3.6.4): skip cleanly if the runtime is absent.
    expect(backendHook).toContain("command -v");
    expect(backendHook).toMatch(/exit 0/);

    const storefrontHook = readFileSync(
      join(cwd, "apps/storefront/.claude/hooks/quality-gate-pre-commit.sh"),
      "utf-8",
    );
    expect(storefrontHook).toContain("pnpm -w lint");
  });

  it("workspace CLAUDE.md omits root-only global blocks but keeps stack-specific ones (#70)", () => {
    mkdirSync(join(cwd, "apps/backend"), { recursive: true });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "monorepo-demo",
      engines: ["claude"],
      preset: "custom",
      project: { codeLanguage: "ts" },
      monorepo: {
        enabled: true,
        tool: "turbo",
        workspaces: [{ name: "backend", path: "apps/backend" }],
      },
    });

    runRender(cwd);

    const root = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
    const ws = readFileSync(join(cwd, "apps/backend/CLAUDE.md"), "utf-8");

    // Root carries the global blocks.
    expect(root).toContain('navori:managed id="orquestacion"');
    expect(root).toContain('navori:managed id="idioma-rol"');

    // Workspace inherits those from the parent → NOT re-emitted.
    expect(ws).not.toContain('navori:managed id="orquestacion"');
    expect(ws).not.toContain('navori:managed id="idioma-rol"');
    expect(ws).not.toContain('navori:managed id="operaciones-seguras"');
    // But the stack-specific TS block (per-workspace language) stays.
    expect(ws).toContain('navori:managed id="tipado-fuerte"');
  });

  it("does NOT resurrect a declared workspace whose directory was deleted (#70)", () => {
    // Only apps/backend exists on disk; apps/ghost is declared but was removed.
    mkdirSync(join(cwd, "apps/backend"), { recursive: true });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "monorepo-demo",
      engines: ["claude"],
      preset: "monorepo-turbopnpm",
      monorepo: {
        enabled: true,
        tool: "turbo",
        workspaces: [
          { name: "backend", path: "apps/backend" },
          { name: "ghost", path: "apps/ghost" },
        ],
      },
    });

    const result = runRender(cwd);

    expect(result.ok).toBe(true);
    // The orphan is skipped, not resurrected.
    expect(existsSync(join(cwd, "apps/ghost"))).toBe(false);
    expect(result.workspaces.map((w) => w.workspaceName)).toEqual(["backend"]);
    expect(result.orphanedWorkspaces).toEqual(["apps/ghost"]);
    // The live workspace still renders.
    expect(existsSync(join(cwd, "apps/backend/CLAUDE.md"))).toBe(true);
  });

  it("resolves a local preset from the repo root for every workspace (repoRoot)", () => {
    // A local preset lives ONLY at the repo root (.navori/presets/), shared by
    // every workspace. Each workspace renders with its own cwd (apps/api), so
    // this fails unless loadPreset resolves against repoRoot, not the workspace.
    const presetDir = join(cwd, ".navori/presets/mistack");
    mkdirSync(join(presetDir, "managed"), { recursive: true });
    mkdirSync(join(presetDir, "skills"), { recursive: true });
    writeFileSync(
      join(presetDir, "mistack.json"),
      JSON.stringify({
        id: "mistack",
        displayName: "Mistack",
        extends: "core",
        extras: {
          managed: [{ id: "stack-mistack", relPath: "managed/stack.md" }],
          skills: [
            {
              id: "mistack-example",
              relPath: "skills/mistack-example.md",
              destRelPath: ".claude/skills/mistack-example.md",
            },
          ],
        },
        invariants: [],
      }),
    );
    writeFileSync(join(presetDir, "managed/stack.md"), "## Stack — mistack\n\nLocal preset.\n");
    writeFileSync(
      join(presetDir, "skills/mistack-example.md"),
      "---\nname: mistack-example\ndescription: x\ntype: reference\n---\n\n# mistack-example\n",
    );

    mkdirSync(join(cwd, "apps/api"), { recursive: true });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "monorepo-local-preset",
      engines: ["claude"],
      preset: "mistack", // local preset at the root; workspace inherits it
      qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
      monorepo: {
        enabled: true,
        tool: "pnpm",
        workspaces: [{ name: "api", path: "apps/api" }],
      },
    });

    const result = runRender(cwd);
    expect(result.ok).toBe(true);

    // Root materialized the local preset.
    expect(existsSync(join(cwd, ".claude/skills/mistack-example.md"))).toBe(true);
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf-8")).toContain('id="stack-mistack"');

    // The workspace did too — proof it resolved the preset from the root, not
    // from apps/api/.navori/ (which does not exist).
    expect(existsSync(join(cwd, "apps/api/.claude/skills/mistack-example.md"))).toBe(true);
    const wsClaudeMd = readFileSync(join(cwd, "apps/api/CLAUDE.md"), "utf-8");
    expect(wsClaudeMd).toContain('id="stack-mistack"');
    expect(wsClaudeMd).toContain("## Stack — mistack");
  });

  it("back-compat: when monorepo.workspaces[] is empty, renders only the root", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "single-app",
      engines: ["claude"],
      preset: "custom",
      qualityGate: { fast: "pnpm test", full: "pnpm test" },
    });

    const result = runRender(cwd);

    expect(result.ok).toBe(true);
    expect(result.workspaces).toHaveLength(0);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/settings.json"))).toBe(true);
  });

  it("back-compat: monorepo declared but workspaces[] empty renders only the root", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "monorepo-no-workspaces",
      engines: ["claude"],
      preset: "monorepo-pnpm",
      monorepo: { enabled: true, tool: "pnpm", workspaces: [] },
    });

    const result = runRender(cwd);

    expect(result.ok).toBe(true);
    expect(result.workspaces).toHaveLength(0);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
  });

  it("workspace render is reported per-workspace in the result entries", () => {
    mkdirSync(join(cwd, "apps/api"), { recursive: true });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "monorepo-pnpm",
      qualityGate: { fast: "pnpm lint", full: "pnpm test" },
      monorepo: {
        enabled: true,
        tool: "pnpm",
        workspaces: [{ name: "api", path: "apps/api" }],
      },
    });

    const result = runRender(cwd);
    const ws = result.workspaces[0]!;
    expect(ws.workspacePath).toBe("apps/api");
    expect(ws.workspaceName).toBe("api");
    expect(ws.filePath.endsWith("apps/api/CLAUDE.md")).toBe(true);
    expect(ws.engineResult).toBeDefined();
    expect(ws.engineResult!.written.find((w) => w.path === "CLAUDE.md")).toBeDefined();
    // The workspace render is independent: it has its own backupPath/inspected count
    expect(ws.engineResult!.inspected).toBeGreaterThan(0);
  });

  it("dry-run does not write workspace files", () => {
    mkdirSync(join(cwd, "apps/web"), { recursive: true });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "monorepo-pnpm",
      qualityGate: { fast: "pnpm lint", full: "pnpm test" },
      monorepo: {
        enabled: true,
        tool: "pnpm",
        workspaces: [{ name: "web", path: "apps/web" }],
      },
    });

    const result = runRender(cwd, /* dryRun */ true);
    expect(result.ok).toBe(true);
    expect(result.workspaces).toHaveLength(1);
    expect(existsSync(join(cwd, "apps/web/CLAUDE.md"))).toBe(false);
    expect(existsSync(join(cwd, "apps/web/.claude/settings.json"))).toBe(false);
  });

  describe("--workspace filter (spec 0001 fase 4)", () => {
    function seedMonorepo(): void {
      mkdirSync(join(cwd, "apps/backend"), { recursive: true });
      mkdirSync(join(cwd, "apps/storefront"), { recursive: true });
      writeConfig(join(cwd, "navori.config.json"), {
        name: "demo",
        engines: ["claude"],
        preset: "monorepo-turbopnpm",
        qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
        monorepo: {
          enabled: true,
          tool: "turbo",
          workspaces: [
            { name: "backend", path: "apps/backend" },
            { name: "storefront", path: "apps/storefront" },
          ],
        },
      });
    }

    it("renders only the matched workspace, skips root", () => {
      seedMonorepo();
      const result = runRender(cwd, { workspaceFilter: "backend" });

      expect(result.ok).toBe(true);
      expect(result.workspaces).toHaveLength(1);
      expect(result.workspaces[0]!.workspaceName).toBe("backend");
      // Root render should NOT have been performed
      expect(result.engineResult).toBeUndefined();
      expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(cwd, ".claude/settings.json"))).toBe(false);
      // Backend SHOULD have been rendered
      expect(existsSync(join(cwd, "apps/backend/CLAUDE.md"))).toBe(true);
      // Storefront should NOT have been rendered
      expect(existsSync(join(cwd, "apps/storefront/CLAUDE.md"))).toBe(false);
    });

    it("returns ok:false when the workspace name does not match", () => {
      seedMonorepo();
      const result = runRender(cwd, { workspaceFilter: "missing" });
      expect(result.ok).toBe(false);
      // Reason is localized by config.language (es here); assert on the
      // workspace name + the known list, which are language-neutral.
      expect(result.reason).toContain("missing");
      expect(result.reason).toContain("backend");
      expect(result.reason).toContain("storefront");
    });

    it("returns ok:false when there's no monorepo in config", () => {
      writeConfig(join(cwd, "navori.config.json"), {
        name: "single-app",
        engines: ["claude"],
        preset: "nextjs",
      });
      const result = runRender(cwd, { workspaceFilter: "backend" });
      expect(result.ok).toBe(false);
      // Localized (es): "--workspace requiere un monorepo con workspaces …".
      expect(result.reason).toMatch(/requires a monorepo|requiere un monorepo/);
    });

    it("dry-run with --workspace does not write the target workspace", () => {
      seedMonorepo();
      const result = runRender(cwd, { workspaceFilter: "backend", dryRun: true });
      expect(result.ok).toBe(true);
      expect(result.workspaces).toHaveLength(1);
      expect(existsSync(join(cwd, "apps/backend/CLAUDE.md"))).toBe(false);
    });
  });

  describe("non-Claude engines in monorepos (#77)", () => {
    function seedMonorepo(engines: string[]): void {
      mkdirSync(join(cwd, "apps/backend"), { recursive: true });
      mkdirSync(join(cwd, "apps/storefront"), { recursive: true });
      writeConfig(join(cwd, "navori.config.json"), {
        name: "demo",
        engines,
        preset: "monorepo-turbopnpm",
        qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
        monorepo: {
          enabled: true,
          tool: "turbo",
          workspaces: [
            { name: "backend", path: "apps/backend" },
            { name: "storefront", path: "apps/storefront" },
          ],
        },
      });
    }

    it("engines [claude, agents-md] writes AGENTS.md at the root AND in every workspace", () => {
      seedMonorepo(["claude", "agents-md"]);
      const result = runRender(cwd);

      expect(result.ok).toBe(true);
      expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(cwd, "apps/backend/AGENTS.md"))).toBe(true);
      expect(existsSync(join(cwd, "apps/storefront/AGENTS.md"))).toBe(true);

      // Reported like the root: per-workspace extraEngines carry the file list.
      const root = (result.extraEngines ?? []).find((e) => e.engine === "agents-md");
      expect(root?.written).toEqual([{ path: "AGENTS.md", status: "created" }]);
      for (const ws of result.workspaces) {
        const eng = ws.extraEngines.find((e) => e.engine === "agents-md");
        expect(eng?.written).toEqual([{ path: "AGENTS.md", status: "created" }]);
      }
    });

    it("workspace AGENTS.md omits root-only blocks (inherited from the root file)", () => {
      seedMonorepo(["claude", "agents-md"]);
      runRender(cwd);

      const root = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
      const ws = readFileSync(join(cwd, "apps/backend/AGENTS.md"), "utf-8");
      expect(root).toContain("## Idioma y rol"); // rootOnly block present at root
      expect(ws).not.toContain("## Idioma y rol"); // omitted per workspace
      expect(ws).toContain("## Flujo de trabajo"); // engine-agnostic sections stay
    });

    it("engines [agents-md] only: no CLAUDE.md anywhere, AGENTS.md everywhere", () => {
      seedMonorepo(["agents-md"]);
      const result = runRender(cwd);

      expect(result.ok).toBe(true);
      expect(result.engineResult).toBeUndefined();
      expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(cwd, "apps/backend/CLAUDE.md"))).toBe(false);
      expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(cwd, "apps/backend/AGENTS.md"))).toBe(true);
      expect(result.workspaces).toHaveLength(2);
      expect(result.workspaces.every((w) => w.engineResult === undefined)).toBe(true);
    });

    it("respects the orphaned-workspace guard (#70): no AGENTS.md resurrected", () => {
      mkdirSync(join(cwd, "apps/backend"), { recursive: true });
      writeConfig(join(cwd, "navori.config.json"), {
        name: "demo",
        engines: ["claude", "agents-md"],
        preset: "monorepo-turbopnpm",
        monorepo: {
          enabled: true,
          tool: "turbo",
          workspaces: [
            { name: "backend", path: "apps/backend" },
            { name: "ghost", path: "apps/ghost" },
          ],
        },
      });

      const result = runRender(cwd);
      expect(result.orphanedWorkspaces).toEqual(["apps/ghost"]);
      expect(existsSync(join(cwd, "apps/ghost"))).toBe(false);
      expect(existsSync(join(cwd, "apps/backend/AGENTS.md"))).toBe(true);
    });

    it("--workspace X also renders the non-Claude engines for that workspace", () => {
      seedMonorepo(["claude", "agents-md"]);
      const result = runRender(cwd, { workspaceFilter: "backend" });

      expect(result.ok).toBe(true);
      expect(existsSync(join(cwd, "apps/backend/AGENTS.md"))).toBe(true);
      // Root and the other workspace stay untouched.
      expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
      expect(existsSync(join(cwd, "apps/storefront/AGENTS.md"))).toBe(false);
      // The summaries land in the top-level extraEngines (no root render here).
      const eng = (result.extraEngines ?? []).find((e) => e.engine === "agents-md");
      expect(eng?.written).toEqual([{ path: "AGENTS.md", status: "created" }]);
    });

    it("dry-run keeps the non-Claude engines preview-only (root + workspaces)", () => {
      seedMonorepo(["claude", "agents-md"]);
      const result = runRender(cwd, { dryRun: true });

      expect(result.ok).toBe(true);
      expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
      expect(existsSync(join(cwd, "apps/backend/AGENTS.md"))).toBe(false);
      const root = (result.extraEngines ?? []).find((e) => e.engine === "agents-md");
      expect(root?.written).toEqual([{ path: "AGENTS.md", status: "created" }]);
    });

    it("warns once (root only) about engines without adapter (cursor/copilot)", () => {
      seedMonorepo(["claude", "cursor"]);
      const result = runRender(cwd);

      const root = (result.extraEngines ?? []).find((e) => e.engine === "cursor");
      expect(root?.warnings.some((w) => w.includes("cursor"))).toBe(true);
      // Workspaces don't repeat the same repo-level warning.
      for (const ws of result.workspaces) {
        expect(ws.extraEngines.find((e) => e.engine === "cursor")).toBeUndefined();
      }
    });

    it("--workspace X still surfaces the no-adapter warning (no root render to do it)", () => {
      seedMonorepo(["claude", "copilot"]);
      const result = runRender(cwd, { workspaceFilter: "backend" });

      const eng = (result.extraEngines ?? []).find((e) => e.engine === "copilot");
      expect(eng?.warnings.some((w) => w.includes("copilot"))).toBe(true);
    });
  });
});
