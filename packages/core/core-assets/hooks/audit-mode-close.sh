#!/usr/bin/env bash
# navori — audit-mode close (SessionEnd)
#
# Seals the session's append-only log when the session ends. It does NOT ask
# and does NOT generate the report: SessionEnd has no one to ask — the human is
# already gone — and the log is immutable, so `navori audit` can build the
# report later, tomorrow or in two weeks, from the same intact file.
#
# FAIL-OPEN ABSOLUTE: exit 0 on anything unexpected.

set +e

# navori:include audit-repo

payload=$(cat 2>/dev/null) || exit 0
[ -n "$payload" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

session_id=$(printf '%s' "$payload" | jq -r '.session_id // ""' 2>/dev/null) || exit 0
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null) || exit 0
# reason is categorized below, never transported as caller free text.
reason=$(printf '%s' "$payload" | jq -r '.reason // .matcher // "other"' 2>/dev/null) || reason="other"
[ -n "$session_id" ] || exit 0
case "$session_id" in *[!A-Za-z0-9_-]*) exit 0 ;; esac
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

[ -f "$log_file" ] || exit 0

# navori:include audit-log
navori_audit_phase=SessionEnd
case "$reason" in clear | logout | prompt_input_exit | bypass_permissions_disabled) : ;; *) reason=other ;; esac
now_ms=$(navori_audit_now)
[ "$now_ms" -ge 0 ] 2>/dev/null || now_ms=0
metadata=$(printf '%s' "$payload" | jq -c --arg reason "$reason" --argjson tsMs "$now_ms" '
  {event:"session-end",reason:$reason,tsMs:$tsMs}
  + (if (.agent_id|type) == "string" and (.agent_id|length) <= 256 and (.agent_id|test("^[A-Za-z0-9_-]+$")) then {agentId:.agent_id} else {} end)' 2>/dev/null) || exit 0
navori_audit_record_metadata "$metadata"
exit 0
