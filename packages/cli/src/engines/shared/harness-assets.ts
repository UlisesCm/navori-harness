import type { NavoriConfig } from "../../lib/config.ts";
import { resolveCondition } from "../../lib/marker.ts";
import type { PresetExtraFile } from "../../lib/presets.ts";
import {
  ROSTER_AGENTS,
  ROSTER_CORE_SKILLS,
  ROSTER_WORKFLOW_SKILLS,
  RETIRED_SKILLS as ROSTER_RETIRED_SKILLS,
  RETIRED_HOOKS as ROSTER_RETIRED_HOOKS,
  type Retired,
} from "./roster.ts";

export type { Retired, RetiredAdapter } from "./roster.ts";

/**
 * `sandbox` is a property of the ROLE, not of any engine: it renders read-only
 * wherever a provider supports sandboxing (today Codex's `sandbox_mode`); absent
 * → workspace-write. Keeping it here means the next provider inherits it for free
 * (Spec 0007 M4).
 *
 * A harness role that hands off through `.claude/progress/*.md` (+ the reviewer's
 * `receipt.txt`) needs `workspace-write`: a read-only sandbox would silently break
 * the RDD anti-broken-telephone signature (#204). reviewer, researcher, explorer,
 * ticket-audit and auditor still never touch production code — that's enforced by
 * their prose contract (and their tool set), not the sandbox. The auditor writes its
 * durable outputs (`progress/audit_deep_*.md`, `plan_*.md`, SDD drafts) to disk, so a
 * read-only sandbox would break its contract in Codex exactly like the sibling roles
 * (#280).
 *
 * Re-exported from `roster.ts` (spec 0026 T8): that file is now the canonical
 * source, checked against every other agent-id list by `roster-parity.test.ts`.
 */
export const CORE_AGENTS: ReadonlyArray<{
  id: string;
  harnessKey: keyof NonNullable<NavoriConfig["harness"]>;
  sandbox?: "read-only" | "workspace-write";
}> = ROSTER_AGENTS;

/** Re-exported from `roster.ts` (spec 0026 T8) — see that file for the rationale. */
export const CORE_SKILLS: ReadonlyArray<string> = ROSTER_CORE_SKILLS;

/** Re-exported from `roster.ts` (spec 0026 T8) — see that file for the rationale. */
export const WORKFLOW_SKILLS: ReadonlyArray<string> = ROSTER_WORKFLOW_SKILLS;

/**
 * Skill ids navori USED to ship and no longer does. Append-only: an entry is a
 * historical fact, so it is never removed once added.
 *
 * Without it a retired skill lives forever in every already-onboarded repo
 * (#702). `render` only ever visits what it currently renders, `--prune` covers
 * outputs of DISABLED ENGINES, and `doctor` says nothing — so the file stays on
 * disk, and Claude Code keeps loading it because it discovers skills by walking
 * the directory, not by reading the index navori renders. A retired skill is not
 * an inert file: it is doctrine the agent still reads, and if it was retired for
 * being wrong, the repo keeps exactly the version somebody wanted gone.
 *
 * A LIST rather than a directory scan, for the reason §8.7 of the Claude engine
 * already gives about library skills: the set of valid destinations is only
 * complete when the render fully succeeded, so a scan would hard-delete still
 * valid managed files whenever a preset failed to load. These ids are known to
 * be retired independently of any config, so they carry no such failure mode.
 *
 * Removal stays marker-gated and version-gated on top of this (a user's own
 * `<id>/SKILL.md` at the same path is never touched), so the list decides WHICH
 * ids to consider, never whether a given file may be deleted.
 *
 * Re-exported from `roster.ts` (spec 0026 T8), which also carries the real
 * managed-marker id per adapter (`markerIdByAdapter`) — see that file.
 */
export const RETIRED_SKILLS: ReadonlyArray<Retired> = ROSTER_RETIRED_SKILLS;

/**
 * Hook ids navori USED to ship and no longer does. Append-only, same contract as
 * `RETIRED_SKILLS`: an entry is a historical fact and is never removed.
 *
 * A retired hook is quieter than a retired skill — nothing invokes a script that
 * no longer appears in `settings.json`, so it cannot run — but it is not
 * harmless either. It stays on disk in every already-onboarded repo (the park
 * was 22 when this list was created), it keeps a managed marker that `doctor`
 * and `managed-drift-watch` have to account for, and a reader who finds
 * `.claude/hooks/<id>.sh` has no way to tell a retired hook from a broken
 * registration. `render` only visits what it currently renders, and `--prune`
 * covers outputs of DISABLED ENGINES, so without this list nothing would ever
 * remove it.
 *
 * Removal is marker-gated and version-gated (`isRemovableNavoriFile`) on top of
 * this, so the list decides WHICH ids to consider, never whether a given file
 * may be deleted: a user's own script at the same path is untouched, and one a
 * newer navori wrote is not ours to roll back.
 *
 * Re-exported from `roster.ts` (spec 0026 T8) — see that file.
 */
export const RETIRED_HOOKS: ReadonlyArray<Retired> = ROSTER_RETIRED_HOOKS;

export function isAgentEnabled(
  config: NavoriConfig,
  key: keyof NonNullable<NavoriConfig["harness"]>,
): boolean {
  return config.harness?.[key] !== false;
}

export function extraConditionMet(extra: PresetExtraFile, config: NavoriConfig): boolean {
  return !extra.condition || resolveCondition(config as Record<string, unknown>, extra.condition);
}
