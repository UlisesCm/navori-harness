/**
 * Retarget Claude-oriented prose to the surfaces Pi actually reads, for the
 * shared files Pi writes when no other engine owns them (`AGENTS.md`,
 * `.agents/skills/<id>/SKILL.md`).
 *
 * Only term and path swaps live here. A sentence a swap cannot make true for Pi
 * (Codex's dispatch markers, Claude's `SendMessage` continuation, the
 * orchestrator depth file Pi does not have) sits in a `navori:if-not onPi` span
 * of the source asset instead, so Claude and Codex keep their output byte for
 * byte.
 */
export function adaptHarnessTextForPi(content: string): string {
  return (
    content
      // Pi discovers project skills under `.agents/skills/` (docs/pi.md), in the
      // directory form; both spellings a harness asset uses to cite one.
      .replace(/\.claude\/skills\/([a-z0-9-]+)\/SKILL\.md/g, ".agents/skills/$1/SKILL.md")
      .replace(/\.claude\/skills\/([a-z0-9-]+)\.md/g, ".agents/skills/$1/SKILL.md")
      // Role files live under `.pi/agents/`. The orchestrator has none (the main
      // thread embodies it): its citations sit in `if-not onPi` spans of the
      // assets, and the lookahead keeps a new one from becoming a dead path.
      .replace(/\.claude\/agents\/(?!orchestrator\.md)([a-z0-9-]+)\.md/g, ".pi/agents/$1.md")
      // A manual skill invocation in Pi is `/skill:<name>` (Pi docs/skills.md).
      .replaceAll("`/spec-bootstrap`", "`/skill:spec-bootstrap`")
      .replaceAll("`/master-plan`", "`/skill:master-plan`")
      // Pi delegates through the `navori_subagent` tool, with `role` and `task`.
      .replaceAll("`Agent(subagent_type: orchestrator)`", "`navori_subagent(role: orchestrator)`")
      .replaceAll("`Agent`", "`navori_subagent`")
      // The harness directory a bare mention points at ("doctor if `.claude/` looks
      // inconsistent") is Pi's own.
      .replaceAll("`.claude/`", "`.pi/`")
      .replaceAll("CLAUDE.md", "AGENTS.md")
  );
}
