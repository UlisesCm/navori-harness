#!/usr/bin/env bash
# Rule 7 vs spellings of git (read-only on the repo): shell and native verdicts on a dirty repo.
set -u
WT=${WT:?worktree}
BIN=${BIN:?navori-rust binary}
work=$(mktemp -d /tmp/s1-guard-forms.XXXXXX)
trap 'rm -rf "$work"' EXIT
repo=$work/repo nonrepo=$work/nonrepo
mkdir -p "$repo" "$nonrepo" && cd "$repo" || exit 1
git init -q && git config user.email t@t && git config user.name t
mkdir -p .claude/hooks && cp "$WT/.claude/hooks/guard-destructive.sh" .claude/hooks/
cp -r "$WT/.claude/scripts" .claude/ 2>/dev/null; cp "$WT/navori.config.json" . 2>/dev/null
echo a > f.txt && git add -A && git commit -qm init && echo b > f.txt
bindir=$work/bin && mkdir -p "$bindir" && ln -s "$BIN" "$bindir/navori-rust"
forms=(
  "git reset --hard"
  "GIT_DIR=$repo/.git GIT_WORK_TREE=$repo git -C $nonrepo reset --hard"
  "GIT_WORK_TREE=$repo GIT_DIR=$repo/.git git -C $nonrepo checkout -- ."
  "FOO=1 git reset --hard"
  "/usr/bin/git reset --hard"
  "/usr/bin/git -C $repo clean -fd"
  "env git reset --hard"
  "command git reset --hard"
  "\\\\git reset --hard"
  "cd $nonrepo && git --git-dir=$repo/.git --work-tree=$repo reset --hard"
  "git -C $nonrepo --git-dir=$repo/.git reset --hard"
  "export GIT_DIR=$repo/.git; git -C $nonrepo reset --hard"
  "sudo git reset --hard"
  "sh -c 'git reset --hard'"
  "bash -c \"git reset --hard\""
  "eval git reset --hard"
  "eval 'git reset --hard'"
  "git -C $nonrepo reset --hard"
)
for impl in shell rust; do
  for f in "${forms[@]}"; do
    payload=$(jq -cn --arg cwd "$repo" --arg c "$f" '{session_id:"s",cwd:$cwd,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:$c}}')
    out=$(printf '%s' "$payload" | env -i HOME="$work" PATH="$bindir:/usr/bin:/bin" CLAUDE_PROJECT_DIR="$repo" LC_ALL=C \
      NAVORI_HOOK_IMPL="$impl" bash "$repo/.claude/hooks/guard-destructive.sh" 2>&1); rc=$?
    v=allow; [ "$rc" = 2 ] && v=deny; case "$out" in *'"permissionDecision":"ask"'*) v=ask ;; esac
    printf '%-5s %-5s %s\n' "$impl" "$v" "${f//$work/<w>}"
  done
done
