import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreRoot } from "../bundled-assets.ts";
import { DEFAULT_GLOBAL_BLOCKS, defaultGlobalConfig } from "../global-config.ts";
import { interpolate } from "../interpolate.ts";
import { CORE_MANAGED_ASSETS, resolveAssetPath, type CoreManagedAsset } from "../render-plan.ts";
import { globalRenderConfig } from "../../engines/claude/global-render.ts";
import { CORE_AGENTS, CORE_SKILLS, WORKFLOW_SKILLS } from "../../engines/shared/harness-assets.ts";

/**
 * The audit behind `globalSafe` (Spec 0010 §4, issue #541), enforced instead of
 * written down.
 *
 * §4 was a table in a markdown file, and it went stale without anything
 * failing: it claimed `arranque-sesion` interpolates `{{branchBase}}`, the asset
 * dropped that interpolation, and the only runtime check — a `/\{\{/` scan —
 * started saying yes to a block that describes `progress/current.md` and
 * `navori doctor`, neither of which exists in a project with no navori config.
 *
 * So the rules live here as executable predicates, and the suite asserts the
 * equivalence in BOTH directions: every marked asset passes all of them, and
 * every unmarked asset fails at least one. The reverse direction is the half
 * that matters most — without it, an asset that is genuinely global-safe can sit
 * unmarked forever and nobody notices the baseline is poorer than it could be,
 * which is exactly how a curated list rots.
 */

/**
 * Artifacts that only exist inside a repo navori has initialized, and that the
 * prose sends its reader to CONSULT.
 *
 * FB (#546) dropped `progress/` and `.claude/` from this list. The global scope
 * now installs the agents, and those two paths name files the agents WRITE —
 * a handoff report, a session-state file — which any project can hold. What
 * stays is what has to be there already for the advice to mean anything:
 * navori's own config, its doctor, and the SDD tree a repo opts into.
 */
const REPO_SCOPED_TOKENS = ["navori.config.json", "navori doctor", "specs/"] as const;

/**
 * Every navori agent and skill, read off disk rather than hardcoded, so a new
 * one is covered the day it ships.
 */
function navoriAgentAndSkillNames(): string[] {
  const root = getCoreRoot();
  const names: string[] = [];
  for (const dir of ["core-assets/agents", "core-assets/skills"]) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      names.push(entry.isDirectory() ? entry.name : basename(entry.name, ".md"));
    }
  }
  return [...new Set(names)];
}

/**
 * The subset the `@skills-dir` plugin actually installs (Spec 0010 FB). Naming
 * one of these globally is fine — the reader can act on it. Naming an asset
 * OUTSIDE the set (a preset agent, a library skill) still is not: only a repo
 * render materializes those.
 */
const GLOBALLY_SHIPPED = new Set<string>([
  ...CORE_AGENTS.map((a) => a.id),
  ...CORE_SKILLS,
  ...WORKFLOW_SKILLS,
]);

const AGENT_AND_SKILL_NAMES = navoriAgentAndSkillNames();

/** The config the global render interpolates against — the real one, not a stub. */
const GLOBAL_CONFIG = globalRenderConfig(defaultGlobalConfig("0.0.0"));

/** Both language renderings of a block — a rule must hold for whichever ships. */
function bodies(asset: CoreManagedAsset): string[] {
  const seen = new Set<string>();
  for (const lang of ["es", "en"] as const) {
    seen.add(readFileSync(resolveAssetPath(asset, lang).path, "utf-8"));
  }
  return [...seen];
}

/** Why this asset may NOT compose the global baseline. Empty ⇒ it may. */
function disqualifiers(asset: CoreManagedAsset): string[] {
  const reasons: string[] = [];
  if (asset.condition) {
    reasons.push(`has condition '${asset.condition}', which reads repo config`);
  }
  for (const body of bodies(asset)) {
    // Not "has {{" — "has a {{ that resolves to nothing here". The global
    // fallback scope answers `qualityGate.*`, `branchBase` and `prTarget` with
    // the instruction to derive them, which is what lets `orquestacion` ship.
    for (const miss of new Set(
      interpolate(body, GLOBAL_CONFIG, { fallbackScope: "global" }).match(
        /<not configured: [^>]+>/g,
      ) ?? [],
    )) {
      reasons.push(`leaves ${miss} unresolved in the global scope`);
    }
    for (const token of REPO_SCOPED_TOKENS) {
      if (body.includes(token)) reasons.push(`names the repo-scoped artifact '${token}'`);
    }
    for (const name of AGENT_AND_SKILL_NAMES) {
      // Backticked so prose like "explore the code" never counts as naming the
      // `explorer` agent — the assets cite them as `code`, always.
      if (body.includes(`\`${name}\``) && !GLOBALLY_SHIPPED.has(name)) {
        reasons.push(`names '${name}', which the global plugin does not ship`);
      }
    }
  }
  return [...new Set(reasons)];
}

describe("globalSafe is the audit, executed (#541, Spec 0010 §4)", () => {
  it.each(CORE_MANAGED_ASSETS.map((a) => [a.id, a] as const))(
    "'%s' — the declared mark matches what the asset actually is",
    (id, asset) => {
      const reasons = disqualifiers(asset);
      if (asset.globalSafe) {
        expect(
          reasons,
          `'${id}' is marked globalSafe but breaks the audit:\n  - ${reasons.join("\n  - ")}\n` +
            `Either fix the asset or drop the mark (see CoreManagedAsset.globalSafe).`,
        ).toEqual([]);
      } else {
        expect(
          reasons.length,
          `'${id}' is NOT marked globalSafe, yet it passes every rule of the audit. ` +
            `Mark it globalSafe so the global baseline can offer it, or — if it is ` +
            `unsafe for a reason no rule captures — add that rule here rather than ` +
            `leaving the exclusion undocumented.`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it("the shipped default baseline only selects global-safe blocks", () => {
    const safe = new Set(CORE_MANAGED_ASSETS.filter((a) => a.globalSafe).map((a) => a.id));
    for (const id of DEFAULT_GLOBAL_BLOCKS) expect(safe).toContain(id);
  });

  it("every DEFAULT_GLOBAL_BLOCKS id is a real core block", () => {
    const ids = new Set(CORE_MANAGED_ASSETS.map((a) => a.id));
    for (const id of DEFAULT_GLOBAL_BLOCKS) expect(ids).toContain(id);
  });

  it("at least one block is global-safe — an empty baseline would ship silently", () => {
    expect(CORE_MANAGED_ASSETS.filter((a) => a.globalSafe).length).toBeGreaterThan(0);
  });

  /**
   * The regression this issue exists for, pinned by name: `arranque-sesion` has
   * no interpolation left, so the old `/\{\{/` check would wave it through.
   */
  it("arranque-sesion is excluded for its PROSE, not for interpolation it no longer has", () => {
    const asset = CORE_MANAGED_ASSETS.find((a) => a.id === "arranque-sesion");
    expect(asset?.globalSafe).toBeFalsy();
    const reasons = disqualifiers(asset as CoreManagedAsset);
    expect(reasons.some((r) => r.includes("repo-scoped artifact"))).toBe(true);
    expect(reasons.some((r) => r.includes("unresolved"))).toBe(false);
  });

  /**
   * FB's headline: the routing doctrine ships globally BECAUSE the placeholders
   * it carries now have answers, not because the rule was loosened away.
   */
  it("orquestacion qualifies through the global fallbacks, not despite them", () => {
    const asset = CORE_MANAGED_ASSETS.find((a) => a.id === "orquestacion");
    expect(asset?.globalSafe).toBe(true);
    expect(disqualifiers(asset as CoreManagedAsset)).toEqual([]);
    const body = bodies(asset as CoreManagedAsset)[0] as string;
    expect(body).toContain("{{qualityGate.full}}");
    expect(interpolate(body, GLOBAL_CONFIG, { fallbackScope: "global" })).not.toContain(
      "{{qualityGate.full}}",
    );
  });
});
