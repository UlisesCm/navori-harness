import { describe, it, expect } from "vitest";
import { loadPrompts } from "../prompts-loader.ts";

describe("loadPrompts", () => {
  it("loads the 3 core prompts shipped in @navori/core", () => {
    const r = loadPrompts(undefined);
    expect(r.warnings).toEqual([]);
    const keys = r.prompts.map((p) => p.key);
    expect(keys).toContain("project.legacyPaths");
    expect(keys).toContain("project.criticalAreas");
    expect(keys).toContain("project.testRunner");
  });

  it("attributes each core prompt to source 'core'", () => {
    const r = loadPrompts(undefined);
    for (const p of r.prompts) {
      expect(p.source).toBe("core");
    }
  });

  it("ignores plugin entries when no plugin manifest declares prompts", () => {
    const r = loadPrompts({ engram: { enabled: true } });
    // Today no shipped plugin declares prompts → all entries still come from core.
    for (const p of r.prompts) {
      expect(p.source).toBe("core");
    }
  });
});
