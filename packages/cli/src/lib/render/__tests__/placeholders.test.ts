import { describe, it, expect } from "vitest";
import { DEFAULT_LANG, SUPPORTED_LANGS } from "../i18n.ts";
import { placeholderFallback } from "../placeholders.ts";

describe("placeholderFallback (F12)", () => {
  it("renders prose (not a runnable command) for qualityGate paths", () => {
    // Templates use `corre \`{{qualityGate.fast}}\``; a raw token reads like a
    // command. The fallback must be prose pointing at the fix.
    expect(placeholderFallback("qualityGate.fast", DEFAULT_LANG)).toContain("sin configurar");
    expect(placeholderFallback("qualityGate.fast", DEFAULT_LANG)).toContain(
      "navori configure quality-gate",
    );
    expect(placeholderFallback("qualityGate.fast", DEFAULT_LANG)).not.toMatch(/^<not configured/);
    expect(placeholderFallback("qualityGate.full", DEFAULT_LANG)).toContain("sin configurar");
  });

  it("keeps the raw hint for unknown paths (spots a typo'd placeholder)", () => {
    expect(placeholderFallback("some.unknown.path", DEFAULT_LANG)).toBe(
      "<not configured: some.unknown.path>",
    );
  });

  it("renders a generic list for the array-defaulted project paths (#375)", () => {
    // These default to `[]`, so they are unresolved in every config that didn't
    // fill them in, and they are cited INLINE mid-sentence — the fallback has to
    // read as a value, not as a diagnostic.
    for (const path of ["project.criticalAreas", "project.legacyPaths"]) {
      expect(placeholderFallback(path, DEFAULT_LANG)).not.toMatch(/^</);
      expect(placeholderFallback(path, DEFAULT_LANG)).not.toContain("not configured");
    }
    expect(placeholderFallback("project.criticalAreas", DEFAULT_LANG)).toBe(
      "auth, permissions, payments, data integrity",
    );
  });

  // #445 — the diagnostic used to be a Spanish literal with no way to reach the
  // config, so an English repo published it verbatim in ~82 asset sites.
  describe("the qualityGate diagnostic follows the requested locale (#445)", () => {
    for (const path of ["qualityGate.fast", "qualityGate.full"] as const) {
      it(`${path}: en is English, es is Spanish, and they differ`, () => {
        const en = placeholderFallback(path, "en");
        const es = placeholderFallback(path, "es");
        expect(en).toBe("(quality gate not configured — run 'navori configure quality-gate')");
        expect(es).toBe("(quality gate sin configurar — corre 'navori configure quality-gate')");
        expect(en).not.toBe(es);
      });
    }

    it("defaults to es, so a call site with no config keeps its old output", () => {
      expect(placeholderFallback("qualityGate.fast", DEFAULT_LANG)).toBe(
        placeholderFallback("qualityGate.fast", "es"),
      );
    });

    it("leaves the locale-neutral fallbacks identical in every locale", () => {
      // The hard hint names a config path, and the generic project defaults are
      // values a config would supply verbatim: translating either would be wrong.
      for (const path of ["project.criticalAreas", "project.legacyPaths", "some.unknown.path"]) {
        const rendered = new Set(SUPPORTED_LANGS.map((lang) => placeholderFallback(path, lang)));
        expect([...rendered]).toHaveLength(1);
      }
    });
  });

  // #447 — `path` comes from an asset, so an inherited member must never resolve:
  // indexing an object literal made `{{constructor}}` render
  // `function Object() { [native code] }` into the prose. Re-pinned here because
  // #445 rebuilt the lookup's value type (string -> resolver).
  it("does not resolve inherited members for a prototype-shaped path", () => {
    for (const path of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(placeholderFallback(path, DEFAULT_LANG)).toBe(`<not configured: ${path}>`);
      expect(placeholderFallback(path, "en")).toBe(`<not configured: ${path}>`);
    }
  });
});
