import { describe, it, expect } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/config/schema.ts";
import { pluginExtraVars } from "../plugin-extra-vars.ts";

function config(preset: string): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "extra-vars-demo",
    engines: ["claude"],
    preset,
    branchBase: "main",
    qualityGate: { fast: "pnpm lint", full: "pnpm test" },
  });
}

describe("pluginExtraVars (#1055, retired jscpdThreshold in #1060)", () => {
  it("returns an empty set — no plugin currently needs a derived extraVar", () => {
    expect(pluginExtraVars(config("vite-react-ts"))).toEqual({});
  });

  it("stays empty regardless of preset — the mechanism, not a jscpd-specific value", () => {
    expect(pluginExtraVars(config("custom"))).toEqual({});
  });
});
