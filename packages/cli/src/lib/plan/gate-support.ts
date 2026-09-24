/**
 * R17 (spec 0032, #1011): where the engine cannot intercept the launch of a
 * subagent, `harness.planTiers`'s hard gate degrades to the reviewer's own
 * `classify` check (R21) — `navori doctor` reports the degradation instead of
 * leaving it silent.
 *
 * Only Claude Code renders the `PreToolUse(Agent)` hook (`build-settings.ts`).
 * Codex registers only `[[hooks.PreToolUse]]` for a fixed, hand-written set of
 * scripts (`engines/codex/build-config-toml.ts`) with no confirmed
 * subagent-dispatch interception equivalent (`engines/codex/compat.ts:113`).
 * The prose engines (`agents-md`, `cursor`, `copilot`) render no hooks at all.
 */
import type { NavoriConfig } from "../config/config.ts";

/** The only engine whose render wires the workplan gate into a hook. */
const GATE_CAPABLE_ENGINE = "claude";

export interface PlanTiersGateSupport {
  /** Engines configured that render NO `PreToolUse(Agent)` gate. */
  unsupportedEngines: string[];
}

/**
 * Null when `harness.planTiers` is off (nothing to report) or every
 * configured engine intercepts the dispatch. Otherwise names the engines
 * whose sessions fall back to the reviewer-only check.
 */
export function scanPlanTiersGateSupport(config: NavoriConfig): PlanTiersGateSupport | null {
  if (config.harness?.planTiers !== true) return null;
  const unsupportedEngines = config.engines.filter((e) => e !== GATE_CAPABLE_ENGINE);
  if (unsupportedEngines.length === 0) return null;
  return { unsupportedEngines };
}
