#!/usr/bin/env bash
# Repeat one guard payload under shell and rust and count the first message line of each.
set -u
WT=${WT:?worktree}
BIN=${BIN:?binary}
N=${N:-40}
work=$(mktemp -d /tmp/s1-flaky.XXXXXX)
trap 'rm -rf "$work"' EXIT
repo=$work/repo
mkdir -p "$repo" && cd "$repo" || exit 1
git init -q && git config user.email t@t && git config user.name t
mkdir -p .claude/hooks && cp "$WT/.claude/hooks/guard-destructive.sh" .claude/hooks/
cp -r "$WT/.claude/scripts" .claude/ 2>/dev/null; cp "$WT/navori.config.json" . 2>/dev/null
echo a > f.txt && git add -A && git commit -qm init
bindir=$work/bin && mkdir -p "$bindir" && ln -s "$BIN" "$bindir/navori-rust"
cmd=$(printf 'git commit -n -m x \\\n  (git push origin +main) && \\rm -rf /tmp')
payload=$(jq -cn --arg cwd "$repo" --arg c "$cmd" '{session_id:"s",cwd:$cwd,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:$c}}')
for impl in shell rust; do
  for i in $(seq "$N"); do
    printf '%s' "$payload" | env -i HOME="$work" PATH="$bindir:/usr/bin:/bin" CLAUDE_PROJECT_DIR="$repo" LC_ALL=C \
      NAVORI_HOOK_IMPL="$impl" bash "$repo/.claude/hooks/guard-destructive.sh" 2>&1 | head -1
  done | sort | uniq -c | sed "s/^/$impl /"
done
