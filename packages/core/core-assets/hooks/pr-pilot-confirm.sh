#!/usr/bin/env bash
#
# PreToolUse(Bash): a `gh pr create` that did NOT come from the
# `commit-pr-pilot` is raised to a user confirmation.
#
# WHY (#705): the pilot is the single owner of commit+PR, and it is invoked on
# 15% of the PRs this harness opens. The rate is not uniform — one park repo
# runs at 48%, and the repo that PUBLISHES the pilot sat at 0 of 101. The
# confound was checked and does not hold: in the sessions where subagents were
# demonstrably available and used, the pilot was still never called. The pilot
# is not skipped; its antechamber is never entered, because `gh pr create` falls
# out of whatever the main agent was already doing and nothing interrupts it.
#
# So this hook interrupts, and does no more than that. It does NOT block: a
# session where the operator forbids subagents has no way to reach the pilot,
# and a hook that made PRs impossible there would be worse than the deviation it
# corrects. `ask` keeps the decision with the human while removing the one thing
# measured to fail — a layer that only suggests.
set -euo pipefail

# Command extraction (payload → $cmd). Shared body, single source of truth.
# navori:include extract-cmd

# Gate to `gh pr create` only. $TRIGGER_RE is consumed by the shared detector
# inlined below, which splits compound commands on && || ; | and matches at a
# segment START — so `git push … && gh pr create …` is caught and an
# `echo "gh pr create"` is not.
TRIGGER_RE='^gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'
# Literal substring every branch of $TRIGGER_RE needs, read by the fast path in
# the shared detector (spec 0016). `create` rather than `gh`: both are necessary
# conditions, and the rarer one skips the fork on more commands. Keep NEXT to
# the regex — a branch added there without its token here loses the shortcut.
TRIGGER_TOKENS='create'
# navori:include gate-trigger

# THE CHEAP GATE, and it comes before everything that costs a process.
#
# This hook fires on EVERY Bash call and does real work on almost none of them,
# and until this line it paid for that privilege twice: `extract_cmd` forks jq
# (or node) to read the command, and the `skip` record forks jq again to write
# "I ran and it was not a PR". Measured on a `git status` payload: 24.8 ms per
# Bash call, half of the ~48 ms that already forced `audit-log.sh` to be
# redesigned.
#
# `has_trigger_token` answers from the payload navori already has in memory,
# with no fork at all, and its answer is a proof rather than a guess: the
# command is a substring of the payload, and JSON escaping cannot break a token
# apart. No token in the payload → no segment can match → nothing here concerns
# this hook.
#
# WHAT IS GIVEN UP: the `skip` record for those calls. It says "the hook ran and
# the command was not a PR" — 99.9% of its firings — and it cost two forks to
# produce. Every record that carries information (`ask`, `allow`) is still
# written below. Same trade as #696, for the same reason.
has_trigger_token "${payload:-}" || exit 0

cmd=$(extract_cmd)

navori_audit_name="pr-pilot-confirm"
navori_audit_phase="PreToolUse"
navori_audit_tool="Bash"
# Fail-open no-ops, overwritten by the real definitions the include brings in.
# Same contract as the sibling gates: a recorder may never kill what it observes.
navori_audit_begin() { :; }
navori_audit_log() { :; }
# navori:include audit-log
navori_audit_begin

# The verdict is derived once, in a trap, rather than by a call per branch —
# this fires on EVERY Bash call and does real work on almost none of them.
navori_audit_verdict="skip"
navori_audit_reason="el comando no abre un PR"
navori_audit_on_exit() {
  navori_audit_log "$navori_audit_verdict" "$navori_audit_reason" || true
  return 0
}
trap navori_audit_on_exit EXIT

# An EMPTY $cmd means nothing could be read from the tool input, not "some
# command that isn't a PR". Unlike the quality gate, the fail-open direction
# here is to stay quiet: this hook's worst case is a false confirmation prompt
# on every Bash call, which would train the user to dismiss it unread — and a
# prompt nobody reads is worth less than no prompt at all.
[ -n "$cmd" ] || exit 0
is_scan_trigger "$cmd" || exit 0

# Who is running it. Inside a subagent the host sends a real `agent_id` on the
# tool phases; the main thread sends none. Measured over the park's audit logs:
# 10,879 events carried a real id and every one of them resolved to a subagent.
#
# Read HERE, not at the top: `payload_field` may spawn a process, and by this
# line we already know the command is the rare one that needs the answer.
#
# It names SOME subagent, not specifically the pilot — a `researcher` opening a
# PR would pass. That is deliberate: this is a routing nudge, not a security
# boundary, and the detector cannot see through `sh -c` either.
navori_pr_agent=$(payload_field agent_id)
[ -n "$navori_pr_agent" ] || navori_pr_agent=$(payload_field subagent_id)
if [ -n "$navori_pr_agent" ]; then
  navori_audit_verdict="allow"
  navori_audit_reason="el PR viene de un subagente"
  exit 0
fi

navori_audit_verdict="ask"
navori_audit_reason="PR abierto fuera del commit-pr-pilot"

# `ask` routes the call to the user instead of resolving it. The reason is what
# they read, so it says what the pilot adds and how to get it — a prompt that
# only says "are you sure" is a tax, not a routing signal.
#
# jq builds it: the reason travels inside JSON and a hand-rolled string would
# break on the first quote. No jq (not preinstalled on macOS) → stay silent
# rather than emit malformed JSON, which the host rejects with a wall of schema
# text that teaches the user to ignore this hook.
command -v jq >/dev/null 2>&1 || exit 0

# The message lands in its own assignment rather than inline in the jq call.
# A heredoc nested inside `"$( ... )"` is parsed by the shell BEFORE the quoted
# delimiter takes effect for the outer context, so the apostrophe in "repo's"
# and the backticks around `gh pr create` opened quotes that were never closed
# and the file failed `bash -n` outright. Caught by the syntax check; it would
# have shipped a hook that cannot run to every repo in the park.
navori_pr_reason=$(cat <<'MSG'
[navori] this `gh pr create` does not come from the commit-pr-pilot.

The pilot is the single owner of commit+PR: it applies the title/body format
this repo uses and runs the git/gh pre-flight before opening anything.

Delegate it with the Agent tool (subagent_type: commit-pr-pilot), or confirm to
open this PR by hand — a rollout PR, a revert, or a session where subagents are
unavailable are all legitimate reasons to do so.
MSG
)

jq -cn --arg reason "$navori_pr_reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$reason}}'
exit 0
