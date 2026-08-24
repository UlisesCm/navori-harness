import type { NavoriConfig } from "../../lib/config.ts";

/**
 * The commit-hygiene line ("Never commit `.claude/` or `CLAUDE.md`") must NOT be
 * caught by the blanket `CLAUDE.md → AGENTS.md` rewrite: under Codex, AGENTS.md
 * is the durable checked-in guide, so "Never commit … AGENTS.md" would tell the
 * user to drop their own project guidance. We shield the exact phrase behind a
 * sentinel across the rewrite, then restore it verbatim. (#209)
 *
 * #375 removed the phrase from the core assets (`gitignoreHarness` owns that
 * rule now), so the shield no longer fires on navori's own prose — it stays
 * because this adapter also runs over USER-ZONE text, where a user who wrote
 * the line by hand would otherwise get the #209 bug back.
 *
 * The sentinel's U+0000 delimiters are written as ESCAPE SEQUENCES on purpose:
 * as raw bytes they turned this source file binary for git and grep (`git log
 * -p` printed "Binary files … differ" and ripgrep hid every match), so no diff
 * of it was ever reviewable. Same runtime value, readable source.
 */
const NEVER_COMMIT_PHRASE = "Never commit `.claude/` or `CLAUDE.md`";
const NEVER_COMMIT_SENTINEL = "\u0000navori:never-commit\u0000";

/**
 * Directories under `.claude/` that a Codex render actually mirrors, mapped to
 * where Codex puts them. This list — not a blanket `.claude/` → `.codex/` — is
 * what the retarget below is allowed to translate.
 *
 * #428: the old catch-all assumed tree parity between engines, and that parity
 * does not exist. Only the Claude engine copies plugin scripts (`engines/claude/
 * index.ts` writes `.claude/scripts/`); nothing under `engines/codex/` emits
 * `.codex/scripts/`. So a citation of `.claude/scripts/check-semgrep.sh` —
 * correct for a Claude repo — was rewritten into a path no repo can have.
 *
 * A first segment that is NOT here stays spelled `.claude/…` on purpose. That
 * citation is still wrong under Codex, but it is HONESTLY wrong: the
 * cross-engine sweep (`engines/__tests__/cited-paths-exist.test.ts`) sees a
 * foreign-engine path and fails, whereas an invented `.codex/…` twin looks
 * plausible to both the sweep and a human reader. Adding a directory here is
 * a claim that the Codex render emits it — check before you extend it.
 */
// A Map, not an object literal: the lookup key is the first path segment of an
// arbitrary citation, and an object would resolve `Object.prototype` members —
// `.claude/constructor` would substitute a Function's source text into the
// rendered prose. A Map has no prototype chain to reach, and `.get` is honestly
// typed `string | undefined`, whereas indexing an object under
// `noUncheckedIndexedAccess` claims that type while the runtime can hand back a
// Function.
const CODEX_MIRRORED_DIRS: ReadonlyMap<string, string> = new Map([
  ["agents", ".codex/agents"],
  ["hooks", ".codex/hooks"],
  // Ephemeral inter-agent handoffs stay in the engine dir, NOT in `progress/` —
  // that root dir holds git-persisted SESSION STATE (`progress/current.md`), and
  // collapsing the two would violate the harness's own "Path separation (don't
  // mix)" rule. (#208)
  ["progress", ".codex/progress"],
  // Codex discovers skills from `.agents/skills`, outside its engine dir.
  ["skills", ".agents/skills"],
]);

/**
 * Retarget Claude-oriented prose assets to Codex's durable surfaces and tool
 * vocabulary without duplicating the source assets.
 */
export function adaptHarnessTextForCodex(content: string, _config: NavoriConfig): string {
  return (
    content
      .replaceAll(".claude/agents/leader.md", "AGENTS.md")
      // Any OTHER agent citation points at the file Codex actually reads: a
      // standalone TOML under `.codex/agents/`. `leader` is the exception above
      // because it is embodied by the main agent, not spawned.
      .replace(/\.claude\/agents\/([a-z0-9-]+)\.md/g, ".codex/agents/$1.toml")
      // Both spellings a harness asset uses to cite a skill: the flat
      // `<id>.md` and the directory `<id>/SKILL.md`. #364: only the flat one
      // was covered, so every citation the core assets actually write (they
      // all use the directory form) survived the adapter intact and sent the
      // Codex agents to a path that does not exist under this engine.
      .replace(/\.claude\/skills\/([a-z0-9-]+)\/SKILL\.md/g, ".agents/skills/$1/SKILL.md")
      .replace(/\.claude\/skills\/([a-z0-9-]+)\.md/g, ".agents/skills/$1/SKILL.md")
      .replaceAll(NEVER_COMMIT_PHRASE, NEVER_COMMIT_SENTINEL)
      // Everything the shape-specific rules above left, including a citation
      // with a placeholder instead of a concrete id (`.claude/skills/<id>/
      // SKILL.md`) or a bare directory (`mkdir -p .claude/progress`). A bare
      // mention of the harness dir itself ("run doctor if `.claude/` looks
      // inconsistent") is `.codex/` under this engine; a path UNDER it is only
      // retargeted when Codex mirrors that directory, and is otherwise left
      // alone (#428 — see CODEX_MIRRORED_DIRS, the single place that decides).
      // Inside the sentinel window so the commit-hygiene line keeps its
      // literal `.claude/`.
      .replace(
        /\.claude\/([A-Za-z0-9_.-]*)/g,
        (citation, dir: string) =>
          (dir === "" ? ".codex/" : CODEX_MIRRORED_DIRS.get(dir)) ?? citation,
      )
      .replaceAll("CLAUDE.md", "AGENTS.md")
      .replaceAll(NEVER_COMMIT_SENTINEL, NEVER_COMMIT_PHRASE)
      .replaceAll("`Agent(subagent_type: leader)`", "un subagente `leader`")
      .replaceAll("`Agent`", "`spawn_agent`")
      .replaceAll("Claude por defecto", "Codex")
      .replaceAll("En Claude Code", "En Codex")
  );
}
