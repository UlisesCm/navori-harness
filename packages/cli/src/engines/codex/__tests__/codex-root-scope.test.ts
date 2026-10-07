import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { writeConfig } from "../../../lib/config/config.ts";
import { countPendingRenderChanges, runRender } from "../../../commands/render.ts";

/**
 * Spec 0043 T11 / R8 — `workspaceHarness: "root"` under the Codex engine: a
 * workspace keeps its `AGENTS.md` and nothing else, the root receives the
 * library and preset skills the workspaces hand up, and `minimal`/`full` leave
 * the Codex tree exactly as it was.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-codex-root-"));
  mkdirSync(join(cwd, "apps/backend"), { recursive: true });
  mkdirSync(join(cwd, "apps/storefront"), { recursive: true });
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeMonorepo(harness: "minimal" | "full" | "root", engines = ["claude", "codex"]): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "codex-root-demo",
    engines,
    preset: "monorepo-turbopnpm",
    qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
    monorepo: {
      enabled: true,
      tool: "turbo",
      workspaces: [
        { name: "backend", path: "apps/backend", preset: "medusa" },
        {
          name: "storefront",
          path: "apps/storefront",
          preset: "nextjs",
          qualityGate: { fast: "pnpm lint", full: "pnpm test" },
        },
      ],
      workspaceHarness: harness,
    },
  });
}

/** Every file under `dir`, relative to it, sorted. */
const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();

const apply = (): ReturnType<typeof runRender> => runRender(cwd, { dryRun: false });

describe("renderCodexEngine — workspace bajo `root` (spec 0043 T11)", () => {
  it("bajo `root` el workspace queda solo con `AGENTS.md`", () => {
    // Covers: R8
    writeMonorepo("full");
    expect(apply().ok).toBe(true);
    expect(existsSync(join(cwd, "apps/storefront/.codex"))).toBe(true);
    expect(existsSync(join(cwd, "apps/storefront/.agents/skills"))).toBe(true);

    writeMonorepo("root");
    expect(apply().ok).toBe(true);

    // The context file is the Claude engine's; `progress/` is the user's once written
    // (the `full` render made it). The Codex engine leaves exactly one file of its own.
    for (const ws of ["apps/storefront", "apps/backend"]) {
      expect(readdirSync(join(cwd, ws)).sort()).toEqual(["AGENTS.md", "CLAUDE.md", "progress"]);
    }
  });

  it("un `.codex/config.toml` con claves del usuario fuera del bloque se conserva", () => {
    // Covers: R8
    writeMonorepo("full");
    expect(apply().ok).toBe(true);
    const ws = join(cwd, "apps/backend");
    const config = join(ws, ".codex/config.toml");
    writeFileSync(config, `${readFileSync(config, "utf-8")}\n[mine]\nkey = "value"\n`);

    writeMonorepo("root");
    const result = apply();
    expect(result.ok).toBe(true);

    expect(readFileSync(config, "utf-8")).toContain('key = "value"');
    // Everything navori wrote and nobody touched is gone; only the user's file keeps `.codex/`.
    expect(files(join(ws, ".codex"))).toEqual(["config.toml"]);
    const backend = result.workspaces.find((w) => w.workspaceName === "backend")!;
    const codex = backend.extraEngines.find((e) => e.engine === "codex")!;
    expect(codex.warnings.join("\n")).toContain(".codex/config.toml");
    expect(existsSync(join(ws, ".agents"))).toBe(false);
  });

  it("la raíz recibe lo subido en `.agents/skills`", () => {
    // Covers: R8, R5
    writeMonorepo("root");
    expect(apply().ok).toBe(true);
    const skills = readdirSync(join(cwd, ".agents/skills"));
    expect(skills).toEqual(
      expect.arrayContaining([
        "medusa-modules",
        "medusa-api-routes",
        "nextjs-app-router",
        "nextjs-data-fetching",
        "new-resource",
      ]),
    );
    // The hoisted skill is the Codex rendering, not the Claude one.
    expect(
      existsSync(join(cwd, ".agents/skills/medusa-modules/SKILL.md")) &&
        readFileSync(join(cwd, ".agents/skills/medusa-modules/SKILL.md"), "utf-8"),
    ).not.toContain(".claude/progress");
  });

  it("bajo `minimal` el árbol Codex del workspace es idéntico al de antes", () => {
    // Covers: R8
    writeMonorepo("minimal");
    expect(apply().ok).toBe(true);
    const minimal = files(join(cwd, "apps/backend")).filter(
      (f) => f.startsWith(".codex/") || f.startsWith(".agents/") || f === "AGENTS.md",
    );
    rmSync(join(cwd, "apps/backend/.codex"), { recursive: true, force: true });
    rmSync(join(cwd, "apps/backend/.agents"), { recursive: true, force: true });
    writeMonorepo("full");
    expect(apply().ok).toBe(true);
    const full = files(join(cwd, "apps/backend")).filter(
      (f) => f.startsWith(".codex/") || f.startsWith(".agents/") || f === "AGENTS.md",
    );
    expect(minimal.length).toBeGreaterThan(5);
    expect(minimal).toEqual(full);
  });

  it("engines claude+codex+agents-md: segundo render con cero cambios", () => {
    // Covers: R9
    writeMonorepo("root", ["claude", "codex", "agents-md"]);
    expect(apply().ok).toBe(true);
    expect(countPendingRenderChanges(apply())).toBe(0);
    expect(countPendingRenderChanges(runRender(cwd, { dryRun: true }))).toBe(0);
  });

  it("desde cero, bajo `root`, el workspace nunca tuvo árbol Codex ni de Claude", () => {
    // Covers: R4, R8
    writeMonorepo("root");
    expect(apply().ok).toBe(true);
    expect(files(join(cwd, "apps/backend"))).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });
});
