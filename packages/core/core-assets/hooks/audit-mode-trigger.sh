#!/usr/bin/env bash
# navori — audit-mode prompt recorder (UserPromptSubmit)
#
# While audit-mode is active, transports prompt metadata to the private writer.
#
# It used to also detect an audit-mode invocation in the prompt text and ask
# Claude to confirm activation. That was removed (spec 0013, R3): matching
# `audit mode` as a substring cannot separate INVOKING the mode from TALKING
# ABOUT it, and talking about it is what you do all day while working on the
# feature. The asymmetry made it worse — turning it ON matched loosely, while
# turning it OFF required the literal phrase, so sessions stayed open forever.
# Activation is now exclusively `navori audit --start <id>`.
#
# FAIL-OPEN ABSOLUTE: this hook runs on every prompt. Any error, any missing
# dependency, any odd path exits 0 silently. It must never be the reason a
# session fails to start.

set +e

# navori:include audit-repo

payload=$(cat 2>/dev/null) || exit 0
[ -n "$payload" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
# navori:include extract-cmd
# navori:include hook-input

session_id=$(printf '%s' "$payload" | jq -r '.session_id // ""' 2>/dev/null) || exit 0
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null) || exit 0
[ -n "$session_id" ] || exit 0
# The id composes `log_file` below, so a path-shaped one would escape the
# audit root. The CLI validates it too (#503) — this guard is here so the
# hook does not DEPEND on that: "safe because the other layer cannot create
# the case" is the coupling that let three delete paths drift apart. Same
# character class the CLI enforces; anything else means the payload is not
# what we think it is, so do nothing rather than guess.
case "$session_id" in
  *[!A-Za-z0-9_-]*) exit 0 ;;
esac
[ -n "$cwd" ] || cwd=$PWD

repo=$(navori_audit_repo_from_cwd "$cwd") || exit 0
[ -n "$repo" ] || exit 0

if [ -n "$NAVORI_AUDITS_ROOT" ]; then
  audits_root=$NAVORI_AUDITS_ROOT
else
  [ -n "$HOME" ] || exit 0
  audits_root=$HOME/.navori/audits
fi
log_file=$audits_root/$repo/session-$session_id.log

# ─── Armed audit-mode for the RUNNING session (#599) ─────────────────────────
# `navori audit --arm` (another terminal, or `! navori audit --arm` in-session)
# → the NEXT prompt lands here, consumes the flag and starts recording. This is
# the UX the SessionStart-only flow lacked: no closing and reopening a session
# that is already warm. Costs one stat per prompt when not armed. The stdout
# line is deliberate — a UserPromptSubmit hook's stdout is injected as context,
# so the model learns it is being recorded the moment it starts to be.
# Mid-session coverage is already modeled by the report (recorder horizon), so a
# log that starts at prompt N is a smaller log, never a broken one.
# navori:include audit-arm
if navori_audit_consume_armed "$session_id" "$cwd" "$audits_root" "$nv_engine"; then
  printf 'navori: audit-mode ACTIVE from this message on (armed via navori audit --arm; the hook ran --start %s).\n' "$session_id"
fi

# ─── audit.mode = always (cobertura sin acordarse) ───────────────────────────
# `opt-in` keeps the historical behaviour: nothing is recorded until someone runs
# `navori audit --start|--arm`. `always` starts the recorder on this session's
# first prompt instead.
#
# It exists because opt-in coverage was measured and it is thin: of 187 real
# sessions only 54 carried a log, so the instrument saw 39% of the work — and the
# two arms of a controlled A/B sat at 0%, which is the one place the measurement
# was supposed to decide something. Same failure mode as the release tag that got
# skipped twice: a step that waits on a human remembering it.
#
# The `! -f` guard is what makes this idempotent AND free: once the log exists
# the branch is never taken again, and in `opt-in` repos the string compare costs
# nothing. Failure to start is silent and leaves the session unrecorded, exactly
# as if the mode were off — a recorder may never be the reason a prompt fails.
audit_mode={{shq:audit.mode}}
if [ ! -f "$log_file" ] && [ "$audit_mode" = "always" ] && command -v navori >/dev/null 2>&1; then
  if navori audit --start "$session_id" --cwd "$cwd" --host "$nv_engine" >/dev/null 2>&1; then
    # Same reasoning as the armed branch: a UserPromptSubmit hook's stdout is
    # injected as context, so the model learns it is being recorded as it starts.
    printf 'navori: audit-mode ACTIVE from this message on (audit.mode=always; no --arm needed).\n'
  fi
fi

# Not marked → not recording. This is also what makes the hook free outside
# audit-mode: one stat and out.
[ -f "$log_file" ] || exit 0

# Metadata only: prompt text and private transcript paths never cross the bridge.
# navori:include audit-log
navori_audit_phase=UserPromptSubmit
navori_audit_now_ms=$(navori_audit_now)
[ "$navori_audit_now_ms" -ge 0 ] 2>/dev/null || navori_audit_now_ms=0
metadata=$(printf '%s' "$payload" | jq -c --argjson tsMs "$navori_audit_now_ms" '
  (.prompt // .user_prompt // "") as $prompt |
  {event:"prompt",kind:"user",length:(if ($prompt|type) == "string" then ($prompt|length) else 0 end),tsMs:$tsMs}
  + (if (.agent_id|type) == "string" and (.agent_id|length) <= 256 and (.agent_id|test("^[A-Za-z0-9_-]+$")) then {agentId:.agent_id} else {} end)' 2>/dev/null) || exit 0
navori_audit_record_metadata "$metadata"
exit 0
