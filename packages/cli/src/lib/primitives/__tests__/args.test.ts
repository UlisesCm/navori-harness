import { describe, expect, it } from "vitest";
import { isCittyCamelAlias, reparseBareValueFlags, restoreRepeatedFlags } from "../args.ts";

const declared = ["by-engine", "record-metadata", "json", "consume-arm"];

describe("isCittyCamelAlias", () => {
  // Covers: R4
  it("recognizes the camelCase alias citty adds for a declared kebab-case arg", () => {
    expect(isCittyCamelAlias("byEngine", declared)).toBe(true);
    expect(isCittyCamelAlias("recordMetadata", declared)).toBe(true);
    expect(isCittyCamelAlias("consumeArm", declared)).toBe(true);
  });

  // Covers: R4
  it("does not hide undeclared flags or declared names themselves", () => {
    expect(isCittyCamelAlias("bogusFlag", declared)).toBe(false);
    expect(isCittyCamelAlias("bogus-flag", declared)).toBe(false);
    expect(isCittyCamelAlias("by-engine", declared)).toBe(false);
    expect(isCittyCamelAlias("json", declared)).toBe(false);
  });
});

describe("restoreRepeatedFlags", () => {
  const defs = { start: { type: "string" }, "consume-arm": { type: "boolean" } } as const;

  // Covers: R4
  it("rebuilds the array citty 0.2 collapses to the last value", () => {
    const out: Record<string, unknown> = restoreRepeatedFlags(
      { _: [], start: "b" } as Record<string, unknown>,
      ["--start", "a", "--start=b", "--consume-arm", "--consume-arm"],
      defs,
    );
    expect(out.start).toEqual(["a", "b"]);
    expect(out["consume-arm"]).toEqual([true, true]);
  });

  // Covers: R4
  it("leaves single and post-`--` occurrences untouched", () => {
    const args = { _: [], start: "a" };
    expect(restoreRepeatedFlags(args, ["--start", "a", "--", "--start", "z"], defs)).toEqual(args);
  });
});

describe("reparseBareValueFlags", () => {
  const defs = { diff: { type: "string" }, cwd: { type: "string" } } as const;

  // Covers: R4
  it("keeps the next flag when an optional-value flag is bare", () => {
    const out = reparseBareValueFlags(
      { _: [], diff: "--cwd", cwd: "" },
      ["--diff", "--cwd", "/x"],
      defs,
      ["diff"],
    );
    expect(out.diff).toBe("");
    expect(out.cwd).toBe("/x");
  });

  // Covers: R4
  it("returns args untouched when the flag carries a value", () => {
    const args = { _: [], diff: "main", cwd: "" };
    expect(reparseBareValueFlags(args, ["--diff", "main"], defs, ["diff"])).toBe(args);
  });
});
