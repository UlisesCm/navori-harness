#!/usr/bin/env bash
#
# PreToolUse(Bash): `navori master accept|reject` records the user's QA verdict
# in the acceptance log (branch navori/acceptance), whoever invokes the CLI
# (navori, npx, `node …/index.js`); any mention of that branch (a push, an
# update-ref) and `navori plan escalation-reset --approved-by` ask too, so the
# person whose approval it records confirms it (spec 0063, spec 0039 R58).
#
# This is deliberately an interruption, not a parser for the command. The CLI
# validates the complete flag contract; this hook keeps the human in the loop.
# The v1 write forms (`master part`, `close`, `delivery-*`) no longer write
# (spec 0063 T6), so they no longer ask.
set -euo pipefail

# Command extraction (payload → $cmd). Shared body, single source of truth.
nv_payload_fields="tool_input.command"
payload_load() { :; }
# navori:include extract-cmd

# Every matching command needs this literal token, so its absence from the raw
# payload proves this hook cannot apply and avoids parsing the payload at all.
TRIGGER_TOKENS='escalation-reset navori master'
# navori:include gate-trigger

has_trigger_token "${payload:-}" || exit 0

payload_load
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
# `--approved-by` takes `=` or a space.
BOUND='(^|[;&|(`]|[[:space:]])'
RUNNER='((npx|bunx|pnpm[[:space:]]+(exec|dlx))[[:space:]]+(-[^[:space:]]+[[:space:]]+)*)?'
NAVORI="${RUNNER}([^[:space:];&|(\`]*/)?navori(@[^[:space:]]+)?"
RESET_RE="${NAVORI}[[:space:]]+plan[[:space:]]+escalation-reset([[:space:]]|\$).*--approved-by([[:space:]=]|\$)"
# Any invoker: `master` just needs the boundary before it (`echo masterpiece` does not match).
ACCEPT_RE="master[[:space:]]+(accept|reject)([[:space:];&|)<>]|\$)"
LOG_RE='[^[:space:]]*navori/acceptance'
TRIGGER_RE=".*${BOUND}(${ACCEPT_RE}|${LOG_RE}|${RESET_RE})"
# A command substitution starts a new command: make it a segment of its own so
# the `VAR=$(` prefix peeling in the shared scan cannot swallow it.
navori_subst='$('
navori_semi='; '
cmd="${cmd//"$navori_subst"/$navori_semi}"
# Quotes hide the boundary from `BOUND` in wrapped forms (`sh -c 'navori master
# accept'`, `eval "…"`, `navori master "accept"`): delete ONLY `"` and `'`. Never
# `\`: `navori_count_triggers` joins a `\<newline>` continuation first, and
# removing the backslash here would split the segment (spec 0052 R36). The cost
# is asking on `echo "navori master accept"`, the safe direction. A word split by
# quotes (`navo"ri`) is deliberate obfuscation this hook does not claim to catch.
# `tr`, not `${cmd//[\"\']/}`: bash 3.2's class substitution is superlinear (44 s
# on 6.5 KB). `$(…)` trims trailing newlines, harmless: the next step splits on
# newlines and an empty segment never matches.
cmd=$(printf '%s' "$cmd" | LC_ALL=C tr -d "\"'")
is_scan_trigger "$cmd" || exit 0

approval_description="the QA verdict on these slices or decisions, written to navori/acceptance"
case "$cmd" in
  *navori/acceptance*) approval_description="a direct change to the acceptance log (navori/acceptance)" ;;
  *escalation-reset*) approval_description="another review round after two rejections at level 2 or higher" ;;
esac

# Fixed by construction: no repository content reaches JSON, so this still
# works when jq and node are unavailable.
# Codex parses `permissionDecision` but drops `"ask"` (the call proceeds), so
# the Codex copy denies instead: deny-as-confirmation, decided by `$0` like
# `comment-draft-confirm.sh` (spec 0041 D11). Never an allow.
case "$0" in
  *".codex/hooks/"*)
    navori_audit_verdict="deny"
    navori_audit_reason="manual approval"
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[navori] this records that the user approved %s, and Codex hooks cannot prompt. Show the user what it approves and let them confirm and run the command themselves."}}\n' "$approval_description"
    ;;
  *)
    navori_audit_verdict="ask"
    navori_audit_reason="manual approval"
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"[navori] this records that you approved %s. Confirm only if you reviewed it."}}\n' "$approval_description"
    ;;
esac
