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
 * Claude's vocabulary → Codex's, applied last in the pipeline. Every entry
 * rewrites a TERM (a tool call, an engine name) and leaves the sentence around
 * it verbatim: this adapter retargets vocabulary, it does not author prose.
 *
 * #443: the four rules this replaces were written against SPANISH prose, and the
 * core assets have been English since #154. Two never matched anything, and the
 * one that did (`Agent(subagent_type: leader)` → `un subagente \`leader\``)
 * translated the surrounding phrase too, so every Codex render shipped that
 * Spanish fragment inside an English `AGENTS.md` — including repos with
 * `language: "en"`. Which language a block is served in is decided upstream by
 * `resolveAssetPath` + `CoreManagedAsset.baseLanguage` (per-language files on
 * disk); an adapter that also translates gives that decision a second owner and
 * can only ever cover the snippets someone remembered to list here.
 *
 * Exported so `render-codex.test.ts` can enumerate them and assert each one
 * still fires on a real render: a rule that matches nothing is a bug, not a
 * harmless no-op — that is exactly how the two dead ones survived for months.
 */
export const CODEX_VOCABULARY: ReadonlyArray<readonly [from: string, to: string]> = [
  // `leader` is embodied by Codex's main thread (no `.codex/agents/leader.toml`
  // is rendered), so the citation stays the "do NOT invoke it" instruction it
  // already is; only the tool's name moves, matching the bare `Agent` rule below.
  ["`Agent(subagent_type: leader)`", "`spawn_agent(leader)`"],
  ["`Agent`", "`spawn_agent`"],
  // Names the engine the reader is actually running. The claim it qualifies —
  // "emit ALL the calls in a SINGLE turn" — is the harness's own instruction and
  // is unchanged; only the proper noun does.
  //
  // The serialization claim itself is INHERITED, not verified: it restores the
  // intent of the dead `"Claude por defecto"` rule, and nothing in this repo
  // documents Codex's real concurrency (spec 0004 does not cover it). If Codex
  // turns out to parallelize by default the sentence is merely conservative —
  // the operative instruction does not change either way — but do not cite it
  // as evidence of Codex behaviour. (#443)
  ["Claude serializes by default", "Codex serializes by default"],
];

/**
 * Deliberately NOT a vocabulary rule: `arranque-sesion.md` opens with "On
 * Claude, a `SessionStart` hook injects the live context … Otherwise, read
 * `progress/current.md` yourself." That sentence is an explicit ENGINE
 * CONDITIONAL and it is already correct under Codex — a Codex reader takes the
 * "Otherwise" branch, which is the instruction it must follow.
 *
 * The dead `"En Claude Code" → "En Codex"` rule this replaces would have made it
 * WRONG in two ways: Codex registers only `[[hooks.PreToolUse]]` (see
 * `build-config-toml.ts`), so no session-start hook injects anything, and
 * renaming the engine swallows the branch that tells the agent to read the file
 * itself. Renaming the proper noun here is not a term swap, it is a false claim.
 * If you come back to "finish the job", change the ASSET (or add a translation),
 * not this adapter.
 */

/**
 * Retarget Claude-oriented prose assets to Codex's durable surfaces and tool
 * vocabulary without duplicating the source assets.
 *
 * `_config` is unused on purpose. Every rule below rewrites a path or a term,
 * and none of them depends on the repo's `language`: NOT branching on it is
 * itself the fix for #443 (see `CODEX_VOCABULARY`). The parameter stays because
 * all six call sites already thread the render's config, and this note is here
 * so the next reader does not re-add a language branch.
 */
export function adaptHarnessTextForCodex(content: string, _config: NavoriConfig): string {
  const retargeted = content
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
    .replaceAll(NEVER_COMMIT_SENTINEL, NEVER_COMMIT_PHRASE);

  return CODEX_VOCABULARY.reduce((text, [from, to]) => text.replaceAll(from, to), retargeted);
}
