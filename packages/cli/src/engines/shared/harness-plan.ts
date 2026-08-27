import { join } from "node:path";
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
  /**
   * Key into config.models / config.effort for per-role assignment. Typed off
   * `harness` — the agent-role key set, which is exactly what `harnessKey`
   * feeds it. `keyof models` would also admit `codexMap`, a tier→model map
   * that is not a role and cannot index `config.effort`.
   */
  modelKey?: keyof NonNullable<NavoriConfig["harness"]>;
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
      id: extra.id,
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
    const id = extra.id;
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
    {
      id: "session-start-context",
      assetPath: join(coreAssets, "hooks/session-start-context.sh"),
      managedId: "session-start-context-base",
    },
    // Lifecycle hooks (N1). SubagentStop + PreCompact are unconditional: both
    // are advisory and near-silent, so there's no reason to gate them.
    {
      id: "subagent-stop-handoff",
      assetPath: join(coreAssets, "hooks/subagent-stop-handoff.sh"),
      managedId: "subagent-stop-handoff-base",
    },
    {
      id: "precompact-session-summary",
      assetPath: join(coreAssets, "hooks/precompact-session-summary.sh"),
      managedId: "precompact-session-summary-base",
    },
    // #530. The ONE PostToolUse hook, and the exception to the "never
    // PostToolUse" note in build-settings: it costs a single `find` against a
    // stamp file in the common case (~10ms measured, nothing changed → no
    // hashing at all). It is unconditional on purpose — an opt-in defense
    // protects nobody by default, and the freeze it detects is silent.
    {
      id: "managed-drift-watch",
      assetPath: join(coreAssets, "hooks/managed-drift-watch.sh"),
      managedId: "managed-drift-watch-base",
    },
    // #527: SessionEnd sweep for agent worktrees. Cleanup that depended on an
    // agent remembering to report a `worktree:` line left 27 of them (~2.6 GB)
    // behind; this one runs whether or not anybody remembered.
    {
      id: "worktree-reclaim",
      assetPath: join(coreAssets, "hooks/worktree-reclaim.sh"),
      managedId: "worktree-reclaim-base",
    },
    // Audit-mode (UserPromptSubmit + SessionEnd). Shipped unconditionally but
    // INERT until a session opts in by phrase: distribution is global so the
    // feature is versioned with the harness, activation stays per session.
    // Both run on rare events only — never PostToolUse — so an inactive repo
    // pays one cheap spawn per typed prompt.
    {
      id: "audit-mode-trigger",
      assetPath: join(coreAssets, "hooks/audit-mode-trigger.sh"),
      managedId: "audit-mode-trigger-base",
    },
    {
      id: "audit-mode-close",
      assetPath: join(coreAssets, "hooks/audit-mode-close.sh"),
      managedId: "audit-mode-close-base",
    },
  ];
  if (config.qualityGate?.fast) {
    hooks.push({
      id: "quality-gate-pre-commit",
      assetPath: join(coreAssets, "hooks/quality-gate-pre-commit.sh"),
      managedId: "qg-pre-commit-base",
    });
  }
  // Stop hook (verify-before-done reminder) is OPT-IN — noisy per-turn, so it
  // ships only when the repo asks for it. Same gating shape as the QG hook.
  if (config.hooks?.verifyOnStop) {
    hooks.push({
      id: "stop-verify-reminder",
      assetPath: join(coreAssets, "hooks/stop-verify-reminder.sh"),
      managedId: "stop-verify-reminder-base",
    });
  }

  return { agents, skills, hooks };
}
