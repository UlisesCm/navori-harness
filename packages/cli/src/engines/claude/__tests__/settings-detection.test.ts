import { describe, it, expect } from "vitest";
import { isNavoriOwnedSettings } from "../settings-detection.ts";

describe("isNavoriOwnedSettings", () => {
  it("returns true for $navori.managed === true", () => {
    expect(isNavoriOwnedSettings({ $navori: { managed: true } })).toBe(true);
    expect(isNavoriOwnedSettings({ $navori: { managed: true, version: "0.0.1" }, hooks: {} })).toBe(true);
  });

  it("returns false when $navori absent", () => {
    expect(isNavoriOwnedSettings({ hooks: {}, permissions: { allow: [] } })).toBe(false);
  });

  it("returns false when managed flag is missing or false", () => {
    expect(isNavoriOwnedSettings({ $navori: {} })).toBe(false);
    expect(isNavoriOwnedSettings({ $navori: { managed: false } })).toBe(false);
    expect(isNavoriOwnedSettings({ $navori: { managed: "true" } })).toBe(false);
  });

  it("returns false for non-objects, arrays, null", () => {
    expect(isNavoriOwnedSettings(null)).toBe(false);
    expect(isNavoriOwnedSettings(undefined)).toBe(false);
    expect(isNavoriOwnedSettings("string")).toBe(false);
    expect(isNavoriOwnedSettings([])).toBe(false);
    expect(isNavoriOwnedSettings({ $navori: [] })).toBe(false);
  });
});
