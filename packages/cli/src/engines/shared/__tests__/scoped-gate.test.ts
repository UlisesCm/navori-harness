import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreRoot } from "../../../lib/bundled-assets.ts";
import { ROSTER_CORE_SKILLS } from "../roster.ts";

const coreAssets = resolve(getCoreRoot(), "core-assets");
const asset = (path: string): string => readFileSync(resolve(coreAssets, path), "utf8");

/**
 * #901 — the diff-scoped quality gate pattern travels to consumer repos as a
 * core skill, not as a distributed script (multi-engine: skills mirror to
 * Codex, `.claude/scripts/` does not). This suite asserts the load-bearing
 * doctrine survives any future edit to the skill's prose.
 */
describe("scoped-gate skill (#901)", () => {
  it("is registered as a core skill", () => {
    expect(ROSTER_CORE_SKILLS).toContain("scoped-gate");
  });

  it("states the hygiene-never-a-seal doctrine and the four measured edge cases", () => {
    const skill = asset("skills/scoped-gate.md");

    expect(skill).toContain("hygiene, never a seal");
    expect(skill).toContain("never replaces `qualityGate.full`");

    // The four edge cases, each with the issue that surfaced it.
    expect(skill).toContain("Untracked files (#777)");
    expect(skill).toContain('A failed listing is not "nothing changed" (#511)');
    expect(skill).toContain("Baseline freshness");
    expect(skill).toContain("Agent worktrees");

    // Package-manager-script wiring restriction (not a bare script path).
    expect(skill).toContain("build-settings.ts:634-638");
    expect(skill).toContain("never as a direct path to a");

    // Honest limit on typecheck.
    expect(skill).toContain("does not scope");
  });
});
