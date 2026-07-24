import { describe, it, expect } from "vitest";
import { assetInScope, computeRenderPlan, type AssetScope, type RenderScope } from "../render-plan.ts";
import { NavoriConfigSchema } from "../schema.ts";

// preset "custom" → no preset resolution, so repoRoot is never read from disk.
const repoRoot = process.cwd();
const baseConfig = NavoriConfigSchema.parse({ name: "demo", engines: ["claude"], preset: "custom" });

describe("assetInScope — full scope matrix (spec 0005 §2.2)", () => {
  // Every (assetScope × renderScope) combination, including the global-only
  // block seen during a repo render (the strip branch) and the undefined =
  // repo default that keeps pre-0005 assets repo-only.
  const cases: Array<{ assetScope: AssetScope | undefined; renderScope: RenderScope; expected: boolean }> = [
    { assetScope: "repo", renderScope: "repo", expected: true },
    { assetScope: "repo", renderScope: "global", expected: false },
    { assetScope: "global", renderScope: "repo", expected: false }, // global-only block in a repo render → strip
    { assetScope: "global", renderScope: "global", expected: true },
    { assetScope: "both", renderScope: "repo", expected: true },
    { assetScope: "both", renderScope: "global", expected: true },
    { assetScope: undefined, renderScope: "repo", expected: true }, // absent = repo
    { assetScope: undefined, renderScope: "global", expected: false },
  ];

  for (const { assetScope, renderScope, expected } of cases) {
    it(`assetScope=${assetScope ?? "undefined"} × renderScope=${renderScope} → ${expected}`, () => {
      expect(assetInScope(assetScope, renderScope)).toBe(expected);
    });
  }
});

describe("plugin allowedScopes × renderScope gate (render-plan.ts)", () => {
  const config = NavoriConfigSchema.parse({
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    // engram → allowedScopes ["global","repo"]; jscpd → default ["repo"].
    plugins: { engram: { enabled: true }, jscpd: { enabled: true } },
  });

  it("a global+repo plugin (engram) emits its block in BOTH renders", () => {
    const repo = computeRenderPlan("", config, repoRoot, { scope: "repo" });
    const global = computeRenderPlan("", config, repoRoot, { scope: "global" });
    expect(repo.next).toContain('id="engram-protocol"');
    expect(global.next).toContain('id="engram-protocol"');
  });

  it("a repo-only plugin (jscpd) emits in the repo render but is ABSENT from the global render", () => {
    const repo = computeRenderPlan("", config, repoRoot, { scope: "repo" });
    const global = computeRenderPlan("", config, repoRoot, { scope: "global" });
    expect(repo.next).toContain('id="jscpd-protocol"');
    expect(global.next).not.toContain('id="jscpd-protocol"');
  });
});

describe("scope self-heal honors user-modified hash (render-plan.ts)", () => {
  // orquestacion is scope:repo, so a global render must strip it — UNLESS the
  // user hand-edited it, in which case deleting it silently would clobber the
  // edit. Seed a repo render (valid orquestacion block + hash), then render the
  // same document at global scope.
  const seeded = computeRenderPlan("", baseConfig, repoRoot, { scope: "repo" }).next;

  it("an UNMODIFIED out-of-scope block is stripped", () => {
    expect(seeded).toContain('id="orquestacion"');
    const global = computeRenderPlan(seeded, baseConfig, repoRoot, { scope: "global" });
    expect(global.next).not.toContain('id="orquestacion"');
    const entry = global.entries.find((e) => e.asset.id === "orquestacion");
    expect(entry?.status).toBe("removed-condition-false");
  });

  it("a HAND-EDITED out-of-scope block is preserved and flagged as a conflict, not deleted", () => {
    // Insert a line into the orquestacion body → hash drift.
    const tampered = seeded.replace(/(id="orquestacion"[^>]*-->\n)/, "$1HAND EDITED LINE\n");
    expect(tampered).not.toBe(seeded);

    const global = computeRenderPlan(tampered, baseConfig, repoRoot, { scope: "global" });
    // The block survives verbatim, edit included.
    expect(global.next).toContain('id="orquestacion"');
    expect(global.next).toContain("HAND EDITED LINE");
    // …and is surfaced as a conflict for the user to resolve explicitly.
    const entry = global.entries.find((e) => e.asset.id === "orquestacion");
    expect(entry?.status).toBe("user-modified-skipped");
  });
});
