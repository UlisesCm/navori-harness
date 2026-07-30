#!/usr/bin/env bash
#
# SessionStart context hook.
# Injects the harness's live session context — current branch, recent commits,
# and the previous session's `progress/current.md` — into the model's context
# at the TOP of the session, so "resume where we left off" is deterministic
# instead of something the model has to remember to read. Wired for the
# `startup|resume|compact` SessionStart sources (fresh start, resume, and after
# a compaction that dropped the harness context).
#
# Output contract (Claude Code SessionStart): a JSON object on stdout whose
# `hookSpecificOutput.additionalContext` string is injected before the first
# model request. We build it with node (Claude Code's own runtime, always
# present) so the multi-line context is JSON-escaped correctly; jq is a
# fallback. If neither runs, or there is nothing to inject, we exit 0 silently
# (no context, no error — a SessionStart hook can't block anyway).
#
# Memory (mem_context) is intentionally NOT injected here: the engram plugin
# ships its own SessionStart hook for that, and duplicating it would double the
# context. This hook only covers the harness's own git + progress state.
#
# The `{{...}}` placeholders are filled by `navori render`; do NOT edit by hand.
set -euo pipefail

cat >/dev/null 2>&1 || true   # drain the SessionStart JSON on stdin (unused)

ctx=""
add() { ctx="${ctx}${1}"$'\n'; }

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
  # branchBase is shell-quoted at render time via the shq: marker (#197) so an
  # untrusted branchBase can't inject a command here.
  base={{shq:branchBase}}
  if [ "$branch" = "$base" ]; then
    add "Branch: ${branch}  ⚠️ on the base branch — create a working branch before committing."
  else
    add "Branch: ${branch}  (base: ${base})"
  fi
  log=$(git log --oneline -15 2>/dev/null || true)
  if [ -n "$log" ]; then
    add "Recent commits:"
    add "$log"
  fi
fi

# Previous-session state. The default lives at `progress/current.md`; the
# Claude progress dir is the fallback. (These are literal, not interpolated:
# `progress.dir`/`progress.currentFile` aren't exposed to the render's
# interpolator, and the default covers the overwhelming common case.)
current=""
for f in "progress/current.md" ".claude/progress/current.md"; do
  if [ -f "$f" ]; then current="$f"; break; fi
done
if [ -n "$current" ]; then
  body=$(cat "$current" 2>/dev/null || true)
  if [ -n "$body" ]; then
    add ""
    add "Resume — ${current}:"
    add "$body"
  fi
fi

# Workspace Dominio: canonical cross-repo knowledge for the workspace this repo
# belongs to (e.g. "coachee = user-profile.kind"), so agents don't relearn it
# wrong in every repo. The CLI owns the resolution (which workspace is cwd in +
# read the index); the hook stays dumb. Cheap pre-check first so the common
# no-workspace case never spawns the binary, and `|| true` so a missing/broken
# `navori` never blocks session startup. (spec 0011 §6.1)
if [ -d "$HOME/.navori/workspaces" ] && command -v navori >/dev/null 2>&1; then
  dominio=$(navori dominio inject 2>/dev/null || true)
  if [ -n "$dominio" ]; then
    add ""
    add "$dominio"
  fi
fi

[ -n "$ctx" ] || exit 0

# Emit the JSON safely: node (best escaping) → jq → give up (exit 0, no context).
if command -v node >/dev/null 2>&1; then
  CTX="$ctx" node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:process.env.CTX}}))'
elif command -v jq >/dev/null 2>&1; then
  jq -n --arg ctx "$ctx" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
fi
exit 0
