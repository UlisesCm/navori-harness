# Shared audit-mode event recorder — inlined into each managed hook at render
# time (see the include directive in the source scripts + lib/hook-includes.ts).
#
# WHY (spec 0013): a hook is only visible to the transcript when it BLOCKS or
# INJECTS context. Every hook that runs and lets the action through is invisible,
# so `navori audit` could never answer "did the gate run, and what did it cost?".
# The transcript cannot be fixed — it is the host's format — so the harness
# records its own execution instead, and the session log becomes the source of
# truth for what the harness did.
#
# Expects `$payload` (the raw hook payload on stdin) to be in scope, and reads
# `$navori_audit_t0` for the start instant. Both are set by `navori_audit_begin`.
#
# Every variable read here carries a `:-` default ON PURPOSE: most managed hooks
# run under `set -euo pipefail`, where an unset variable ABORTS the hook. A
# recorder that can abort the thing it observes is worse than no recorder, so the
# partial must be safe to inline into `set -u` and `set +e` alike.
#
# FAIL-OPEN ABSOLUTE, and this matters more here than anywhere else: this code is
# inlined into hooks whose own contract is to never break a session. Observation
# must never become the reason an action fails, so every path returns 0 and
# nothing is ever written to stdout — a stray byte there would be interpreted by
# the host as hook output (context injection, or a block reason).

# Start the clock. Called once, right after the payload is read.
navori_audit_begin() {
  # Milliseconds since epoch, portable: GNU date has %s%3N, BSD/macOS date does
  # not. `perl` is present on every macOS and virtually every Linux; when it is
  # missing the clock degrades to seconds*1000 rather than disabling the record.
  navori_audit_t0=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000' 2>/dev/null) \
    || navori_audit_t0=$(( $(date +%s 2>/dev/null || echo 0) * 1000 ))
}

# navori_audit_log <verdict> [reason]
#
# `name`, `phase`, `tool` and `source` come from the caller's own variables,
# which the render sets per hook — the partial never guesses which hook it is
# inlined into.
navori_audit_log() {
  # No payload, no jq, no clock → nothing to record. Each of these is a normal
  # state for a hook that bailed early, not an error worth surfacing.
  [ -n "${payload:-}" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  navori_audit_session=$(printf '%s' "${payload:-}" | jq -r '.session_id // ""' 2>/dev/null) || return 0
  [ -n "$navori_audit_session" ] || return 0
  # Same character class the CLI enforces (#503): the id composes a path, so
  # anything path-shaped means the payload is not what we think it is.
  case "$navori_audit_session" in
    *[!A-Za-z0-9_-]*) return 0 ;;
  esac

  navori_audit_cwd=$(printf '%s' "${payload:-}" | jq -r '.cwd // ""' 2>/dev/null) || return 0
  [ -n "$navori_audit_cwd" ] || navori_audit_cwd=$PWD
  navori_audit_repo=$(basename "$navori_audit_cwd" 2>/dev/null) || return 0
  [ -n "$navori_audit_repo" ] || return 0

  if [ -n "${NAVORI_AUDITS_ROOT:-}" ]; then
    navori_audit_root=$NAVORI_AUDITS_ROOT
  else
    [ -n "${HOME:-}" ] || return 0
    navori_audit_root=$HOME/.navori/audits
  fi
  navori_audit_file=$navori_audit_root/$navori_audit_repo/session-$navori_audit_session.log

  # THE no-op that keeps audit-mode free: one stat when the mode is off, which
  # is every session that never opted in. Also the writability check — a log
  # that cannot be appended to is not an error, it is simply not recording.
  [ -f "$navori_audit_file" ] || return 0
  [ -w "$navori_audit_file" ] || return 0

  # Volume valve, OFF by default.
  #
  # `PreToolUse(Bash)` chains four hooks, so every shell command leaves four
  # lines and most are `skip` — a long session runs to thousands. Set
  # NAVORI_AUDIT_SKIP_NOOPS=1 to drop the ones that did nothing.
  #
  # Default off on purpose: a `skip` is the ONLY evidence that a hook ran and
  # decided it had no business acting, which is exactly what distinguishes it
  # from a hook that never executed — the question that motivated recording
  # hooks at all. The valve trades that away knowingly; it must not be the
  # silent default.
  if [ "${NAVORI_AUDIT_SKIP_NOOPS:-0}" = "1" ]; then
    case "$1" in
      skip|noop) return 0 ;;
    esac
  fi

  navori_audit_now=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000' 2>/dev/null) \
    || navori_audit_now=$(( $(date +%s 2>/dev/null || echo 0) * 1000 ))
  navori_audit_ms=$(( navori_audit_now - ${navori_audit_t0:-$navori_audit_now} ))
  [ "$navori_audit_ms" -ge 0 ] 2>/dev/null || navori_audit_ms=0

  navori_audit_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || navori_audit_ts=""
  # The agent id is what lets the report attribute a hook to a subagent WITHOUT
  # guessing: with agents running in parallel their time windows overlap, so
  # attribution by timestamp is the fallback, not the primary route.
  navori_audit_agent=$(printf '%s' "${payload:-}" | jq -r '.agent_id // .subagent_id // ""' 2>/dev/null) || navori_audit_agent=""

  printf '%s\n' "$(jq -cn \
    --arg ts "$navori_audit_ts" \
    --arg name "${navori_audit_name:-unknown}" \
    --arg phase "${navori_audit_phase:-unknown}" \
    --arg verdict "${1:-unknown}" \
    --arg reason "${2:-}" \
    --arg tool "${navori_audit_tool:-}" \
    --arg src "${navori_audit_source:-core}" \
    --arg agent "${navori_audit_agent:-}" \
    --argjson ms "$navori_audit_ms" \
    '{ts:$ts,event:"hook",name:$name,phase:$phase,verdict:$verdict,ms:$ms,source:$src}
     + (if $tool   == "" then {} else {tool:$tool}       end)
     + (if $reason == "" then {} else {reason:$reason}   end)
     + (if $agent  == "" then {} else {agentId:$agent}   end)' 2>/dev/null)" \
    >> "$navori_audit_file" 2>/dev/null

  return 0
}
