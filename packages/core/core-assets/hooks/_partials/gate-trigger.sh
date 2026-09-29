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
