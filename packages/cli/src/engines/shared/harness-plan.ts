import { join } from "node:path";
import type { NavoriConfig } from "../../lib/config.ts";
import { librarySkillById } from "../../lib/assets/library-skills.ts";
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
  /**
   * The hook can only do its job on the main thread: inside a subagent it is a
   * spawn that produces nothing. Stamped from `MAIN_THREAD_ONLY_HOOKS`; absent
   * means "does real work in a subagent too", which is the default.
   *
   * It does NOT unregister the hook — both hosts fire tool events inside
   * subagents and there is no per-thread registration to ask for. It is a
   * declaration the audit reads, so a firing that can do nothing shows up as a
   * finding instead of as an indistinguishable row.
   */
  mainThreadOnly?: true;
}

/**
 * Core hooks that are inert inside a subagent — DECLARED, never inferred.
 *
 * #924 tested the obvious inference ("it never returned a verdict other than
 * `skip` in a subagent") against this repo's audit store and it is refuted:
 * `model-advisor` emits `skip` 100% of the time in BOTH contexts (1,030
 * orchestrator firings, 3,649 subagent ones), so the heuristic would flag the
 * main thread just as hard. It does not improve with more data; it is
 * structural. The declaration is the only sound route.
 *
 * The bar for an entry is the hook's OWN code proving the inertness, not an
 * opinion about its purpose:
 *   - `model-advisor` — `model-advisor.sh:46` exits 0 unconditionally when the
 *     payload carries `agent_id` or `agent_type`. It cannot do anything there.
 *
 * Deliberately NOT here, with the reason, because the tempting cases are the
 * ones that produce false findings:
 *   - `guard-destructive` blocks in subagents (7 blocks / 1,535 allows measured)
 *     and is the hook that sets the pace of `PreToolUse`.
 *   - `routing-watch` reads `agent_id` to RECORD delegation (`routing-watch.sh:256`),
 *     which is work, not a no-op.
 *   - `pr-publisher-confirm` reads it to decide, and records the `allow` it
 *     decided (`pr-publisher-confirm.sh:98-104`) — an observable, not nothing.
 *   - The lifecycle hooks (`session-start-context`, `worktree-reclaim`,
 *     `audit-mode-*`) ride events neither host fires for subagents, so they
 *     cannot misfire and an entry would only add noise.
 */
export const MAIN_THREAD_ONLY_HOOKS: ReadonlySet<string> = new Set(["model-advisor"]);

export interface HarnessPlan {
  agents: PlannedAgent[];
  skills: PlannedSkill[];
  hooks: PlannedHook[];
}

export function resolveHarnessPlan(
  config: NavoriConfig,
  coreAssets: string,
  preset: ReturnType<typeof loadPreset>,
  options: { includeOrchestrator?: boolean } = {},
): HarnessPlan {
  const agents: PlannedAgent[] = [];
  for (const agent of CORE_AGENTS) {
    // Engines whose main thread embodies the orchestrator (Codex) leave this off.
    if (agent.id === "orchestrator" && options.includeOrchestrator !== true) continue;
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

  const workflowSkills =
    config.sdd?.enabled === false
      ? WORKFLOW_SKILLS.filter((id) => id !== "spec-bootstrap")
      : WORKFLOW_SKILLS;
  const skills: PlannedSkill[] = [
    ...CORE_SKILLS.map((id) => ({
      id,
      assetPath: join(coreAssets, `skills/${id}.md`),
      managedId: `${id}-base`,
    })),
    ...workflowSkills.map((id) => ({
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
    // Spec 0030 (#985), R3/R4: the mechanical backstop for "the implementer
    // does not write Markdown". Unconditional, like the guard above — it is
    // scoped to a single role's payload, not a configurable feature.
    {
      id: "implementer-no-markdown",
      assetPath: join(coreAssets, "hooks/implementer-no-markdown.sh"),
      managedId: "implementer-no-markdown-base",
    },
    {
      id: "session-start-context",
      assetPath: join(coreAssets, "hooks/session-start-context.sh"),
      managedId: "session-start-context-base",
    },
    {
      id: "model-advisor",
      assetPath: join(coreAssets, "hooks/model-advisor.sh"),
      managedId: "model-advisor-base",
    },
    // Lifecycle hook (N1). Unconditional: advisory and near-silent, so there's
    // no reason to gate it. It rides PostToolUse(`Agent|Task`) since #774 — the
    // id keeps its original spelling because it is a managed-block id stamped
    // into every already-rendered repo, not a description of the event.
    //
    // `precompact-session-summary` was RETIRED here in #774: PreCompact has no
    // documented channel to the model, so the reminder moved to the
    // `SessionStart(compact)` branch of `session-start-context.sh`. Its leftover
    // copies are pruned through `RETIRED_HOOKS`.
    {
      id: "subagent-stop-handoff",
      assetPath: join(coreAssets, "hooks/subagent-stop-handoff.sh"),
      managedId: "subagent-stop-handoff-base",
    },
    // #530. The first PostToolUse hook, and the exception to the "never
    // PostToolUse" note in build-settings: it costs one `shasum` pass over the
    // managed files (~35ms, the median of 13,692 recorded runs). It was a
    // find/mtime probe at ~10ms until that proved unreliable in CI and was
    // redesigned. The measurement and why the clock was never a sound basis
    // live in the script's own COST header; this comment and the one in
    // `build-settings.ts` restate it, so a correction has to land in all three.
    // It is unconditional on purpose — an opt-in defense protects nobody by
    // default, and the freeze it detects is silent.
    {
      id: "managed-drift-watch",
      assetPath: join(coreAssets, "hooks/managed-drift-watch.sh"),
      managedId: "managed-drift-watch-base",
    },
    // Spec 0020. The second PostToolUse hook: it counts distinct files written
    // in the session and hands the model R2 of the routing ladder, ONCE, when
    // the count crosses 4 with no subagent invoked. Unconditional for the same
    // reason as its neighbour — the failure it addresses (delegating nothing on
    // a session that should have) is silent, and measured at 57% of the
    // sessions that crossed the threshold. Its matcher confines it to the write
    // tools plus `Agent`, so a Read or a Grep never spawns it.
    {
      id: "routing-watch",
      assetPath: join(coreAssets, "hooks/routing-watch.sh"),
      managedId: "routing-watch-base",
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
  // Spec 0026 E1 (R10). Unconditional like the guard: the draft-confirm
  // covers ANY agent's Bash call that publishes a comment or review, and its
  // owner is the harness itself, not a configurable agent or plugin — so
  // there is no feature flag whose absence should silence it.
  hooks.push({
    id: "comment-draft-confirm",
    assetPath: join(coreAssets, "hooks/comment-draft-confirm.sh"),
    managedId: "comment-draft-confirm-base",
  });
  // #705: only a repo that receives publisher receives its dependent
  // routing hook. The guard stays unconditional; this hook has an owner.
  if (isAgentEnabled(config, "publisher")) {
    hooks.push({
      id: "pr-publisher-confirm",
      assetPath: join(coreAssets, "hooks/pr-publisher-confirm.sh"),
      managedId: "pr-publisher-confirm-base",
    });
  }
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

  // Stamped here, once, instead of on each literal above: the list is the
  // single source of truth, and a hook added conditionally further up would
  // otherwise be the one that forgets the flag.
  return {
    agents,
    skills,
    hooks: hooks.map((hook) =>
      MAIN_THREAD_ONLY_HOOKS.has(hook.id) ? { ...hook, mainThreadOnly: true as const } : hook,
    ),
  };
}
