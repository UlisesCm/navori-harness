# Shared hook boilerplate — inlined into each hook at render time (see the
# include directive in the source scripts + lib/render/hook-includes.ts). Single source
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
# The sed fallback reads a JSON string through its first unescaped quote. JSON
# object member order is not a host contract: `command` can precede `cwd`, so a
# greedy capture to the last quote would swallow the rest of the payload when
# neither jq nor node is available.
# `${payload-$(cat)}` (unset test, not `:-`) rather than an unconditional
# `payload=$(cat)`: a caller that already captured stdin itself (spec 0035 —
# `managed-drift-watch.sh` needs the audit recorder's session_id/cwd even on
# tool names this hook does not otherwise read) keeps that value, empty or
# not, instead of this partial re-reading an already-drained pipe and
# clobbering it with "".
payload=${payload-$(cat)}
payload_field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -r ".$1 // empty" 2>/dev/null && return 0
  fi
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$payload" | node -e 'let s="";const p=process.argv[1].split(".");process.stdin.on("data",c=>s+=c).on("end",()=>{try{let v=JSON.parse(s);for(const k of p)v=v?.[k];process.stdout.write(String(v??""))}catch{}})' "$1" 2>/dev/null && return 0
  fi
  printf '%s' "$payload" | sed -nE "s/.*\"${1##*.}\"[[:space:]]*:[[:space:]]*\"(([^\"\\]|\\.)*)\".*/\\1/p"
}
extract_cmd() {
  payload_field tool_input.command
}

# payload_fields VAR=path… — several fields, ONE process (spec 0054 R22, D10).
# Each `payload_field` call forks a subshell plus jq/node; a hook that needs two
# or more fields up front pays that per field. Here a single jq (or node) emits
# every field followed by a NUL and closes with the sentinel `END` NUL.
#
# NEVER SHIFTS A FIELD (challenge B3). `tool_input.command` is model-controlled,
# and JSON `\u0000` decodes to a NUL byte, which would end that field early and
# slide the next value (`cwd`, `session_id`, a role) into the wrong variable. So
# the producer REFUSES to emit anything when any value holds a NUL, and the shell
# reads exactly N fields plus the sentinel with nothing after it. Any anomaly —
# a NUL, a missing or extra field, empty output for a non-empty payload, a
# producer that failed — discards the whole read and repeats it field by field
# with `payload_field`, i.e. exactly today's behaviour. A variable is never left
# empty "because the read went wrong" (that would read as "allowed").
#
# Values match `$(payload_field …)`: trailing newlines stripped, `null` and
# `false` empty, non-strings as compact JSON. Paths are dotted and written HERE,
# never user input. Works under bash 3.2 and zsh: no arrays, `printf -v` to assign.
_payload_fields_read() {
  local _pf_spec _pf_val _pf_end _pf_extra
  for _pf_spec in "$@"; do
    IFS= read -r -d '' _pf_val || return 1
    while [ "${_pf_val%$'\n'}" != "$_pf_val" ]; do _pf_val=${_pf_val%$'\n'}; done
    printf -v "${_pf_spec%%=*}" '%s' "$_pf_val" || return 1
  done
  IFS= read -r -d '' _pf_end || return 1
  [ "$_pf_end" = END ] || return 1
  if IFS= read -r -d '' _pf_extra; then return 1; fi
  [ -z "$_pf_extra" ] || return 1
  return 0
}
payload_fields() {
  local _pf_spec _pf_filter="" _pf_paths=""
  [ "$#" -gt 0 ] || return 0
  if [ -z "$payload" ]; then
    for _pf_spec in "$@"; do printf -v "${_pf_spec%%=*}" '%s' ""; done
    return 0
  fi
  for _pf_spec in "$@"; do
    _pf_filter="$_pf_filter(.${_pf_spec#*=} // \"\" | tostring),"
    _pf_paths="$_pf_paths ${_pf_spec#*=}"
  done
  _pf_filter="[${_pf_filter%,}] as \$v | if all(\$v[]; any(explode[]; . == 0) | not) then (\$v[] | ., \"\\u0000\"), \"END\\u0000\" else empty end"
  if command -v jq >/dev/null 2>&1; then
    _payload_fields_read "$@" < <(printf '%s' "$payload" | jq -j "$_pf_filter" 2>/dev/null) && return 0
  fi
  if command -v node >/dev/null 2>&1; then
    _payload_fields_read "$@" < <(printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);let o="";for(const p of process.argv[1].trim().split(" ")){let v=j;for(const k of p.split("."))v=v?.[k];const t=v==null||v===false?"":typeof v==="string"?v:JSON.stringify(v);if(t.includes("\0"))return;o+=t+"\0"}process.stdout.write(o+"END\0")}catch{}})' "$_pf_paths" 2>/dev/null) && return 0
  fi
  for _pf_spec in "$@"; do
    printf -v "${_pf_spec%%=*}" '%s' "$(payload_field "${_pf_spec#*=}")"
  done
  return 0
}
# NOT called here on purpose. `payload_field` may spawn a process, and
# `routing-watch.sh` — which includes this partial and runs after EVERY tool call
# in every session — never reads `cmd`. Each consumer that wants it calls
# `extract_cmd` itself, at the point where it already knows it needs it.
