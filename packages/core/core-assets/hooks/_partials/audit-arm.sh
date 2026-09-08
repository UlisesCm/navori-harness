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
