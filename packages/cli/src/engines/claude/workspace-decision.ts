import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { NavoriConfig } from "../../lib/config/config.ts";
import { navoriAuthorship } from "../../lib/render/removable.ts";
import {
  effectiveConfigForWorkspace,
  enabledMonorepoWorkspaces,
} from "../../lib/workspace/monorepo.ts";
import type { PlannedSkill } from "../shared/harness-plan.ts";
import {
  decideWorkspaceSkills,
  type DecisionWorkspace,
  type WorkspaceHarness,
  type WorkspaceSkillDecision,
} from "../shared/workspace-skills.ts";
import { claudeSkillDest } from "./adapter.ts";
import { composeFreshClaudeSkill, planClaudeSkills } from "./index.ts";

const NOTHING_OMITTED: WorkspaceSkillDecision = { omitted: new Map() };

/**
 * The workspace-skill decision for a Claude render of `config` (spec 0043),
 * taken ONCE per run before anything is written. `render`, `sync` and `doctor`
 * all call this, so a preview, an apply and a diagnosis start from the same
 * plans and cannot disagree.
 *
 * `rootRendered` says whether THIS run writes the root's `.claude/skills` before
 * it reaches the workspaces (the full `render`/`sync` path): then the root's own
 * plan answers "will the root hold this skill". A `--workspace` run renders no
 * root, so only what is already on disk counts — a workspace never drops a copy
 * on the strength of a root that may not have it (the next full render converges).
 */
export function decideClaudeWorkspaceSkills(
  cwd: string,
  config: NavoriConfig,
  opts: { rootRendered: boolean },
): WorkspaceSkillDecision {
  const mode: WorkspaceHarness = config.monorepo?.workspaceHarness ?? "minimal";
  const declared = enabledMonorepoWorkspaces(config);
  if (
    mode === "full" ||
    declared.length === 0 ||
    !(config.engines ?? ["claude"]).includes("claude")
  ) {
    return NOTHING_OMITTED;
  }
  const rootPlan = planClaudeSkills(cwd, config, { repoRoot: cwd });
  const rootIds = new Set(rootPlan.skills.map((s) => s.id));
  const workspaces: DecisionWorkspace[] = [];
  for (const ws of declared) {
    const wsCwd = resolve(cwd, ws.path);
    // A workspace missing from disk is reported elsewhere and never rendered.
    if (!existsSync(wsCwd)) continue;
    const wsConfig = effectiveConfigForWorkspace(config, ws);
    const plan = planClaudeSkills(wsCwd, wsConfig, { repoRoot: cwd });
    workspaces.push({ ws, config: wsConfig, skills: plan.skills, presetLoaded: plan.presetLoaded });
  }
  return decideWorkspaceSkills({
    mode,
    root: { config, skills: rootPlan.skills, presetLoaded: rootPlan.presetLoaded },
    workspaces,
    render: (skill: PlannedSkill, skillConfig: NavoriConfig) =>
      composeFreshClaudeSkill(skill, skillConfig, rootPlan.plugins),
    rootHas: (name) =>
      (opts.rootRendered && rootIds.has(name)) ||
      navoriAuthorship(join(cwd, claudeSkillDest(name))) !== "foreign",
  });
}
