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

    const storefrontHook = readFileSync(
      join(cwd, "apps/storefront/.claude/hooks/quality-gate-pre-commit.sh"),
      "utf-8",
    );
    expect(storefrontHook).toContain("pnpm -w lint");
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
    expect(ws.engineResult.written.find((w) => w.path === "CLAUDE.md")).toBeDefined();
    // The workspace render is independent: it has its own backupPath/inspected count
    expect(ws.engineResult.inspected).toBeGreaterThan(0);
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
      expect(result.reason).toContain("Workspace 'missing' not found");
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
      expect(result.reason).toContain("requires a monorepo");
    });

    it("dry-run with --workspace does not write the target workspace", () => {
      seedMonorepo();
      const result = runRender(cwd, { workspaceFilter: "backend", dryRun: true });
      expect(result.ok).toBe(true);
      expect(result.workspaces).toHaveLength(1);
      expect(existsSync(join(cwd, "apps/backend/CLAUDE.md"))).toBe(false);
    });
  });
});
