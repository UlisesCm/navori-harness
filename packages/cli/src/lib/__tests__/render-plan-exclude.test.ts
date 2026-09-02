import { describe, it, expect } from "vitest";
import { computeRenderPlan, canonicalManagedOrder, EXCLUDABLE_BLOCK_IDS } from "../render-plan.ts";
import { NavoriConfigSchema } from "../schema.ts";

/**
 * Feature: `blocks.exclude` lets a repo opt OUT of specific core managed blocks
 * (e.g. a repo with its own orchestration/SDD protocol excludes navori's
 * `orquestacion`/`sdd`). Sync semantics: a previously-rendered block that gets
 * excluded is REMOVED (markers included) on the next render, reusing the same
 * removal path a disabled plugin / a false condition uses.
 */

// preset "custom" so no preset resolution happens — repoRoot is never read.
const repoRoot = process.cwd();

function makeConfig(exclude: string[]) {
  return NavoriConfigSchema.parse({
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    blocks: { exclude },
  });
}

describe("computeRenderPlan — blocks.exclude", () => {
  it("EXCLUDABLE_BLOCK_IDS is the tight whitelist (only orquestacion, sdd)", () => {
    expect([...EXCLUDABLE_BLOCK_IDS].sort()).toEqual(["orquestacion", "sdd"]);
    // Identity / session / safety blocks are NOT excludable.
    expect(EXCLUDABLE_BLOCK_IDS).not.toContain("idioma-rol");
    expect(EXCLUDABLE_BLOCK_IDS).not.toContain("operaciones-seguras");
  });

  it("keeps a non-excludable core block even when it is listed in blocks.exclude", () => {
    // A hand-edited config listing `operaciones-seguras` must NOT strip it — the
    // whitelist is enforced at render time, not just in doctor/configure.
    const seeded = computeRenderPlan("", makeConfig([]), repoRoot).next;
    expect(seeded).toContain('id="operaciones-seguras"');
    const plan = computeRenderPlan(seeded, makeConfig(["operaciones-seguras"]), repoRoot);
    expect(plan.next).toContain('id="operaciones-seguras"');
    expect(plan.next).toBe(seeded);
    expect(plan.changed).toBe(false);
  });

  // The example block is `sdd`, not `orquestacion`: since #573 the routing
  // doctrine renders to `.claude/context/` instead of CLAUDE.md, so it can no
  // longer stand in for "a block in this file". The exclusion semantics under
  // test are the same for both, and the engine spec covers that the opt-out
  // reaches the new channel too.
  it("omits an excluded block from a fresh render", () => {
    const withBlock = computeRenderPlan("", makeConfig([]), repoRoot).next;
    expect(withBlock).toContain('id="sdd"');

    const excluded = computeRenderPlan("", makeConfig(["sdd"]), repoRoot).next;
    expect(excluded).not.toContain('id="sdd"');
    // Other core blocks still render.
    expect(excluded).toContain('id="idioma-rol"');
  });

  it("removes a previously-rendered block (markers included) when it becomes excluded", () => {
    // First render seeds sdd + idioma-rol.
    const seeded = computeRenderPlan("", makeConfig([]), repoRoot).next;
    expect(seeded).toContain('id="sdd"');
    expect(seeded).toContain('id="idioma-rol"');

    // Re-render with the block now excluded → its managed region is stripped.
    const plan = computeRenderPlan(seeded, makeConfig(["sdd"]), repoRoot);
    expect(plan.next).not.toContain('id="sdd"');
    expect(plan.next).not.toContain('/navori:managed id="sdd"');
    // The exclusion is reported via the same status a false condition uses.
    const entry = plan.entries.find((e) => e.asset.id === "sdd");
    expect(entry?.status).toBe("removed-condition-false");
    expect(entry?.newContent).toBeNull();
    // Untouched blocks survive.
    expect(plan.next).toContain('id="idioma-rol"');
    expect(plan.changed).toBe(true);
  });

  it("removes hand-edited excluded block content (documented data-loss semantics, consistent with disabled-plugin path)", () => {
    // Seed the block, then simulate a user hand-editing INSIDE its managed
    // region. Excluding it strips the whole region — the edit included —
    // silently, exactly like a disabled plugin's block. This pins the current
    // (intentional) data-loss behavior so a future change to it is a conscious
    // decision, not an accident.
    const seeded = computeRenderPlan("", makeConfig([]), repoRoot).next;
    expect(seeded).toContain('id="sdd"');
    const handEdited = seeded.replace(
      '<!-- /navori:managed id="sdd" -->',
      'HAND-EDITED LINE THAT WILL BE LOST\n<!-- /navori:managed id="sdd" -->',
    );
    expect(handEdited).toContain("HAND-EDITED LINE THAT WILL BE LOST");

    const plan = computeRenderPlan(handEdited, makeConfig(["sdd"]), repoRoot);
    // Region + markers + the user's edit are all gone — exclusion trumps edits.
    expect(plan.next).not.toContain('id="sdd"');
    expect(plan.next).not.toContain("HAND-EDITED LINE THAT WILL BE LOST");
    const entry = plan.entries.find((e) => e.asset.id === "sdd");
    expect(entry?.status).toBe("removed-condition-false");
    expect(entry?.newContent).toBeNull();
    expect(plan.changed).toBe(true);
  });

  it("is a no-op (unchanged) when the excluded block was never rendered", () => {
    const seeded = computeRenderPlan("", makeConfig(["orquestacion"]), repoRoot).next;
    // Re-run: orquestacion is absent, so removal is a no-op for that entry.
    const plan = computeRenderPlan(seeded, makeConfig(["orquestacion"]), repoRoot);
    const entry = plan.entries.find((e) => e.asset.id === "orquestacion");
    expect(entry?.status).toBe("unchanged");
    expect(plan.changed).toBe(false);
  });

  it("ignores an unknown id (no block matches, so nothing is stripped)", () => {
    const seeded = computeRenderPlan("", makeConfig([]), repoRoot).next;
    const plan = computeRenderPlan(seeded, makeConfig(["not-a-real-block"]), repoRoot);
    // Unknown id can't strip anything → identical output; doctor is what warns.
    expect(plan.next).toBe(seeded);
    expect(plan.changed).toBe(false);
  });

  it("drops the excluded block from the canonical order (so reorder never expects it)", () => {
    const order = canonicalManagedOrder(makeConfig(["orquestacion"]), repoRoot);
    expect(order).not.toContain("orquestacion");
    // A non-excluded core block stays.
    expect(order).toContain("idioma-rol");
  });
});
