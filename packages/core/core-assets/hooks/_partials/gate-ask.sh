# Can this gate hand a no-verdict outcome to the user instead of blocking?
# Inlined at render time (see lib/render/hook-includes.ts). Decides only; the
# JSON that speaks to the host stays in each script (partials never carry host
# output vocabulary — hook-output-contract.test.ts).
#
# WHY (#1117): when the TOOL failed (scanner missing a flag, declared runner not
# on PATH) the gate has no verdict, and "run it yourself outside the agent" is a
# dead end. Claude Code's PreToolUse can ask the human; that is the right exit.
#
# Returns 0 only when ALL hold; any doubt is "no", and "no" is today's block:
#   - the script is not a Codex copy (Codex drops `permissionDecision`, so an
#     ask there would let the call PROCEED unasked). Decided by WHERE THE SCRIPT
#     LIVES, the same rule as the hook-input partial; hooks live in `.codex/hooks/`,
#     plugin scripts in `.codex/scripts/`.
#   - the payload is a real PreToolUse hook call. A git hook or the CLI
#     (`</dev/null`) has no payload, so there is nobody to ask.
#   - jq exists to build the reason JSON safely; without it, block.
# Needs `payload`/`payload_field` from the extract-cmd partial.
navori_can_ask() {
  case "$0" in
    *".codex/hooks/"* | *".codex/scripts/"*) return 1 ;;
  esac
  command -v jq >/dev/null 2>&1 || return 1
  [ "$(payload_field hook_event_name)" = "PreToolUse" ]
}
