import type { NavoriConfig } from "../../lib/config/config.ts";
import {
  decideEngineWorkspaceSkills,
  type EngineSkillStrategy,
} from "../shared/workspace-engine-decision.ts";
import type { WorkspaceSkillDecision } from "../shared/workspace-skills.ts";
import { claudeSkillDest } from "./adapter.ts";
import { composeFreshClaudeSkill, planClaudeSkills } from "./index.ts";

const CLAUDE_STRATEGY: EngineSkillStrategy = {
  engine: "claude",
  destOf: claudeSkillDest,
  plan: planClaudeSkills,
  compose: (skill, config, plugins) => composeFreshClaudeSkill(skill, config, plugins),
  effectiveMode: (mode) => mode,
};

/**
 * The workspace-skill decision for a Claude render of `config` (spec 0043): what
 * each workspace omits and what the root writes on its behalf. See
 * `decideEngineWorkspaceSkills` for the contract and `rootRendered`.
 */
export function decideClaudeWorkspaceSkills(
  cwd: string,
  config: NavoriConfig,
  opts: { rootRendered: boolean },
): WorkspaceSkillDecision {
  return decideEngineWorkspaceSkills(cwd, config, opts, CLAUDE_STRATEGY);
}
