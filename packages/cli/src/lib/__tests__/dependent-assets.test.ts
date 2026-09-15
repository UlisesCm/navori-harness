import { describe, expect, it } from "vitest";
import { computeRenderPlan } from "../render-plan.ts";
import { NavoriConfigSchema } from "../schema.ts";

describe("dependent rendered doctrine (#769)", () => {
  it("does not route to disabled agents or SDD assets", () => {
    const config = NavoriConfigSchema.parse({
      name: "disabled-doctrine",
      engines: ["claude"],
      preset: "custom",
      harness: { researcher: false },
      sdd: { enabled: false },
    });
    const plan = computeRenderPlan("", config, process.cwd());
    const orchestration = plan.entries.find(
      (entry) => entry.asset.id === "orquestacion",
    )?.newContent;

    expect(orchestration).not.toContain("`researcher`");
    expect(orchestration).not.toContain("`spec-bootstrap`");
  });
});
