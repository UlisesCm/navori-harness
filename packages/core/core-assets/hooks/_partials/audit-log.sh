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

# Start the clock — but only after establishing that anything will be recorded.
#
# THE COST OF BEING OFF is the number that matters here: this code is inlined
# into hooks that fire on EVERY Bash call, and audit-mode is off for virtually
# every session of every user. An earlier version ran `perl` plus two `jq`
# invocations before it ever checked whether a log existed — three processes per
# hook, four hooks per command, ~48 ms on every single shell call for a feature
# nobody had turned on.
#
# So the gate is a pure-builtin one first: the per-repo audit directory only
# exists once audit-mode has been activated in this repo at least once. No
# subprocess, no parsing. Everything expensive lives behind it.
navori_audit_begin() {
  navori_audit_on=0

  navori_audit_root=${NAVORI_AUDITS_ROOT:-}
  if [ -z "$navori_audit_root" ]; then
    [ -n "${HOME:-}" ] || return 0
    navori_audit_root=$HOME/.navori/audits
  fi

  # The gate tests the audit ROOT, not the per-repo directory.
  #
  # Deriving the repo cheaply would mean `${CLAUDE_PROJECT_DIR##*/}` — and that
  # is WRONG: the authoritative repo comes from the payload's `cwd`, and the two
  # differ whenever a hook fires inside an agent worktree, since the hook process
  # starts in the main repo (#454). A gate built on the wrong name would silently
  # record nothing exactly where the harness runs its parallel work.
  #
  # The root alone is enough for what this gate is for: a user who has never
  # activated audit-mode anywhere has no `~/.navori/audits`, so the common case
  # costs one stat and zero processes. Someone who does use audit-mode pays the
  # parsing — which is the cost of the feature they turned on.
  [ -d "$navori_audit_root" ] || return 0

  navori_audit_on=1
  navori_audit_t0=$(navori_audit_now)
}

# Milliseconds since epoch, spending a process only when it has to.
#
# `$EPOCHREALTIME` is a BUILTIN in bash 5 and in zsh (with zsh/datetime, which
# the harness's zsh path already has): no fork at all. Only a shell without it
# pays for `perl`, and only a machine without perl degrades to whole seconds —
# `date` has no portable millisecond format (GNU has %s%3N, BSD does not).
navori_audit_now() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    # `1756... .123456` → milliseconds, with pure parameter expansion.
    navori_audit_epoch=${EPOCHREALTIME/,/.}
    printf '%s%s' "${navori_audit_epoch%%.*}" "$(printf '%.3s' "${navori_audit_epoch#*.}")"
    return 0
  fi
  perl -MTime::HiRes=time -e 'printf "%.0f", time*1000' 2>/dev/null \
    || printf '%s' $(( $(date +%s 2>/dev/null || echo 0) * 1000 ))
}

# navori_audit_log <verdict> [reason]
#
# `name`, `phase`, `tool` and `source` come from the caller's own variables,
# which the render sets per hook — the partial never guesses which hook it is
# inlined into.
navori_audit_log() {
  # The builtin-only gate from `navori_audit_begin`: when audit-mode was never
  # activated in this repo, nothing below runs and no process is spawned.
  [ "${navori_audit_on:-0}" = "1" ] || return 0
  # No payload, no jq, no clock → nothing to record. Each of these is a normal
  # state for a hook that bailed early, not an error worth surfacing.
  [ -n "${payload:-}" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  # ONE jq for every field, not one per field: this runs on each hook of each
  # Bash call, and a fork is the most expensive thing in it. Newline-separated,
  # read back positionally.
  navori_audit_fields=$(printf '%s' "${payload:-}" | jq -r '[.session_id // "", .cwd // "", .agent_id // .subagent_id // ""] | .[]' 2>/dev/null) || return 0
  navori_audit_session=${navori_audit_fields%%
*}
  navori_audit_rest=${navori_audit_fields#*
}
  navori_audit_cwd=${navori_audit_rest%%
*}
  navori_audit_agent=${navori_audit_rest#*
}
  [ -n "$navori_audit_session" ] || return 0
  # Same character class the CLI enforces (#503): the id composes a path, so
  # anything path-shaped means the payload is not what we think it is.
  case "$navori_audit_session" in
    *[!A-Za-z0-9_-]*) return 0 ;;
  esac

  [ -n "$navori_audit_cwd" ] || navori_audit_cwd=$PWD
  navori_audit_repo=$(basename "$navori_audit_cwd" 2>/dev/null) || return 0
  [ -n "$navori_audit_repo" ] || return 0

  navori_audit_file=$navori_audit_root/$navori_audit_repo/session-$navori_audit_session.log

  # The session may not be the marked one even in a repo that has been audited
  # before. Also the writability check — a log that cannot be appended to is not
  # an error, it is simply not recording.
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

  navori_audit_end=$(navori_audit_now)
  navori_audit_ms=$(( navori_audit_end - ${navori_audit_t0:-$navori_audit_end} ))
  [ "$navori_audit_ms" -ge 0 ] 2>/dev/null || navori_audit_ms=0

  navori_audit_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || navori_audit_ts=""
  # `navori_audit_agent` came out of the same single jq above. It is what lets
  # the report attribute a hook to a subagent WITHOUT guessing: with agents
  # running in parallel their time windows overlap, so attribution by timestamp
  # is the fallback, not the primary route.

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
