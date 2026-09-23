---
name: worktree-hygiene
description: Use when session startup warns about conserved worktrees under `.claude/worktrees/`, or before deleting one by hand. Read-only diagnosis that classifies each worktree as safe / keep / ask and proposes the removal command — never deletes. Not for the automated sweep itself (see `worktree-reclaim.sh`), only for the ones it already refused to touch.
metadata:
  type: reference
---

# Diagnosing conserved worktrees

`.claude/worktrees/` accumulates full checkouts, one per agent session. A
`SessionEnd` hook (`worktree-reclaim.sh`) already auto-removes the easy
cases and writes the rest to `.claude/worktrees/.navori-kept-notice`, which
the next `SessionStart` surfaces as a warning — that notice already gives
the hook's own reason per worktree (uncommitted changes, no upstream,
unpushed commits, or no merged PR found). This skill is for what's left
after reading that reason: confirming it, or going deeper when the reason
alone isn't enough to decide.

## Diagnosis, per worktree

1. `git worktree list --porcelain` — note any `locked` entry; a locked
   worktree is never a candidate, skip it.
2. `git status --porcelain` inside the worktree — anything printed means
   uncommitted or untracked work exists ONLY there. Stop: `keep`.
3. Does the branch have commits nowhere else? `git rev-parse --abbrev-ref
   @{u}` (no upstream = never pushed) or `git rev-list @{u}..HEAD` (commits
   ahead of it). Either means work exists only in this worktree. Stop:
   `keep`.
4. Is the branch merged? **Don't trust `git merge-base --is-ancestor`
   alone** — this repo squash-merges, so a shipped branch's SHA is never an
   ancestor of `main` and that check reports "not merged" even for PRs that
   landed weeks ago. Check the PR's actual state instead:
   `gh pr list --head <branch> --state merged`. No result doesn't
   necessarily mean unmerged — it can also mean no PR was ever opened for
   that branch; treat that case as `ask`, not `safe`.
5. **Gitignored artifacts that exist nowhere else** (the #889/#890 case):
   `.claude/progress/` is gitignored, so an implementer's `impl_*.md` or
   `explore_*.md` written inside the worktree is invisible to git status and
   survives only on disk. Check `find <worktree>/.claude/progress -type f`
   (or any other gitignored path the session may have used) before calling
   a branch with unpushed-nothing-else `safe` — a clean `git status` does
   not mean the worktree is empty of unique value.

## Classification and output

For each worktree, report one of:

- **safe** — no lock, no uncommitted/untracked changes, no unpushed
  commits, PR confirmed merged, no orphaned gitignored artifact.
- **keep** — fails any check above with a definitive answer (uncommitted
  work, unpushed commits, or an artifact that exists nowhere else).
- **ask** — the checks can't reach a definitive answer (e.g. no PR found
  for the branch, `gh` unavailable, or a locked worktree that may no longer
  need to be).

For every `safe` worktree, PROPOSE the removal command — never run it:

```bash
git worktree remove <path>
```

The user confirms deletion; this repo's rule for destructive operations
applies here like anywhere else.

## Checklist

- [ ] Locked worktrees excluded from consideration.
- [ ] Each worktree checked for uncommitted/untracked changes and unpushed
      commits.
- [ ] Merge status confirmed via `gh pr list --head <branch> --state
      merged`, not `merge-base --is-ancestor`.
- [ ] Gitignored artifacts under the worktree's `.claude/progress/` (or
      similar) checked before calling anything `safe`.
- [ ] Output is a classification per worktree plus proposed commands, with
      no deletion executed.

If any item fails, fix it and re-run the whole list.
