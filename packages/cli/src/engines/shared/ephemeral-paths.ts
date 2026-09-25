/**
 * Ephemeral, machine-local harness state under `.claude/`: subagent handoffs
 * (`progress/`), agent worktrees, and per-user settings. Repo-relative, with the
 * trailing slash on directories so the list can be dropped straight into a
 * `.gitignore` body.
 *
 * SINGLE SOURCE OF TRUTH for "the harness never versions this" (#348). Four
 * consumers used to keep their own copy and they drifted — `.gitignore` knew
 * about `worktrees/` while the render backup did not, so every `render --apply`
 * cloned every worktree into `~/.navori/backups/` (131 GB / 6873 backups on a
 * real machine, until `ENOSPC` broke render itself). The rule is one fact: a
 * path that is never committed has nothing to recover from a backup, nothing to
 * track in git, and must be gitignored. Add a new ephemeral here and all four
 * consumers get it:
 * - `gitignore-harness.ts` — cubo A of the managed root `.gitignore` block.
 * - `nested-gitignore-harness.ts` — the managed block of the nested
 *   `.claude/.gitignore`/`.codex/.gitignore` (#1024/#1039), unconditional
 *   unlike the root block above.
 * - `engines/shared/execute-plan.ts` — `commitWrites` always excludes these
 *   from the pre-render backup, for EVERY engine (the per-engine opt-in let
 *   Codex snapshot `.codex/progress/` receipts — audit v0.5.1 A2).
 * - `commands/doctor.ts` — the git-hygiene "should be ignored" scan.
 *
 * Order is load-bearing: it is the order these entries have always had in the
 * rendered `.gitignore` block, whose body is hashed for drift detection, so
 * reordering would flag every already-onboarded repo as drifted.
 *
 * NOTE: the ephemeral progress dir is `.claude/progress/` (and its Codex mirror
 * `.codex/progress/`, which is what `engines/codex/compat.ts` rewrites it into),
 * never the root `progress/` — that one is git-persisted by design (session
 * state travels). `.codex/progress/` was missing until #354, so under
 * `gitignoreHarness: "local"` the Codex receipt and every subagent handoff were
 * versionable — the exact omission #348 created this constant to prevent.
 *
 * Deliberately NOT here: `.navori/`. It belongs in the `.gitignore` cubo A but
 * not in this set — it legitimately holds versioned local presets, so it is not
 * "ephemeral state nobody would want back".
 *
 * `.claude/.managed-drift-stamp` / `.claude/.routing-watch/` are LEGACY entries
 * (#1024 round 2). As of #1024 neither hook writes there anymore — both moved to
 * `$(git rev-parse --git-common-dir)/navori/`, outside `.claude/` entirely — but
 * a repo onboarded on navori ≤0.10.0 already has those files on disk, and the
 * hooks never delete what they used to write (by design — a detector cleaning up
 * after itself is a detector that can also clean up evidence). Removing the two
 * entries here made rendering this branch UNTRACK them retroactively for every
 * already-onboarded repo (`?? .claude/.managed-drift-stamp` reappearing in
 * `git status`, reproduced against a `gitignoreHarness: "local"` fixture) — the
 * exact regression #1024 exists to prevent, just triggered by the fix itself
 * instead of the original bug. They stay here, in their original position (the
 * hash-order note above applies), until a future release can safely assume no
 * repo still has the pre-#1024 files on disk.
 */
export const EPHEMERAL_HARNESS_PATHS: readonly string[] = [
  ".claude/settings.local.json",
  ".claude/worktrees/",
  ".claude/progress/",
  // Appended, never inserted: the order above is the one already hashed into
  // every onboarded repo's `.gitignore` block (see the note on order).
  ".codex/progress/",
  // #530, legacy (see the module doc above): neither hook writes here anymore,
  // but a pre-#1024 repo's already-written stamp must stay ignored.
  ".claude/.managed-drift-stamp",
  // Spec 0020, legacy (see the module doc above): same reasoning, for the
  // routing watcher's per-session stamps.
  ".claude/.routing-watch/",
];
