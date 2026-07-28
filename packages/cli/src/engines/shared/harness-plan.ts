import { basename, join } from "node:path";
import type { NavoriConfig } from "../../lib/config.ts";
import { librarySkillById } from "../../lib/library-skills.ts";
import type { loadPreset } from "../../lib/presets.ts";
import {
  CORE_AGENTS,
  CORE_SKILLS,
  WORKFLOW_SKILLS,
  extraConditionMet,
  isAgentEnabled,
} from "./harness-assets.ts";

/**
 * Provider-agnostic harness inventory (Spec 0007, Capa 1). Resolves WHICH
 * agents/skills/hooks a render must materialize from config + preset +
 * detected libraries. Knows nothing about destinations or formats — those
 * belong to each engine adapter (Capa 2).
 */

export interface PlannedAgent {
  id: string;
  assetPath: string;
  /**
   * Canonical (Claude-style) managed-block id: `<id>-base` for core agents,
   * the preset extra's own id for preset agents. Codex ignores it and derives
   * its own `<id>-codex-base` namespace to avoid collisions.
   */
  managedId: string;
  /** Key into config.models / config.effort for per-role assignment. */
  modelKey?: keyof NonNullable<NavoriConfig["models"]>;
  /** Role sandbox from the catalog; providers that sandbox honor it (Codex). */
  sandbox?: "read-only" | "workspace-write";
}

export interface PlannedSkill {
  id: string;
  assetPath: string;
  managedId: string;
}

export interface PlannedHook {
  /** Basename without extension; engines derive `<dir>/<id>.sh`. */
  id: string;
  assetPath: string;
  managedId: string;
}

export interface HarnessPlan {
  agents: PlannedAgent[];
  skills: PlannedSkill[];
  hooks: PlannedHook[];
}

export function resolveHarnessPlan(
  config: NavoriConfig,
  coreAssets: string,
  preset: ReturnType<typeof loadPreset>,
  options: { includeLeader?: boolean } = {},
): HarnessPlan {
  const agents: PlannedAgent[] = [];
  for (const agent of CORE_AGENTS) {
    // Engines whose main thread embodies the leader (Codex) leave this off.
    if (agent.id === "leader" && options.includeLeader !== true) continue;
    if (!isAgentEnabled(config, agent.harnessKey)) continue;
    agents.push({
      id: agent.id,
      assetPath: join(coreAssets, `agents/${agent.id}.md`),
      managedId: `${agent.id}-base`,
      modelKey: agent.harnessKey,
      sandbox: agent.sandbox,
    });
  }
  for (const extra of preset?.def.extras.agents ?? []) {
    if (!extraConditionMet(extra, config)) continue;
    agents.push({
      id: basename(extra.destRelPath).replace(/\.md$/, ""),
      assetPath: join(preset!.assetRoot, extra.relPath),
      managedId: extra.id,
    });
  }

  const skills: PlannedSkill[] = [
    ...CORE_SKILLS.map((id) => ({
      id,
      assetPath: join(coreAssets, `skills/${id}.md`),
      managedId: `${id}-base`,
    })),
    ...WORKFLOW_SKILLS.map((id) => ({
      id,
      assetPath: join(coreAssets, `skills/${id}.md`),
      managedId: id,
    })),
  ];
  const seen = new Set(skills.map(({ id }) => id));
  for (const extra of preset?.def.extras.skills ?? []) {
    if (!extraConditionMet(extra, config)) continue;
    const id = basename(extra.destRelPath).replace(/\.md$/, "");
    if (seen.has(id)) continue;
    seen.add(id);
    skills.push({ id, assetPath: join(preset!.assetRoot, extra.relPath), managedId: extra.id });
  }
  for (const id of config.project?.libraries ?? []) {
    if (seen.has(id) || !librarySkillById(id)) continue;
    seen.add(id);
    skills.push({ id, assetPath: join(coreAssets, `lib-skills/${id}.md`), managedId: id });
  }

  const hooks: PlannedHook[] = [
    {
      id: "guard-destructive",
      assetPath: join(coreAssets, "hooks/guard-destructive.sh"),
      managedId: "guard-destructive-base",
    },
  ];
  if (config.qualityGate?.fast) {
    hooks.push({
      id: "quality-gate-pre-commit",
      assetPath: join(coreAssets, "hooks/quality-gate-pre-commit.sh"),
      managedId: "qg-pre-commit-base",
    });
  }

  return { agents, skills, hooks };
}
