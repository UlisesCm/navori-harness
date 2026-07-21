import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../lib/config.ts";
import { runRender } from "../render.ts";
import { aggregateRender, deadProgressKeys, refreshWorkspaceScopes } from "../update.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-update-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("deadProgressKeys (#79)", () => {
  it("lists the removed progress keys the config still carries", () => {
    expect(
      deadProgressKeys({ progress: { dir: "progress", checkpointsDir: "cp", archiveAfterDays: 30 } }),
    ).toEqual(["checkpointsDir", "archiveAfterDays"]);
  });

  it("returns [] when progress is clean or absent", () => {
    expect(deadProgressKeys({ progress: { dir: "progress" } })).toEqual([]);
    expect(deadProgressKeys({})).toEqual([]);
    expect(deadProgressKeys({ progress: "nonsense" })).toEqual([]);
  });
});

describe("refreshWorkspaceScopes — re-home per-workspace library skills (#80 migration)", () => {
  function writePkg(path: string, pkg: object): void {
    mkdirSync(join(cwd, path), { recursive: true });
    writeFileSync(join(cwd, path, "package.json"), JSON.stringify(pkg));
  }

  it("re-homes a workspace-only lib onto its config entry and returns true", () => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - 'apps/*'\n`);
    writePkg("apps/api", { name: "api", dependencies: { mongoose: "^8" } });
    // Legacy-style config: aggregated lib on the root, workspace entry has none.
    const raw: Record<string, unknown> = {
      project: { libraries: ["mongoose"] },
      monorepo: { enabled: true, tool: "pnpm", workspaces: [{ name: "api", path: "apps/api" }] },
    };

    const changed = refreshWorkspaceScopes(raw, cwd);

    expect(changed).toBe(true);
    const ws = (raw.monorepo as { workspaces: Array<Record<string, unknown>> }).workspaces[0]!;
    expect(ws.libraries).toEqual(["mongoose"]);
  });

  it("is a no-op (returns false) when workspaces are already correctly scoped", () => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - 'apps/*'\n`);
    writePkg("apps/api", { name: "api", dependencies: { mongoose: "^8" } });
    const raw: Record<string, unknown> = {
      monorepo: {
        enabled: true,
        tool: "pnpm",
        workspaces: [{ name: "api", path: "apps/api", libraries: ["mongoose"] }],
      },
    };

    expect(refreshWorkspaceScopes(raw, cwd)).toBe(false);
  });

  it("returns false for a non-monorepo config", () => {
    expect(refreshWorkspaceScopes({ project: { libraries: ["zod-validation"] } }, cwd)).toBe(false);
  });
});

describe("aggregateRender — monorepo fidelity (#79 crítico 3)", () => {
  function seedMonorepo(): void {
    mkdirSync(join(cwd, "apps/backend"), { recursive: true });
    mkdirSync(join(cwd, "apps/web"), { recursive: true });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "monorepo-pnpm",
      qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
      monorepo: {
        enabled: true,
        tool: "pnpm",
        workspaces: [
          { name: "backend", path: "apps/backend" },
          { name: "web", path: "apps/web" },
        ],
      },
    });
  }

  it("surfaces pending writes for the root AND every workspace (not just root)", () => {
    seedMonorepo();
    // Preview of a fresh repo: everything is pending "created".
    const preview = runRender(cwd, true);
    const agg = aggregateRender(preview);

    const scopes = new Set(agg.writes.map((w) => w.scope));
    expect(scopes.has("root")).toBe(true);
    expect(scopes.has("backend")).toBe(true);
    expect(scopes.has("web")).toBe(true);
    // Each workspace contributes its own CLAUDE.md write.
    for (const scope of ["root", "backend", "web"]) {
      expect(agg.writes.some((w) => w.scope === scope && w.path === "CLAUDE.md")).toBe(true);
    }
  });

  it("aggregates non-Claude engine writes too (AGENTS.md at root + workspaces)", () => {
    mkdirSync(join(cwd, "apps/backend"), { recursive: true });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude", "agents-md"],
      preset: "monorepo-pnpm",
      monorepo: {
        enabled: true,
        tool: "pnpm",
        workspaces: [{ name: "backend", path: "apps/backend" }],
      },
    });
    const agg = aggregateRender(runRender(cwd, true));
    expect(agg.writes.some((w) => w.path === "AGENTS.md" && w.scope.startsWith("root"))).toBe(true);
    expect(agg.writes.some((w) => w.path === "AGENTS.md" && w.scope.startsWith("backend"))).toBe(true);
  });
});

describe("anti-retroceso end-to-end via runRender (#79 crítico 1)", () => {
  it("preserves a CLAUDE.md block written by a newer navori and reports the downgrade", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
    });
    // First render materializes the tree with the current version markers.
    runRender(cwd, false);
    const claudeMdPath = join(cwd, "CLAUDE.md");
    const before = readFileSync(claudeMdPath, "utf-8");

    // Simulate a teammate on a newer navori: bump a core block's version marker
    // far ahead and change its body.
    const bumped = before
      .replace(/(id="idioma-rol"[^>]*version=")[^"]+(")/, "$199.0.0$2")
      .replace(/(<!-- navori:managed id="idioma-rol"[\s\S]*?-->\n)[\s\S]*?(\n<!-- \/navori:managed id="idioma-rol")/,
        "$1CONTENIDO DE UNA NAVORI MÁS NUEVA$2");
    writeFileSync(claudeMdPath, bumped);

    const result = runRender(cwd, false);
    const agg = aggregateRender(result);

    // The downgrade is reported…
    expect(agg.downgrades.some((d) => d.id === "idioma-rol")).toBe(true);
    // …and the newer content was preserved on disk, not clobbered.
    const after = readFileSync(claudeMdPath, "utf-8");
    expect(after).toContain("CONTENIDO DE UNA NAVORI MÁS NUEVA");
    expect(after).toContain('version="99.0.0"');
  });
});
