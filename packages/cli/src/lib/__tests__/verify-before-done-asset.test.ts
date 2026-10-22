import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";

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
  // Spec 0019: §Synthesis moved to the depth reference, so the skill now points
  // there. What this test guards is unchanged — the cross-reference must resolve
  // to an asset that really carries the criterion, never to a dangling name.
  const orchestration = readCoreAsset("agents", "orchestrator.md");

  it("does not mandate a full re-read of the subagent's diff", () => {
    // Old wording that pushed a third full read of the diff:
    expect(skill).not.toMatch(/without opening the diff/);
    expect(skill).not.toMatch(/verifying the diff yourself/);
  });

  it("scopes subagent-report verification to load-bearing claims", () => {
    expect(skill).toMatch(/load-bearing/);
  });

  it("cross-references the orchestration block that owns the definition", () => {
    const block = "Anti-broken-telephone";
    expect(skill).toContain(block);
    // The referenced block must actually exist in the orchestration asset
    // and carry the canonical load-bearing criterion.
    expect(orchestration).toContain(block);
    expect(orchestration).toMatch(/load-bearing claims/);
  });
});

describe("verify-before-done asset — verification cadence (issue #1325)", () => {
  const skill = readCoreAsset("skills", "verify-before-done.md");
  const row = (label: string): string => {
    const line = skill.split("\n").find((l) => l.startsWith(`| ${label}`));
    expect(line, `table row missing: ${label}`).toBeDefined();
    return line ?? "";
  };

  it("forbids parallel runs sharing artifacts of the same checkout", () => {
    const r = row("Suites, builds or coverage in the same checkout");
    expect(r).toMatch(/one at a time/i);
    expect(r).toMatch(/`dist`/);
    expect(r).toMatch(/shared artifacts/);
    expect(r).toMatch(/worktrees with their own `dist`/i);
  });

  it("never removes an active lock nor kills another session", () => {
    const r = row("Active `dist` lock");
    expect(r).toMatch(/owner/);
    expect(r).toMatch(/verified-dead/);
    expect(r).toMatch(/Deleting the lock/);
    expect(r).toMatch(/killing another session/);
  });

  it("reruns the full gate once the fix set is stable, without weakening it", () => {
    const r = row("Full gate red");
    expect(r).toMatch(/focal tests/);
    expect(r).toMatch(/once the fix set is stable/);
    expect(r).toMatch(/mandatory before sign\/ship/i);
    expect(r).toMatch(/after every edit/);
  });
});
