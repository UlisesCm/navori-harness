import { describe, it, expect } from "vitest";
import { computeRenderPlan } from "../render-plan.ts";
import { injectManagedSection } from "../marker.ts";
import { NavoriConfigSchema } from "../schema.ts";
import { RETIRED_PLUGINS } from "../plugins.ts";

/**
 * #271 — a plugin removed from navori (e.g. `cognitive`, removed in #130) still
 * lingers in existing configs, and the managed block it injected into CLAUDE.md
 * became an unremovable orphan: the render's plugin loop hit the
 * `PluginNotFoundError` catch and `continue`d BEFORE the strip branch, so no
 * command could clean it. Registering the id in `RETIRED_PLUGINS` lets the
 * render prune the block (like `REMOVED_LIB_SKILLS` does for retired skills).
 */

// preset "custom" so no preset resolution happens — repoRoot is never read.
const repoRoot = process.cwd();

function makeConfig(plugins: Record<string, { enabled: boolean }>) {
  return NavoriConfigSchema.parse({
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    plugins,
  });
}

/** Seed a well-formed `cognitive-protocol` managed block into the base render. */
function seedWithCognitiveBlock(): string {
  const base = computeRenderPlan("", makeConfig({}), repoRoot).next;
  return injectManagedSection(
    base,
    "cognitive-protocol",
    "Complejidad cognitiva: mantén las funciones simples.\n",
    { source: "@navori/plugin-cognitive", version: "0.1.0" },
    "html",
  ).output;
}

describe("computeRenderPlan — retired plugin (#271)", () => {
  it("registers cognitive as retired with its orphan block id", () => {
    expect(RETIRED_PLUGINS.cognitive).toBeDefined();
    expect(RETIRED_PLUGINS.cognitive!.blockIds).toContain("cognitive-protocol");
  });

  it("strips the orphan managed block a retired plugin left in CLAUDE.md", () => {
    const seeded = seedWithCognitiveBlock();
    expect(seeded).toContain('id="cognitive-protocol"');
    expect(seeded).toContain("Complejidad cognitiva");

    // Config still declares the retired plugin (enabled) — its manifest is gone.
    const plan = computeRenderPlan(seeded, makeConfig({ cognitive: { enabled: true } }), repoRoot);

    // The orphan block and its markers are gone.
    expect(plan.next).not.toContain('id="cognitive-protocol"');
    expect(plan.next).not.toContain('/navori:managed id="cognitive-protocol"');
    expect(plan.next).not.toContain("Complejidad cognitiva");
    expect(plan.changed).toBe(true);

    // Reported via the same status a disabled plugin's block uses.
    const entry = plan.entries.find((e) => e.asset.id === "cognitive-protocol");
    expect(entry?.status).toBe("removed-condition-false");
    expect(entry?.source).toBe("cognitive");
    expect(entry?.newContent).toBeNull();

    // A retired plugin is NOT reported as a plain "unknown plugin" — doctor
    // gives the actionable hint instead.
    expect(plan.missingPlugins.find((m) => m.id === "cognitive")).toBeUndefined();
  });

  it("also strips when the retired plugin is declared disabled", () => {
    const seeded = seedWithCognitiveBlock();
    const plan = computeRenderPlan(seeded, makeConfig({ cognitive: { enabled: false } }), repoRoot);
    expect(plan.next).not.toContain('id="cognitive-protocol"');
    expect(plan.changed).toBe(true);
  });

  it("is a no-op when there is no orphan block to strip", () => {
    const base = computeRenderPlan("", makeConfig({}), repoRoot).next;
    const plan = computeRenderPlan(base, makeConfig({ cognitive: { enabled: true } }), repoRoot);
    const entry = plan.entries.find((e) => e.asset.id === "cognitive-protocol");
    expect(entry?.status).toBe("unchanged");
    expect(plan.next).toBe(base);
    expect(plan.changed).toBe(false);
  });

  it("still reports a genuinely unknown plugin as missing", () => {
    const base = computeRenderPlan("", makeConfig({}), repoRoot).next;
    const plan = computeRenderPlan(
      base,
      makeConfig({ "ghost-plugin": { enabled: true } }),
      repoRoot,
    );
    const missing = plan.missingPlugins.find((m) => m.id === "ghost-plugin");
    expect(missing?.reason).toBe("unknown plugin id");
  });
});
