# PII-egress Bash lane (#1445) — inlined into `guard-destructive` at render time (see the
# include directive in the source script + lib/render/hook-includes.ts). It rides inside the
# destructive guard, not in a hook of its own, because spec 0039 R28 forbids adding a hook to
# the ordinary Bash path (the per-call latency of every extra process). Matching, identifiers,
# the never-echo rule and the failure contract live in `pii-egress.sh` (included beside it).
#
# "NETWORK REQUEST TO AN EXTERNAL HOST", for Bash: a LIVE segment (heredoc bodies and
# `-m`/`--body` values are data) whose command is, behind `sudo|env|time|command|exec` and a
# path prefix, one of `curl wget http https xh xhs`, or an inline `node|bun|deno|python|python3`
# (`-e|-c|eval`) using `fetch(`, `requests.`, `urllib` or `http.request`. Matching is PER
# SEGMENT, plus the heredoc bodies of the command when that segment opens a heredoc (the body
# IS the request body). A `git commit -m "<email>" && curl https://x` is therefore not blocked.
# A scheme-less segment is external unless one of its words is a local host. A request is also
# blocked when it READS the email inline (`-A "$(git config user.email)"`).
#
# DOCUMENTED FALSE NEGATIVES (a seatbelt against accidental leaks, not a sandbox): `git` (push,
# commit --author), `gh`, `ssh`, `scp`, `rsync`, MCP tools, `sh -c`, `eval`, obfuscation;
# scheme-less `nc|ncat|netcat|telnet|xh` (not in the cheap gate); a value the lane cannot see
# expanded (`$EMAIL`, `$(cat file)`, `-K cfg`, `--data @file`, `-H @file`); `node script.js`,
# `python3 script.py`, `bun run`, `npx` and a `python3 - <<EOF` (no inline flag); a `;` inside a
# quoted URL splits the segment. WebFetch/WebSearch are covered by `pii-egress-guard` (Claude).
#
# FAILURE CONTRACT. The cheap gate is fork-free and runs on every Bash call; before it matches,
# nothing runs and any error allows. After it matches, the check runs in a SUBSHELL, so no
# failure of this lane can end the guard and disable its other rules; a status other than the
# explicit codes denies ("could not verify"). A command too large to inspect never reaches the
# lane: the guard's own ceilings block it first.
#
# Requires, from the caller: `$cmd`, `$skeleton` (after `navori_inert_skeleton`), the inert
# partial's `navori_inert_live`/`navori_inert_segments`, and the `pii-egress.sh` partial.

# Is segment $1 an external network request's text? (0 = external)
_pii_external() {
  local _seg="$1" _line _found=0 _w
  local _hre="[A-Za-z][A-Za-z0-9+.-]*://[^/?#\"'[:space:]]*"
  local _urls
  _urls=$(printf '%s\n' "$_seg" | grep -oE "$_hre" 2>/dev/null) || [ "$?" -eq 1 ]
  while IFS= read -r _line; do
    [ -n "$_line" ] || continue
    _found=1
    _pii_local "${_line#*://}" || return 0
  done <<<"$_urls"
  [ "$_found" -eq 1 ] && return 1
  # No scheme: local only when one word is a local host[:port][/path].
  while IFS= read -r _w; do
    case "$_w" in "" | -*) continue ;; esac
    _w="${_w#[\"\']}"
    _w="${_w%%/*}"
    _pii_local "$_w" && return 1
  done <<<"$(printf '%s' "$_seg" | tr -s '[:space:]' '\n')"
  return 0
}

# Is segment $1 a network request (see the header)? (0 = yes)
_pii_is_request() {
  local _s="$1" _w
  while :; do
    _s="${_s#"${_s%%[![:space:]]*}"}"
    _w="${_s%%[[:space:]]*}"
    case "$_w" in
      sudo | env | time | command | exec) _s="${_s#"$_w"}" ;;
      [A-Za-z_]*=*) _s="${_s#"$_w"}" ;;
      *) break ;;
    esac
  done
  _w="${_w##*/}"
  case "$_w" in
    curl | wget | http | https | xh | xhs) return 0 ;;
    node | bun | deno | python | python3)
      case " $_s " in
        *' -e '* | *' -c '* | *' --eval '* | *' eval '*)
          case "$_s" in
            *fetch* | *requests.* | *urllib* | *http.request*) return 0 ;;
          esac
          ;;
      esac
      ;;
  esac
  return 1
}

# Subshell body. Exit 0 allow · 41 hit on git user.email · 42 hit on NAVORI_PERSONAL_IDS ·
# anything else: could not verify.
navori_pii_bash_check() {
  set -euo pipefail
  # Never the guard's `block()`: it prints the command. The ceilings were already enforced
  # by the caller, so this is unreachable unless the contract changes — then it fails closed.
  block() { exit 1; }
  local _texts="" _seg
  navori_inert_live
  navori_inert_segments
  # Per live segment; a heredoc opener widens that segment to the whole command (the body is
  # the request body).
  while IFS= read -r _seg; do
    [ -n "$_seg" ] || continue
    _pii_is_request "$_seg" || continue
    _pii_external "$_seg" || continue
    case "$_seg" in
      *'<<'*) _texts="${_texts}${cmd}${_pii_nl}" ;;
      *) _texts="${_texts}${_seg}${_pii_nl}" ;;
    esac
    case "$_seg" in
      *'git config user.email'* | *'git config --get user.email'*) exit 41 ;;
    esac
  done <<<"$segments"
  [ -n "$_texts" ] || exit 0
  navori_pii_verdict "$_texts"
}

# The lane. THE CHEAP GATE comes first: pure `case`, no fork. Word-bounded tools (`nc`, `xh`…)
# are NOT here on purpose: a bare `nc` matches `sync`, `once` and `--since`, and would send
# ordinary calls through the forks below. A deny exits 2 through `navori_pii_finish`.
navori_pii_bash_lane() {
  case "$cmd" in
    *curl* | *wget* | *'://'* | *'fetch('*) ;;
    *) return 0 ;;
  esac
  local _rc=0
  set +e
  ( navori_pii_bash_check )
  _rc=$?
  set -e
  navori_pii_finish "$_rc"
}
