#!/usr/bin/env bash
#
# PreToolUse(WebFetch|WebSearch) guard — the web half of "never send the user's personal data
# to an external service" (#1445). The Bash half is a lane inside `guard-destructive`
# (spec 0039 R28 forbids a second hook on the Bash path); both share
# `_partials/pii-egress.sh`, which holds the identifiers, the matching, the never-echo rule and
# the failure contract. Blocks with `exit 2` + stderr, the channel `guard-destructive` uses,
# evaluated BEFORE permission rules.
#
# "NETWORK REQUEST TO AN EXTERNAL HOST".
#   - WebFetch: the host of `tool_input.url`; only the URL is inspected (`prompt` goes to the
#     model provider, not to the destination). A local or private host is allowed.
#   - WebSearch: always external; `tool_input.query` is inspected.
# Registered on Claude only: Codex's hosted web search has no hook event and Pi has no such tool.
#
# FAILURE CONTRACT. Not a web tool call, or no identifier resolvable → exit 0 with no fork.
# After the network gate matches, the check runs in a subshell and any error DENIES (exit 2,
# "could not verify"). One deliberate fail-OPEN: a host without `jq`/`node` where the sed
# fallback misses a field.
# Blocking classification (#1117): an identifier in a request to an external host is hard (personal
# data leaving the machine cannot be recalled; route: a generic identifier); a check that could
# not complete after the gate matched is hard (fail closed, nothing was verified).
set -euo pipefail

# Payload → $payload (shared body); fields are read below, only past the gate.
nv_payload_fields="tool_input.command tool_input.query tool_input.url tool_name"
# navori:include extract-cmd

navori_audit_name="pii-egress-guard"
navori_audit_phase="PreToolUse"
# Fallback no-ops, overwritten by the real definitions the includes bring in.
# FAIL-OPEN: an undefined function under `set -e` would be exit 127.
navori_audit_begin() { :; }
navori_audit_log() { :; }
# navori:include audit-repo
# navori:include audit-log
# navori:include pii-egress
navori_audit_begin

navori_audit_verdict="allow"
navori_audit_reason=""
navori_audit_on_exit() {
  navori_audit_log "$navori_audit_verdict" "$navori_audit_reason" || true
  return 0
}
trap navori_audit_on_exit EXIT

# THE CHEAP GATE: fork-free, on every call this hook is wired to.
case "$payload" in
  *'"WebFetch"'* | *'"WebSearch"'*) ;;
  *)
    navori_audit_verdict="skip"
    navori_audit_reason="no network gate"
    exit 0
    ;;
esac

# Exit 0 allow · 41 hit on git user.email · 42 hit on NAVORI_PERSONAL_IDS ·
# anything else: could not verify.
pii_web_check() {
  set -euo pipefail
  local navori_tool="" navori_url="" navori_query=""
# Column 0 on purpose: hook-matcher-wiring reads this line to derive the tools the case below accepts.
payload_fields navori_tool=tool_name navori_url=tool_input.url navori_query=tool_input.query
  local _texts=""
  case "$navori_tool" in
    WebFetch)
      [ -n "$navori_url" ] || exit 0
      _pii_local "${navori_url#*://}" && exit 0
      _texts="$navori_url"
      ;;
    WebSearch)
      [ -n "$navori_query" ] || exit 0
      _texts="$navori_query"
      ;;
    *) exit 0 ;;
  esac
  navori_pii_verdict "$_texts"
}

# Everything past the gate runs in a subshell with `set -e` on and the outer
# `set +e`, so ANY failure inside is a status the contract maps to a deny.
set +e
( pii_web_check )
navori_pii_rc=$?
set -e

navori_pii_finish "$navori_pii_rc"
navori_audit_verdict="allow"
navori_audit_reason="no identifier in an external request"
exit 0
