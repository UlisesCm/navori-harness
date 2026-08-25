#!/usr/bin/env bash
# navori — audit-mode trigger (UserPromptSubmit)
#
# Detects an audit-mode invocation in the user's prompt and asks Claude to
# CONFIRM with the user before anything is recorded. It never activates the
# mode by itself: a false positive must die in the question, leaving no state
# on disk.
#
# While the mode is active it appends the typed prompt to the session's
# append-only log. Writes are O_APPEND only; the log is never re-read to be
# rewritten, so parallel subagents cannot corrupt it and a crashed session
# still leaves a valid (merely shorter) file.
#
# FAIL-OPEN ABSOLUTE: this hook runs on every prompt. Any error, any missing
# dependency, any odd path exits 0 silently. It must never be the reason a
# session fails to start.

set +e

emit_and_exit() { printf '%s\n' "$1"; exit 0; }

# Is `audit` actually available in the CLI on PATH?
#
# The hook orders the agent to run `navori audit --start`, and that resolves the
# PUBLISHED binary, never a working tree's build. When the installed version
# predates the subcommand, citty prints the help and exits 0 — so an agent that
# checks the exit code reads a silent no-op as success and reports a recording
# that never started. Match the subcommand inside the CLI's own USAGE line
# instead of trusting the status.
#
# Returns 1 when the subcommand is absent AND when the check itself cannot run
# (no binary on PATH, no USAGE line). Both collapse into "could not confirm",
# which is what the caller's message must say: claiming "your version is old"
# would be wrong for a machine with no navori installed at all.
audit_subcommand_available() {
  command -v navori >/dev/null 2>&1 || return 1
  usage=$(navori --help 2>/dev/null | grep -m1 '^USAGE' 2>/dev/null) || return 1
  [ -n "$usage" ] || return 1
  # Normalize separators so the token matches at any position: `USAGE navori
  # init|add|audit` -> `|USAGE|navori|init|add|audit|`.
  tokens=$(printf '%s' "$usage" | tr ' ' '|' 2>/dev/null) || return 1
  case "|$tokens|" in
    *"|audit|"*) return 0 ;;
    *) return 1 ;;
  esac
}

payload=$(cat 2>/dev/null) || exit 0
[ -n "$payload" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# The typed text, under whichever key the host uses.
#
# Reading only `.user_prompt` recorded EMPTY prompts against a real session:
# the hook fired, matched, and appended `{"event":"prompt","prompt":""}` — the
# field simply wasn't there. An audit whose whole job is attribution cannot
# silently log blanks, and `jq`'s `//` makes tolerating both names free.
#
# Order matters: the more specific `user_prompt` wins when both are present, so
# a host that ships both never gets the wrong one.
prompt=$(printf '%s' "$payload" | jq -r '.user_prompt // .prompt // ""' 2>/dev/null) || exit 0
session_id=$(printf '%s' "$payload" | jq -r '.session_id // ""' 2>/dev/null) || exit 0
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null) || exit 0
[ -n "$session_id" ] || exit 0
[ -n "$cwd" ] || cwd=$PWD

repo=$(basename "$cwd" 2>/dev/null) || exit 0
[ -n "$repo" ] || exit 0

if [ -n "$NAVORI_AUDITS_ROOT" ]; then
  audits_root=$NAVORI_AUDITS_ROOT
else
  [ -n "$HOME" ] || exit 0
  audits_root=$HOME/.navori/audits
fi
log_file=$audits_root/$repo/session-$session_id.log

lower=$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]' 2>/dev/null) || exit 0

# Deliberately tolerant: a spurious match costs one question, while a missed
# one costs the whole recording.
case "$lower" in
  *"audit mode"*|*"audit-mode"*|*"modo audit"*|*"modo auditoría"*|*"modo auditoria"*) matched=1 ;;
  *) matched=0 ;;
esac

case "$lower" in
  *apaga*|*apagar*|*desactiva*|*"salir de"*|*detén*|*deten*|*stop*|*"turn off"*|*disable*) off_intent=1 ;;
  *) off_intent=0 ;;
esac

if [ -f "$log_file" ]; then
  # Active: record the human's own words — they entered the model's context,
  # so they cost tokens and belong in the audit.
  #
  # `transcript_path` rides along because the payload is the ONLY place it is
  # stated. Without it the reader has to guess the transcript's location by
  # re-deriving Claude Code's undocumented directory encoding (see paths.ts),
  # and a guess that misses costs the whole report.
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || ts=""
  transcript=$(printf '%s' "$payload" | jq -r '.transcript_path // ""' 2>/dev/null) || transcript=""
  printf '%s\n' "$(jq -cn --arg ts "$ts" --arg ev "prompt" --arg p "$prompt" --arg tr "$transcript" \
    '{ts:$ts,event:$ev,prompt:$p} + (if $tr == "" then {} else {transcript:$tr} end)' 2>/dev/null)" >> "$log_file" 2>/dev/null

  if [ "$matched" = "1" ] && [ "$off_intent" = "1" ]; then
    if audit_subcommand_available; then
      emit_and_exit "[navori audit-mode] The user asked to turn audit-mode OFF. Before doing anything, ask them explicitly: \"audit mode will be turned off, continue?\". Only if they confirm, run: navori audit --stop $session_id (that seals the log and generates the report). Then check the output: it must name the report it wrote. If it prints the command list (USAGE) instead, the installed CLI has no such subcommand — tell the user and do NOT assume the session was closed. If they decline, leave the mode active and carry on with the task."
    else
      emit_and_exit "[navori audit-mode] The user asked to turn audit-mode OFF, but the available 'navori' could not be confirmed to ship the 'audit' subcommand: it may not be installed at all, or it may predate that command. Do NOT run 'navori audit --stop' blindly: if the binary exists but is old, it prints its help and exits 0, which looks like success without being one. Tell the user what happened and that the session log stays intact on disk, so the report can still be generated once the CLI is up to date. Then carry on with the task."
    fi
  fi
  exit 0
fi

if [ "$matched" = "1" ] && [ "$off_intent" = "0" ]; then
  if audit_subcommand_available; then
    emit_and_exit "[navori audit-mode] An audit-mode invocation was detected in the prompt. Before activating anything, ask the user explicitly: \"an audit mode invocation was detected, continue?\". Only if they confirm, run: navori audit --start $session_id (that creates the session log). Then check the output: it must name the log file it created. If it prints the command list (USAGE) instead, the installed CLI has no such subcommand — tell the user and do NOT assume the mode is active. If they decline, run nothing and carry on with the task."
  else
    emit_and_exit "[navori audit-mode] An audit-mode invocation was detected, but the available 'navori' could not be confirmed to ship the 'audit' subcommand: it may not be installed at all, or it may predate that command. Do NOT run 'navori audit --start' blindly: if the binary exists but is old, it prints its help and exits 0, which looks like success without being one. Tell the user that nothing was activated, and why. Then carry on with the task."
  fi
fi

exit 0
