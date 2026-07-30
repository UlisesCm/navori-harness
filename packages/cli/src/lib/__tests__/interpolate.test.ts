import { describe, it, expect } from "vitest";
import { interpolate } from "../interpolate.ts";
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
  models: { leader: "opus", implementer: "sonnet" },
  project: {
    legacyPaths: ["src/legacy"],
    criticalAreas: ["src/auth", "src/billing"],
    emptyList: [],
    libraryMigrations: [{ legacy: "axios", preferred: "ky", domain: "http" }],
  },
} as unknown as NavoriConfig;

describe("interpolate — default mode", () => {
  it("resolves simple paths", () => {
    expect(interpolate("Run: {{qualityGate.fast}}", CONFIG)).toBe("Run: pnpm typecheck");
  });

  it("joins array values with commas", () => {
    expect(interpolate("{{project.criticalAreas}}", CONFIG)).toBe("src/auth, src/billing");
  });

  it("serializes a single-element primitive array (#89 — legacyPaths not empty)", () => {
    expect(interpolate("legacy: {{project.legacyPaths}}", CONFIG)).toBe("legacy: src/legacy");
  });

  it("renders an empty array as an empty string (#89)", () => {
    expect(interpolate("x={{project.emptyList}}", CONFIG)).toBe("x=");
  });

  it("falls back for arrays of objects instead of emitting [object Object] (#89)", () => {
    // libraryMigrations is an object array — no meaningful inline form.
    expect(interpolate("m={{project.libraryMigrations}}", CONFIG)).toBe(
      "m=<not configured: project.libraryMigrations>",
    );
  });

  it("falls back for a plain object value instead of leaking a raw {{...}}", () => {
    const out = interpolate("q={{qualityGate}}", CONFIG);
    expect(out).toBe("q=<not configured: qualityGate>");
    expect(out).not.toContain("{{");
  });

  it("uses <not configured> for missing paths", () => {
    expect(interpolate("v={{models.reviewer}}", CONFIG)).toBe(
      "v=<not configured: models.reviewer>",
    );
  });

  it("respects extraVars over config paths", () => {
    const r = interpolate("ver={{coreVersion}}", CONFIG, { extraVars: { coreVersion: "0.0.1" } });
    expect(r).toBe("ver=0.0.1");
  });
});

describe("interpolate — shell-quote marker (#197)", () => {
  it("wraps a resolved value in single quotes", () => {
    expect(interpolate("base={{shq:branchBase}}", CONFIG)).toBe("base='main'");
  });

  it("neutralizes an injected command in a hostile value", () => {
    const hostile = {
      ...CONFIG,
      branchBase: "main'; touch /tmp/navori_probe; :'",
    } as unknown as NavoriConfig;
    const out = interpolate("base={{shq:branchBase}}", hostile);
    // The whole payload lands inside one shell string; the `'` is escaped as
    // '\'' so it can never close the quote and start a new command.
    expect(out).toBe("base='main'\\''; touch /tmp/navori_probe; :'\\'''");
    expect(out.startsWith("base='")).toBe(true);
  });

  it("still shell-quotes the fallback for an unresolved shq placeholder", () => {
    const out = interpolate("gate={{shq:qualityGate.missing}}", CONFIG);
    expect(out).toBe("gate='<not configured: qualityGate.missing>'");
    expect(out).not.toContain("{{");
  });

  it("leaves plain (unmarked) placeholders unquoted", () => {
    expect(interpolate("base={{branchBase}}", CONFIG)).toBe("base=main");
  });
});

describe("interpolate — omitUnresolvedKeyLines (frontmatter mode)", () => {
  it("drops `key: {{x}}` lines when x is unresolved", () => {
    const input = `name: leader\nmodel: {{models.reviewer}}\ndescription: text\n`;
    const result = interpolate(input, CONFIG, { omitUnresolvedKeyLines: true });
    // Trailing newline becomes an empty final line — preserved as empty after the filter.
    expect(result).toBe("name: leader\ndescription: text\n");
  });

  it("keeps `key: {{x}}` lines when x resolves", () => {
    const input = `model: {{models.leader}}`;
    expect(interpolate(input, CONFIG, { omitUnresolvedKeyLines: true })).toBe("model: opus");
  });

  it("falls back to <not configured> for unresolved placeholders NOT on a `key:` line", () => {
    const input = `description: see {{models.reviewer}} for details`;
    const result = interpolate(input, CONFIG, { omitUnresolvedKeyLines: true });
    expect(result).toContain("<not configured: models.reviewer>");
  });
});
