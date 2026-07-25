import type { NavoriConfig } from "../../lib/config.ts";
import { resolveCondition } from "../../lib/marker.ts";
import type { PresetExtraFile } from "../../lib/presets.ts";

export const CORE_AGENTS: ReadonlyArray<{
  id: string;
  harnessKey: keyof NonNullable<NavoriConfig["harness"]>;
}> = [
  { id: "leader", harnessKey: "leader" },
  { id: "implementer", harnessKey: "implementer" },
  { id: "reviewer", harnessKey: "reviewer" },
  { id: "researcher", harnessKey: "researcher" },
  { id: "ticket-audit", harnessKey: "ticketAudit" },
  { id: "commit-pr-pilot", harnessKey: "commitPrPilot" },
  { id: "explorer", harnessKey: "explorer" },
  { id: "auditor", harnessKey: "auditor" },
];

export const CORE_SKILLS: ReadonlyArray<string> = [
  "verify-before-done",
  "loop-back-debug",
  "review-diff",
  "security-guidance",
  "debug-error",
];

export const WORKFLOW_SKILLS: ReadonlyArray<string> = [
  "ticket-intake",
  "pr-create",
  "spec-bootstrap",
];

export function isAgentEnabled(
  config: NavoriConfig,
  key: keyof NonNullable<NavoriConfig["harness"]>,
): boolean {
  return config.harness?.[key] !== false;
}

export function extraConditionMet(extra: PresetExtraFile, config: NavoriConfig): boolean {
  return !extra.condition || resolveCondition(config as Record<string, unknown>, extra.condition);
}
