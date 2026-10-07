import type { NavoriConfig } from "../../lib/config/config.ts";
import {
  decideEngineWorkspaceSkills,
  type EngineSkillStrategy,
} from "../shared/workspace-engine-decision.ts";
import type { WorkspaceSkillDecision } from "../shared/workspace-skills.ts";
import { composeFreshCodexSkill, planCodexSkills } from "./index.ts";

const CODEX_STRATEGY: EngineSkillStrategy = {
  engine: "codex",
  destOf: (name) => `.agents/skills/${name}/SKILL.md`,
  plan: planCodexSkills,
  compose: (skill, config, plugins) => composeFreshCodexSkill(skill, config, plugins),
  // Codex under `minimal` stays as it was (the user's decision, spec 0043): only
  // `root` trims it. Mapping `minimal` to `full` also keeps the leftovers of an
  // earlier `root` visible as prune candidates.
  effectiveMode: (mode) => (mode === "root" ? "root" : "full"),
};

/**
 * The workspace-skill decision for a Codex render of `config` (spec 0043 R8):
 * what a workspace under `root` omits and what the root writes into its
 * `.agents/skills` on the workspaces' behalf. See `decideEngineWorkspaceSkills`.
 */
export function decideCodexWorkspaceSkills(
  cwd: string,
  config: NavoriConfig,
  opts: { rootRendered: boolean },
): WorkspaceSkillDecision {
  return decideEngineWorkspaceSkills(cwd, config, opts, CODEX_STRATEGY);
}
