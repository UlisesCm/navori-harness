import { describe, it, expect } from "vitest";
import { isNavoriOwnedSettings, readNavoriOwnership } from "../json-ownership.ts";

describe("isNavoriOwnedSettings", () => {
  it("returns true for $navori.managed === true", () => {
    expect(isNavoriOwnedSettings({ $navori: { managed: true } })).toBe(true);
    expect(isNavoriOwnedSettings({ $navori: { managed: true, version: "0.0.1" }, hooks: {} })).toBe(
      true,
    );
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

describe("readNavoriOwnership", () => {
  it("reads the marker out of raw JSON text, with its version", () => {
    expect(readNavoriOwnership('{"$navori":{"managed":true,"version":"0.6.4"}}')).toEqual({
      managed: true,
      version: "0.6.4",
    });
  });

  it("reports an unstamped marker as managed without a version", () => {
    expect(readNavoriOwnership('{"$navori":{"managed":true}}')).toEqual({
      managed: true,
      version: undefined,
    });
    // An empty string is not a version — it would read as "stamped" downstream.
    expect(
      readNavoriOwnership('{"$navori":{"managed":true,"version":""}}')?.version,
    ).toBeUndefined();
  });

  it("reports a hybrid file (navori edits it by key) as NOT managed", () => {
    // `.mcp.json` and a coexisting settings.json: navori owns some keys, not the
    // file, so nothing may delete or overwrite them wholesale.
    expect(readNavoriOwnership('{"$navori":{"managedHooks":["a"]},"mcpServers":{}}')).toEqual({
      managed: false,
      version: undefined,
    });
  });

  it("returns null for text that is not a JSON object", () => {
    expect(readNavoriOwnership("# markdown\n")).toBeNull();
    expect(readNavoriOwnership("[]")).toBeNull();
    expect(readNavoriOwnership('{"hooks":{}}')).toBeNull();
  });
});
