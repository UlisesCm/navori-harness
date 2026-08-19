import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Content invariants for the review checklist (#333, #334, #335, #336).
 *
 * These rules exist because a human reviewer, running the generic checklist,
 * approved diffs that shipped the exact bugs they describe: a guard added to
 * one of four sibling endpoints, a state transition with no way back, an
 * unsupervised job entry point that swallowed the whole cycle. Generic prose
 * already covered them "in spirit" and still didn't fire.
 *
 * `skill-caps.test.ts` only looks upward (that the skill doesn't balloon); it
 * never notices an item being deleted. This suite looks downward: it fails when
 * one of the concrete triggers disappears in a future rewrite. The assertions
 * target the load-bearing tokens, not whole sentences, so rewording is free and
 * removal is not.
 */

const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "core", "core-assets");

const read = (rel: string): string => readFileSync(resolve(coreAssets, rel), "utf-8");

/**
 * Body of a single `## ` section, so an item is asserted to live in the right
 * dimension of the checklist. A trigger filed under the wrong heading is a
 * trigger the reviewer reads in the wrong pass.
 */
function section(text: string, headingStartsWith: string): string {
  const body = text
    .split(/^## /m)
    .slice(1)
    .find((chunk) => chunk.startsWith(headingStartsWith));
  expect(
    body,
    `no '## ${headingStartsWith}…' section found — the checklist was restructured`,
  ).toBeDefined();
  return body!;
}

describe("review-diff — the checklist keeps its concrete triggers", () => {
  it("§2 demands the inverse state transition, or a stated reason there is none (#335)", () => {
    const data = section(read("skills/review-diff.md"), "2. Data layer");
    expect(data).toContain("A→B");
    expect(data).toContain("B→A");
    // The severity is what makes it blocking; a note without one gets ignored.
    expect(data).toMatch(/B→A[^\n]*HIGH/);
  });

  it("§3 covers unsupervised async entry points (#336)", () => {
    const errors = section(read("skills/review-diff.md"), "3. Error handling");
    const item = errors.split("\n").find((l) => /queue consumer/i.test(l)) ?? "";
    expect(item, "the scheduled-job / consumer / listener trigger is gone").not.toBe("");
    expect(item).toMatch(/event listener/i);
    expect(item).toMatch(/entry point/i);
    expect(item).toMatch(/HIGH/);
  });

  it("§4 requires enumerating every entry point a guard must cover (#334)", () => {
    const security = section(read("skills/review-diff.md"), "4. Security");
    const item = security.split("\n").find((l) => /guard\/policy/i.test(l)) ?? "";
    expect(item, "the guard-coverage trigger is gone").not.toBe("");
    expect(item).toMatch(/mutate the same resource/i);
    // Enumerating is the mechanical part; without evidence it degrades to a vibe.
    expect(item).toMatch(/enumerate/i);
    expect(item).toContain("structural-search");
    // Partial coverage is a live authorization hole, not a nit.
    expect(item).toMatch(/CRITICAL/);
    // An unexplained exclusion is the same hole with a nicer diff.
    expect(item).toMatch(/justify|exclusion/i);
  });

  it("§4 refuses data-mutating scripts that default their target (#336)", () => {
    const security = section(read("skills/review-diff.md"), "4. Security");
    const item = security.split("\n").find((l) => /falls back to a default/i.test(l)) ?? "";
    expect(item, "the script-fallback trigger is gone").not.toBe("");
    expect(item).toMatch(/CRITICAL/);
    // The finding is blast radius (wrong target, clean run), not "there's a literal".
    expect(item).toMatch(/refuse to start/i);
  });

  it("§7 flags cognitive complexity over the repo's threshold (#333)", () => {
    const excess = section(read("skills/review-diff.md"), "7. Over-engineering");
    const item = excess.split("\n").find((l) => /cognitive complexity/i.test(l)) ?? "";
    expect(item, "the cognitive-complexity trigger is gone").not.toBe("");
    expect(item).toMatch(/threshold/i);
    expect(item).toMatch(/HIGH/);
  });
});

describe("the guard-coverage invariant reaches the two agents that act on it", () => {
  it("security-guidance §1 carries the business invariant, not just the trigger (#334)", () => {
    const auth = section(read("skills/security-guidance.md"), "1. Authorization");
    expect(auth).toMatch(/least-covered entry point/i);
    // What's protected is the resource, so the enumeration is over ways to mutate it.
    expect(auth).toMatch(/enumerating every way that resource is mutated/i);
    // Silence is not an exclusion.
    expect(auth).toMatch(/excluded with the reason/i);
  });

  it("the implementer must hand over the enumeration, not only the diff (#334)", () => {
    const impl = section(read("agents/implementer.md"), "Hard rules");
    const rule = impl.split("\n").find((l) => /Guard\/policy coverage/i.test(l)) ?? "";
    expect(rule, "the conditional guard/policy rule is gone from Hard rules").not.toBe("");
    // Conditional, in the shape of the SDD-traceability precedent above it.
    expect(rule).toMatch(/only if/i);
    expect(rule).toMatch(/entry point/i);
    expect(rule).toMatch(/file:line/i);
    expect(rule).toMatch(/covered or excluded/i);
  });
});
