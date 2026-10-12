#!/usr/bin/env bash
#
# PreToolUse(Bash): a call that PUBLISHES a comment/review or creates a GitHub
# issue — `gh pr/issue comment`, `gh pr review` with a body, `gh issue create`,
# `gh api` writing to comments/reviews/issues or a GraphQL mutation, or
# `acli jira workitem comment create|update` — is raised to user confirmation,
# with the draft's own text shown in the reason (R10, R11, R43).
#
# WHY (spec 0026 E1): a hook is the only layer that forces the human to look at
# what is about to be posted publicly. `--body-file`/`-F` never show the
# content in the tool call itself, so a review approved a stale draft, and an
# agent-composed PR comment shipped unread more than once in this park.
#
# Applies to ANY agent, including the main thread, and is registered in BOTH
# engines without depending on which plugins are enabled (R10). Claude gets
# `ask` — the two-sided guarantee: the hook FORCES the prompt in auto mode, and
# the reason is what the human actually reads before confirming. Codex parses
# `permissionDecision` but does not support `"ask"` yet (marks the hook run
# failed and lets the tool call through), so the SAME script returns `deny`
# there instead (R13) — decided by `$0`, since `placeHook` does not transform
# Codex hooks (`engines/codex/index.ts:254-261`).
set -euo pipefail

# Command extraction (payload → $cmd). Shared body, single source of truth.
# navori:include extract-cmd

# Gate is broad on purpose: is-it-worth-a-fork, not is-it-the-exact-row. The
# per-row classification below reads $cmd directly once we are already on the
# slow path. $TRIGGER_TOKENS lists the literal substring EVERY branch needs —
# any row's verb ("comment", "review", "create") or `gh api`'s own name — so its absence
# proves no row can match, the same argument `gate-trigger.sh` makes for its
# own regex.
TRIGGER_RE='^gh[[:space:]]+(pr|issue)[[:space:]]+comment([[:space:]]|$)|^gh[[:space:]]+pr[[:space:]]+review([[:space:]]|$)|^gh[[:space:]]+api([[:space:]]|$)|^acli[[:space:]]+jira[[:space:]]+workitem[[:space:]]+comment[[:space:]]+(create|update)([[:space:]]|$)'
TRIGGER_TOKENS='comment review api create'
# navori:include gate-trigger

# THE CHEAP GATE — before anything that costs a process. This fires on EVERY
# Bash call and does real work on almost none of them: `payload_field` forks
# jq/node to read the command, so proving absence from the in-memory payload
# first (no fork at all) is what keeps an unrelated `git status` free. Same
# trade as `pr-publisher-confirm.sh` (#705).
has_trigger_token "${payload:-}" || exit 0

cmd=$(extract_cmd)

navori_audit_name="comment-draft-confirm"
navori_audit_phase="PreToolUse"
navori_audit_tool="Bash"
navori_audit_begin() { :; }
navori_audit_log() { :; }
# navori:include audit-repo
# navori:include audit-log
navori_audit_begin

navori_audit_verdict="skip"
navori_audit_reason="el comando no publica un comentario, una review ni un issue"
navori_audit_on_exit() {
  navori_audit_log "$navori_audit_verdict" "$navori_audit_reason" || true
  return 0
}
trap navori_audit_on_exit EXIT

# An EMPTY $cmd means nothing could be read from the tool input, not "some
# command that is not a comment". Same fail-open direction as `pr-publisher-confirm`:
# the worst case here is a false confirmation prompt on every Bash call.
[ -n "$cmd" ] || exit 0

# Boundary so a compound command (`cd x && gh pr comment …`) is still caught —
# this scans the WHOLE command text, not a wrapper-peeled segment, so it is a
# seatbelt (per the sibling hooks' own limitation), not a sandbox: it cannot
# see through `sh -c`/`eval`, and a value that happens to repeat another row's
# verb in an unrelated place could misclassify. Body VALUES are never read out
# of this scan when they might contain the separators it does not respect
# (`;`, `|`) — only a FILE PATH (never containing them in practice) is
# extracted this way; an inline body is only ever detected as PRESENT, never
# read for content (see "inline" branch below).
BOUND='(^|[;&|(`]|[[:space:]])'

nv_kind=""
if printf '%s' "$cmd" | grep -qE "${BOUND}gh[[:space:]]+(pr|issue)[[:space:]]+comment([[:space:]]|\$)"; then
  nv_kind="gh-comment"
elif printf '%s' "$cmd" | grep -qE "${BOUND}gh[[:space:]]+pr[[:space:]]+review([[:space:]]|\$)"; then
  nv_kind="gh-review"
elif printf '%s' "$cmd" | grep -qE "${BOUND}gh[[:space:]]+issue[[:space:]]+create([[:space:]]|\$)"; then
  nv_kind="gh-issue-create"
elif printf '%s' "$cmd" | grep -qE "${BOUND}gh[[:space:]]+api([[:space:]]|\$)"; then
  nv_kind="gh-api"
elif printf '%s' "$cmd" | grep -qE "${BOUND}acli[[:space:]]+jira[[:space:]]+workitem[[:space:]]+comment[[:space:]]+create([[:space:]]|\$)"; then
  nv_kind="acli-create"
elif printf '%s' "$cmd" | grep -qE "${BOUND}acli[[:space:]]+jira[[:space:]]+workitem[[:space:]]+comment[[:space:]]+update([[:space:]]|\$)"; then
  nv_kind="acli-update"
fi
[ -n "$nv_kind" ] || exit 0

# --- Row-specific applicability + label ("does this row actually publish?") --
nv_label=""
case "$nv_kind" in
  gh-comment)
    nv_label="a GitHub PR/issue comment"
    ;;
  gh-review)
    nv_label="a GitHub PR review comment"
    # Only "with a body" (R10's table row): `-a`/`--approve` alone with no `-b`
    # or `-F` is not publishing prose anyone needs to preview.
    printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-c|--comment|-a|--approve|-r|--request-changes)([[:space:]]|$)' \
      || exit 0
    printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-b|--body|-F|--body-file)([[:space:]=]|$)' \
      || exit 0
    ;;
  gh-issue-create)
    nv_label="a GitHub issue"
    ;;
  gh-api)
    if printf '%s' "$cmd" | grep -qE "${BOUND}graphql([[:space:]]|\$)"; then
      nv_label="a GitHub GraphQL comment/review mutation"
      # `query` only classifies the call; the six `add*` and the four
      # `update*` mutations are what makes it a write (R10, R11).
      printf '%s' "$cmd" | grep -qE '(^|[^A-Za-z])(createIssue|add(Comment|DiscussionComment|PullRequestReview|PullRequestReviewComment|PullRequestReviewThread|PullRequestReviewThreadReply)|update(IssueComment|DiscussionComment|PullRequestReview|PullRequestReviewComment))([^A-Za-z]|$)' \
        || exit 0
      if printf '%s' "$cmd" | grep -qE '(^|[^A-Za-z])createIssue([^A-Za-z]|$)'; then
        nv_label="a GitHub issue"
      fi
      nv_kind="gh-api-graphql"
    else
      nv_label="a GitHub API comment/review write"
      nv_writeish=0
      nv_method=$(printf '%s' "$cmd" | grep -oE '(-X|--method)[[:space:]=]+(GET|POST|PATCH|PUT|DELETE)' | head -1) || true
      printf '%s' "$nv_method" | grep -qE '(POST|PATCH|PUT)$' && nv_writeish=1
      if [ -z "$nv_method" ]; then
        printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-f|-F|--input)([[:space:]=]|$)' && nv_writeish=1
      fi
      [ "$nv_writeish" = 1 ] || exit 0
      if printf '%s' "$cmd" | grep -qE "/?repos/[^/[:space:]]+/[^/[:space:]]+/issues([[:space:]?\"']|$)"; then
        printf '%s' "$nv_method" | grep -qE '(PATCH|PUT)$' && exit 0
        nv_label="a GitHub issue"
      else
        printf '%s' "$cmd" | grep -qE '/(comments|reviews)([[:space:]/]|$)' || exit 0
      fi
      nv_kind="gh-api-rest"
    fi
    ;;
  acli-create)
    nv_label="a Jira comment"
    ;;
  acli-update)
    nv_label="a Jira comment edit"
    ;;
esac

# `$0`, not the payload: Codex does not transform hook commands
# (`engines/codex/index.ts:254-261`), so the SAME script decides its own
# output shape by where it was installed. This applies whether or not a
# parser is on PATH — the `deny` fallback below is unconditional (R13).
case "$0" in
  *".codex/hooks/"*) nv_decision="deny" ;;
  *) nv_decision="ask" ;;
esac

# R12's fixed reason. Deliberately free of `"`, `\` and control characters —
# it is the ONLY string the printf-only tier below ever emits, so it must be
# safe to embed in JSON by construction, with no escaping step to trust.
NV_FALLBACK_REASON="[navori] this call publishes $nv_label and its draft could not be read or rendered (no readable body, or no jq/node on PATH to parse it). Review the exact command above before confirming."

nv_have_jq=0
command -v jq >/dev/null 2>&1 && nv_have_jq=1
nv_have_node=0
command -v node >/dev/null 2>&1 && nv_have_node=1

navori_audit_verdict="$nv_decision"

# No parser at all → R12 prevails over any partial reading we could still do
# with plain shell tools: never emit a hand-built JSON string carrying
# arbitrary draft content without jq/node to escape it.
if [ "$nv_have_jq" = 0 ] && [ "$nv_have_node" = 0 ]; then
  navori_audit_reason="sin jq ni node: razón fija (R12)"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' \
    "$nv_decision" "$NV_FALLBACK_REASON"
  exit 0
fi

# navori:include draft-body
navori_draft_body

navori_audit_reason="$nv_body_source"

# Spec 0048 D5 (R5): a Pi copy (decided by `$0`, like the Codex arm above) also names the file the
# draft was read from in the top-level `navoriBodyFiles`, a key Claude never sees. The Pi extension
# hashes it when it shows the confirmation and again right before allowing the call, so a body edited
# in between is refused.
nv_pi_files=0
case "$0" in
  *"/.pi/navori/"*) [ -z "$nv_bound_file" ] || nv_pi_files=1 ;;
esac

if [ "$nv_have_jq" = 1 ]; then
  jq -cn --arg d "$nv_decision" --arg r "$nv_reason" --arg f "$nv_pi_files:$nv_bound_file" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}
      + (if ($f | startswith("1:")) then {navoriBodyFiles: [$f[2:]]} else {} end)'
else
  NV_D="$nv_decision" NV_R="$nv_reason" NV_F="$nv_pi_files:$nv_bound_file" node -e 'const out={hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:process.env.NV_D,permissionDecisionReason:process.env.NV_R}};if(process.env.NV_F.startsWith("1:"))out.navoriBodyFiles=[process.env.NV_F.slice(2)];process.stdout.write(JSON.stringify(out))'
fi
exit 0
