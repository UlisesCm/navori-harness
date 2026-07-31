# Shared hook boilerplate — inlined into each hook at render time (see the
# include directive in the source scripts + lib/hook-includes.ts). Single source
# of truth for the sibling gate scripts; DO NOT copy this body back into a hook
# by hand (that is the drift #225/#261 removed).
#
# PreToolUse(Bash) passes the tool input on stdin. Extract .tool_input.command
# WITHOUT hard-depending on jq (NOT preinstalled on macOS): try jq, then node
# (Claude Code's own runtime), then a best-effort sed unwrap. No command
# extracted → empty $cmd, and each caller decides what that means (the gate
# scripts scan defensively; guard-destructive waves the command through).
payload=$(cat)
extract_cmd() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null && return 0
  fi
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)?.tool_input?.command??""))}catch{}})' 2>/dev/null && return 0
  fi
  printf '%s' "$payload" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p'
}
cmd=$(extract_cmd)
