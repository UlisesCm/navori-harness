# navori:managed start id="pr-publisher-confirm-base" hash="d9e5fd27" version="0.11.2" source="@navori/core"
#!/usr/bin/env bash
#
# PreToolUse(Bash): a `gh pr create` that did NOT come from the
# `publisher` is raised to a user confirmation.
#
# WHY (#705): the publisher is the single owner of commit+PR, and it is invoked on
# 15% of the PRs this harness opens. The rate is not uniform — one park repo
# runs at 48%, and the repo that PUBLISHES the publisher sat at 0 of 101. The
# confound was checked and does not hold: in the sessions where subagents were
# demonstrably available and used, the publisher was still never called. The publisher
# is not skipped; its antechamber is never entered, because `gh pr create` falls
# out of whatever the main agent was already doing and nothing interrupts it.
#
# So this hook interrupts, and does no more than that. It does NOT block: a
# session where the operator forbids subagents has no way to reach the publisher,
# and a hook that made PRs impossible there would be worse than the deviation it
# corrects. `ask` keeps the decision with the human while removing the one thing
# measured to fail — a layer that only suggests.
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

navori_audit_name="pr-publisher-confirm"
navori_audit_phase="PreToolUse"
navori_audit_tool="Bash"
# Fail-open no-ops, overwritten by the real definitions the include brings in.
# Same contract as the sibling gates: a recorder may never kill what it observes.
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
# It names SOME subagent, not specifically the publisher — a `scout` opening a
# PR would pass. That is deliberate: this is a routing nudge, not a security
# boundary, and the detector cannot see through `sh -c` either.
#
# CODEX (spec 0041 R10): Codex hooks cannot emit `ask` and a `.codex/rules`
# `prompt` rule only confirms on the main thread — it is silent inside the
# publisher subagent (live probe V1) — so the Codex copy denies instead:
# deny-as-confirmation, decided by `$0` like `comment-draft-confirm.sh`. It runs
# BEFORE the subagent allow, because the publisher is exactly where the
# unconfirmed `gh pr create` happens. Fixed by construction: no jq needed.
case "$0" in
  *".codex/hooks/"*)
    navori_audit_verdict="deny"
    navori_audit_reason="gh pr create requires user confirmation (Codex)"
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[navori] this `gh pr create` opens a PR and Codex hooks cannot prompt. Show the user the title and body, and let them confirm and run the command themselves."}}'
    exit 0
    ;;
esac

navori_pr_agent=$(payload_field agent_id)
[ -n "$navori_pr_agent" ] || navori_pr_agent=$(payload_field subagent_id)
if [ -n "$navori_pr_agent" ]; then
  navori_audit_verdict="allow"
  navori_audit_reason="el PR viene de un subagente"
  exit 0
fi

navori_audit_verdict="ask"
navori_audit_reason="PR abierto fuera del publisher"

# `ask` routes the call to the user instead of resolving it. The reason is what
# they read, so it says what the publisher adds and how to get it — a prompt that
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
[navori] this `gh pr create` does not come from the publisher.

The publisher is the single owner of commit+PR: it applies the title/body format
this repo uses and runs the git/gh pre-flight before opening anything.

Delegate it with the Agent tool (subagent_type: publisher), or confirm to
open this PR by hand — a rollout PR, a revert, or a session where subagents are
unavailable are all legitimate reasons to do so.
MSG
)

jq -cn --arg reason "$navori_pr_reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$reason}}'
exit 0
# navori:managed end id="pr-publisher-confirm-base"
