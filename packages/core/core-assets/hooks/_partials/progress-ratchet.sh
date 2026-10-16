# Session-state ratchet (#1263, #1266) — inlined into each hook that enforces it at
# render time (see the include directive in the source scripts +
# lib/render/hook-includes.ts), and sourced as-is by the repo's own git pre-commit.
# Two consumers, ONE body: `quality-gate-pre-commit` (qualityGate.fast declared)
# and `guard-destructive` (qualityGate.fast absent), so the check never has a
# second copy to drift.
#
# The session-state file is meant to hold the CURRENT state and the next step;
# past the delivery budget it falls out of startup context. RATCHET, not a plain
# cap: blocks only when the file is over the ceiling AND larger than at HEAD, so a
# trim that is still big passes and an untouched legacy file never blocks an
# unrelated commit. The size is the max of the index (what a plain `git commit`
# lands) and the worktree (what `-a`, a pathspec or `add && commit` in one call
# lands). Bytes via `wc -c` / `git cat-file -s`: locale-independent, unlike
# `${#var}`. Every git call is guarded: an unborn HEAD or an unmerged index exits
# non-zero under `set -e`.
#
# Requires: `$navori_progress_hard_cap` (digits) set by the caller. Never exits: a
# block is `return 2`, so each host decides how to stop (and how to record it).
# Plain functions, quoted expansions, no word-splitting: they run under bash and zsh.

# Ratchet check for ONE session-state path. Returns 0 (ok) or 2 (blocked).
navori_progress_ratchet() {
  navori_pr_path=$1
  # A gitignored file is never committed, so its size is not this gate's business.
  if git check-ignore -q -- "$navori_pr_path" 2>/dev/null; then return 0; fi
  navori_pr_wt=0
  navori_pr_idx=0
  navori_pr_head=0
  if [ -f "$navori_pr_path" ]; then
    navori_pr_wt=$(wc -c <"$navori_pr_path" 2>/dev/null | tr -d '[:space:]') || navori_pr_wt=0
  fi
  navori_pr_idx=$(git cat-file -s ":$navori_pr_path" 2>/dev/null) || navori_pr_idx=0
  navori_pr_head=$(git cat-file -s "HEAD:$navori_pr_path" 2>/dev/null) || navori_pr_head=0
  case "$navori_pr_wt" in ''|*[!0-9]*) navori_pr_wt=0 ;; esac
  case "$navori_pr_idx" in ''|*[!0-9]*) navori_pr_idx=0 ;; esac
  case "$navori_pr_head" in ''|*[!0-9]*) navori_pr_head=0 ;; esac
  navori_pr_size=$navori_pr_wt
  if [ "$navori_pr_idx" -gt "$navori_pr_size" ]; then navori_pr_size=$navori_pr_idx; fi
  if [ "$navori_pr_size" -gt "$navori_progress_hard_cap" ] && [ "$navori_pr_size" -gt "$navori_pr_head" ]; then
    navori_audit_block_reason="el estado de sesion '$navori_pr_path' crecio a $navori_pr_size bytes, sobre el techo de $navori_progress_hard_cap; commit bloqueado"
    echo "[navori] Commit BLOCKED: $navori_pr_path is $navori_pr_size bytes, over the $navori_progress_hard_cap-byte ceiling, and larger than at HEAD ($navori_pr_head bytes)." >&2
    echo "[navori] It must hold only the current state and the next step. Trim it (move older checkpoints to progress/history.md) and commit again." >&2
    return 2
  fi
  return 0
}

# The whole lane for the hooks: the ceiling plus the loop over the session-state
# paths, run from the root of the tree being committed. Returns 0 or 2.
# The ceiling is injected from the single TS constant (a raw, unrendered copy
# leaves the placeholder text, which is not numeric: the lane then stays off
# rather than guess a number).
# Guarded by `-n "$cmd"`: with an empty `$cmd` (#511) the lane would run on EVERY
# Bash call and block the very command that fixes the file.
navori_progress_ratchet_lane() {
  navori_progress_hard_cap={{navori.progressHardCapBytes}}
  case "$navori_progress_hard_cap" in ''|*[!0-9]*) navori_progress_hard_cap="" ;; esac
  if [ -n "$cmd" ] && [ -n "$navori_progress_hard_cap" ]; then
    for navori_pf in "progress/current.md" ".claude/progress/current.md" ".codex/progress/current.md"; do
      navori_progress_ratchet "$navori_pf" || return 2
    done
  fi
  return 0
}
