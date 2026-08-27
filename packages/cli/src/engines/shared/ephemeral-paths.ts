/**
 * Ephemeral, machine-local harness state under `.claude/`: subagent handoffs
 * (`progress/`), agent worktrees, and per-user settings. Repo-relative, with the
 * trailing slash on directories so the list can be dropped straight into a
 * `.gitignore` body.
 *
 * SINGLE SOURCE OF TRUTH for "the harness never versions this" (#348). Three
 * consumers used to keep their own copy and they drifted — `.gitignore` knew
 * about `worktrees/` while the render backup did not, so every `render --apply`
 * cloned every worktree into `~/.navori/backups/` (131 GB / 6873 backups on a
 * real machine, until `ENOSPC` broke render itself). The rule is one fact: a
 * path that is never committed has nothing to recover from a backup, nothing to
 * track in git, and must be gitignored. Add a new ephemeral here and all three
 * consumers get it:
 * - `gitignore-harness.ts` — cubo A of the managed `.gitignore` block.
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
 * Deliberately NOT here: `.codegraph/` and `.navori/`. Both belong in the
 * `.gitignore` cubo A but not in this set — `.codegraph/` has its own richer
 * doctor check, and `.navori/` legitimately holds versioned local presets, so
 * neither is "ephemeral state nobody would want back".
 */
export const EPHEMERAL_HARNESS_PATHS: readonly string[] = [
  ".claude/settings.local.json",
  ".claude/worktrees/",
  ".claude/progress/",
  // Appended, never inserted: the order above is the one already hashed into
  // every onboarded repo's `.gitignore` block (see the note on order).
  ".codex/progress/",
  // #530: the drift watcher's stamp file. Pure machine-local timing state — its
  // mtime is the "last checked" mark and nothing else — so committing it would
  // make every teammate's first command re-check every managed file.
  ".claude/.managed-drift-stamp",
];
