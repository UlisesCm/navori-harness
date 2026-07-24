import { describe, it, expect } from "vitest";
import { computeRenderPlan, canonicalManagedOrder } from "../render-plan.ts";
import { NavoriConfigSchema } from "../schema.ts";

/**
 * Spec 0003 §3.1.4 — forceIds (accept-new) and skipIds (keep-mine) drive how a
 * hand-edited managed block is resolved during sync --interactive.
 */
const config = NavoriConfigSchema.parse({
  name: "demo",
  engines: ["claude"],
  preset: "custom",
});

// preset is "custom" so no preset resolution happens — repoRoot is never read.
const repoRoot = process.cwd();

describe("computeRenderPlan forceIds / skipIds (spec 0003 §3.1.4)", () => {
  it("forceIds overwrites a user-modified block; skipIds keeps it", () => {
    // Fresh render seeds the managed blocks.
    const fresh = computeRenderPlan("", config, repoRoot).next;
    expect(fresh).toContain('id="idioma-rol"');

    // User edits inside the idioma-rol block → hash drift.
    const modified = fresh.replace("Tech Lead Senior", "USER-EDIT-XYZ");

    // Plain re-render: conflict, edit preserved.
    const plain = computeRenderPlan(modified, config, repoRoot);
    expect(plain.entries.find((e) => e.asset.id === "idioma-rol")?.status).toBe(
      "user-modified-skipped",
    );
    expect(plain.next).toContain("USER-EDIT-XYZ");

    // accept-new (forceIds): block overwritten with the rendered version.
    const forced = computeRenderPlan(modified, config, repoRoot, {
      forceIds: new Set(["idioma-rol"]),
    });
    expect(forced.entries.find((e) => e.asset.id === "idioma-rol")?.status).toBe("updated");
    expect(forced.next).not.toContain("USER-EDIT-XYZ");
    expect(forced.next).toContain("Tech Lead Senior");

    // keep-mine (skipIds): block left untouched (not even inspected).
    const kept = computeRenderPlan(modified, config, repoRoot, {
      skipIds: new Set(["idioma-rol"]),
    });
    expect(kept.next).toContain("USER-EDIT-XYZ");
    expect(kept.entries.find((e) => e.asset.id === "idioma-rol")).toBeUndefined();
  });
});

describe("canonicalManagedOrder", () => {
  it("leads with the orchestrator block and ends with the computed blocks", () => {
    const order = canonicalManagedOrder(config, repoRoot);
    expect(order[0]).toBe("orquestacion");
    expect(order).toContain("idioma-rol");
    expect(order.slice(-4)).toEqual([
      "skills-index",
      "agentes-disponibles",
      "contexto-monorepo",
      "contexto-proyecto",
    ]);
  });

  it("matches the emission order of a fresh render", () => {
    const fresh = computeRenderPlan("", config, repoRoot).next;
    const emitted = [...fresh.matchAll(/<!-- navori:managed id="([^"]+)"/g)].map((m) => m[1]!);
    const order = canonicalManagedOrder(config, repoRoot);
    // every emitted block appears in canonical order, in the same relative order
    const ranked = emitted.map((id) => order.indexOf(id));
    expect(ranked).toEqual([...ranked].sort((a, b) => a - b));
    expect(ranked.every((r) => r >= 0)).toBe(true);
  });
});
