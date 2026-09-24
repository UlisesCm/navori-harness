/**
 * Spec 0033 D5 (R21): `navori doctor` lists, for the engines actually
 * configured, every control (`engine-capabilities.ts`) that ISN'T `enforced`
 * — one registry feeding both the render and the diagnostic, instead of a
 * second list that can drift from it.
 *
 * R17 (spec 0032, #1011): where the engine cannot intercept the launch of a
 * subagent, `harness.planTiers`'s hard gate degrades to the reviewer's own
 * `classify` check (R21) — that specific case is now a row of this scan
 * (control `plan-gate`), not the standalone `scanPlanTiersGateSupport` this
 * module replaces.
 */
import type { NavoriConfig } from "../config/config.ts";
import {
  CONTROL_DEFINITIONS,
  ENGINE_CAPABILITIES,
  type ControlCondition,
  type ControlId,
  type EngineId,
} from "../../engines/shared/engine-capabilities.ts";

/** One non-`enforced` control, for one configured engine. */
export interface ControlGap {
  readonly engine: EngineId;
  readonly control: ControlId;
  readonly state: "advisory" | "unsupported";
  readonly reason: string;
  /**
   * `warn` only for a control whose condition flag the user turned ON and
   * that still isn't `enforced` for this engine — everything else is `info`,
   * so a solo-Claude repo doesn't see permanent warnings for controls it
   * never asked for (D5, "Severidad en doctor").
   */
  readonly severity: "info" | "warn";
}

/** Whether `condition`'s flag is currently on in `config`. */
function isConditionActive(config: NavoriConfig, condition: ControlCondition): boolean {
  if (condition === "localSkills") return (config.project?.localSkills?.length ?? 0) > 0;
  return config.harness?.[condition] === true;
}

/**
 * For every engine `config` declares, every control not `enforced` there,
 * skipping a conditioned control whose flag is currently off (nothing to
 * report: the control simply doesn't apply yet).
 */
export function scanControlGaps(config: NavoriConfig): ControlGap[] {
  const gaps: ControlGap[] = [];
  for (const engine of config.engines) {
    const capability = ENGINE_CAPABILITIES[engine];
    for (const [control, definition] of Object.entries(CONTROL_DEFINITIONS) as Array<
      [ControlId, (typeof CONTROL_DEFINITIONS)[ControlId]]
    >) {
      if (definition.condition && !isConditionActive(config, definition.condition)) continue;
      const declaration = capability.controls[control];
      if (declaration.state === "enforced") continue;
      gaps.push({
        engine,
        control,
        state: declaration.state,
        reason: declaration.reason,
        severity: definition.condition ? "warn" : "info",
      });
    }
  }
  return gaps;
}
