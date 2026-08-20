import { describe, it, expect } from "vitest";
import { summarizeTrigger } from "../skill-meta.ts";

/**
 * `summarizeTrigger` condenses a skill `description` into the one-line row of
 * the always-on skills index. It is the only thing the agent reads when
 * deciding whether a skill applies, so a cut in the wrong place doesn't just
 * look bad — it hides a capability (#372).
 */
describe("summarizeTrigger", () => {
  it("cuts at the first sentence break", () => {
    expect(summarizeTrigger("Use when X happens. Then it does Y.")).toBe("Use when X happens");
  });

  it("cuts at a semicolon", () => {
    expect(summarizeTrigger("Use when X; also when Y")).toBe("Use when X");
  });

  it("cuts at a dash that separates a real clause", () => {
    expect(summarizeTrigger("Use when reviewing a diff — the full checklist")).toBe(
      "Use when reviewing a diff",
    );
  });

  // The bug: in `dominio` the dashes are parentheses, not a clause break, so
  // the index rendered the useless "Use when you discover".
  it("keeps the sentence when a PAIR of dashes encloses an aside", () => {
    const out = summarizeTrigger(
      "Use when you discover — or need — a durable fact that spans multiple repos",
    );
    expect(out).toBe("Use when you discover a durable fact that spans multiple repos");
  });

  // A lone dash after a 3-word lead is a label, not a condition: cutting there
  // would produce the row "Debugging", which says nothing about WHEN to reach
  // for the skill. Keeping the rest costs a few chars and keeps it routable.
  it("does not cut at a dash that leaves a clause too short to route on", () => {
    expect(summarizeTrigger("Debugging — use when tsc spews a wall of errors")).toBe(
      "Debugging — use when tsc spews a wall of errors",
    );
  });

  it("treats a LONG span between two dashes as a real clause, not an aside", () => {
    expect(
      summarizeTrigger(
        "Use when locating a symbol — read the region and only the confirmed span first — then edit",
      ),
    ).toBe("Use when locating a symbol");
  });

  it("caps the length and ellipsizes", () => {
    const out = summarizeTrigger(`Use when ${"x".repeat(200)}`);
    expect(out).toHaveLength(120);
    expect(out?.endsWith("…")).toBe(true);
  });

  it("returns null for an absent or blank description", () => {
    expect(summarizeTrigger(null)).toBeNull();
    expect(summarizeTrigger("   ")).toBeNull();
  });
});
