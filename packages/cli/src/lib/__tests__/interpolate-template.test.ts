import { describe, it, expect } from "vitest";
import { interpolateTemplate } from "../render-plan.ts";
import type { NavoriConfig } from "../config.ts";

const CONFIG = {
  name: "test",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
  project: {
    legacyPaths: ["src/legacy", "vendor/old"],
    libraryMigrations: [{ legacy: "axios", preferred: "ky", domain: "http" }],
  },
} as unknown as NavoriConfig;

describe("interpolateTemplate (CLAUDE.md managed blocks)", () => {
  it("resolves scalar placeholders", () => {
    expect(interpolateTemplate("base: {{branchBase}}", CONFIG)).toBe("base: main");
  });

  it("serializes arrays of primitives (#89)", () => {
    expect(interpolateTemplate("{{project.legacyPaths}}", CONFIG)).toBe("src/legacy, vendor/old");
  });

  it("uses the readable fallback for a missing path (never a raw placeholder)", () => {
    expect(interpolateTemplate("v={{models.reviewer}}", CONFIG)).toBe(
      "v=<not configured: models.reviewer>",
    );
  });

  it("falls back for arrays of objects instead of leaking a raw {{...}} (#89 alignment)", () => {
    const out = interpolateTemplate("m={{project.libraryMigrations}}", CONFIG);
    expect(out).toBe("m=<not configured: project.libraryMigrations>");
    expect(out).not.toContain("{{");
    expect(out).not.toContain("[object Object]");
  });

  it("falls back for a plain object value instead of leaking a raw {{...}}", () => {
    const out = interpolateTemplate("q={{qualityGate}}", CONFIG);
    expect(out).toBe("q=<not configured: qualityGate>");
    expect(out).not.toContain("{{");
  });
});
