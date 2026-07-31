import { describe, it, expect } from "vitest";
import { computeRenderPlan } from "../render-plan.ts";
import { NavoriConfigSchema } from "../schema.ts";

/**
 * #229 — the base language of each core managed asset is declared truthfully
 * (`baseLanguage`), so `languageFallbacks` stops lying:
 *   - the English-authored harness spine (orquestacion, sdd, session, safe-ops)
 *     served to a `language:"en"` repo is NOT reported as a Spanish fallback;
 *   - a Spanish-authored identity block served to an `en` repo (no translation)
 *     IS reported — the exact case the warning wording describes;
 *   - a default `es` repo reports no fallbacks at all.
 */
const repoRoot = process.cwd();

function planFor(language: "es" | "en") {
  const config = NavoriConfigSchema.parse({
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    language,
  });
  return computeRenderPlan("", config, repoRoot);
}

describe("core asset base-language / languageFallbacks (#229)", () => {
  it("an es (default) repo reports no language fallbacks", () => {
    expect(planFor("es").languageFallbacks).toEqual([]);
  });

  it("an en repo does NOT report the English-authored spine as a Spanish fallback", () => {
    const fallbacks = planFor("en").languageFallbacks;
    expect(fallbacks).not.toContain("orquestacion");
    expect(fallbacks).not.toContain("sdd");
    expect(fallbacks).not.toContain("arranque-sesion");
    expect(fallbacks).not.toContain("operaciones-seguras");
  });

  it("an en repo DOES report the Spanish-only identity blocks (no en translation)", () => {
    const fallbacks = planFor("en").languageFallbacks;
    expect(fallbacks).toContain("idioma-rol");
    expect(fallbacks).toContain("formato-respuesta");
  });
});
