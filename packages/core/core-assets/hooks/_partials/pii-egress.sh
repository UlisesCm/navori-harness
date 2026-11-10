# Shared PII-egress core (#1445) — inlined into `guard-destructive` (its Bash lane) and
# `pii-egress-guard` (WebFetch/WebSearch) at render time (see the include directive in the
# source scripts + lib/render/hook-includes.ts). DO NOT copy this body back into a hook by
# hand: two hand-synced copies of a matcher are how scanners drift (#225/#261).
#
# The mechanical half of "never send the user's personal data to an external service". An
# agent once put the user's git email in the `User-Agent` of a `curl` to a third-party API,
# because the prose rule did not exist yet and a contact address "looked polite".
#
# IDENTIFIERS. `git config user.email` and the comma-separated env var `NAVORI_PERSONAL_IDS`
# (entries shorter than 4 characters are ignored). No identifier resolvable → no verdict.
# Matching is a case-insensitive literal (`grep -iF`) of each identifier plus its URL-encoded
# forms (`@`→`%40`, `+`→`%2B`, space→`%20`/`+`).
#
# EXTERNAL = any host that is not `localhost`, `*.localhost`, `127/8`, `::1`, `0.0.0.0`,
# `10/8`, `172.16/12` or `192.168/16`. Mixed hosts → external. `169.254/16` is external.
#
# NEVER ECHOES. Neither stderr nor the audit log carries the identifier or the command: the
# message names the rule and the SOURCE (git user.email / NAVORI_PERSONAL_IDS) and the audit
# reason is the fixed code `pii-egress`. The caller's own `block()` is NOT used for this
# reason: `guard-destructive`'s prints the command.
#
# FAILURE CONTRACT (owned by the callers, executed through `navori_pii_finish`): the check
# runs in a subshell; before the caller's network gate matches, any error ALLOWS; after it
# matches, a status other than the explicit codes below DENIES ("could not verify").
#
# Requires, from the caller: the `navori_audit_verdict`/`navori_audit_reason` variables the
# audit trap reads. Blocking classification (#1117):
#   - an identifier in a request to an external host: hard — personal data leaving the machine
#     cannot be recalled; the message names the rule and the source, and the route is a generic identifier.
#   - a check that could not complete after the gate matched: hard — fail closed, nothing was verified.
_pii_nl=$'\n'

# 1 when the text holds identifier $1, 0 otherwise; a grep error leaves the
# subshell (exit 1 → "could not verify").
_pii_has() {
  local _rc=0
  grep -qiF -e "$1" <<<"$2" >/dev/null 2>&1 || _rc=$?
  [ "$_rc" -le 1 ] || exit 1
  [ "$_rc" -eq 0 ]
}

# Does the text carry identifier $1 in any of its forms?
_pii_hits() {
  local _id="$1" _t="$2" _enc
  _pii_has "$_id" "$_t" && return 0
  _enc="${_id//@/%40}"
  _enc="${_enc//+/%2B}"
  _enc="${_enc// /%20}"
  _pii_has "$_enc" "$_t" && return 0
  _enc="${_id// /+}"
  _pii_has "$_enc" "$_t" && return 0
  return 1
}

# Is host[:port] $1 local? (0 = local)
_pii_local() {
  local _h="$1" _hn
  # Authority only: cut the path/query first, so an `@` in a query is not userinfo.
  _h="${_h%%/*}"
  _h="${_h%%\?*}"
  _h="${_h%%#*}"
  _h="${_h##*@}"
  case "$_h" in
    "" | '[::1]' | '[::1]':*) return 0 ;;
  esac
  _hn="${_h%%:*}"
  case "$_hn" in
    localhost | *.localhost | 0.0.0.0) return 0 ;;
    *[!0-9.]*) return 1 ;;
  esac
  case "$_hn" in
    127.* | 10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 0 ;;
  esac
  return 1
}

# Subshell body, last step: resolve the identifiers (at most one fork, only for an external
# request) and look for them in text $1. Exit 0 no hit · 41 hit on git user.email · 42 hit on
# NAVORI_PERSONAL_IDS.
navori_pii_verdict() {
  local _texts="$1" _ids="" _email _v _line _src
  _email=$(git config user.email 2>/dev/null || true)
  [ "${#_email}" -lt 4 ] || _ids="g:${_email}${_pii_nl}"
  if [ -n "${NAVORI_PERSONAL_IDS:-}" ]; then
    while IFS= read -r _v; do
      _v="${_v#"${_v%%[![:space:]]*}"}"
      _v="${_v%"${_v##*[![:space:]]}"}"
      [ "${#_v}" -lt 4 ] || _ids="${_ids}e:${_v}${_pii_nl}"
    done <<<"$(printf '%s' "$NAVORI_PERSONAL_IDS" | tr ',' '\n')"
  fi
  [ -n "$_ids" ] || exit 0
  while IFS= read -r _line; do
    [ -n "$_line" ] || continue
    _src="${_line%%:*}"
    _v="${_line#*:}"
    if _pii_hits "$_v" "$_texts"; then
      if [ "$_src" = g ]; then exit 41; fi
      exit 42
    fi
  done <<<"$_ids"
  exit 0
}

# Turn the subshell status $1 into the verdict: 0 returns (allow), anything else denies with
# `exit 2`. Only ASSIGNMENTS before the exit: the caller's trap records the verdict.
navori_pii_finish() {
  local _why
  case "$1" in
    0) return 0 ;;
    41) _why="a request to an external host carries a personal identifier (source: the configured user email)." ;;
    42) _why="a request to an external host carries a personal identifier (source: NAVORI_PERSONAL_IDS)." ;;
    *) _why="could not verify that this network request is free of personal identifiers; split it, or ask the user to run it." ;;
  esac
  echo "[navori] BLOCKED by pii-egress-guard: ${_why}" >&2
  echo "[navori] Rule: never send the user's personal data to external services. Use a generic identifier instead, e.g. \"User-Agent: navori-agent/1.0\" or example@example.com." >&2
  navori_audit_verdict="block"
  navori_audit_reason="pii-egress"
  exit 2
}
