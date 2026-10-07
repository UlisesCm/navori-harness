# navori:managed start id="comment-draft-confirm-base" hash="291efa1c" version="0.11.2" source="@navori/core"
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
# Shared hook boilerplate — inlined into each hook at render time (see the
# include directive in the source scripts + lib/render/hook-includes.ts). Single source
# of truth for the sibling gate scripts; DO NOT copy this body back into a hook
# by hand (that is the drift #225/#261 removed).
#
# PreToolUse(Bash) passes the tool input on stdin. Read one field out of it
# WITHOUT hard-depending on jq (NOT preinstalled on macOS): try jq, then node
# (Claude Code's own runtime), then a best-effort sed unwrap on the leaf key.
# Nothing extracted → empty output, and each caller decides what that means (the
# gate scripts scan defensively; guard-destructive waves the command through).
#
# $1 is a dotted path written HERE, never user input — the payload is the data.
# Generic on purpose: `.cwd` feeds the worktree resolver of #454 through the
# SAME hardened cascade instead of a second copy of it.
#
# The sed fallback reads a JSON string through its first unescaped quote. JSON
# object member order is not a host contract: `command` can precede `cwd`, so a
# greedy capture to the last quote would swallow the rest of the payload when
# neither jq nor node is available.
# `${payload-$(cat)}` (unset test, not `:-`) rather than an unconditional
# `payload=$(cat)`: a caller that already captured stdin itself (spec 0035 —
# `managed-drift-watch.sh` needs the audit recorder's session_id/cwd even on
# tool names this hook does not otherwise read) keeps that value, empty or
# not, instead of this partial re-reading an already-drained pipe and
# clobbering it with "".
payload=${payload-$(cat)}
payload_field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -r ".$1 // empty" 2>/dev/null && return 0
  fi
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$payload" | node -e 'let s="";const p=process.argv[1].split(".");process.stdin.on("data",c=>s+=c).on("end",()=>{try{let v=JSON.parse(s);for(const k of p)v=v?.[k];process.stdout.write(String(v??""))}catch{}})' "$1" 2>/dev/null && return 0
  fi
  printf '%s' "$payload" | sed -nE "s/.*\"${1##*.}\"[[:space:]]*:[[:space:]]*\"(([^\"\\]|\\.)*)\".*/\\1/p"
}
extract_cmd() {
  payload_field tool_input.command
}
# NOT called here on purpose. `payload_field` may spawn a process, and
# `routing-watch.sh` — which includes this partial and runs after EVERY tool call
# in every session — never reads `cmd`. Each consumer that wants it calls
# `extract_cmd` itself, at the point where it already knows it needs it.

# Gate is broad on purpose: is-it-worth-a-fork, not is-it-the-exact-row. The
# per-row classification below reads $cmd directly once we are already on the
# slow path. $TRIGGER_TOKENS lists the literal substring EVERY branch needs —
# any row's verb ("comment", "review", "create") or `gh api`'s own name — so its absence
# proves no row can match, the same argument `gate-trigger.sh` makes for its
# own regex.
TRIGGER_RE='^gh[[:space:]]+(pr|issue)[[:space:]]+comment([[:space:]]|$)|^gh[[:space:]]+pr[[:space:]]+review([[:space:]]|$)|^gh[[:space:]]+api([[:space:]]|$)|^acli[[:space:]]+jira[[:space:]]+workitem[[:space:]]+comment[[:space:]]+(create|update)([[:space:]]|$)'
TRIGGER_TOKENS='comment review api create'
# Shared gate detector — inlined into each hook at render time (see the include
# directive in the source scripts + lib/render/hook-includes.ts). The caller MUST set
# $TRIGGER_RE (an ERE) before the include; it decides which git ops this hook
# gates. Single source of truth for the FIX B/C wrapper-peeling logic; DO NOT
# copy this body into a hook by hand.
#
# Detect whether $1 (a possibly-compound command) invokes a gated operation.
# Splits $1 on the shell separators && || ; | and newlines, strips leading
# whitespace plus wrapper words (`(`, `\`, `command `) and `VAR=value` env
# prefixes from each segment, and returns 0 if ANY segment STARTS with a gated
# `git …` invocation on a word boundary (matched by $TRIGGER_RE). Replaces
# literal-prefix `case` matching, which silently skipped the gate for
# `cd x && git commit`, `echo y; git push`, or a leading space (#88: NEVER skip
# the gate silently). Matching a segment START means a quoted `echo "git commit"`
# does NOT trigger it. Known limitation: it cannot see through `sh -c`, `eval`,
# or obfuscation — a seatbelt, not a sandbox.
#
# Heredoc bodies (#1095): when the caller sets TRIGGER_STRIP_HEREDOC_BODIES=1,
# the body of a `cat <<TAG … TAG` heredoc is DATA, not commands, so a
# `git commit` line inside e.g. a `gh issue create --body "$(cat <<'EOF' …`
# no longer counts. It is an ALLOW-list on purpose: only a `cat` heredoc (bare,
# or inside `$(…)` of gh/git/echo/printf) with nothing chained after it is
# stripped; anything else — `bash <<EOF`, `while read c; do $c; done <<EOF`,
# `cat <<EOF | sh`, `python - <<EOF` — keeps its body, because a shell or
# interpreter may execute it. Opt-in because master-accept-confirm matches
# unanchored and must keep seeing bodies fed to a non-shell interpreter.
# The fast path on its own, so a caller can apply it EARLIER than the segment
# scan — before it has even paid to extract the command from the payload.
#
# Returns 0 when $1 may contain a gated operation, 1 when it provably cannot.
# The argument is the one the block below spells out: no $TRIGGER_RE can match
# without one of the caller's literal TOKENS appearing in the segment it
# matches, and every segment is a substring of the input. So the absence of
# every token is proof that no segment can match — and the same proof holds one
# level up, over the raw PAYLOAD the command was extracted from: JSON escaping
# touches `"`, `\` and control characters, never the letters of a token.
#
# Disarms when $TRIGGER_TOKENS is unset: with no tokens declared there is
# nothing to prove absent, so it answers "maybe" and the caller does the work.
# Fail-open to the SLOW path, never to a skip.
has_trigger_token() {
  [ -n "${TRIGGER_TOKENS:-}" ] || return 0
  # Token iteration goes through newline-split + `read`, NOT `for _tok in
  # $TRIGGER_TOKENS`: zsh does not word-split an unquoted expansion, so the
  # `for` form iterated ONCE with the whole list as a single token there — and
  # a token that can never match is a gate that never fires. Caught by the
  # bash×zsh differential suite.
  local _input="$1" _tok _nl=$'\n'
  local _toks="${TRIGGER_TOKENS// /$_nl}"
  while IFS= read -r _tok; do
    [ -n "$_tok" ] || continue
    case "$_input" in *"$_tok"*) return 0 ;; esac
  done <<< "$_toks"
  return 1
}

# Words that let a later part of a command re-enter git, the cwd or a shell.
# Text is reduced to alphanumeric words first, so `/usr/bin/git` and `(cd` match.
navori_mentions_shellish() {
  local t=" ${1//[!A-Za-z0-9_]/ } "
  case "$t" in
    *" git "*|*" cd "*|*" pushd "*|*" popd "*|*" sh "*|*" bash "*|*" zsh "*|*" dash "*|*" ksh "*) return 0 ;;
    *" env "*|*" eval "*|*" exec "*|*" command "*|*" builtin "*|*" source "*|*" xargs "*) return 0 ;;
  esac
  return 1
}

# Sets `navori_heredoc_stripped` to $1 minus the bodies (and terminators) of
# heredocs this hook may safely treat as data; the introducing line is KEPT, so
# `git commit -F - <<'EOF'` still triggers. Any doubt (second heredoc on the
# line, unterminated body, empty tag) leaves the text untouched: fail closed.
# All locals are declared once at the top: zsh prints a re-declared `local`.
navori_strip_heredoc_bodies() {
  local input="$1" line before rest seg pre pfirst tag after cmp="" out="" r=""
  local dash=0 inbody=0 tab=$'\t' nl=$'\n'
  navori_heredoc_stripped="$input"
  case "$input" in *'<<'*) ;; *) return 0 ;; esac
  while IFS= read -r line; do
    if [ "$inbody" = 1 ]; then
      cmp="$line"
      if [ "$dash" = 1 ]; then cmp="${cmp#"${cmp%%[!$tab]*}"}"; fi
      if [ "$cmp" = "$tag" ]; then inbody=0; fi
      continue
    fi
    out="$out$line$nl"
    case "$line" in *'<<'*) ;; *) continue ;; esac
    before="${line%%<<*}"
    rest="${line#*<<}"
    case "$rest" in '<'*) continue ;; esac                  # here-string: no body
    dash=0
    case "$rest" in -*) dash=1; rest="${rest#-}" ;; esac
    rest="${rest#"${rest%%[![:space:]]*}"}"
    tag=""; after=""
    case "$rest" in
      \'*) r="${rest#\'}"; case "$r" in *\'*) tag="${r%%\'*}"; after="${r#*\'}" ;; esac ;;
      \"*) r="${rest#\"}"; case "$r" in *\"*) tag="${r%%\"*}"; after="${r#*\"}" ;; esac ;;
      \\*) r="${rest#\\}"; tag="${r%%[!A-Za-z0-9_.-]*}"; after="${r#"$tag"}" ;;
      *) tag="${rest%%[!A-Za-z0-9_.-]*}"; after="${rest#"$tag"}" ;;
    esac
    [ -n "$tag" ] || continue
    # Nothing chained after the tag, and no second heredoc on the line.
    case "$after" in *'|'*|*';'*|*'&'*|*'<<'*) continue ;; esac
    # The word before `<<` must be `cat`. Inside `$(…)`/backticks the command
    # that receives cat's output must be a known data consumer, not an
    # interpreter (`bash -c "$(cat <<EOF`, `eval "$(cat <<EOF`).
    seg="$before"
    case "$before" in
      *'$('*) seg="${before##*\$\(}"; pre="${before%\$\(*}" ;;
      *'`'*) seg="${before##*\`}"; pre="${before%\`*}" ;;
      *) pre="" ;;
    esac
    if [ -n "$pre" ]; then
      pre="${pre##*&&}"; pre="${pre##*;}"; pre="${pre##*|}"
      pre="${pre#"${pre%%[![:space:]]*}"}"
      pfirst="${pre%%[[:space:]]*}"
      case "$pfirst" in gh|git|echo|printf) ;; *) continue ;; esac
    fi
    seg="${seg#"${seg%%[![:space:]]*}"}"
    case "$seg" in *'|'*|*';'*|*'&'*) continue ;; esac
    case "$seg" in cat|cat[[:space:]]*) ;; *) continue ;; esac
    inbody=1
  done <<< "$input"
  [ "$inbody" = 0 ] || return 0                             # unterminated: keep all
  navori_heredoc_stripped="$out"
  return 0
}

# Counts the segments of $1 that start with a gated op ($TRIGGER_RE); sets the
# global `navori_trigger_hits`. `$2` = 1 stops at the first hit (is_scan_trigger
# only needs "any"). The single home of the segment normalisation, shared with
# navori_commit_landing so the two can never disagree about what a segment is.
navori_count_triggers() {
  # Pre-expanded newline: zsh does NOT expand $'\n' in the REPLACEMENT of
  # ${var//pat/repl} (it inserts the literal characters), so an inline $'\n'
  # left compound commands unsplit there and the gate silently skipped
  # `cd x && git commit` (#391). A plain variable expands identically in
  # bash and zsh. ($'\n' in PATTERN position expands fine in both.)
  local input="$1" stop="${2:-0}" segment nl=$'\n'
  navori_trigger_hits=0
  if [ "${TRIGGER_STRIP_HEREDOC_BODIES:-}" = 1 ]; then
    case "$input" in *'<<'*) navori_strip_heredoc_bodies "$input"; input="$navori_heredoc_stripped" ;; esac
  fi
  # FIX B: join `\<newline>` continuations into a space FIRST, so a command
  # split across lines with a trailing backslash stays ONE logical segment
  # (otherwise the subcommand/flag lands in a segment not starting with git).
  input="${input//\\$'\n'/ }"
  input="${input//&&/$nl}"
  input="${input//||/$nl}"
  input="${input//;/$nl}"
  input="${input//|/$nl}"
  # `<<<` feeds the already-expanded value as data — no re-evaluation — so a
  # command that contains backticks/$() is inspected, never executed.
  while IFS= read -r segment; do
    segment="${segment#"${segment%%[![:space:]]*}"}"        # strip leading ws
    # FIX C: peel wrappers so `(git …`, `\git`, `command git …` and
    # `VAR=val git …` all reduce to a plain `git …` before matching.
    while [[ "$segment" == \(* ]]; do                       # strip leading ( runs
      segment="${segment#\(}"
      segment="${segment#"${segment%%[![:space:]]*}"}"
    done
    segment="${segment#\\}"                                 # strip a leading backslash (\git)
    while [[ "$segment" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do  # strip VAR=val prefixes
      case "$segment" in
        *[[:space:]]*)
          segment="${segment#*[[:space:]]}"
          segment="${segment#"${segment%%[![:space:]]*}"}"
          ;;
        *) segment=""; break ;;
      esac
    done
    if [[ "$segment" == command\ * ]]; then                 # strip a leading `command ` word
      segment="${segment#command }"
      segment="${segment#"${segment%%[![:space:]]*}"}"
    fi
    # FIX C: allow git global options between `git` and the subcommand
    # (`git -c k=v commit`, `git -C /repo push`). $TRIGGER_RE's trailing boundary
    # keeps `git commitgraph` / `git config …` from matching.
    if printf '%s' "$segment" | grep -qE "$TRIGGER_RE"; then
      navori_trigger_hits=$((navori_trigger_hits + 1))
      if [ "$stop" = 1 ]; then return 0; fi
    fi
  done <<< "$input"
  return 0
}

is_scan_trigger() {
  # ─── Fast path (spec 0016 T3.2, second pass): the segment loop pays one
  # `grep -qE` FORK per segment — and a heredoc body or a 40-step compound
  # is 40 segments, so the field cost scaled with command length (measured:
  # 2.8 ms trivial, 14.8 ms for a 199-char heredoc, 95.8 ms for 40 segments;
  # p50 across one real session's commands was 40 ms per hook, not the
  # trivial floor). No $TRIGGER_RE can match without one of the caller's
  # literal TOKENS appearing in the segment it matches — and every segment is
  # a substring of the input, transformed only by insertions (`\<NL>` → space,
  # separators → newline) and prefix-peeling, none of which can CREATE a
  # token. So a single in-process substring scan of the raw input is a strict
  # superset of the segment matches: if no token is present, no segment can
  # match, and the gate answers "not for me" without a single fork. Same
  # argument, same safe direction, as the guard's own fast path.
  #
  # $TRIGGER_TOKENS is set by the including hook NEXT TO its $TRIGGER_RE, so
  # the pair travels together; when unset the fast path disarms and the loop
  # runs exactly as before (fail-open to the SLOW path, never to a skip).
  has_trigger_token "$1" || return 1
  navori_count_triggers "$1" 1
  [ "$navori_trigger_hits" -gt 0 ]
}

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
# Shared audit repository resolver (#764) — inlined into every audit hook at
# render time. A nested agent worktree lives below the repository's
# `.claude/worktrees/` directory, but its basename is an ephemeral agent id.
#
# navori_audit_repo_from_cwd <cwd> — prints the stable parent repo name.
# This only uses shell builtins before the existing `basename` call: audit hooks
# run often, so discovering the Git common directory would add an avoidable fork
# per invocation.
navori_audit_repo_from_cwd() {
  navori_audit_repo_cwd=$1
  case "$navori_audit_repo_cwd" in
    */.claude/worktrees | */.claude/worktrees/*)
      navori_audit_repo_cwd=${navori_audit_repo_cwd%%/.claude/worktrees*}
      ;;
  esac
  basename "$navori_audit_repo_cwd" 2>/dev/null
}
# Shared advisory metadata recorder. The CLI is the single private-FD writer.
# No shell redirects, human content, or fallback writes are permitted here.
# Missing CLI or failed validation leaves an observation gap, never a hook failure.
# zsh replaces $0 with the function name; preserve the enclosing script identity.
navori_audit_script=$0
navori_audit_begin() {
  navori_audit_on=0
  navori_audit_root=${NAVORI_AUDITS_ROOT:-${HOME:-}/.navori/audits}
  [ -n "${HOME:-}${NAVORI_AUDITS_ROOT:-}" ] || return 0
  [ -d "$navori_audit_root" ] || return 0
  navori_audit_on=1
  navori_audit_t0=$(navori_audit_now)
}

navori_audit_now() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    # `1756... .123456` → milliseconds, with pure parameter expansion.
    navori_audit_epoch=${EPOCHREALTIME/,/.}
    printf '%s%s' "${navori_audit_epoch%%.*}" "$(printf '%.3s' "${navori_audit_epoch#*.}")"
    return 0
  fi
  perl -MTime::HiRes=time -e 'printf "%.0f", time*1000' 2>/dev/null \
    || printf '%s' $(( $(date +%s 2>/dev/null || echo 0) * 1000 ))
}

# Resolve one exact marker before invoking the metadata writer. Startup may
# offer a repo-scoped arm candidate; the CLI authoritatively validates private
# modes, ownership and header identity before either append or spool creation.
navori_audit_record_metadata() {
  [ -n "${payload:-}" ] || return 0
  navori_audit_root=${NAVORI_AUDITS_ROOT:-${HOME:-}/.navori/audits}
  [ -n "${HOME:-}${NAVORI_AUDITS_ROOT:-}" ] || return 0
  [ -d "$navori_audit_root" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  navori_audit_fields=$(printf '%s' "$payload" | jq -er '
    def id: type == "string" and length > 0 and length <= 256 and test("^[A-Za-z0-9_-]+$");
    select(.session_id | id) |
    [.session_id, (if (.cwd | type) == "string" then .cwd else "" end),
     ([.agent_id, .subagent_id] | map(select(id)) | first) // "orchestrator", "."] | .[]' 2>/dev/null) || return 0
  navori_audit_session=${navori_audit_fields%%
*}
  navori_audit_rest=${navori_audit_fields#*
}
  navori_audit_cwd=${navori_audit_rest%%
*}
  navori_audit_rest=${navori_audit_rest#*
}
  navori_audit_agent=${navori_audit_rest%%
*}
  [ -n "$navori_audit_cwd" ] || navori_audit_cwd=$PWD
  navori_audit_repo=$(navori_audit_repo_from_cwd "$navori_audit_cwd") || return 0
  case "$navori_audit_repo" in "" | . | .. | *[!A-Za-z0-9_.-]*) return 0 ;; esac
  navori_audit_file=$navori_audit_root/$navori_audit_repo/session-$navori_audit_session.log
  if [ ! -f "$navori_audit_file" ] || [ -L "$navori_audit_file" ]; then
    [ "${navori_audit_phase:-}" = SessionStart ] || return 0
    navori_audit_arm=$navori_audit_root/$navori_audit_repo/.armed
    [ -f "$navori_audit_arm" ] && [ ! -L "$navori_audit_arm" ] || return 0
  fi
  command -v navori >/dev/null 2>&1 || return 0
  case "${nv_engine:-}" in
    claude | codex) navori_audit_host=$nv_engine ;;
    *) case "$navori_audit_script" in *".codex/hooks/"* | *".codex/scripts/"*) navori_audit_host=codex ;; *) navori_audit_host=claude ;; esac ;;
  esac
  # The writer assigns eventId/wireVersion before first persistence. Replay
  # keeps those identifiers; this transport never generates replacement IDs.
  printf '%s' "$1" | navori audit --record-metadata --host "$navori_audit_host" \
    --root-session "$navori_audit_session" --repo "$navori_audit_repo" \
    --root "$navori_audit_root" >/dev/null 2>&1 || :
  return 0
}

# Only closed categories and bounded technical identifiers cross this bridge.
# Args: verdict, reason, kind. `reason` is recorded only when it is one of the
# allowlisted codes below (mirrored by HOOK_REASON_CODES in lib/audit/model.ts,
# pinned by a drift test); any other non-empty text is stored as "unspecified".
# `kind` defaults from the verdict (block -> hard, ask -> ask); `deny` stays
# explicit because the confirm hooks use it as deny-as-confirmation on Codex.
navori_audit_log() {
  [ "${navori_audit_on:-0}" = 1 ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  if [ "${NAVORI_AUDIT_SKIP_NOOPS:-0}" = 1 ]; then
    case "${1:-}" in skip | noop) return 0 ;; esac
  fi
  navori_audit_end=$(navori_audit_now)
  [ "$navori_audit_end" -ge 0 ] 2>/dev/null || navori_audit_end=0
  navori_audit_ms=$(( navori_audit_end - ${navori_audit_t0:-$navori_audit_end} ))
  [ "$navori_audit_ms" -ge 0 ] 2>/dev/null || navori_audit_ms=0
  navori_audit_metadata=$(printf '%s' "${payload:-}" | jq -c \
    --arg name "${navori_audit_name:-unknown}" --arg phase "${navori_audit_phase:-unknown}" \
    --arg verdict "${1:-unknown}" --arg reason "${2:-}" \
    --arg tool "${navori_audit_tool:-}" --arg source "${navori_audit_source:-core}" \
    --arg kind "${3:-}" --argjson ms "$navori_audit_ms" --argjson tsMs "$navori_audit_end" '
    def id: type == "string" and length > 0 and length <= 256 and test("^[A-Za-z0-9_-]+$");
    def technical_label: if length <= 256 and test("^[A-Za-z0-9_.:-]+$") then . else "unknown" end;
    {event:"hook",name:($name|technical_label),source:($source|technical_label),ms:$ms,tsMs:$tsMs,
     phase:(if (["PreToolUse","PostToolUse","SessionStart","SessionEnd","Stop","SubagentStart","SubagentStop","UserPromptSubmit","PreCompact"]|index($phase)) != null then $phase else "unknown" end),
     verdict:(if (["allow","ask","block","deny","skip","noop","clean","dirty","inject","repeat","partial","compact-advice","gate-started","gate-killed"]|index($verdict)) != null then $verdict else "unknown" end),
     agentId:(([.agent_id,.subagent_id]|map(select(id))|first)//"orchestrator")}
     + (if (.tool_use_id|id) then {toolUseId:.tool_use_id} else {} end)
     + (if (["Bash","Edit","Read","Write","Agent","Task","NotebookEdit"]|index($tool)) != null then {tool:$tool} else {} end)
     + (if $reason == "" then {}
        elif (["oversize","no-verify","force-push-base","rm-root","rm-var","no-preserve-root","fork-bomb","block-device","managed-rewrite","binary-missing","plan-denied","subcommand-unavailable"]|index($reason)) != null then {reason:$reason}
        else {reason:"unspecified"} end)
     + (($kind | if . == "" then (if $verdict == "block" then "hard" elif $verdict == "ask" then "ask" else "" end) else . end) as $k
        | if (["hard","ask","advisory"]|index($k)) != null then {kind:$k} else {} end)' 2>/dev/null) || return 0
  navori_audit_record_metadata "$navori_audit_metadata"
  return 0
}
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
  gh-comment | gh-review | gh-issue-create)
    nv_body_path=$(nv_flag_value "$cmd" '-F|--body-file')
    if [ -n "$nv_body_path" ] && [ "$nv_body_path" != "-" ]; then
      nv_body_source="file"
    elif printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-b|--body)([[:space:]=]|$)'; then
      nv_body_source="inline"
    fi
    ;;
  gh-api-graphql)
    nv_body_path=$(printf '%s' "$cmd" | grep -oE -- '-F[[:space:]]+body=@[^[:space:]]+' | head -1 | sed -E 's/^-F[[:space:]]+body=@//') || true
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
      nv_body_path=$(printf '%s' "$cmd" | grep -oE -- '-F[[:space:]]+[A-Za-z0-9_]+=@[^[:space:]]+' | head -1 | sed -E 's/^-F[[:space:]]+[A-Za-z0-9_]+=@//') || true
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
# navori:managed end id="comment-draft-confirm-base"
