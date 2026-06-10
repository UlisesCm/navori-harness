import type { DetectedProject } from "../lib/detect.ts";
import type { ClaudeInfraInventory } from "../lib/claude-infra.ts";
import type { WorkspaceConfig } from "../lib/workspace.ts";
import { dim as grey, kv, color, sym } from "../lib/style.ts";

export { grey };

export function formatInfraSummary(infra: ClaudeInfraInventory): string {
  const rows: Array<[string, string]> = [];
  if (infra.agentFiles.length > 0) {
    rows.push([".claude/agents/", `${infra.agentFiles.join(", ")} ${grey(`(${infra.agentFiles.length})`)}`]);
  }
  if (infra.skillFiles.length > 0) {
    const preview = infra.skillFiles.slice(0, 3).join(", ");
    const more = infra.skillFiles.length > 3 ? grey(` (+${infra.skillFiles.length - 3} more)`) : "";
    rows.push([".claude/skills/", `${preview}${more} ${grey(`(${infra.skillFiles.length})`)}`]);
  }
  if (infra.hasSettings) rows.push([".claude/settings.json", grey("present")]);
  if (infra.hasLocalSettings) rows.push([".claude/settings.local.json", grey("present (gitignored)")]);
  if (infra.hasClaudeMd) rows.push(["CLAUDE.md", grey("present")]);
  if (infra.hasAgentsMd) rows.push(["AGENTS.md", grey("present")]);
  if (infra.hasCheckpointsMd) rows.push(["CHECKPOINTS.md", grey("present")]);
  if (infra.hasFeatureList) rows.push(["feature_list.json", grey("present")]);
  if (infra.progressFiles > 0) rows.push(["progress/", grey(`${infra.progressFiles} file(s)`)]);
  if (infra.specsDirs > 0) rows.push(["specs/", grey(`${infra.specsDirs} feature(s)`)]);
  return kv(rows);
}

export function formatDetectionSummary(d: DetectedProject): string {
  const rows: Array<[string, string]> = [];
  rows.push([
    "name",
    d.name ? `${color.cyan(d.name)}  ${grey(`(from ${d.sources.name})`)}` : grey("(not detected — will ask)"),
  ]);
  rows.push([
    "branchBase",
    d.branchBase
      ? `${d.branchBase}  ${grey(`(from ${d.sources.branchBase})`)}`
      : `main  ${grey("(default — no git detected)")}`,
  ]);
  rows.push([
    "engines",
    d.existingEngines.length > 0
      ? `${d.existingEngines.join(", ")}  ${grey("(found in repo)")}`
      : `claude  ${grey("(default — nothing detected)")}`,
  ]);
  // Skip the stack language line entirely when we couldn't detect anything —
  // showing "unknown" right above "language: es (default)" causes a confusing
  // label collision where two distinct concepts share a label.
  if (d.stack.language !== "unknown") rows.push(["stack lang", d.stack.language]);
  if (d.stack.framework) rows.push(["framework", d.stack.framework]);
  if (d.stack.ui) rows.push(["ui", d.stack.ui]);
  if (d.stack.forms) rows.push(["forms", d.stack.forms]);
  if (d.stack.state) rows.push(["state", d.stack.state]);
  if (d.stack.test) rows.push(["test", d.stack.test]);
  if (d.packageManager) {
    rows.push(["packageManager", `${d.packageManager}  ${grey(`(from ${d.sources.packageManager})`)}`]);
  }
  if (d.monorepo) {
    rows.push(["monorepo", `${d.monorepo.tool}  ${grey(`(from ${d.monorepo.source})`)}`]);
  }
  rows.push(["preset", `${d.suggestedPreset}  ${grey("(suggested)")}`]);
  rows.push(["asset lang", `es  ${grey("(default — change in wizard if you need 'en' fallback)")}`]);
  if (d.qualityGate) {
    rows.push(["qualityGate", `${d.qualityGate.full}  ${grey("(from package.json scripts)")}`]);
  }
  return kv(rows);
}

export function formatWorkspaceSummary(ws: WorkspaceConfig): string {
  const d = ws.defaults;
  const rows: Array<[string, string]> = [];
  if (d.branchBase) rows.push(["branchBase", d.branchBase]);
  if (d.commits) rows.push(["commits", d.commits]);
  if (d.language) rows.push(["language", d.language]);
  if (d.engines && d.engines.length > 0) rows.push(["engines", d.engines.join(", ")]);
  if (d.plugins && Object.keys(d.plugins).length > 0) {
    const enabled = Object.entries(d.plugins).filter(([, v]) => v.enabled).map(([k]) => k);
    rows.push(["plugins", enabled.join(", ") || grey("(none enabled)")]);
  }
  if (rows.length === 0) {
    return `  ${grey("(workspace has no defaults configured)")}`;
  }
  return kv(rows);
}
