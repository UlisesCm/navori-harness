# navori:managed start id="audit-mode-trigger-base" hash="1b31abb8" version="0.7.5" source="@navori/core"
#!/usr/bin/env bash
# navori — audit-mode prompt recorder (UserPromptSubmit)
#
# While audit-mode is active, appends the typed prompt to the session's
# append-only log. That is its ONLY job.
#
# It used to also detect an audit-mode invocation in the prompt text and ask
# Claude to confirm activation. That was removed (spec 0013, R3): matching
# `audit mode` as a substring cannot separate INVOKING the mode from TALKING
# ABOUT it, and talking about it is what you do all day while working on the
# feature. The asymmetry made it worse — turning it ON matched loosely, while
# turning it OFF required the literal phrase, so sessions stayed open forever.
# Activation is now exclusively `navori audit --start <id>`.
#
# Writes are O_APPEND only; the log is never re-read to be rewritten, so
# parallel subagents cannot corrupt it and a crashed session still leaves a
# valid (merely shorter) file.
#
# FAIL-OPEN ABSOLUTE: this hook runs on every prompt. Any error, any missing
# dependency, any odd path exits 0 silently. It must never be the reason a
# session fails to start.

set +e

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
# The id composes `log_file` below, so a path-shaped one would escape the
# audit root. The CLI validates it too (#503) — this guard is here so the
# hook does not DEPEND on that: "safe because the other layer cannot create
# the case" is the coupling that let three delete paths drift apart. Same
# character class the CLI enforces; anything else means the payload is not
# what we think it is, so do nothing rather than guess.
case "$session_id" in
  *[!A-Za-z0-9_-]*) exit 0 ;;
esac
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

# ─── Armed audit-mode for the RUNNING session (#599) ─────────────────────────
# `navori audit --arm` (another terminal, or `! navori audit --arm` in-session)
# → the NEXT prompt lands here, consumes the flag and starts recording. This is
# the UX the SessionStart-only flow lacked: no closing and reopening a session
# that is already warm. Costs one stat per prompt when not armed. The stdout
# line is deliberate — a UserPromptSubmit hook's stdout is injected as context,
# so the model learns it is being recorded the moment it starts to be.
# Mid-session coverage is already modeled by the report (recorder horizon), so a
# log that starts at prompt N is a smaller log, never a broken one.
# Shared armed-audit consumption (#597, #599) — inlined into each consuming hook
# at render time (see lib/hook-includes.ts). Single source of truth for the flag
# protocol so the two consumers cannot drift apart:
#
#   · SessionStart  — arm BEFORE opening the session (original #597 flow).
#   · UserPromptSubmit — arm the RUNNING session: `navori audit --arm` (from
#     another terminal, or in-session via `! navori audit --arm`) and the NEXT
#     message activates recording (#599). No restart, no lost context.
#
# The flag is `<audits-root>/<repo>/.armed`, written by `navori audit --arm`.
# Consumption comes FIRST: the flag arms exactly ONE session. If `--start` then
# fails, the arm is lost rather than latched — a flag that survives a failure
# would fire on some later unrelated session, which is worse than asking the
# user to arm again.
#
# CALLER CONTRACT: $1 is a session id ALREADY validated against the shared
# charset (#503) — this function trusts it into a command line, so an unvalidated
# id must never reach here. $2 is the payload's cwd (#454: never
# CLAUDE_PROJECT_DIR — they differ in worktrees, and --arm wrote the flag under
# the name basename(cwd) resolves to). $3 is the audits root.
#
# Fail-open and silent: returns 0 ONLY when audit-mode was actually started, so
# the caller can announce it; every other path returns 1 and changes nothing.
# Safe under `set -euo pipefail` and `set +e` alike.
navori_audit_consume_armed() {
  narm_sid=$1
  narm_cwd=$2
  narm_root=$3
  [ -n "$narm_sid" ] && [ -n "$narm_cwd" ] && [ -n "$narm_root" ] || return 1
  narm_repo=$(basename "$narm_cwd" 2>/dev/null) || return 1
  [ -n "$narm_repo" ] || return 1
  narm_file=$narm_root/$narm_repo/.armed
  [ -f "$narm_file" ] || return 1
  command -v navori >/dev/null 2>&1 || return 1
  rm -f "$narm_file" 2>/dev/null || true
  navori audit --start "$narm_sid" --cwd "$narm_cwd" >/dev/null 2>&1 || return 1
  return 0
}
if navori_audit_consume_armed "$session_id" "$cwd" "$audits_root"; then
  printf 'navori: audit-mode ACTIVE from this message on (armed via navori audit --arm; the hook ran --start %s).\n' "$session_id"
fi

# Not marked → not recording. This is also what makes the hook free outside
# audit-mode: one stat and out.
[ -f "$log_file" ] || exit 0

# Record the human's own words — they entered the model's context, so they cost
# tokens and belong in the audit.
#
# `transcript_path` rides along because the payload is the ONLY place it is
# stated. Without it the reader has to guess the transcript's location by
# re-deriving Claude Code's undocumented directory encoding (see paths.ts),
# and a guess that misses costs the whole report.
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || ts=""
transcript=$(printf '%s' "$payload" | jq -r '.transcript_path // ""' 2>/dev/null) || transcript=""
printf '%s\n' "$(jq -cn --arg ts "$ts" --arg ev "prompt" --arg p "$prompt" --arg tr "$transcript" \
  '{ts:$ts,event:$ev,prompt:$p} + (if $tr == "" then {} else {transcript:$tr} end)' 2>/dev/null)" >> "$log_file" 2>/dev/null

exit 0
# navori:managed end id="audit-mode-trigger-base"
