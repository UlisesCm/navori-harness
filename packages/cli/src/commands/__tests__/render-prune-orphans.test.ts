import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #312: outputs left behind by an engine removed from config.engines[] (a stale
 * AGENTS.md / .codex after narrowing to claude) must be reported by render, and
 * deleted only with `--prune` on an apply run — never in preview. createBackup
 * writes under ~/.navori/backups, so safeHomedir is mocked to a throwaway home.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { writeConfig } = await import("../../lib/config.ts");
const { runRender } = await import("../render.ts");

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-render-prune-"));
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
  });
  // A leftover AGENTS.md from a previously-configured agents-md/codex engine.
  writeFileSync(join(cwd, "AGENTS.md"), "leftover orphan content\n");
  mkdirSync(join(cwd, ".codex"), { recursive: true });
  writeFileSync(join(cwd, ".codex/config.toml"), 'sandbox_mode = "read-only"\n');
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

describe("runRender — orphaned engine output pruning (#312)", () => {
  it("reports orphaned outputs without deleting them (no --prune)", () => {
    const result = runRender(cwd, { dryRun: false, prune: false });
    expect(result.ok).toBe(true);
    const orphanPaths = (result.orphanedEngineOutputs ?? []).flatMap((o) => o.paths);
    expect(orphanPaths).toContain("AGENTS.md");
    expect(orphanPaths).toContain(".codex");
    expect(result.prunedEngineOutputs ?? []).toHaveLength(0);
    // Left untouched.
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".codex"))).toBe(true);
  });

  it("does NOT delete on --prune in preview mode", () => {
    const result = runRender(cwd, { dryRun: true, prune: true });
    expect(result.prunedEngineOutputs ?? []).toHaveLength(0);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".codex"))).toBe(true);
  });

  it("deletes orphaned outputs with --prune on an apply run", () => {
    const result = runRender(cwd, { dryRun: false, prune: true });
    expect(result.prunedEngineOutputs).toContain("AGENTS.md");
    expect(result.prunedEngineOutputs).toContain(".codex");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".codex"))).toBe(false);
  });

  it("keeps AGENTS.md when agents-md is still a configured engine", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude", "agents-md"],
      preset: "custom",
    });
    const result = runRender(cwd, { dryRun: false, prune: true });
    const orphanPaths = (result.orphanedEngineOutputs ?? []).flatMap((o) => o.paths);
    expect(orphanPaths).not.toContain("AGENTS.md");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
  });
});
