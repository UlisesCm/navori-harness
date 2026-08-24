# Shared hook boilerplate — inlined into each hook at render time (see the
# include directive in the source scripts + lib/hook-includes.ts). Single source
# of truth for the sibling gate scripts; DO NOT copy this body back into a hook
# by hand (that is the drift #225/#261 removed).
#
# PreToolUse(Bash) passes the tool input on stdin. Read one field out of it
# WITHOUT hard-depending on jq (NOT preinstalled on macOS): try jq, then node
# (Claude Code's own runtime), then a best-effort sed unwrap on the leaf key.
# Nothing extracted → empty output, and each caller decides what that means (the
# gate scripts scan defensively; guard-destructive waves the command through).
#
# $1 is a dotted path written HERE, never user input — the payload is the data.
# Generic on purpose: `.cwd` feeds the worktree resolver of #454 through the
# SAME hardened cascade instead of a second copy of it.
#
# $2 overrides the sed fallback's capture. `.*` (greedy, to the last quote on the
# line) is right for `command`, whose value can itself contain escaped quotes and
# which Claude Code sends LAST. Every other field takes the default `[^"]*` run,
# so a value with more JSON after it is not swallowed whole.
payload=$(cat)
payload_field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -r ".$1 // empty" 2>/dev/null && return 0
  fi
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$payload" | node -e 'let s="";const p=process.argv[1].split(".");process.stdin.on("data",c=>s+=c).on("end",()=>{try{let v=JSON.parse(s);for(const k of p)v=v?.[k];process.stdout.write(String(v??""))}catch{}})' "$1" 2>/dev/null && return 0
  fi
  printf '%s' "$payload" | sed -n "s/.*\"${1##*.}\"[[:space:]]*:[[:space:]]*\"\(${2:-[^\"]*}\)\".*/\1/p"
}
extract_cmd() {
  payload_field tool_input.command '.*'
}
cmd=$(extract_cmd)
