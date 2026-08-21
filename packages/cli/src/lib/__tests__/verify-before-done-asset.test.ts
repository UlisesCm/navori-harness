import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * Anti-regression: coherence between `verify-before-done.md` and the
 * orchestration asset (issue #400).
 *
 * The harness has ONE post-`done -> file` re-verification policy, defined in
 * the "Synthesis without broken telephone" block of `orquestacion.md`:
 * re-verify only the LOAD-BEARING claims (each cited `file:line` plus the
 * diff the subagent touched). The skill must reference that same criterion —
 * it must never mandate a full third read of a diff the implementer wrote
 * and the reviewer already validated in two passes.
 */

function readCoreAsset(...segments: string[]): string {
  const path = resolve(getCoreRoot(), "core-assets", ...segments);
  expect(existsSync(path), `core asset missing: ${path}`).toBe(true);
  return readFileSync(path, "utf-8");
}

describe("verify-before-done asset — single re-verification policy", () => {
  const skill = readCoreAsset("skills", "verify-before-done.md");
  const orchestration = readCoreAsset("managed", "orquestacion.md");

  it("does not mandate a full re-read of the subagent's diff", () => {
    // Old wording that pushed a third full read of the diff:
    expect(skill).not.toMatch(/without opening the diff/);
    expect(skill).not.toMatch(/verifying the diff yourself/);
  });

  it("scopes subagent-report verification to load-bearing claims", () => {
    expect(skill).toMatch(/load-bearing/);
  });

  it("cross-references the orchestration block that owns the definition", () => {
    const block = "Synthesis without broken telephone";
    expect(skill).toContain(block);
    // The referenced block must actually exist in the orchestration asset
    // and carry the canonical load-bearing criterion.
    expect(orchestration).toContain(block);
    expect(orchestration).toMatch(/load-bearing claims/);
  });
});
