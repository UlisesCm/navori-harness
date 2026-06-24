import { describe, it, expect } from "vitest";
import { t, SUPPORTED_LANGS } from "../i18n.ts";

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
