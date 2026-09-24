import { describe, expect, it } from "vitest";
import { conditionOrchestration, UnbalancedConditionMarkerError } from "../render-plan.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../../config/schema.ts";

/**
 * Direct, synthetic unit coverage for `tokenizeConditions` / `resolveConditions`
 * (render-plan.ts). Until this suite, the only exercise of the rewritten
 * parser was through `orquestacion.md`'s real prose — this isolates the
 * nesting and error-handling behavior from that asset's current shape so a
 * future regression is caught even if the prose changes (#1011).
 */

function config(planTiers: boolean): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "condition-tokens-demo",
    engines: ["claude"],
    preset: "custom",
    harness: { planTiers },
  });
}

describe("resolveConditions — nesting", () => {
  // Covers: R30, R33
  it("resolves same-kind nesting (if-not wrapping if-not)", () => {
    const content =
      "before\n" +
      "<!-- navori:if-not planTiers -->\n" +
      "outer\n" +
      "<!-- navori:if-not planTiers -->\n" +
      "inner\n" +
      "<!-- /navori:if-not -->\n" +
      "<!-- /navori:if-not -->\n" +
      "after";
    expect(conditionOrchestration(content, config(false))).toBe("before\nouter\ninner\nafter");
    // Both markers hide, but the blank line BETWEEN the inner closer and the
    // outer closer belongs to the outer body's own trailing text, not to
    // either marker's start/end newline pair — `withoutMarkers` only trims a
    // SINGLE leading/trailing `\n`, so that line survives even when hidden.
    expect(conditionOrchestration(content, config(true))).toBe("before\n\nafter");
  });

  // Covers: R30, R33
  it("resolves same-kind nesting (if wrapping if)", () => {
    const content =
      "<!-- navori:if planTiers -->" +
      "outer-" +
      "<!-- navori:if planTiers -->" +
      "inner" +
      "<!-- /navori:if -->" +
      "<!-- /navori:if -->" +
      "tail";
    expect(conditionOrchestration(content, config(true))).toBe("outer-innertail");
    expect(conditionOrchestration(content, config(false))).toBe("tail");
  });

  // Covers: R30, R33
  it("resolves mixed-kind nesting (if inside if-not, if-not inside if)", () => {
    const content =
      "<!-- navori:if-not planTiers -->" +
      "A" +
      "<!-- navori:if planTiers -->" +
      "B" +
      "<!-- /navori:if -->" +
      "C" +
      "<!-- /navori:if-not -->" +
      "D";
    // planTiers=false: outer if-not shows (A..C), inner if hides (B dropped).
    expect(conditionOrchestration(content, config(false))).toBe("ACD");
    // planTiers=true: outer if-not hides entirely, regardless of the inner if.
    expect(conditionOrchestration(content, config(true))).toBe("D");
  });

  it("returns content with no markers byte for byte", () => {
    const content = "# Title\n\nSome plain text with no conditional markers at all.\n";
    expect(conditionOrchestration(content, config(true))).toBe(content);
    expect(conditionOrchestration(content, config(false))).toBe(content);
  });

  it("shows the if-branch when the key is enabled and hides it when disabled", () => {
    const content = "x<!-- navori:if planTiers -->shown<!-- /navori:if -->y";
    expect(conditionOrchestration(content, config(true))).toBe("xshowny");
    expect(conditionOrchestration(content, config(false))).toBe("xy");
  });
});

describe("resolveConditions — malformed markers throw", () => {
  it("throws on an opener with no matching closer", () => {
    const content = "before<!-- navori:if planTiers -->never closed";
    expect(() => conditionOrchestration(content, config(true))).toThrow(
      UnbalancedConditionMarkerError,
    );
    expect(() => conditionOrchestration(content, config(true))).toThrow(/Unclosed marker/);
  });

  it("throws on a closer with no matching opener", () => {
    const content = "before<!-- /navori:if -->after";
    expect(() => conditionOrchestration(content, config(true))).toThrow(
      UnbalancedConditionMarkerError,
    );
    expect(() => conditionOrchestration(content, config(true))).toThrow(/no opener/);
  });

  it("throws when a closer's kind doesn't match the innermost opener", () => {
    const content =
      "<!-- navori:if-not planTiers -->" +
      "<!-- navori:if planTiers -->" +
      "body" +
      "<!-- /navori:if-not -->" +
      "<!-- /navori:if-not -->";
    expect(() => conditionOrchestration(content, config(true))).toThrow(
      UnbalancedConditionMarkerError,
    );
    expect(() => conditionOrchestration(content, config(true))).toThrow(/mismatched/);
  });
});
