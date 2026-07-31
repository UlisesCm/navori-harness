import { describe, it, expect } from "vitest";
import { resolveHarnessPlan } from "../shared/harness-plan.ts";
import { NavoriConfigSchema } from "../../lib/schema.ts";
import { PresetDefinitionSchema, type LoadedPreset } from "../../lib/presets.ts";

/**
 * Regression (#166): the planned id of a preset agent/skill MUST come from the
 * preset extra's declared `id`, NOT from `basename(destRelPath)`. With the
 * legacy `basename` derivation, a nested skill destination (the
 * `.claude/skills/<id>/SKILL.md` layout) collapsed the id to `"SKILL"` —
 * silently colliding across every nested skill. Deriving from `extra.id` is
 * behavior-preserving for the flat `<id>.md` presets shipped today and robust
 * to the nested form.
 */

const config = NavoriConfigSchema.parse({
  name: "demo",
  engines: ["claude"],
  preset: "custom",
});

function presetWithNestedExtras(): LoadedPreset {
  const def = PresetDefinitionSchema.parse({
    id: "demo-preset",
    displayName: "Demo",
    extras: {
      agents: [
        {
          id: "my-agent",
          relPath: "agents/my-agent.md",
          destRelPath: ".claude/agents/my-agent/AGENT.md",
        },
      ],
      skills: [
        {
          id: "my-skill",
          relPath: "skills/my-skill.md",
          destRelPath: ".claude/skills/my-skill/SKILL.md",
        },
      ],
    },
  });
  return { def, assetRoot: "/fake/assets", source: "local" };
}

describe("resolveHarnessPlan — preset extra id derivation", () => {
  it("derives a nested-skill id from extra.id, not basename(destRelPath)", () => {
    const plan = resolveHarnessPlan(config, "/core", presetWithNestedExtras());

    const skill = plan.skills.find((s) => s.managedId === "my-skill");
    expect(skill?.id).toBe("my-skill");
    expect(plan.skills.map((s) => s.id)).not.toContain("SKILL");
  });

  it("derives a nested-agent id from extra.id, not basename(destRelPath)", () => {
    const plan = resolveHarnessPlan(config, "/core", presetWithNestedExtras());

    const agent = plan.agents.find((a) => a.managedId === "my-agent");
    expect(agent?.id).toBe("my-agent");
    expect(plan.agents.map((a) => a.id)).not.toContain("AGENT");
  });
});
