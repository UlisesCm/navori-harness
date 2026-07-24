import { describe, it, expect } from "vitest";
import { t, tc, resolveLang, DEFAULT_LANG, SUPPORTED_LANGS } from "../i18n.ts";

describe("i18n", () => {
  it("returns a dict for every supported lang", () => {
    for (const lang of SUPPORTED_LANGS) {
      const dict = t(lang);
      expect(dict).toBeDefined();
      expect(dict.cancelled.length).toBeGreaterThan(0);
    }
  });

  it("es and en have the exact same key set (parity)", () => {
    const es = t("es") as Record<string, unknown>;
    const en = t("en") as Record<string, unknown>;
    const esKeys = Object.keys(es).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(esKeys);
  });

  it("function-valued strings produce non-empty output in both langs", () => {
    for (const lang of SUPPORTED_LANGS) {
      const dict = t(lang);
      expect(dict.dirNotFound("/tmp/x").length).toBeGreaterThan(0);
      expect(dict.configExists("/tmp/x").length).toBeGreaterThan(0);
      expect(dict.wroteConfig("/tmp/x").length).toBeGreaterThan(0);
      expect(dict.agentFor("foo", "bar").length).toBeGreaterThan(0);
      expect(dict.backedUp(3, "/tmp/x").length).toBeGreaterThan(0);
      expect(dict.removedOriginals("/tmp/x").length).toBeGreaterThan(0);
      expect(dict.from("package.json").length).toBeGreaterThan(0);
      expect(dict.filesCount(2).length).toBeGreaterThan(0);
      expect(dict.featuresCount(2).length).toBeGreaterThan(0);
      expect(dict.workspaceDefaultsTitle("ws").length).toBeGreaterThan(0);
      expect(dict.recPluginsEnabled("engram, gh").length).toBeGreaterThan(0);
    }
  });

  it("presetGapNotice points at 'preset init' and interpolates the stack", () => {
    // Regression: the notice drifted out of sync with the command — it must
    // name the command that actually covers the gap (navori preset init).
    for (const lang of SUPPORTED_LANGS) {
      const msg = t(lang).presetGapNotice("fastify");
      expect(msg).toContain("preset init");
      expect(msg).toContain("fastify");
    }
  });

  it("es strings actually differ from en (sanity: no leftover English)", () => {
    const es = t("es");
    const en = t("en");
    // Spot-check a handful of high-visibility strings
    expect(es.useTheseValues).not.toBe(en.useTheseValues);
    expect(es.howToAdopt).not.toBe(en.howToAdopt);
    expect(es.renderNow).not.toBe(en.renderNow);
    expect(es.pluginsToEnable).not.toBe(en.pluginsToEnable);
  });
});

describe("i18n — runtime language resolution (#84)", () => {
  it("resolveLang passes through supported locales", () => {
    expect(resolveLang("es")).toBe("es");
    expect(resolveLang("en")).toBe("en");
  });

  it("resolveLang falls back to DEFAULT_LANG (es) for missing / unknown values", () => {
    // A forward-compat config from a newer navori may carry a locale this CLI
    // doesn't ship — it must not index an undefined catalog.
    expect(resolveLang(undefined)).toBe(DEFAULT_LANG);
    expect(resolveLang(null)).toBe(DEFAULT_LANG);
    expect(resolveLang("fr")).toBe(DEFAULT_LANG);
    expect(resolveLang(42)).toBe(DEFAULT_LANG);
    expect(DEFAULT_LANG).toBe("es");
  });
});

describe("i18n — command catalog (tc)", () => {
  it("returns different prose per locale for render / sync / doctor", () => {
    expect(tc("es").render.previewHint).not.toBe(tc("en").render.previewHint);
    expect(tc("es").render.previewHint).toContain("para escribir");
    expect(tc("en").render.previewHint).toContain("to write");

    expect(tc("es").sync.upToDate).toContain("Al día");
    expect(tc("en").sync.upToDate).toContain("Up to date");

    expect(tc("es").doctor.nextStepsTitle).toBe("Próximos pasos");
    expect(tc("en").doctor.nextStepsTitle).toBe("Next steps");
  });

  it("parameterized entries interpolate their args in both locales", () => {
    for (const lang of SUPPORTED_LANGS) {
      const c = tc(lang);
      expect(c.sync.workspaceNotFound("ghost", "a, b")).toContain("ghost");
      expect(c.sync.workspaceNotFound("ghost", "a, b")).toContain("a, b");
      expect(c.doctor.missingPreset("phantom")).toContain("phantom");
      expect(c.render.adapterMissing("cursor")).toContain("cursor");
    }
  });

  it("each command section has the same key set across locales (no missing translations)", () => {
    const keysOf = (o: Record<string, unknown>) => Object.keys(o).sort();
    const es = tc("es");
    const en = tc("en");
    for (const section of ["common", "render", "sync", "doctor", "feature", "global"] as const) {
      expect(keysOf(es[section] as unknown as Record<string, unknown>)).toEqual(
        keysOf(en[section] as unknown as Record<string, unknown>),
      );
    }
  });

  it("global.initSkillsPrompt exists and differs per locale (skills catalog multiselect)", () => {
    expect(tc("es").global.initSkillsPrompt.length).toBeGreaterThan(0);
    expect(tc("en").global.initSkillsPrompt.length).toBeGreaterThan(0);
    expect(tc("es").global.initSkillsPrompt).not.toBe(tc("en").global.initSkillsPrompt);
  });
});
