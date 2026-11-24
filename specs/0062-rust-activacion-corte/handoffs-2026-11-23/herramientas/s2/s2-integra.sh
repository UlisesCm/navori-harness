#!/usr/bin/env bash
# Usage: s2-integra.sh <pr> -> worktree .claude/worktrees/integra-<pr> detached at the PR head, rebased on origin/migration/rust.
set -euo pipefail
N=$1
ROOT=$HOME/Documentos/dev/personal/navori-harness
cd "$ROOT"
git fetch -q origin
BR=$(gh pr view "$N" --json headRefName -q .headRefName)
OLD=$(gh pr view "$N" --json headRefOid -q .headRefOid)
WT="$ROOT/.claude/worktrees/integra-$N"
[ -d "$WT" ] || git worktree add -q --detach "$WT" "$OLD"
cd "$WT"
[ "$(git rev-parse --show-toplevel)" = "$WT" ] || { echo "not in $WT"; exit 9; }
echo "branch=$BR old=$OLD base=$(git rev-parse --short origin/migration/rust) mergebase=$(git merge-base HEAD origin/migration/rust | cut -c1-8)"
git log --oneline origin/migration/rust..HEAD | cat
if git rebase origin/migration/rust >/tmp/s2-integra-$N.log 2>&1; then echo REBASE_OK; else grep -E 'CONFLICT' /tmp/s2-integra-$N.log || tail -5 /tmp/s2-integra-$N.log; echo REBASE_CONFLICT; fi
