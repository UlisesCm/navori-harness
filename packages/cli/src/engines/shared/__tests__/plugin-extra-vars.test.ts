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

describe("pluginExtraVars (#1055)", () => {
  it("derives jscpdThreshold=10 for a frontend preset", () => {
    expect(pluginExtraVars(config("vite-react-ts"))).toEqual({ jscpdThreshold: "10" });
  });

  it("derives jscpdThreshold=5 for a non-frontend preset", () => {
    expect(pluginExtraVars(config("custom"))).toEqual({ jscpdThreshold: "5" });
  });
});
