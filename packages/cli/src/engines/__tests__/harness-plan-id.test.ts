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

describe("resolveHarnessPlan — dependent assets follow their feature gate (#769)", () => {
  it("omits the PR hook and SDD scaffolder when their owners are disabled", () => {
    const disabled = NavoriConfigSchema.parse({
      name: "disabled-dependencies",
      engines: ["claude"],
      preset: "custom",
      harness: { publisher: false },
      sdd: { enabled: false },
    });
    const plan = resolveHarnessPlan(disabled, "/core", null);

    expect(plan.hooks.map((hook) => hook.id)).not.toContain("pr-pilot-confirm");
    expect(plan.skills.map((skill) => skill.id)).not.toContain("spec-bootstrap");
  });
});

// Covers: R10, R52
describe("resolveHarnessPlan — comment-draft-confirm (spec 0026 E1)", () => {
  it("comment-draft-confirm is planned without plugin conditions", () => {
    // No plugin enabled at all (not even the ones that talk to gh/acli/Jira):
    // R10 requires the hook regardless of which plugins are on, because the
    // Bash call it gates does not come from a plugin's own tool surface.
    const noPlugins = NavoriConfigSchema.parse({
      name: "no-plugins",
      engines: ["claude"],
      preset: "custom",
      plugins: {},
    });
    const plan = resolveHarnessPlan(noPlugins, "/core", null);
    expect(plan.hooks.map((hook) => hook.id)).toContain("comment-draft-confirm");

    // Disabling every configurable agent/feature this file knows how to gate
    // (commit-pr-pilot, sdd) still leaves it in — it has no owner to disable
    // it with, unlike `pr-pilot-confirm` above.
    const disabled = NavoriConfigSchema.parse({
      name: "disabled-dependencies-2",
      engines: ["claude"],
      preset: "custom",
      harness: { publisher: false },
      sdd: { enabled: false },
    });
    const plan2 = resolveHarnessPlan(disabled, "/core", null);
    expect(plan2.hooks.map((hook) => hook.id)).toContain("comment-draft-confirm");
  });
});
