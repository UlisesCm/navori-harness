import type { NavoriConfig } from "../../lib/config.ts";
import { resolveCondition } from "../../lib/marker.ts";
import type { PresetExtraFile } from "../../lib/presets.ts";

/**
 * `sandbox` is a property of the ROLE, not of any engine: a reviewer/auditor
 * inspects without mutating, so it renders read-only wherever a provider
 * supports sandboxing (today Codex's `sandbox_mode`). Absent → workspace-write.
 * Keeping it here means the next provider inherits it for free (Spec 0007 M4).
 */
export const CORE_AGENTS: ReadonlyArray<{
  id: string;
  harnessKey: keyof NonNullable<NavoriConfig["harness"]>;
  sandbox?: "read-only" | "workspace-write";
}> = [
  { id: "leader", harnessKey: "leader" },
  { id: "implementer", harnessKey: "implementer" },
  { id: "reviewer", harnessKey: "reviewer", sandbox: "read-only" },
  { id: "researcher", harnessKey: "researcher", sandbox: "read-only" },
  { id: "ticket-audit", harnessKey: "ticketAudit", sandbox: "read-only" },
  { id: "commit-pr-pilot", harnessKey: "commitPrPilot" },
  { id: "explorer", harnessKey: "explorer", sandbox: "read-only" },
  { id: "auditor", harnessKey: "auditor", sandbox: "read-only" },
];

export const CORE_SKILLS: ReadonlyArray<string> = [
  "verify-before-done",
  "loop-back-debug",
  "review-diff",
  "security-guidance",
  "debug-error",
  "structural-search",
];

export const WORKFLOW_SKILLS: ReadonlyArray<string> = [
  "ticket-intake",
  "pr-create",
  "spec-bootstrap",
  "dominio",
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
