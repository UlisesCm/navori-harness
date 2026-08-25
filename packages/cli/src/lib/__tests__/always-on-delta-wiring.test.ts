import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #396 — measuring the harness against itself, the two ways that actually paid.
 *
 * The issue proposed a behavior benchmark (frozen sandbox + frozen ticket +
 * metrics pipeline). It was dropped with evidence: three issues asked in writing
 * to measure against that baseline and all three shipped without it, replaced by
 * a byte count that falsified the very premise of the issue requesting it. What
 * this file pins is what the repo did instead, three times, without naming it:
 *
 *   1. `commit-pr-pilot` — the always-on byte delta, stated in the PR body.
 *   2. `spec-bootstrap`  — `evals.md`, the RED/GREEN run, for the rare case of a
 *      brand-new always-on layer.
 *
 * Two properties are as important as the prose existing at all, and both are
 * asserted here because both are one careless edit away:
 *
 *   - **It is not a gate.** A non-deterministic check in the gate teaches people
 *     to ignore the gate — the exact mistake the receipt backstop made (#365),
 *     and it was removed for it. So the delta may never appear in the pilot's
 *     abort conditions or its quality-gate section.
 *   - **It is generic.** These assets render into EVERY repo that uses navori.
 *     `packages/core/core-assets/` exists only here; the rendered `CLAUDE.md`
 *     exists everywhere (and the Codex adapter rewrites that name per engine),
 *     so the rule is anchored to the artifact, not to this repo's layout.
 */

const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "core", "core-assets");

const read = (rel: string): string => readFileSync(resolve(coreAssets, rel), "utf-8");

const PILOT = "agents/commit-pr-pilot.md";
const SPEC_BOOTSTRAP = "skills/spec-bootstrap.md";

/** Paths that exist in navori's own monorepo and in no repo it onboards. */
const NAVORI_ONLY_PATHS = /packages\/core|core-assets|packages\/plugins/;

/**
 * A top-level (`## `) section of an asset, heading included, up to the next one.
 *
 * Fence-aware on purpose: this very agent embeds a PR template whose fenced
 * body starts lines with `## Summary` / `## Changes`. A naive split on `^## `
 * cuts the section at that literal and hides everything written after the
 * template — which is exactly where the rule below lives. `### ` sub-headings
 * stay inside their section (the match needs a space after exactly two hashes).
 */
// Same shape as `FENCE_LINE_RE` in lib/marker.ts (not exported, so restated):
// indented fences and `~~~` both count. A `startsWith("```")` here would be
// blind to the asset's own indented fences, and an unseen fence pair around a
// column-0 `## ` truncates the section — greening the ABSENCE asserts below for
// the wrong reason. That is the #452/#459 failure class, in a test this time.
const FENCE_LINE = /^\s*(```|~~~)/;

function topLevelSection(rel: string, headingStartsWith: string): string {
  let inFence = false;
  let started = false;
  const collected: string[] = [];
  for (const line of read(rel).split("\n")) {
    if (FENCE_LINE.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith("## ")) {
      if (started) break;
      if (line.startsWith(`## ${headingStartsWith}`)) started = true;
    }
    if (started) collected.push(line);
  }
  expect(started, `${rel} lost its "## ${headingStartsWith}" section`).toBe(true);
  return collected.join("\n");
}

/**
 * The always-on delta rule, resolved THROUGH the body-drafting section: if it
 * ever moves to an appendix, this lookup fails instead of quietly passing on a
 * paragraph nobody opens while writing a PR body.
 */
function alwaysOnRule(): string {
  const bodySection = topLevelSection(PILOT, "Body template");
  const at = bodySection.indexOf("### Always-on delta");
  expect(
    at,
    "the always-on delta rule left the section where the PR body is drafted — " +
      "a rule the pilot has to go looking for is not wired",
  ).toBeGreaterThanOrEqual(0);
  return bodySection.slice(at);
}

/** The single line of `spec-bootstrap` that introduces the optional eval. */
function evalsLine(): string {
  const line = read(SPEC_BOOTSTRAP)
    .split("\n")
    .find((l) => l.includes("evals.md"));
  expect(line, "spec-bootstrap no longer offers `evals.md` as a spec artifact").toBeDefined();
  return line!;
}

describe("always-on delta — a number in the PR body, never a gate (#396)", () => {
  it("the rule sits where the pilot drafts the body, and only there", () => {
    const rule = alwaysOnRule();
    expect(rule).toMatch(/always-on layer/);
    // One home. A second copy elsewhere in the agent is drift waiting to happen:
    // the two would disagree the first time either is edited.
    const inFile = read(PILOT).match(/always-on/gi) ?? [];
    const inRule = rule.match(/always-on/gi) ?? [];
    expect(inFile.length, "the always-on rule is stated twice in the pilot").toBe(inRule.length);
  });

  it("measures with a byte count, against the same base as the PR diff", () => {
    const rule = alwaysOnRule();
    // Deterministic, reproducible by hand, and no tooling to install: this is
    // the whole reason it beat the benchmark it replaced.
    // `2>/dev/null` is load-bearing, not cosmetic: in the first PR of a repo that
    // just adopted navori the file does not exist in the base ref, and the raw
    // command prints `fatal:` on the very PR whose delta is largest.
    expect(rule).toContain("git show origin/{{prTarget}}:CLAUDE.md 2>/dev/null | wc -c");
    expect(rule).toContain("wc -c CLAUDE.md");
  });

  it("nothing blocks on it: the delta is absent from the abort and gate paths", () => {
    expect(alwaysOnRule()).toMatch(/never a gate/i);
    // The escape hatch for anyone who does want a ceiling — explicit and
    // deterministic, somewhere else, not bolted onto the PR flow.
    expect(alwaysOnRule()).toMatch(/explicit deterministic cap/i);
    // The two places where the pilot actually stops a PR. If the delta shows up
    // in either, it stopped being a number and became a gate.
    for (const heading of ["When NOT to trigger", "Mandatory pre-flight", "Hard rules"]) {
      expect(
        topLevelSection(PILOT, heading),
        `"${heading}" now blocks on the always-on delta — it is a number, not a gate (#365)`,
      ).not.toMatch(/always-on/i);
    }
  });

  it("a growing delta is reported with its counterpart, not treated as a veto", () => {
    const rule = alwaysOnRule();
    expect(rule).toMatch(/Growth is not a veto/);
    // Half a measurement is the failure mode here: a number with no statement of
    // what it buys reads as "growth is bad" and invites minimizing it.
    expect(rule).toMatch(/counterpart/i);
    expect(rule).toMatch(/not that the number stays small/i);
  });

  it("holds in a repo that is not navori's own monorepo", () => {
    const rule = alwaysOnRule();
    // The layer is named by the artifact every rendered repo has. Citing
    // navori's asset sources instead would make the rule unusable downstream.
    expect(rule).toContain("CLAUDE.md");
    expect(rule, "the rule cites a path that only exists inside navori's monorepo").not.toMatch(
      NAVORI_ONLY_PATHS,
    );
  });
});

describe("evals.md — the real run, for the rare new always-on layer (#396)", () => {
  it("spec-bootstrap offers it as an optional, rare spec artifact", () => {
    const line = evalsLine();
    expect(line).toContain("{{sdd.specsDir}}/<feature>/evals.md");
    expect(line).toMatch(/optional/i);
    expect(line).toMatch(/rare/i);
    // Same trigger the pilot's number covers, named the same way on purpose:
    // one lane, two instruments (cheap number / expensive run).
    expect(line).toMatch(/always-on layer/);
  });

  it("the method is RED/GREEN over one isolated variable, with evidence", () => {
    const line = evalsLine();
    expect(line).toContain("RED");
    expect(line).toContain("GREEN");
    expect(line).toMatch(/ONE isolated variable/);
    expect(line).toMatch(/same ticket, same repo, same model/);
    // An eval re-read to give the result someone wanted is worth nothing.
    expect(line).toMatch(/inverted results kept/i);
  });

  it("it lives in the spec because that is what survives the session", () => {
    const line = evalsLine();
    expect(line).toMatch(/transcript dies/i);
    expect(line).toMatch(/survives in git/i);
  });

  it("optional stays optional: traceability is still tasks and tests", () => {
    // The eval is an extra instrument for one rare trigger. If it leaks into the
    // hard rules, every spec starts paying for a run that almost none needs.
    expect(topLevelSection(SPEC_BOOTSTRAP, "Hard rules")).not.toMatch(/evals/i);
    expect(read(SPEC_BOOTSTRAP)).toContain("**Every `R<n>` ends in ≥1 task and ≥1 test.**");
  });
});
