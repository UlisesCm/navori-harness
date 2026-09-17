#!/usr/bin/env bash
#
# PreToolUse(Bash): a call that PUBLISHES a comment or review — `gh pr/issue
# comment`, `gh pr review` with a body, `gh api` writing to a comments/reviews
# endpoint or a GraphQL comment mutation, `acli jira workitem comment
# create|update` — is raised to a user confirmation, with the draft's own text
# shown in the reason (R10, R11).
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
# any row's verb ("comment", "review") or `gh api`'s own name — so its absence
# proves no row can match, the same argument `gate-trigger.sh` makes for its
# own regex.
TRIGGER_RE='^gh[[:space:]]+(pr|issue)[[:space:]]+comment([[:space:]]|$)|^gh[[:space:]]+pr[[:space:]]+review([[:space:]]|$)|^gh[[:space:]]+api([[:space:]]|$)|^acli[[:space:]]+jira[[:space:]]+workitem[[:space:]]+comment[[:space:]]+(create|update)([[:space:]]|$)'
TRIGGER_TOKENS='comment review api'
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
navori_audit_reason="el comando no publica un comentario ni una review"
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
BOUND='(^|[;&|]|[[:space:]])'

nv_kind=""
if printf '%s' "$cmd" | grep -qE "${BOUND}gh[[:space:]]+(pr|issue)[[:space:]]+comment([[:space:]]|\$)"; then
  nv_kind="gh-comment"
elif printf '%s' "$cmd" | grep -qE "${BOUND}gh[[:space:]]+pr[[:space:]]+review([[:space:]]|\$)"; then
  nv_kind="gh-review"
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
  gh-api)
    if printf '%s' "$cmd" | grep -qE "${BOUND}graphql([[:space:]]|\$)"; then
      nv_label="a GitHub GraphQL comment/review mutation"
      # `query` only classifies the call; the six `add*` and the four
      # `update*` mutations are what makes it a write (R10, R11).
      printf '%s' "$cmd" | grep -qE '(^|[^A-Za-z])add(Comment|DiscussionComment|PullRequestReview|PullRequestReviewComment|PullRequestReviewThread|PullRequestReviewThreadReply)([^A-Za-z]|$)|(^|[^A-Za-z])update(IssueComment|DiscussionComment|PullRequestReview|PullRequestReviewComment)([^A-Za-z]|$)' \
        || exit 0
      nv_kind="gh-api-graphql"
    else
      nv_label="a GitHub API comment/review write"
      nv_writeish=0
      printf '%s' "$cmd" | grep -qE '(-X|--method)[[:space:]=]+(POST|PATCH|PUT)' && nv_writeish=1
      printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-f|-F|--input)([[:space:]=]|$)' && nv_writeish=1
      [ "$nv_writeish" = 1 ] || exit 0
      printf '%s' "$cmd" | grep -qE '/(comments|reviews)([[:space:]/]|$)' || exit 0
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

# --- Locate the flag value for a small set of alternatives (`-F|--body-file`,
# `--body-adf`, `--input`, …). Reads the WHOLE $cmd, so it only ever targets a
# flag whose VALUE is a file path — never a body carried inline in the command,
# which the codebase's own compound-command splitters (`gate-trigger.sh`) do
# not respect quoting for either; a file path does not contain `;`/`|`/`&&` in
# practice, so this stays safe where the inline case (never read this way)
# would not be.
nv_flag_value() {
  local text="$1" flags="$2" raw
  raw=$(printf '%s' "$text" | grep -oE "(^|[[:space:]])(${flags})(=|[[:space:]]+)('[^']*'|\"[^\"]*\"|[^[:space:]]+)" | head -1) || true
  [ -n "$raw" ] || return 0
  printf '%s' "$raw" | sed -E "s/^[[:space:]]*(${flags})(=|[[:space:]]+)//; s/^['\"]//; s/['\"]\$//"
}

nv_looks_like_json() {
  local t="${1#"${1%%[![:space:]]*}"}"
  case "$t" in
    "{"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Reads a bounded prefix of $1 into $nv_body_content. Returns 1 (never aborts
# under `set -e` — always called from an `if`/`||`) when the path is not a
# readable regular file, which is what R12 means by "cannot read the body".
nv_read_body() {
  # NOT named `path`: that identifier is zsh's special array aliased to
  # `$PATH` (`man zshparam`), so a plain `local path=…` silently collapses the
  # function's own command lookup to whatever was assigned — every builtin
  # call after it (here, `head`) then fails with "command not found". Caught
  # by the bash×zsh differential suite (#391), same class as the `$'\n'` and
  # unquoted-`for` pitfalls the shared partials already document.
  local nv_target="$1"
  [ -n "$nv_target" ] && [ "$nv_target" != "-" ] && [ -f "$nv_target" ] && [ -r "$nv_target" ] || return 1
  nv_body_content=$(head -c 200000 -- "$nv_target" 2>/dev/null) || return 1
  return 0
}

# ADF (Atlassian Document Format) is a JSON tree; only its `text` leaves are
# shown, and `query` (GraphQL's OWN document) is never treated as one — R11.
nv_adf_text_from_file() {
  if [ "$nv_have_jq" = 1 ]; then
    jq -r '[.. | .text? // empty] | join(" ")' "$1" 2>/dev/null
    return 0
  fi
  node -e '
const fs = require("fs");
try {
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const out = [];
  const walk = (n) => {
    if (n && typeof n === "object") {
      if (typeof n.text === "string") out.push(n.text);
      for (const k in n) walk(n[k]);
    }
  };
  walk(data);
  process.stdout.write(out.join(" "));
} catch (e) {
  /* leave stdout empty; the caller falls back to the raw file content */
}
' "$1" 2>/dev/null
  return 0
}

nv_gql_body_from_input() {
  if [ "$nv_have_jq" = 1 ]; then
    jq -r '(.variables.body // .body // empty)' "$1" 2>/dev/null
    return 0
  fi
  node -e '
const fs = require("fs");
try {
  const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const b = (d.variables && d.variables.body) || d.body || "";
  process.stdout.write(String(b));
} catch (e) {}
' "$1" 2>/dev/null
  return 0
}

# Caps a preview at 1,500 characters, with the count of what was cut — R11.
nv_truncate() {
  local text="$1" max=1500 len=${#1}
  if [ "$len" -gt "$max" ]; then
    # `$max`, NOT the bare name: zsh's `${text:0:max}` reads `max` as the
    # START of a history-modifier list (`:m…`) instead of a length variable —
    # `unrecognized modifier 'm'` — where bash resolves it as arithmetic. The
    # `$`-prefixed form is unambiguous, and identical, in both shells.
    printf '%s\n[+%d caracteres omitidos]' "${text:0:$max}" "$((len - max))"
  else
    printf '%s' "$text"
  fi
}

nv_body_source="none"
nv_body_path=""
nv_sniff_adf=0
nv_force_adf=0

case "$nv_kind" in
  gh-comment | gh-review)
    nv_body_path=$(nv_flag_value "$cmd" '-F|--body-file')
    if [ -n "$nv_body_path" ] && [ "$nv_body_path" != "-" ]; then
      nv_body_source="file"
    elif printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-b|--body)([[:space:]=]|$)'; then
      nv_body_source="inline"
    fi
    ;;
  gh-api-graphql)
    nv_body_path=$(printf '%s' "$cmd" | grep -oE -- '-F[[:space:]]+body=@[^[:space:]]+' | head -1 | sed -E 's/^-F[[:space:]]+body=@//')
    if [ -n "$nv_body_path" ]; then
      nv_body_source="file"
    elif printf '%s' "$cmd" | grep -qE -- '-f[[:space:]]+body=[^[:space:]]+'; then
      nv_body_source="inline"
    else
      nv_input=$(nv_flag_value "$cmd" '--input')
      if [ -n "$nv_input" ] && [ "$nv_input" != "-" ] && nv_read_body "$nv_input"; then
        nv_gql_text=$(nv_gql_body_from_input "$nv_input")
        if [ -n "$nv_gql_text" ]; then
          nv_body_source="gql-text"
        fi
      fi
    fi
    ;;
  gh-api-rest)
    nv_body_path=$(nv_flag_value "$cmd" '--input')
    if [ -z "$nv_body_path" ]; then
      nv_body_path=$(printf '%s' "$cmd" | grep -oE -- '-F[[:space:]]+[A-Za-z0-9_]+=@[^[:space:]]+' | head -1 | sed -E 's/^-F[[:space:]]+[A-Za-z0-9_]+=@//')
    fi
    if [ -n "$nv_body_path" ] && [ "$nv_body_path" != "-" ]; then
      nv_body_source="file"
    fi
    ;;
  acli-create)
    nv_body_path=$(nv_flag_value "$cmd" '-F|--body-file')
    if [ -n "$nv_body_path" ]; then
      nv_body_source="file"
      nv_sniff_adf=1
    elif printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-b|--body)([[:space:]=]|$)'; then
      nv_body_source="inline"
    fi
    ;;
  acli-update)
    nv_body_path=$(nv_flag_value "$cmd" '--body-adf')
    if [ -n "$nv_body_path" ]; then
      nv_body_source="file"
      nv_force_adf=1
    else
      nv_body_path=$(nv_flag_value "$cmd" '-F|--body-file')
      if [ -n "$nv_body_path" ]; then
        nv_body_source="file"
        nv_sniff_adf=1
      elif printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-b|--body)([[:space:]=]|$)'; then
        nv_body_source="inline"
      fi
    fi
    ;;
esac

nv_reason=""
case "$nv_body_source" in
  inline)
    # R11: never re-derive the value (it might carry `;`/`|`/newlines the
    # compound-command scan above does not respect quoting for); the reason
    # just points back at the command the host already shows the user.
    nv_reason="[navori] this call publishes $nv_label. Its body is inline in the command above — review it there before confirming."
    ;;
  gql-text)
    nv_preview=$(nv_truncate "$nv_gql_text")
    nv_reason="[navori] this call publishes $nv_label. \`body\` variable:

$nv_preview"
    ;;
  file)
    if nv_read_body "$nv_body_path"; then
      nv_text="$nv_body_content"
      if [ "$nv_force_adf" = 1 ] || { [ "$nv_sniff_adf" = 1 ] && nv_looks_like_json "$nv_body_content"; }; then
        nv_adf_text=$(nv_adf_text_from_file "$nv_body_path")
        [ -n "$nv_adf_text" ] && nv_text="$nv_adf_text"
      fi
      nv_preview=$(nv_truncate "$nv_text")
      nv_reason="[navori] this call publishes $nv_label from file '$nv_body_path':

$nv_preview"
    else
      nv_reason="$NV_FALLBACK_REASON"
    fi
    ;;
  *)
    nv_reason="$NV_FALLBACK_REASON"
    ;;
esac

navori_audit_reason="$nv_body_source"

if [ "$nv_have_jq" = 1 ]; then
  jq -cn --arg d "$nv_decision" --arg r "$nv_reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
else
  NV_D="$nv_decision" NV_R="$nv_reason" node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:process.env.NV_D,permissionDecisionReason:process.env.NV_R}}))'
fi
exit 0
