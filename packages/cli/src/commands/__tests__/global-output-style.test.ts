import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic on two axes (spec 0005 §6 safety): ~/.navori (backups) → throwaway
// home via the home.ts mock; the global render TARGET → a temp CLAUDE_CONFIG_DIR.
// Neither the real $HOME/.claude nor ~/.navori is ever touched.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({
  safeHomedir: () => home.dir,
  globalConfigDir: () => process.env.CLAUDE_CONFIG_DIR || join(home.dir, ".claude"),
}));

const { runGlobalRender } = await import("../global.ts");
const { renderClaudeEngine } = await import("../../engines/claude/index.ts");
const { GlobalConfigSchema } = await import("../../lib/global-config.ts");
import type { NavoriConfig } from "../../lib/config.ts";

let claudeDir: string;
const savedEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "global-os-home-"));
  claudeDir = mkdtempSync(join(tmpdir(), "global-os-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
});

const cfg = (over = {}) => GlobalConfigSchema.parse({ language: "es", permissions: true, ...over });
const stylePath = () => join(claudeDir, "output-styles", "navori.md");
const settings = () => JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));

describe("global output style — render + activation (a)", () => {
  it("--recommended writes a valid output style file AND activates it in settings.json", () => {
    const { result } = runGlobalRender(cfg(), { dryRun: false, forceActivateStyle: true });

    // (a1) the style file exists, frontmatter intact and FIRST in the file.
    expect(existsSync(stylePath())).toBe(true);
    const md = readFileSync(stylePath(), "utf-8");
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("name: navori");
    // the hyphenated key must survive verbatim (the managed-file pipeline would
    // have dropped it — proving we write the source as-is).
    expect(md).toContain("keep-coding-instructions: true");

    // (a2) settings.json activates navori.
    expect(settings().outputStyle).toBe("navori");
    expect(result.outputStyle?.kind).toBe("activated");
  });

  it("a fresh profile (no existing style) activates navori without any flag", () => {
    const { result } = runGlobalRender(cfg(), { dryRun: false });
    expect(settings().outputStyle).toBe("navori");
    expect(result.outputStyle?.kind).toBe("activated");
  });
});

describe("global output style — existing non-navori style preserved (b)", () => {
  it("existing 'Gentleman' + NOT recommended → file written, style STAYS Gentleman, note reported", () => {
    // A hand-written (non-navori-owned) settings.json already selects Gentleman.
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ outputStyle: "Gentleman" }, null, 2) + "\n");

    const { result } = runGlobalRender(cfg(), { dryRun: false });

    // file is written (so it's selectable)…
    expect(existsSync(stylePath())).toBe(true);
    // …but the user's active style is untouched.
    expect(settings().outputStyle).toBe("Gentleman");
    expect(result.outputStyle?.kind).toBe("preserved-existing");
    expect(result.outputStyle).toMatchObject({ existing: "Gentleman" });
  });

  it("existing 'Gentleman' + --recommended → navori overrides (headless opt-in)", () => {
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ outputStyle: "Gentleman" }, null, 2) + "\n");
    const { result } = runGlobalRender(cfg(), { dryRun: false, forceActivateStyle: true });
    expect(settings().outputStyle).toBe("navori");
    expect(result.outputStyle?.kind).toBe("activated");
  });
});

describe("global output style — opt out of activation (c)", () => {
  it("--no-output-style writes the file but does NOT activate navori", () => {
    const { result } = runGlobalRender(cfg(), { dryRun: false, noOutputStyle: true });
    expect(existsSync(stylePath())).toBe(true); // still selectable
    expect(settings().outputStyle).toBeUndefined();
    expect(result.outputStyle?.kind).toBe("opted-out");
  });
});

describe("global output style — idempotency (d)", () => {
  it("a second render writes nothing (style file + settings unchanged)", () => {
    runGlobalRender(cfg(), { dryRun: false, forceActivateStyle: true });
    const second = runGlobalRender(cfg(), { dryRun: false, forceActivateStyle: true });
    expect(second.result.written.length).toBe(0);
  });
});

describe("global output style — disabled management cleans up", () => {
  it("outputStyle:false removes navori's own untouched style file", () => {
    runGlobalRender(cfg(), { dryRun: false });
    expect(existsSync(stylePath())).toBe(true);
    const { result } = runGlobalRender(cfg({ outputStyle: false }), { dryRun: false });
    expect(existsSync(stylePath())).toBe(false);
    expect(result.outputStyle?.kind).toBe("deactivated");
  });

  it("outputStyle:false does NOT delete a user's edited same-named style", () => {
    runGlobalRender(cfg(), { dryRun: false });
    // user edits the style → no longer byte-identical to navori's source.
    writeFileSync(stylePath(), "---\nname: navori\n---\n\n# my own tweaks\n");
    runGlobalRender(cfg({ outputStyle: false }), { dryRun: false });
    expect(existsSync(stylePath())).toBe(true);
    expect(readFileSync(stylePath(), "utf-8")).toContain("my own tweaks");
  });
});

describe("global output style — repo scope is excluded (e)", () => {
  it("a repo render never writes output-styles", () => {
    const repoCwd = mkdtempSync(join(tmpdir(), "os-repo-"));
    try {
      const repoConfig = {
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        version: "1.0.0",
        language: "es",
        branchBase: "main",
        commits: "conventional-es",
        plugins: {},
      } as unknown as NavoriConfig;
      // Even if an outputStyle policy is passed, the repo scope ignores it.
      const r = renderClaudeEngine(repoCwd, repoConfig, {
        scope: "repo",
        outputStyle: { manage: true, forceActivate: true, optOut: false },
      });
      expect(existsSync(join(repoCwd, "output-styles"))).toBe(false);
      expect(existsSync(join(repoCwd, ".claude/output-styles"))).toBe(false);
      expect(r.outputStyle).toBeUndefined();
      // repo settings.json is never given an outputStyle key.
      const s = JSON.parse(readFileSync(join(repoCwd, ".claude/settings.json"), "utf-8"));
      expect(s.outputStyle).toBeUndefined();
    } finally {
      rmSync(repoCwd, { recursive: true, force: true });
    }
  });
});
