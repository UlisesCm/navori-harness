#!/usr/bin/env bash
# #1776 repro (read-only on the repo): guard-destructive rule 7 with an unusable git.
# Runs the shell script (NAVORI_HOOK_IMPL=shell) and the native binary (NAVORI_HOOK_IMPL=rust,
# no --shadow) on `git reset --hard` in a dirty scratch repo, under four PATH variants.
set -u
WT=${WT:?worktree}
BIN=${BIN:?navori-rust binary}
work=$(mktemp -d /tmp/s1-guard-git.XXXXXX)
trap 'rm -rf "$work"' EXIT
repo=$work/repo
mkdir -p "$repo" && cd "$repo" || exit 1
git init -q && git config user.email t@t && git config user.name t
echo a > f.txt && git add f.txt && git commit -qm init && echo b > f.txt   # dirty tracked change
mkdir -p "$repo/.claude/hooks"
cp "$WT/.claude/hooks/guard-destructive.sh" "$repo/.claude/hooks/"
cp -r "$WT/.claude/scripts" "$repo/.claude/" 2>/dev/null; cp "$WT/navori.config.json" "$repo/" 2>/dev/null; git -C "$repo" add -A .claude navori.config.json >/dev/null 2>&1; git -C "$repo" commit -qm hooks >/dev/null 2>&1

# PATH without any git: every /usr/bin and /bin entry except git, plus jq, node and the binary.
nogit=$work/nogit
mkdir -p "$nogit"
for d in /usr/bin /bin; do
  for f in "$d"/*; do
    b=${f##*/}
    case "$b" in git | git-*) continue ;; esac
    [ -e "$nogit/$b" ] || ln -s "$f" "$nogit/$b" 2>/dev/null
  done
done
ln -sf "$BIN" "$nogit/navori-rust"
# variant dirs prepended to $nogit
mkdir -p "$work/noexec" "$work/fails" "$work/real"
printf '#!/bin/sh\nexec /usr/bin/git "$@"\n' > "$work/noexec/git" && chmod 644 "$work/noexec/git"
printf '#!/bin/sh\nexit 128\n' > "$work/fails/git" && chmod 755 "$work/fails/git"
ln -s /usr/bin/git "$work/real/git"

payload=$(printf '{"session_id":"s","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git reset --hard"}}' "$repo")
run() { # $1 label, $2 PATH, $3 impl
  local out rc
  out=$(printf '%s' "$payload" | env -i HOME="$work" PATH="$2" CLAUDE_PROJECT_DIR="$repo" LC_ALL=C \
    NAVORI_HOOK_IMPL="$3" bash "$repo/.claude/hooks/guard-destructive.sh" 2>&1); rc=$?
  local verdict=allow
  case "$out" in *'"permissionDecision":"deny"'* | *'"decision":"block"'*) verdict=deny ;; *'"permissionDecision":"ask"'*) verdict=ask ;; esac
  [ "$rc" = 2 ] && verdict=deny
  printf '%-14s %-6s rc=%s verdict=%s %s\n' "$1" "$3" "$rc" "$verdict" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-140)"
}
nonrepo=$work/nonrepo; mkdir -p "$nonrepo"
payload_nr=$(printf '{"session_id":"s","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git -C %s reset --hard"}}' "$repo" "$nonrepo")
for impl in shell rust; do
  payload_save=$payload; payload=$payload_nr; run nonrepo-real "$work/real:$nogit" "$impl"; payload=$payload_save
  run real-git "$work/real:$nogit" "$impl"
  run no-git "$nogit" "$impl"
  run git-noexec "$work/noexec:$nogit" "$impl"
  run git-fails "$work/fails:$nogit" "$impl"
done
