import type { NavoriConfig } from "../../lib/config.ts";
import { resolveCondition } from "../../lib/marker.ts";
import type { PresetExtraFile } from "../../lib/presets.ts";

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
 */
export const CORE_AGENTS: ReadonlyArray<{
  id: string;
  harnessKey: keyof NonNullable<NavoriConfig["harness"]>;
  sandbox?: "read-only" | "workspace-write";
}> = [
  { id: "leader", harnessKey: "leader" },
  { id: "implementer", harnessKey: "implementer" },
  { id: "reviewer", harnessKey: "reviewer", sandbox: "workspace-write" },
  { id: "researcher", harnessKey: "researcher", sandbox: "workspace-write" },
  { id: "ticket-audit", harnessKey: "ticketAudit", sandbox: "workspace-write" },
  { id: "commit-pr-pilot", harnessKey: "commitPrPilot" },
  { id: "explorer", harnessKey: "explorer", sandbox: "workspace-write" },
  { id: "auditor", harnessKey: "auditor", sandbox: "workspace-write" },
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
  "solution-design",
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
