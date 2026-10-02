#!/usr/bin/env bash
# PostToolUseFailure(Bash) advisory. The shared state helper also handles reset
# from routing-watch on a successful PostToolUse(Bash).
set -uo pipefail
# navori:include extract-cmd
# navori:include hook-input
# navori:include bash-outcome
navori_audit_name="bash-outcome-watch"
navori_audit_phase="PostToolUseFailure"
navori_audit_begin() { :; }
navori_audit_log() { :; }
# navori:include audit-repo
# navori:include audit-log
navori_audit_begin
[ -n "${nv_project_dir:-}" ] || exit 0
advice=$(navori_bash_failure_state failure)
if [ -n "$advice" ]; then
  navori_audit_log "advise" "same Bash failure reached three consecutive occurrences"
  NV_ADVICE="$advice" node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUseFailure",additionalContext:process.env.NV_ADVICE}})+"\n")' 2>/dev/null || true
fi
exit 0
