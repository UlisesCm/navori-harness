#!/usr/bin/env bash
#
# PreToolUse(Agent): dispatching `general-purpose` is raised to a user
# confirmation that names the `scout` (spec 0039 R40).
#
# WHY: `general-purpose` is the host's catch-all subagent. For read-only
# exploration and web research the `scout` is the harness's own role, with
# the right tools and sandbox, and nothing interrupts the orchestrator from
# reaching for the catch-all instead. Same posture as `pr-publisher-confirm`:
# this interrupts and does no more. It never blocks — a repo without a usable
# scout, or a task that really needs `general-purpose`, stays one confirmation
# away.
#
# The registration carries no `if`: `Agent(<name>)` if-conditions don't match by
# name in Claude Code 2.1.287, so the hook would never fire. The check below is
# the only filter on `tool_input.subagent_type`.
set -euo pipefail

# Command extraction (payload → $cmd). Shared body, single source of truth.
# navori:include extract-cmd

# Every dispatch this hook cares about carries this literal in the payload, so
# its absence proves the hook cannot apply and skips every fork below. A plain
# `case` rather than the shared token gate: that one is for Bash command gates.
case "${payload:-}" in
  *general-purpose*) ;;
  *) exit 0 ;;
esac

navori_audit_name="general-purpose-confirm"
navori_audit_phase="PreToolUse"
navori_audit_tool="Agent"
navori_audit_begin() { :; }
navori_audit_log() { :; }
# navori:include audit-repo
# navori:include audit-log
navori_audit_begin

navori_audit_verdict="skip"
navori_audit_reason="el subagente no es general-purpose"
navori_audit_on_exit() {
  navori_audit_log "$navori_audit_verdict" "$navori_audit_reason" || true
  return 0
}
trap navori_audit_on_exit EXIT

navori_gp_type=$(payload_field tool_input.subagent_type)
[ "$navori_gp_type" = "general-purpose" ] || exit 0

navori_audit_verdict="ask"
navori_audit_reason="general-purpose despachado; scout cubre lectura e investigación"

# Fixed by construction: no repository content reaches the JSON, so this works
# without jq or node.
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"[navori] general-purpose is dispatched here. For read-only exploration or web research the scout covers it (dispatch it with the Agent tool) with the right tools. Confirm only if this task needs general-purpose."}}'
exit 0
