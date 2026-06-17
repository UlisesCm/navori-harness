import { describe, it, expect } from "vitest";
import { computeRenderPlan } from "../render-plan.ts";
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

describe("computeRenderPlan forceIds / skipIds (spec 0003 §3.1.4)", () => {
  it("forceIds overwrites a user-modified block; skipIds keeps it", () => {
    // Fresh render seeds the managed blocks.
    const fresh = computeRenderPlan("", config).next;
    expect(fresh).toContain('id="idioma-rol"');

    // User edits inside the idioma-rol block → hash drift.
    const modified = fresh.replace("Tech Lead Senior", "USER-EDIT-XYZ");

    // Plain re-render: conflict, edit preserved.
    const plain = computeRenderPlan(modified, config);
    expect(plain.entries.find((e) => e.asset.id === "idioma-rol")?.status).toBe(
      "user-modified-skipped",
    );
    expect(plain.next).toContain("USER-EDIT-XYZ");

    // accept-new (forceIds): block overwritten with the rendered version.
    const forced = computeRenderPlan(modified, config, { forceIds: new Set(["idioma-rol"]) });
    expect(forced.entries.find((e) => e.asset.id === "idioma-rol")?.status).toBe("updated");
    expect(forced.next).not.toContain("USER-EDIT-XYZ");
    expect(forced.next).toContain("Tech Lead Senior");

    // keep-mine (skipIds): block left untouched (not even inspected).
    const kept = computeRenderPlan(modified, config, { skipIds: new Set(["idioma-rol"]) });
    expect(kept.next).toContain("USER-EDIT-XYZ");
    expect(kept.entries.find((e) => e.asset.id === "idioma-rol")).toBeUndefined();
  });
});
