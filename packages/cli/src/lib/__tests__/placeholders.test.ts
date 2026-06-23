import { describe, it, expect } from "vitest";
import { placeholderFallback } from "../placeholders.ts";

describe("placeholderFallback (F12)", () => {
  it("renders prose (not a runnable command) for qualityGate paths", () => {
    // Templates use `corre \`{{qualityGate.fast}}\``; a raw token reads like a
    // command. The fallback must be prose pointing at the fix.
    expect(placeholderFallback("qualityGate.fast")).toContain("sin configurar");
    expect(placeholderFallback("qualityGate.fast")).toContain("navori configure quality-gate");
    expect(placeholderFallback("qualityGate.fast")).not.toMatch(/^<not configured/);
    expect(placeholderFallback("qualityGate.full")).toContain("sin configurar");
  });

  it("keeps the raw hint for unknown paths (spots a typo'd placeholder)", () => {
    expect(placeholderFallback("some.unknown.path")).toBe("<not configured: some.unknown.path>");
  });
});
