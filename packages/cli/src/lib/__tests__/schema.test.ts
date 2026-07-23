import { describe, it, expect } from "vitest";
import { NavoriConfigSchema } from "../schema.ts";

/**
 * Spec 0003 §3.4.2 — boundary + default coverage for the config schema.
 * config.test.ts covers the read/write path; this targets the schema directly:
 * which fields are required, which get defaults, and which values are rejected.
 */

const MINIMAL = { name: "demo", engines: ["claude"], preset: "custom" };

describe("NavoriConfigSchema — defaults (spec 0003 §3.4.2)", () => {
  it("applies top-level defaults when fields are omitted", () => {
    const c = NavoriConfigSchema.parse({ ...MINIMAL });
    expect(c.version).toBe("1.0.0");
    expect(c.language).toBe("es");
    expect(c.branchBase).toBe("main");
    expect(c.commits).toBe("conventional-es");
  });

  it("leaves prTarget undefined when omitted (falls back to branchBase at render)", () => {
    const c = NavoriConfigSchema.parse({ ...MINIMAL });
    expect(c.prTarget).toBeUndefined();
  });

  it("accepts an explicit prTarget", () => {
    const c = NavoriConfigSchema.parse({ ...MINIMAL, branchBase: "main", prTarget: "develop" });
    expect(c.prTarget).toBe("develop");
  });

  it("applies sdd sub-defaults when sdd:{} is given", () => {
    const c = NavoriConfigSchema.parse({ ...MINIMAL, sdd: {} });
    expect(c.sdd).toEqual({
      enabled: true,
      specsDir: "specs",
      applyWhen: [],
      doesNotApplyTo: [],
    });
  });

  it("applies harness sub-defaults (all agents on) when harness:{} is given", () => {
    const c = NavoriConfigSchema.parse({ ...MINIMAL, harness: {} });
    expect(c.harness).toEqual({
      leader: true,
      implementer: true,
      reviewer: true,
      researcher: true,
      ticketAudit: true,
      commitPrPilot: true,
      explorer: true,
      auditor: true,
    });
  });

  it("applies progress sub-defaults when progress:{} is given", () => {
    const c = NavoriConfigSchema.parse({ ...MINIMAL, progress: {} });
    expect(c.progress).toEqual({
      dir: "progress",
      currentFile: "current.md",
      historyFile: "history.md",
    });
  });

  it("defaults monorepo.workspaces to [] when omitted", () => {
    const c = NavoriConfigSchema.parse({ ...MINIMAL, monorepo: { enabled: true } });
    expect(c.monorepo?.workspaces).toEqual([]);
  });
});

describe("NavoriConfigSchema — boundary (spec 0003 §3.4.2)", () => {
  it("requires name, engines and preset", () => {
    expect(NavoriConfigSchema.safeParse({}).success).toBe(false);
    expect(NavoriConfigSchema.safeParse({ name: "x", preset: "custom" }).success).toBe(false);
    expect(NavoriConfigSchema.safeParse({ name: "x", engines: ["claude"] }).success).toBe(false);
  });

  it("rejects an empty engines array (min 1)", () => {
    expect(NavoriConfigSchema.safeParse({ ...MINIMAL, engines: [] }).success).toBe(false);
  });

  it("rejects an empty preset string (min 1)", () => {
    expect(NavoriConfigSchema.safeParse({ ...MINIMAL, preset: "" }).success).toBe(false);
  });

  it("rejects wrong types", () => {
    expect(NavoriConfigSchema.safeParse({ ...MINIMAL, version: 123 }).success).toBe(false);
  });

  // Forward-compat (#70): unknown enum values from a newer navori are dropped
  // (not rejected) so an older CLI keeps reading the config.
  it("drops unknown engines but keeps the known ones", () => {
    const c = NavoriConfigSchema.parse({ ...MINIMAL, engines: ["claude", "future-engine"] });
    expect(c.engines).toEqual(["claude"]);
  });

  it("falls back to a default when ALL enum values are unknown", () => {
    const c = NavoriConfigSchema.parse({ ...MINIMAL, engines: ["jetbrains"] });
    expect(c.engines).toEqual(["claude"]);
    expect(NavoriConfigSchema.parse({ ...MINIMAL, language: "fr" }).language).toBe("es");
    expect(NavoriConfigSchema.parse({ ...MINIMAL, commits: "gitmoji" }).commits).toBe("conventional-es");
  });

  it("still rejects a genuinely empty engines array", () => {
    expect(NavoriConfigSchema.safeParse({ ...MINIMAL, engines: [] }).success).toBe(false);
  });

  it("rejects a qualityGate with empty commands (min 1)", () => {
    expect(
      NavoriConfigSchema.safeParse({ ...MINIMAL, qualityGate: { fast: "", full: "x" } }).success,
    ).toBe(false);
  });

  // Path-traversal hardening: a feature id flows into a filesystem path, so the
  // schema rejects anything with a separator or `..`, plus non-kebab ids.
  it("accepts a kebab-case feature id and rejects traversal-shaped / non-kebab ones", () => {
    expect(NavoriConfigSchema.safeParse({ ...MINIMAL, features: ["app-builder"] }).success).toBe(true);
    for (const bad of ["../evil", "..", "foo/bar", "foo\\bar", "App_Builder", "a/../b", "/etc"]) {
      expect(
        NavoriConfigSchema.safeParse({ ...MINIMAL, features: [bad] }).success,
        `feature id '${bad}' must be rejected`,
      ).toBe(false);
    }
  });

  // Removed keys (#75): legacy configs still carrying checkpointsDir /
  // archiveAfterDays must keep validating — the keys are stripped, not rejected.
  it("tolerates removed progress keys from legacy configs (stripped, not rejected)", () => {
    const c = NavoriConfigSchema.parse({
      ...MINIMAL,
      progress: {
        dir: "progress",
        checkpointsDir: "progress/checkpoints",
        archiveAfterDays: 30,
      },
    });
    expect(c.progress).toEqual({
      dir: "progress",
      currentFile: "current.md",
      historyFile: "history.md",
    });
    // Even invalid values for removed keys don't break validation.
    expect(
      NavoriConfigSchema.safeParse({ ...MINIMAL, progress: { archiveAfterDays: -1 } }).success,
    ).toBe(true);
  });
});
