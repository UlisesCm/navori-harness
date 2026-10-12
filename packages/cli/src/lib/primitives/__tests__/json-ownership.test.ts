import { describe, it, expect } from "vitest";
import { isNavoriOwnedSettings, planStampedJson, readNavoriOwnership } from "../json-ownership.ts";

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

// Covers: A2
describe("planStampedJson", () => {
  const doc = (version: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ $navori: { managed: true, version }, hooks: {}, ...extra }, null, 2) + "\n";

  it("is a noop when only the stamp would differ", () => {
    expect(planStampedJson(doc("0.1.0"), doc("0.2.0"), "0.2.0")).toEqual({ kind: "noop" });
  });

  it("is a noop when identical", () => {
    expect(planStampedJson(doc("0.2.0"), doc("0.2.0"), "0.2.0")).toEqual({ kind: "noop" });
  });

  it("preserves key order: stamp-only diff stays a noop with the stamp not first", () => {
    const mk = (v: string): string =>
      JSON.stringify({ hooks: {}, $navori: { managed: true, version: v }, a: 1 }, null, 2) + "\n";
    expect(planStampedJson(mk("0.1.0"), mk("0.2.0"), "0.2.0")).toEqual({ kind: "noop" });
  });

  it("writes the candidate stamped with the CLI version on a real change", () => {
    const candidate = doc("0.2.0", { extra: 1 });
    expect(planStampedJson(doc("0.1.0"), candidate, "0.2.0")).toEqual({
      kind: "write",
      content: candidate,
    });
  });

  it("skips when the existing stamp is newer than the CLI", () => {
    expect(planStampedJson(doc("0.3.0"), doc("0.2.0", { extra: 1 }), "0.2.0")).toEqual({
      kind: "downgrade-skipped",
      existingVersion: "0.3.0",
    });
  });

  it("skips when the floor is newer than the CLI", () => {
    expect(planStampedJson(doc("0.1.0"), doc("0.2.0", { extra: 1 }), "0.2.0", "0.4.0")).toEqual({
      kind: "downgrade-skipped",
      existingVersion: "0.4.0",
    });
  });

  it("force bypasses the downgrade guards", () => {
    const candidate = doc("0.2.0", { extra: 1 });
    expect(planStampedJson(doc("0.3.0"), candidate, "0.2.0", "0.4.0", true)).toEqual({
      kind: "write",
      content: candidate,
    });
  });

  it("writes when the current file has no readable stamp", () => {
    const candidate = doc("0.2.0");
    expect(planStampedJson("not json", candidate, "0.2.0")).toEqual({
      kind: "write",
      content: candidate,
    });
    expect(planStampedJson("", candidate, "0.2.0")).toEqual({ kind: "write", content: candidate });
  });
});
