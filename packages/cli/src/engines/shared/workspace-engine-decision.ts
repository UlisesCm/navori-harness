import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { NavoriConfig } from "../../lib/config/config.ts";
import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import { getCoreRoot } from "../../lib/render/bundled-assets.ts";
import { navoriAuthorship } from "../../lib/render/removable.ts";
import {
  effectiveConfigForWorkspace,
  enabledMonorepoWorkspaces,
} from "../../lib/workspace/monorepo.ts";
import { CORE_SKILLS, WORKFLOW_SKILLS } from "./harness-assets.ts";
import type { PlannedSkill } from "./harness-plan.ts";
import {
  decideWorkspaceSkills,
  type DecisionWorkspace,
  type SkillKind,
  type WorkspaceHarness,
  type WorkspaceSkillDecision,
} from "./workspace-skills.ts";

/** What an engine contributes to the workspace-skill decision: where it writes, what it plans, how it renders. */
export interface EngineSkillStrategy {
  /** The engine id as it appears in `config.engines`. */
  engine: NavoriConfig["engines"][number];
  /** Repo-relative path of a skill's `SKILL.md` under that engine, for a skill dir name. */
  destOf: (name: string) => string;
  /** The ONE producer of this engine's skill plan (no warnings). */
  plan: (
    cwd: string,
    config: NavoriConfig,
    opts: { repoRoot: string },
  ) => { skills: readonly PlannedSkill[]; presetLoaded: boolean; plugins: readonly LoadedPlugin[] };
  /** Fresh bytes of one skill under one config, sub-blocks included. */
  compose: (skill: PlannedSkill, config: NavoriConfig, plugins: readonly LoadedPlugin[]) => string;
  /** The mode this engine acts on: Codex leaves `minimal` as it was. */
  effectiveMode: (mode: WorkspaceHarness) => WorkspaceHarness;
}

const NOTHING: WorkspaceSkillDecision = {
  omitted: new Map(),
  hoisted: [],
  rootPruneCandidates: [],
  blocked: [],
};

/**
 * The workspace-skill decision for one engine (spec 0043), taken ONCE per run
 * before anything is written. `render`, `sync` and `doctor` all call it, so a
 * preview, an apply and a diagnosis start from the same plans and cannot
 * disagree. Claude and Codex differ only in the strategy they hand in.
 *
 * `rootRendered` says whether THIS run writes the root's skills before it
 * reaches the workspaces (the full `render`/`sync` path): then the root's own
 * plan answers "will the root hold this skill". A `--workspace` run renders no
 * root, so only what is already on disk counts — a workspace never drops a copy
 * on the strength of a root that may not have it (the next full render converges).
 */
export function decideEngineWorkspaceSkills(
  cwd: string,
  config: NavoriConfig,
  opts: { rootRendered: boolean },
  strategy: EngineSkillStrategy,
): WorkspaceSkillDecision {
  const mode = strategy.effectiveMode(config.monorepo?.workspaceHarness ?? "minimal");
  const declared = enabledMonorepoWorkspaces(config);
  if (declared.length === 0 || !(config.engines ?? ["claude"]).includes(strategy.engine)) {
    return NOTHING;
  }
  const coreAssets = resolve(getCoreRoot(), "core-assets");
  const rootPlan = strategy.plan(cwd, config, { repoRoot: cwd });
  const rootIds = new Set(rootPlan.skills.map((s) => s.id));
  const workspaces: DecisionWorkspace[] = [];
  for (const ws of declared) {
    const wsCwd = resolve(cwd, ws.path);
    // A workspace missing from disk is reported elsewhere and never rendered.
    if (!existsSync(wsCwd)) continue;
    const wsConfig = effectiveConfigForWorkspace(config, ws);
    const plan = strategy.plan(wsCwd, wsConfig, { repoRoot: cwd });
    workspaces.push({ ws, config: wsConfig, skills: plan.skills, presetLoaded: plan.presetLoaded });
  }
  const rootSkillPath = (name: string): string => join(cwd, strategy.destOf(name));
  return decideWorkspaceSkills({
    mode,
    root: { config, skills: rootPlan.skills, presetLoaded: rootPlan.presetLoaded },
    workspaces,
    allWorkspaces: declared,
    rootRendered: opts.rootRendered,
    kindOf: (skill) => kindOfSkill(skill, coreAssets),
    render: (skill, skillConfig) => strategy.compose(skill, skillConfig, rootPlan.plugins),
    rootHas: (name) =>
      (opts.rootRendered && rootIds.has(name)) ||
      navoriAuthorship(rootSkillPath(name)) !== "foreign",
    rootAuthorship: (name) =>
      lstatSync(rootSkillPath(name), { throwIfNoEntry: false }) === undefined
        ? "absent"
        : navoriAuthorship(rootSkillPath(name), undefined, { verifyHash: true }),
  });
}

/** Where a planned skill comes from: the core roster, the workflow set, a library or a preset. */
function kindOfSkill(skill: PlannedSkill, coreAssets: string): SkillKind {
  if (CORE_SKILLS.includes(skill.id)) return "core";
  if (WORKFLOW_SKILLS.includes(skill.id)) return "workflow";
  return skill.assetPath === join(coreAssets, `lib-skills/${skill.id}.md`) ? "library" : "preset";
}
