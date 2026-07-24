import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic: point ~/.navori at a throwaway home so global.json + backups never
// touch the real home dir. globalConfigDir also lives in home.ts, so the mock
// provides it too (honoring CLAUDE_CONFIG_DIR) — otherwise importers crash.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../home.ts", () => ({
  safeHomedir: () => home.dir,
  globalConfigDir: () => process.env.CLAUDE_CONFIG_DIR || join(home.dir, ".claude"),
}));

const { GlobalConfigSchema, readGlobalConfig, writeGlobalConfig, globalConfigPath, validateGlobalPlugins } =
  await import("../global-config.ts");
const { PluginManifestSchema } = await import("../plugins.ts");

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "global-cfg-home-"));
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
});

describe("GlobalConfigSchema", () => {
  it("applies lean defaults (permissions on, empty plugins, empty skills, claude engine)", () => {
    const cfg = GlobalConfigSchema.parse({ language: "es" });
    expect(cfg.permissions).toBe(true);
    expect(cfg.plugins).toEqual({});
    expect(cfg.skills).toEqual({});
    expect(cfg.engines).toEqual(["claude"]);
  });

  it("a config written before the skills catalog existed still parses (backward compatible)", () => {
    const cfg = GlobalConfigSchema.parse({ language: "es", plugins: { engram: { enabled: true } } });
    expect(cfg.skills).toEqual({});
  });

  it("accepts a skills selection keyed by catalog id", () => {
    const cfg = GlobalConfigSchema.parse({
      language: "es",
      skills: { "pr-create": { enabled: true }, "loop-back-debug": { enabled: false } },
    });
    expect(cfg.skills["pr-create"]?.enabled).toBe(true);
    expect(cfg.skills["loop-back-debug"]?.enabled).toBe(false);
  });

  it("is permissive about an id not in the catalog at the schema level (mirrors plugins)", () => {
    // Schema-level validation doesn't know the catalog — an unknown id parses
    // fine here. Stripping unknown ids happens where plugins strip them too:
    // `global init` only ever re-emits entries for ids it recognizes.
    const cfg = GlobalConfigSchema.parse({ language: "es", skills: { "not-a-real-skill": { enabled: true } } });
    expect(cfg.skills["not-a-real-skill"]?.enabled).toBe(true);
  });

  it("is tolerant: an unknown language falls back to es, unknown engine is dropped", () => {
    const cfg = GlobalConfigSchema.parse({ language: "fr", engines: ["claude", "zed"] });
    expect(cfg.language).toBe("es");
    expect(cfg.engines).toEqual(["claude"]);
  });

  it("permissions accepts boolean false (opt out of the allowlist)", () => {
    expect(GlobalConfigSchema.parse({ permissions: false }).permissions).toBe(false);
  });

  it("round-trips through disk at ~/.navori/global.json", () => {
    expect(readGlobalConfig()).toBeNull(); // clean machine
    writeGlobalConfig({
      language: "en",
      plugins: { engram: { enabled: true } },
      skills: { "pr-create": { enabled: true } },
      permissions: true,
    });
    expect(globalConfigPath()).toBe(join(home.dir, ".navori", "global.json"));
    const back = readGlobalConfig();
    expect(back?.language).toBe("en");
    expect(back?.plugins.engram.enabled).toBe(true);
    expect(back?.skills["pr-create"]?.enabled).toBe(true);
  });
});

describe("plugin allowedScopes — tolerant parse", () => {
  const base = { id: "x", name: "X", description: "d", version: "1.0.0", managed: [] };

  it("defaults to repo-only when absent", () => {
    expect(PluginManifestSchema.parse(base).allowedScopes).toEqual(["repo"]);
  });
  it("keeps a valid [global, repo]", () => {
    expect(PluginManifestSchema.parse({ ...base, allowedScopes: ["global", "repo"] }).allowedScopes).toEqual([
      "global",
      "repo",
    ]);
  });
  it("drops unknown scopes, keeping the known ones", () => {
    expect(PluginManifestSchema.parse({ ...base, allowedScopes: ["global", "bogus"] }).allowedScopes).toEqual([
      "global",
    ]);
  });
  it("falls back to [repo] when every scope is unknown", () => {
    expect(PluginManifestSchema.parse({ ...base, allowedScopes: ["bogus"] }).allowedScopes).toEqual(["repo"]);
  });
});

describe("validateGlobalPlugins", () => {
  it("passes an identity plugin (engram allows global)", () => {
    const cfg = GlobalConfigSchema.parse({ plugins: { engram: { enabled: true } } });
    expect(validateGlobalPlugins(cfg)).toEqual([]);
  });
  it("flags a repo-only plugin enabled at global scope (jscpd)", () => {
    const cfg = GlobalConfigSchema.parse({ plugins: { jscpd: { enabled: true } } });
    const offenders = validateGlobalPlugins(cfg);
    expect(offenders.map((o) => o.id)).toContain("jscpd");
  });
  it("ignores disabled plugins", () => {
    const cfg = GlobalConfigSchema.parse({ plugins: { jscpd: { enabled: false } } });
    expect(validateGlobalPlugins(cfg)).toEqual([]);
  });
});
