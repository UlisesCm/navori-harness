import { describe, it, expect } from "vitest";
import { applyDefault } from "../workspace-defaults.ts";
import type { WorkspaceDefaults } from "../workspace.ts";

describe("applyDefault — flat keys", () => {
  it("sets branchBase", () => {
    const res = applyDefault({}, "branchBase", "develop");
    expect(res.ok).toBe(true);
    expect(res.defaults?.branchBase).toBe("develop");
  });

  it("sets prTarget", () => {
    const res = applyDefault({}, "prTarget", "develop");
    expect(res.ok).toBe(true);
    expect(res.defaults?.prTarget).toBe("develop");
  });

  it("sets a valid commits enum", () => {
    const res = applyDefault({}, "commits", "conventional-es");
    expect(res.ok).toBe(true);
    expect(res.defaults?.commits).toBe("conventional-es");
  });

  it("rejects an invalid commits enum with a helpful error", () => {
    const res = applyDefault({}, "commits", "gitmoji");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("commits");
  });

  it("sets a valid language enum", () => {
    const res = applyDefault({}, "language", "en");
    expect(res.ok).toBe(true);
    expect(res.defaults?.language).toBe("en");
  });

  it("rejects an invalid language enum", () => {
    const res = applyDefault({}, "language", "fr");
    expect(res.ok).toBe(false);
  });

  it("rejects an unknown key", () => {
    const res = applyDefault({}, "branch_base", "main");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unknown default key");
  });
});

describe("applyDefault — engines (comma-separated)", () => {
  it("splits a comma-separated list", () => {
    const res = applyDefault({}, "engines", "claude,cursor");
    expect(res.ok).toBe(true);
    expect(res.defaults?.engines).toEqual(["claude", "cursor"]);
  });

  it("trims whitespace and drops empties", () => {
    const res = applyDefault({}, "engines", " claude ,  , cursor ");
    expect(res.ok).toBe(true);
    expect(res.defaults?.engines).toEqual(["claude", "cursor"]);
  });
});

describe("applyDefault — plugins.<id>.enabled", () => {
  it("enables a plugin from 'true'", () => {
    const res = applyDefault({}, "plugins.engram.enabled", "true");
    expect(res.ok).toBe(true);
    expect(res.defaults?.plugins?.engram).toEqual({ enabled: true });
  });

  it("disables a plugin from 'false'", () => {
    const res = applyDefault({}, "plugins.engram.enabled", "false");
    expect(res.ok).toBe(true);
    expect(res.defaults?.plugins?.engram).toEqual({ enabled: false });
  });

  it("rejects a non-boolean value", () => {
    const res = applyDefault({}, "plugins.engram.enabled", "yes");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("true");
  });

  it("treats plugins.<id> without .enabled as an unknown key", () => {
    const res = applyDefault({}, "plugins.engram", "true");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unknown default key");
  });
});

describe("applyDefault — merges instead of replacing", () => {
  it("preserves other flat keys", () => {
    const current: WorkspaceDefaults = { commits: "conventional-es" };
    const res = applyDefault(current, "branchBase", "main");
    expect(res.ok).toBe(true);
    expect(res.defaults).toMatchObject({ commits: "conventional-es", branchBase: "main" });
  });

  it("merges a new plugin alongside existing ones", () => {
    const current: WorkspaceDefaults = { plugins: { engram: { enabled: true } } };
    const res = applyDefault(current, "plugins.sdd.enabled", "false");
    expect(res.ok).toBe(true);
    expect(res.defaults?.plugins).toEqual({
      engram: { enabled: true },
      sdd: { enabled: false },
    });
  });

  it("overwrites the same plugin's enabled flag", () => {
    const current: WorkspaceDefaults = { plugins: { engram: { enabled: true } } };
    const res = applyDefault(current, "plugins.engram.enabled", "false");
    expect(res.ok).toBe(true);
    expect(res.defaults?.plugins?.engram).toEqual({ enabled: false });
  });

  it("does not mutate the input defaults object", () => {
    const current: WorkspaceDefaults = { plugins: { engram: { enabled: true } } };
    applyDefault(current, "plugins.engram.enabled", "false");
    expect(current.plugins?.engram).toEqual({ enabled: true });
  });
});
