import { describe, it, expect } from "vitest";
import { interpolate } from "../interpolate.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

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
  project: { legacyPaths: ["src/legacy"], criticalAreas: ["src/auth", "src/billing"] },
} as unknown as NavoriConfig;

describe("interpolate — default mode", () => {
  it("resolves simple paths", () => {
    expect(interpolate("Run: {{qualityGate.fast}}", CONFIG)).toBe("Run: pnpm typecheck");
  });

  it("joins array values with commas", () => {
    expect(interpolate("{{project.criticalAreas}}", CONFIG)).toBe("src/auth, src/billing");
  });

  it("uses <not configured> for missing paths", () => {
    expect(interpolate("v={{models.reviewer}}", CONFIG)).toBe("v=<not configured: models.reviewer>");
  });

  it("respects extraVars over config paths", () => {
    const r = interpolate("ver={{coreVersion}}", CONFIG, { extraVars: { coreVersion: "0.0.1" } });
    expect(r).toBe("ver=0.0.1");
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
