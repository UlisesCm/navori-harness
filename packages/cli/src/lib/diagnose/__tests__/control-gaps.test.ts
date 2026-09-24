import { describe, expect, it } from "vitest";
import { scanControlGaps } from "../control-gaps.ts";
import type { NavoriConfig } from "../../config/config.ts";

/**
 * Migrated from `lib/plan/__tests__/gate-support.test.ts` (spec 0033 T10):
 * `lib/plan/gate-support.ts` is retired, and `plan-gate` is now one row of
 * this scan instead of a standalone function.
 *
 * R17 (spec 0032, #1011): where the engine cannot intercept the launch of a
 * subagent, `harness.planTiers`'s hard gate degrades to the reviewer's own
 * `classify` check (R21) — `navori doctor` reports the degradation instead of
 * leaving it silent.
 *
 * Covers: R21
 */
describe("scanControlGaps", () => {
  function config(overrides: Partial<NavoriConfig>): NavoriConfig {
    return {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      ...overrides,
    } as NavoriConfig;
  }

  it("does not report plan-gate when harness.planTiers is off (default)", () => {
    const gaps = scanControlGaps(config({ engines: ["claude", "codex"] }));
    expect(gaps.some((g) => g.control === "plan-gate")).toBe(false);
  });

  it("does not report plan-gate when only claude is configured (enforced there)", () => {
    const cfg = config({
      engines: ["claude"],
      harness: { planTiers: true } as NavoriConfig["harness"],
    });
    expect(scanControlGaps(cfg).some((g) => g.control === "plan-gate")).toBe(false);
  });

  it("reports plan-gate as advisory and warn when planTiers is on and codex is configured", () => {
    const cfg = config({
      engines: ["claude", "codex"],
      harness: { planTiers: true } as NavoriConfig["harness"],
    });
    const gap = scanControlGaps(cfg).find((g) => g.control === "plan-gate" && g.engine === "codex");
    expect(gap).toMatchObject({ state: "advisory", severity: "warn" });
  });

  it("reports plan-gate for every non-claude engine configured", () => {
    const cfg = config({
      engines: ["codex", "agents-md", "cursor"],
      harness: { planTiers: true } as NavoriConfig["harness"],
    });
    const engines = scanControlGaps(cfg)
      .filter((g) => g.control === "plan-gate")
      .map((g) => g.engine);
    expect(engines).toEqual(["codex", "agents-md", "cursor"]);
  });

  it("reports the unconditional advisory controls as info in a solo-Claude repo", () => {
    const gaps = scanControlGaps(config({ engines: ["claude"] }));
    const unconditional = gaps.filter((g) =>
      ["handoff-shape", "handoff-consumer", "analytic-write-tools"].includes(g.control),
    );
    expect(unconditional.length).toBeGreaterThan(0);
    for (const gap of unconditional) expect(gap.severity).toBe("info");
  });

  it("does not report local-skill-discovery when project.localSkills is empty", () => {
    const gaps = scanControlGaps(config({ engines: ["cursor"] }));
    expect(gaps.some((g) => g.control === "local-skill-discovery")).toBe(false);
  });

  it("reports local-skill-discovery as unsupported and warn for cursor when a local skill is declared", () => {
    const cfg = config({
      engines: ["cursor"],
      project: { localSkills: ["my-skill"] } as NavoriConfig["project"],
    });
    const gap = scanControlGaps(cfg).find((g) => g.control === "local-skill-discovery");
    expect(gap).toMatchObject({ state: "unsupported", severity: "warn" });
  });
});
