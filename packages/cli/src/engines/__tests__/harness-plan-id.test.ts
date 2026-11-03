import { describe, it, expect } from "vitest";
import { resolveHarnessPlan } from "../shared/harness-plan.ts";
import { NavoriConfigSchema } from "../../lib/config/schema.ts";
import { PresetDefinitionSchema, type LoadedPreset } from "../../lib/config/presets.ts";

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
  return { def, assetRoot: "/fake/assets", source: "local", droppedLibraries: [] };
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

    expect(plan.hooks.map((hook) => hook.id)).not.toContain("pr-publisher-confirm");
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
    // it with, unlike `pr-publisher-confirm` above.
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

// Covers: R20, R21
describe("resolveHarnessPlan — opt-in gates (#1484)", () => {
  const ids = (harness: Record<string, boolean>, hooks?: Record<string, boolean>) => {
    const plan = resolveHarnessPlan(
      NavoriConfigSchema.parse({
        name: "gates",
        engines: ["claude"],
        preset: "custom",
        harness,
        ...(hooks ? { hooks } : {}),
      }),
      "/core",
      null,
      { engine: "claude" },
    );
    return {
      skills: plan.skills.map((s) => s.id),
      agents: plan.agents.map((a) => a.id),
      hooks: plan.hooks.map((h) => h.id),
    };
  };

  it("omits every gated unit by default; master-plan and context-intake stay", () => {
    const { skills, agents, hooks } = ids({});
    for (const id of ["plan-simple", "plan-advanced", "dominio", "author-skill"]) {
      expect(skills).not.toContain(id);
    }
    expect(skills).toContain("master-plan");
    expect(skills).toContain("context-intake");
    expect(agents).not.toContain("scribe");
    for (const id of [
      "implementer-no-markdown",
      "routing-watch",
      "model-advisor",
      "audit-mode-trigger",
      "audit-mode-close",
      "master-plan-context",
      "master-accept-confirm",
    ]) {
      expect(hooks).not.toContain(id);
    }
  });

  it("restores each unit with its own flag", () => {
    expect(ids({ planTiers: true }).skills).toEqual(
      expect.arrayContaining(["plan-simple", "plan-advanced"]),
    );
    expect(ids({ planTiers: true }).hooks).toContain("routing-watch");
    expect(ids({ authoring: true }).skills).toEqual(
      expect.arrayContaining(["dominio", "author-skill"]),
    );
    const owns = ids({ scribeOwnsMarkdown: true });
    expect(owns.agents).toContain("scribe");
    expect(owns.hooks).toContain("implementer-no-markdown");
    expect(ids({ scribeOwnsMarkdown: true, scribe: false }).agents).not.toContain("scribe");
    expect(ids({ masterPlan: true }).hooks).toEqual(
      expect.arrayContaining(["master-plan-context", "master-accept-confirm"]),
    );
    expect(ids({}, { modelAdvisor: true }).hooks).toContain("model-advisor");
    expect(ids({}, { auditMode: true }).hooks).toEqual(
      expect.arrayContaining(["audit-mode-trigger", "audit-mode-close"]),
    );
  });

  it("audit.mode always implies the audit hooks; codexIntegration keeps model-advisor on Codex only", () => {
    const always = resolveHarnessPlan(
      NavoriConfigSchema.parse({
        name: "gates",
        engines: ["claude"],
        preset: "custom",
        audit: { mode: "always" },
      }),
      "/core",
      null,
      { engine: "claude" },
    );
    expect(always.hooks.map((h) => h.id)).toEqual(
      expect.arrayContaining(["audit-mode-trigger", "audit-mode-close"]),
    );
    const integration = NavoriConfigSchema.parse({
      name: "gates",
      engines: ["codex"],
      preset: "custom",
      harness: { codexIntegration: true },
    });
    const idsOn = (engine: string) =>
      resolveHarnessPlan(integration, "/core", null, { engine }).hooks.map((h) => h.id);
    expect(idsOn("codex")).toContain("model-advisor");
    expect(idsOn("claude")).not.toContain("model-advisor");
  });
});

// Covers: R20, R21
describe("resolveHarnessPlan — per-engine scope (spec 0041 D11)", () => {
  const scoped = ["master-plan", "context-intake"];
  const scopedHooks = ["master-plan-context", "master-accept-confirm"];
  // #1484: the master-plan hooks are planned only with `harness.masterPlan`.
  const masterConfig = NavoriConfigSchema.parse({
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    harness: { masterPlan: true },
  });
  const idsFor = (engine?: string) => {
    const plan = resolveHarnessPlan(masterConfig, "/core", null, { engine });
    return { skills: plan.skills.map((s) => s.id), hooks: plan.hooks.map((h) => h.id) };
  };

  it.each(["claude", "codex"])("plans the master-plan skills and hooks for %s", (engine) => {
    const { skills, hooks } = idsFor(engine);
    for (const id of scoped) expect(skills).toContain(id);
    for (const id of scopedHooks) expect(hooks).toContain(id);
  });

  // Covers: R5
  it("plans only the master-accept confirmation for pi: its bash runs `navori master`", () => {
    const { skills, hooks } = idsFor("pi");
    for (const id of scoped) expect(skills).not.toContain(id);
    expect(hooks).not.toContain("master-plan-context");
    expect(hooks).toContain("master-accept-confirm");
  });

  it.each([undefined, "cursor", "copilot", "agents-md"])(
    "plans only universal units for %s",
    (engine) => {
      const { skills, hooks } = idsFor(engine);
      for (const id of scoped) expect(skills).not.toContain(id);
      for (const id of scopedHooks) expect(hooks).not.toContain(id);
    },
  );
});
