#!/usr/bin/env bash
#
# PreToolUse(Bash): a manual acceptance (`navori master part … --approved-by`)
# must be confirmed by the person whose approval it records (spec 0034 R62).
#
# This is deliberately an interruption, not a parser for the command. The CLI
# validates the complete flag contract; this hook keeps the human in the loop
# for the one form that claims their manual review.
set -euo pipefail

# Command extraction (payload → $cmd). Shared body, single source of truth.
# navori:include extract-cmd

# Every matching command needs this literal token, so its absence from the raw
# payload proves this hook cannot apply and avoids parsing the payload at all.
TRIGGER_TOKENS='approved-by'
# navori:include gate-trigger

has_trigger_token "${payload:-}" || exit 0

cmd=$(extract_cmd)

navori_audit_name="master-accept-confirm"
navori_audit_phase="PreToolUse"
navori_audit_tool="Bash"
navori_audit_begin() { :; }
navori_audit_log() { :; }
# navori:include audit-repo
# navori:include audit-log
navori_audit_begin

navori_audit_verdict="skip"
navori_audit_reason="el comando no registra una aprobación manual"
navori_audit_on_exit() {
  navori_audit_log "$navori_audit_verdict" "$navori_audit_reason" || true
  return 0
}
trap navori_audit_on_exit EXIT

[ -n "$cmd" ] || exit 0

# Same boundary as D6/R43: a command after `&&`, `;`, `|`, in a subshell or a
# command substitution is still visible. `is_scan_trigger` keeps the flag in
# the same compound-command segment, so an unrelated later `--approved-by`
# cannot turn an earlier command into a confirmation prompt.
BOUND='(^|[;&|(`]|[[:space:]])'
TRIGGER_RE=".*${BOUND}navori[[:space:]]+master[[:space:]]+part([[:space:]]|\$).*--approved-by([[:space:]=]|\$)"
is_scan_trigger "$cmd" || exit 0

# Fixed by construction: no repository content reaches JSON, so this still
# works when jq and node are unavailable.
navori_audit_verdict="ask"
navori_audit_reason="manual criterion acceptance"
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"[navori] this records that you approved a manual criterion. Confirm only if you reviewed it."}}'
