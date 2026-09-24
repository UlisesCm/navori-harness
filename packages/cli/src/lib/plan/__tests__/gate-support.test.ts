import { describe, expect, it } from "vitest";
import { scanPlanTiersGateSupport } from "../gate-support.ts";
import type { NavoriConfig } from "../../config/config.ts";

/** Covers: R17 */
describe("scanPlanTiersGateSupport", () => {
  function config(overrides: Partial<NavoriConfig>): NavoriConfig {
    return {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      ...overrides,
    } as NavoriConfig;
  }

  it("returns null when harness.planTiers is off (default)", () => {
    expect(scanPlanTiersGateSupport(config({ engines: ["claude", "codex"] }))).toBeNull();
  });

  it("returns null when only claude is configured (the gate-capable engine)", () => {
    const cfg = config({
      engines: ["claude"],
      harness: { planTiers: true } as NavoriConfig["harness"],
    });
    expect(scanPlanTiersGateSupport(cfg)).toBeNull();
  });

  it("reports codex when planTiers is on and codex is also configured", () => {
    const cfg = config({
      engines: ["claude", "codex"],
      harness: { planTiers: true } as NavoriConfig["harness"],
    });
    expect(scanPlanTiersGateSupport(cfg)).toEqual({ unsupportedEngines: ["codex"] });
  });

  it("reports every non-claude engine configured", () => {
    const cfg = config({
      engines: ["codex", "agents-md", "cursor"],
      harness: { planTiers: true } as NavoriConfig["harness"],
    });
    expect(scanPlanTiersGateSupport(cfg)?.unsupportedEngines).toEqual([
      "codex",
      "agents-md",
      "cursor",
    ]);
  });
});
