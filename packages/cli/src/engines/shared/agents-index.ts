import { tc, type Lang } from "../../lib/i18n.ts";

/**
 * Assemble the "## Available agents" managed block from localized prose + the
 * per-engine agent catalog. Single source for the heading/intro so Claude and
 * Codex never re-hardcode it (#289): the Claude engine feeds rows built from
 * `blocks.agentsIndex.when` (the orchestrator excluded), Codex feeds the agent
 * descriptions it collected while placing each `.codex/agents/*.toml`.
 *
 * The row format (`- \`id\` — description`) is identical across engines, so it
 * lives here too. Returns null when there are no agents so the caller strips the
 * block instead of emitting a bare heading.
 *
 * `withIntro` gates the orchestrator sentence: the Claude CLAUDE.md wants it
 * (the main agent IS the orchestrator), while Codex's AGENTS.md is itself the
 * catalog and appends the list without a preamble — matching its prior output.
 */
export function buildAgentsIndexBlock(
  lang: Lang,
  agents: ReadonlyArray<{ id: string; description: string }>,
  opts: { withIntro: boolean },
): string | null {
  if (agents.length === 0) return null;
  const t = tc(lang).blocks.agentsIndex;
  return [
    t.heading,
    "",
    ...(opts.withIntro ? [t.intro, ""] : []),
    ...agents.map(({ id, description }) => `- \`${id}\` — ${description}`),
    "",
  ].join("\n");
}

/**
 * One short clause per agent for the root roster: the "Use ..." trigger
 * sentence cut at its first comma (the full text stays in the agent file).
 * Falls back to the first sentence when the description has no trigger.
 * Shared by the AGENTS.md catalogs Codex and Pi write.
 */
export function compactAgentDescription(description: string): string {
  const trigger = description.match(/(?:^|\. )(Use [^.]*)/)?.[1];
  const clause = trigger ?? description.split(/\. /)[0] ?? description;
  return (clause.split(",")[0] ?? clause).replace(/\.$/, "").trim();
}
