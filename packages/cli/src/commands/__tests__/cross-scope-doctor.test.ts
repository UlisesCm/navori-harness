import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({
  safeHomedir: () => home.dir,
  globalConfigDir: () => process.env.CLAUDE_CONFIG_DIR || join(home.dir, ".claude"),
}));

const { scanCrossScope } = await import("../doctor.ts");
const { runGlobalRender } = await import("../global.ts");
const { writeGlobalConfig, GlobalConfigSchema, globalConfigToNavoriConfig } = await import("../../lib/global-config.ts");
const { renderClaudeEngine } = await import("../../engines/claude/index.ts");
const { scanManagedDrift } = await import("../../lib/health.ts");
import type { NavoriConfig } from "../../lib/config.ts";

let repoDir: string;
let claudeDir: string;
const savedEnv = process.env.CLAUDE_CONFIG_DIR;

const repoConfig = {
  name: "repo-x",
  version: "1.0.0",
  engines: ["claude"],
  preset: "custom",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "xscope-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "xscope-repo-"));
  claudeDir = mkdtempSync(join(tmpdir(), "xscope-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterEach(() => {
  for (const d of [home.dir, repoDir, claudeDir]) rmSync(d, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
});

describe("cross-scope doctor (spec 0005 §2.4)", () => {
  it("stays silent (null) when there is no global config", () => {
    renderClaudeEngine(repoDir, repoConfig, {}); // repo has idioma-rol, but no global side
    expect(scanCrossScope(repoDir)).toBeNull();
  });

  it("flags a managed id active in BOTH the repo and ~/.claude", () => {
    // both sides render idioma-rol (scope: both)
    renderClaudeEngine(repoDir, repoConfig, {});
    writeGlobalConfig(GlobalConfigSchema.parse({ language: "es" }));
    runGlobalRender(GlobalConfigSchema.parse({ language: "es" }), { dryRun: false });

    const report = scanCrossScope(repoDir);
    expect(report).not.toBeNull();
    expect(report!.dups).toContain("idioma-rol");
  });

  it("flags a scope:repo block that leaked into the global target", () => {
    writeGlobalConfig(GlobalConfigSchema.parse({ language: "es" }));
    runGlobalRender(GlobalConfigSchema.parse({ language: "es" }), { dryRun: false });
    // simulate a violation: a repo-only block hand-placed in ~/.claude/CLAUDE.md
    appendFileSync(
      join(claudeDir, "CLAUDE.md"),
      '\n<!-- navori:managed id="orquestacion" hash="deadbeef" source="@navori/core" -->\nx\n<!-- /navori:managed id="orquestacion" -->\n',
    );
    const report = scanCrossScope(repoDir);
    expect(report!.violations).toContain("orquestacion");
  });
});

describe("global doctor drift (scanManagedDrift on the global target)", () => {
  it("is clean right after a global render", () => {
    const cfg = GlobalConfigSchema.parse({ language: "es" });
    runGlobalRender(cfg, { dryRun: false });
    const drifts = scanManagedDrift(claudeDir, globalConfigToNavoriConfig(cfg));
    expect(drifts.length).toBe(0);
  });

  it("detects a hand-edited block body as content drift", () => {
    const cfg = GlobalConfigSchema.parse({ language: "es" });
    runGlobalRender(cfg, { dryRun: false });
    const mdPath = join(claudeDir, "CLAUDE.md");
    const tampered = readFileSync(mdPath, "utf-8").replace(
      /(id="idioma-rol"[^>]*-->\n)/,
      "$1HAND EDITED LINE THAT BREAKS THE HASH\n",
    );
    writeFileSync(mdPath, tampered);
    const drifts = scanManagedDrift(claudeDir, globalConfigToNavoriConfig(cfg));
    expect(drifts.some((d) => d.markerId === "idioma-rol" && d.kind === "content")).toBe(true);
  });
});
