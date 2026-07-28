import type { NavoriConfig } from "../../lib/config.ts";

/**
 * Retarget Claude-oriented prose assets to Codex's durable surfaces and tool
 * vocabulary without duplicating the source assets.
 */
export function adaptHarnessTextForCodex(content: string, config: NavoriConfig): string {
  const progressDir = config.progress?.dir ?? "progress";
  return content
    .replaceAll(".claude/agents/leader.md", "AGENTS.md")
    .replace(/\.claude\/skills\/([a-z0-9-]+)\.md/g, ".agents/skills/$1/SKILL.md")
    .replaceAll(".claude/progress/", `${progressDir.replace(/\/+$/, "")}/`)
    .replaceAll("CLAUDE.md", "AGENTS.md")
    .replaceAll("`Agent(subagent_type: leader)`", "un subagente `leader`")
    .replaceAll("`Agent`", "`spawn_agent`")
    .replaceAll("Claude por defecto", "Codex")
    .replaceAll("En Claude Code", "En Codex");
}
