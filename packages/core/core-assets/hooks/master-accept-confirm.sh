#!/usr/bin/env bash
#
# PreToolUse(Bash): a manual acceptance (`navori master part … --approved-by`)
# or a `navori master close` must be confirmed by the person whose approval it
# records (spec 0034 R62, spec 0039 R58).
#
# This is deliberately an interruption, not a parser for the command. The CLI
# validates the complete flag contract; this hook keeps the human in the loop
# for the one form that claims their manual review.
set -euo pipefail

# Command extraction (payload → $cmd). Shared body, single source of truth.
# navori:include extract-cmd

# Every matching command needs this literal token, so its absence from the raw
# payload proves this hook cannot apply and avoids parsing the payload at all.
TRIGGER_TOKENS='approved-by delivery-baseline delivery-queue navori master'
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
# cannot turn an earlier command into a confirmation prompt. `navori` may be
# bare, run via npx/bunx/pnpm exec|dlx, or a path ending in `/navori`.
# `--approved-by` takes `=` or a space; `close` is gated in all its forms.
BOUND='(^|[;&|(`]|[[:space:]])'
RUNNER='((npx|bunx|pnpm[[:space:]]+(exec|dlx))[[:space:]]+(-[^[:space:]]+[[:space:]]+)*)?'
NAVORI="${RUNNER}([^[:space:];&|(\`]*/)?navori(@[^[:space:]]+)?"
PART_RE="${NAVORI}[[:space:]]+master[[:space:]]+part([[:space:]]|\$).*--approved-by([[:space:]=]|\$)"
CLOSE_RE="${NAVORI}[[:space:]]+master[[:space:]]+close([[:space:];&|)<>]|\$)"
BASELINE_RE="${NAVORI}[[:space:]]+master[[:space:]]+delivery-baseline([[:space:]]|\$).*--approved-by([[:space:]=]|\$)"
QUEUE_RE="${NAVORI}[[:space:]]+master[[:space:]]+delivery-queue([[:space:]]|\$).*--approved-by([[:space:]=]|\$)"
TRIGGER_RE=".*${BOUND}(${PART_RE}|${CLOSE_RE}|${BASELINE_RE}|${QUEUE_RE})"
# A command substitution starts a new command: make it a segment of its own so
# the `VAR=$(` prefix peeling in the shared scan cannot swallow it.
navori_subst='$('
navori_semi='; '
cmd="${cmd//"$navori_subst"/$navori_semi}"
is_scan_trigger "$cmd" || exit 0

approval_description="a manual criterion"
case "$cmd" in
  *delivery-baseline*|*delivery-queue*) approval_description="the delivery baseline or bounded queue" ;;
esac

# Fixed by construction: no repository content reaches JSON, so this still
# works when jq and node are unavailable.
# Codex parses `permissionDecision` but drops `"ask"` (the call proceeds), so
# the Codex copy denies instead: deny-as-confirmation, decided by `$0` like
# `comment-draft-confirm.sh` (spec 0041 D11). Never an allow.
case "$0" in
  *".codex/hooks/"*)
    navori_audit_verdict="deny"
    navori_audit_reason="manual approval or stage close"
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[navori] this records that the user approved %s, and Codex hooks cannot prompt. Show the user what it approves and let them confirm and run the command themselves."}}\n' "$approval_description"
    ;;
  *)
    navori_audit_verdict="ask"
    navori_audit_reason="manual approval or stage close"
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"[navori] this records that you approved %s. Confirm only if you reviewed it."}}\n' "$approval_description"
    ;;
esac
