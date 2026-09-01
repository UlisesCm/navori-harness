import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The global harness config (~/.navori/global.json) is machine-local. safeHomedir
 * is mocked so every test writes to a throwaway fake home, never the developer's
 * real ~/.navori. Spec 0010 §2.4 (zero-footprint) hinges on `readGlobalConfig`
 * returning null when the file is absent — the first two tests pin that.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../home.ts", () => ({ safeHomedir: () => home.dir }));

const {
  readGlobalConfig,
  writeGlobalConfig,
  globalConfigExists,
  globalConfigPath,
  defaultGlobalConfig,
  deleteGlobalConfig,
  DEFAULT_GLOBAL_BLOCKS,
} = await import("../global-config.ts");

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
});

describe("global-config — the zero-footprint gate", () => {
  it("readGlobalConfig returns null when the file is absent", () => {
    expect(readGlobalConfig()).toBeNull();
    expect(globalConfigExists()).toBe(false);
  });

  it("globalConfigPath points at ~/.navori/global.json", () => {
    expect(globalConfigPath()).toBe(join(home.dir, ".navori", "global.json"));
  });
});

describe("global-config — read/write round-trip", () => {
  it("writes and reads back, creating ~/.navori/ on the way", () => {
    const cfg = defaultGlobalConfig("0.5.0", "es");
    writeGlobalConfig(cfg);
    expect(globalConfigExists()).toBe(true);
    expect(readGlobalConfig()).toEqual(cfg);
  });

  it("default config seeds the audited baseline blocks in emission order", () => {
    const cfg = defaultGlobalConfig("0.5.0");
    expect(cfg.blocks.include).toEqual([...DEFAULT_GLOBAL_BLOCKS]);
    expect(cfg.blocks.include).toEqual([
      "operaciones-seguras",
      "idioma-rol",
      "formato-respuesta",
      "orquestacion",
    ]);
    expect(cfg.permissions).toEqual({ allow: [], deny: [], ask: [] });
    expect(cfg.language).toBe("es");
  });

  it("fills defaults for a minimal on-disk file", () => {
    mkdirSync(join(home.dir, ".navori"), { recursive: true });
    writeFileSync(globalConfigPath(), JSON.stringify({ version: "0.5.0" }));
    const cfg = readGlobalConfig();
    expect(cfg?.blocks.include).toEqual([...DEFAULT_GLOBAL_BLOCKS]);
    expect(cfg?.permissions.allow).toEqual([]);
    expect(cfg?.language).toBe("es");
  });

  it("tolerates an unknown language, falling back to es", () => {
    mkdirSync(join(home.dir, ".navori"), { recursive: true });
    writeFileSync(globalConfigPath(), JSON.stringify({ version: "0.5.0", language: "fr" }));
    expect(readGlobalConfig()?.language).toBe("es");
  });

  it("throws on a malformed file (installed-but-corrupt is worth surfacing)", () => {
    mkdirSync(join(home.dir, ".navori"), { recursive: true });
    writeFileSync(globalConfigPath(), "{ not json");
    expect(() => readGlobalConfig()).toThrow();
  });

  it("serializes with a trailing newline for stable diffs", () => {
    writeGlobalConfig(defaultGlobalConfig("0.5.0"));
    expect(readFileSync(globalConfigPath(), "utf-8").endsWith("}\n")).toBe(true);
  });

  it("deleteGlobalConfig removes the file and reports whether one was there", () => {
    expect(deleteGlobalConfig()).toBe(false); // nothing to delete yet
    writeGlobalConfig(defaultGlobalConfig("0.5.0"));
    expect(deleteGlobalConfig()).toBe(true);
    expect(globalConfigExists()).toBe(false);
  });
});
