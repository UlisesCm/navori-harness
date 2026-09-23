import { describe, it, expect } from "vitest";
import { parseSemver, compareSemver, isDowngrade } from "../semver.ts";

describe("parseSemver", () => {
  it("parses plain X.Y.Z", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("ignores prerelease and build metadata", () => {
    expect(parseSemver("0.2.9-rc.1")).toEqual({ major: 0, minor: 2, patch: 9 });
    expect(parseSemver("0.2.9+build.7")).toEqual({ major: 0, minor: 2, patch: 9 });
  });

  it("returns null for anything that isn't three integers", () => {
    for (const bad of ["1.2", "v1.2.3", "1.2.x", "", "latest", null, undefined]) {
      expect(parseSemver(bad as string)).toBeNull();
    }
  });
});

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
    expect(compareSemver("0.3.0", "0.2.9")).toBe(1);
    expect(compareSemver("0.2.10", "0.2.9")).toBe(1); // numeric, not lexicographic
    expect(compareSemver("0.2.9", "0.2.9")).toBe(0);
  });

  it("returns null when either side is unparseable", () => {
    expect(compareSemver("1.0.0", "garbage")).toBeNull();
    expect(compareSemver("garbage", "1.0.0")).toBeNull();
  });
});

describe("isDowngrade", () => {
  it("is true only when existing is strictly newer than incoming", () => {
    expect(isDowngrade("0.3.0", "0.2.9")).toBe(true);
    expect(isDowngrade("0.2.10", "0.2.9")).toBe(true);
  });

  it("is false for same version, an upgrade, or unknown ordering", () => {
    expect(isDowngrade("0.2.9", "0.2.9")).toBe(false);
    expect(isDowngrade("0.2.8", "0.2.9")).toBe(false);
    expect(isDowngrade("0.2.9", "garbage")).toBe(false); // never trip on malformed
    expect(isDowngrade(null, "0.2.9")).toBe(false);
  });
});
