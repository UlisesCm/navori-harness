import type { DetectedProject } from "../lib/detect.ts";
import type { ClaudeInfraInventory } from "../lib/claude-infra.ts";
import type { WorkspaceConfig } from "../lib/workspace.ts";
import { dim as grey } from "../lib/style.ts";

export { grey };

export function formatInfraSummary(infra: ClaudeInfraInventory): string {
  const lines: string[] = ["Existing Claude infrastructure detected:"];
  if (infra.agentFiles.length > 0) {
    lines.push(`  .claude/agents/        : ${infra.agentFiles.join(", ")} (${infra.agentFiles.length})`);
  }
  if (infra.skillFiles.length > 0) {
    const preview = infra.skillFiles.slice(0, 3).join(", ");
    const more = infra.skillFiles.length > 3 ? ` (+${infra.skillFiles.length - 3} more)` : "";
    lines.push(`  .claude/skills/        : ${preview}${more} (${infra.skillFiles.length})`);
  }
  if (infra.hasSettings) lines.push(`  .claude/settings.json  : present`);
  if (infra.hasLocalSettings) lines.push(`  .claude/settings.local.json : present (gitignored)`);
  if (infra.hasClaudeMd) lines.push(`  CLAUDE.md              : present`);
  if (infra.hasAgentsMd) lines.push(`  AGENTS.md              : present`);
  if (infra.hasCheckpointsMd) lines.push(`  CHECKPOINTS.md         : present`);
  if (infra.hasFeatureList) lines.push(`  feature_list.json      : present`);
  if (infra.progressFiles > 0) lines.push(`  progress/              : ${infra.progressFiles} file(s)`);
  if (infra.specsDirs > 0) lines.push(`  specs/                 : ${infra.specsDirs} feature(s)`);
  return lines.join("\n");
}

export function formatDetectionSummary(d: DetectedProject): string {
  const lines: string[] = ["Detected from this repo:"];
  lines.push(
    d.name
      ? `  name           : ${d.name}  ${grey(`(from ${d.sources.name})`)}`
      : `  name           : ${grey("(not detected — will ask)")}`,
  );
  lines.push(
    d.branchBase
      ? `  branchBase     : ${d.branchBase}  ${grey(`(from ${d.sources.branchBase})`)}`
      : `  branchBase     : main  ${grey("(default — no git detected)")}`,
  );
  lines.push(
    d.existingEngines.length > 0
      ? `  engines        : ${d.existingEngines.join(", ")}  ${grey("(found in repo)")}`
      : `  engines        : claude  ${grey("(default — nothing detected)")}`,
  );
  // Skip the stack language line entirely when we couldn't detect anything —
  // showing "unknown" right above "language: es (default)" causes a confusing
  // label collision where two distinct concepts share a label.
  if (d.stack.language !== "unknown") {
    lines.push(`  stack lang     : ${d.stack.language}`);
  }
  if (d.stack.framework) lines.push(`  framework      : ${d.stack.framework}`);
  if (d.stack.ui) lines.push(`  ui             : ${d.stack.ui}`);
  if (d.stack.forms) lines.push(`  forms          : ${d.stack.forms}`);
  if (d.stack.state) lines.push(`  state          : ${d.stack.state}`);
  if (d.stack.test) lines.push(`  test           : ${d.stack.test}`);
  if (d.packageManager) {
    lines.push(`  packageManager : ${d.packageManager}  ${grey(`(from ${d.sources.packageManager})`)}`);
  }
  if (d.monorepo) {
    lines.push(`  monorepo       : ${d.monorepo.tool}  ${grey(`(from ${d.monorepo.source})`)}`);
  }
  lines.push(`  preset         : ${d.suggestedPreset}  ${grey("(suggested)")}`);
  lines.push(`  asset lang     : es  ${grey("(default — change in wizard if you need 'en' fallback)")}`);
  if (d.qualityGate) {
    lines.push(`  qualityGate    : ${d.qualityGate.full}  ${grey("(from package.json scripts)")}`);
  }
  return lines.join("\n");
}

export function formatWorkspaceSummary(ws: WorkspaceConfig): string {
  const lines: string[] = [`Inheriting defaults from workspace '${ws.name}':`];
  const d = ws.defaults;
  if (d.branchBase) lines.push(`  branchBase  : ${d.branchBase}`);
  if (d.commits) lines.push(`  commits     : ${d.commits}`);
  if (d.language) lines.push(`  language    : ${d.language}`);
  if (d.engines && d.engines.length > 0) lines.push(`  engines     : ${d.engines.join(", ")}`);
  if (d.plugins && Object.keys(d.plugins).length > 0) {
    const enabled = Object.entries(d.plugins).filter(([, v]) => v.enabled).map(([k]) => k);
    lines.push(`  plugins     : ${enabled.join(", ") || "(none enabled)"}`);
  }
  if (lines.length === 1) lines.push(`  ${grey("(workspace has no defaults configured)")}`);
  return lines.join("\n");
}
