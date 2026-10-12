# Shared inert-content skeleton and command segmentation — inlined into
# `guard-destructive` and `subagent-no-background` at render time (see the
# include directive in the source scripts + lib/render/hook-includes.ts). DO NOT
# copy this body back into a hook by hand: it is ~300 lines of security-sensitive
# text handling, and two hand-synced copies are how scanners drift (#225/#261).
#
# Extracted verbatim from `guard-destructive.sh` (spec 0048 T12/D12) with no
# change of behavior; the comments below keep the reasoning that came with it.
#
# Requires, from the caller: `$cmd` (the command text) and a
# `block <message> [reason] [route]` function that exits. Call order:
#   navori_inert_skeleton   → sets `$skeleton` (heredoc bodies elided)
#   navori_inert_live       → sets `$live` (what the shell will interpret)
#   navori_inert_segments   → sets `$scan` and `$segments` (one segment per line)
# The caller may run its own work between the calls (guard-destructive's fast
# path sits between the first and the second, on purpose).
#
# BOUNDED WORK (#511) ceilings — shared so every user fails closed identically.
# The measurements and rationale live in `guard-destructive.sh`'s header block.
CMD_MAX=131072
LINE_MAX=4096
HEREDOC_PROBE_MAX=64


# Pre-expanded newline, shared by the inert-content pass and the segment split.
# It stays a variable for the reason it became one in #391: an inline $'\n' is
# NOT expanded by zsh in every position bash expands it, and a divergence here
# leaves compound commands unsplit — the rules then fail open. A plain variable
# expands identically in both, in a string concatenation and inside the `sed`
# replacement the split below builds.
_nl=$'\n'

navori_inert_skeleton() {

# INERT CONTENT (#462) — what the shell EXECUTES vs what it merely WRITES.
#
# Every rule below reads the command as TEXT, so a PR body or a commit message
# that QUOTES a destructive command was blocked even though nothing ran. That
# fires on every security change, because documenting a fix means quoting the
# attack it defends against: #403 could not write its own PR body, and a commit
# message naming a recursive delete of HOME needed the `git commit -F <file>`
# detour.
#
# `live` is `$cmd` minus its INERT spans — the text the shell hands to a program
# as DATA and never interprets as a command. `$cmd` stays intact for the
# messages; the rules read `live` (directly, or through `scan`).
#
# INERT (dropped before matching):
#   · a heredoc BODY — `cat > body.md <<'EOF' … EOF` is file content.
#   · the quoted VALUE of a message/body flag (`-m`, `--body`, …) — it lands in
#     a commit object or in a PR, the shell never runs it.
#
# NOT inert. This is the line the decision draws — stated as the FRONTIER it
# actually is, denylist included, because an unstated denylist reads as coverage:
#   · a heredoc whose opener names a SCRIPT path (`cat > run.sh <<'EOF'`) — that
#     is step 1 of write-then-execute, not documentation. The extension list is
#     matched case-INSENSITIVELY; an unlisted or absent extension (`Makefile`,
#     `.mk`, `.lua`, `.awk`, `cat > /tmp/payload`) reads as documentation, and
#     only the execution tell below can still catch it.
#   · ANY command that also EXECUTES something. Precisely: a KNOWN interpreter
#     (`_hd_run`) in COMMAND POSITION — optionally behind `VAR=v` and the simple
#     prefixes of `_hd_pre` WITH their arguments (`sudo -u me`, `env FOO=1`,
#     `timeout 5`), and behind the wrappers the tell normalizes away (`(…)`,
#     `{ …; }`, `\bash`, `"bash"`, `command bash`) —, or a path in command
#     position (`./x`, `/x`, `~/x`), or a `$(…)`/backtick substitution the shell
#     would expand (`git commit -m "$(rm -rf ~)"` really does run it). Such a
#     command is scanned WHOLE, exactly as before #462.
#     ANY OTHER RUNNER ESCAPES, and that is the accepted trade, not an oversight:
#     `npx tsx f`, `lua f`, `make -f f`, `find … -exec bash {} \;`, a runner
#     reached through a shell function or an alias, and one named by a BRACED
#     variable (`${SH} f` — the wrapper normalization collapses `{` to a space,
#     so it reaches the tell as `$ SH`; the plain `$SHELL f` IS caught). A word
#     split by escapes (`b\ash f`) escapes too, as it already does the rules in
#     the pre-#462 guard. A denylist is never complete;
#     widening it is cheap per entry, but each entry ALSO drags a legitimate
#     `… && make build` sitting next to a prose heredoc back into a full scan —
#     back into the exact false positive #462 exists to kill. Same class as the
#     `sh -c` / `eval` limitation the header states: a seatbelt, not a sandbox.
#   · a `<<` that merely sits inside a string (`echo "a << b"`) — it opens no
#     heredoc, so it can never be used to swallow the next real command. A line
#     whose quotes do not pair up (`echo "a \" << EOF"`) counts as a NON-opener
#     for the same reason: inventing a heredoc there would elide the real
#     commands that follow, the one way this pass could scan LESS than before.
# Unchanged scope: a deliberate adversary (`sh -c`, `eval`, base64) already had
# simpler doors and is still out of reach. This is a seatbelt, not a sandbox.
#
# COST (#511, second pass). This is the ONE per-line loop in the file, so it is
# the one place where the number of lines — not the number of bytes — prices the
# guard. Two things keep it bounded:
#   · it runs only when the command contains `<<`. There is nothing to elide
#     without a heredoc, so every other command takes the `*)` arm and the
#     skeleton IS the command, at zero per-line cost.
#   · the kept lines land in an ARRAY, joined once at the end. The
#     `skeleton="${skeleton}${_line}${_nl}"` this replaces was quadratic (bash
#     copies the whole accumulator on every iteration), and it was 96-99% of the
#     guard's runtime: 3.5s at 16k lines, 13.2s at 32k, 53.2s at 64k — killed by
#     the timeout, which reads exactly like an approval. Same inputs through the
#     array: 445ms, 833ms, 1.6s. Linear, and 32x cheaper at the top end.
#     Inside LINE_MAX the gap is 3.5s vs 300ms, so the ceiling alone would not
#     have been enough on a slower box; the two halves are not redundant.
_hd_q='@navoriQ@'   # marks a QUOTED heredoc delimiter (`<<'EOF'`: no expansion)
skeleton=""
_sk=()
_hd_delim=""
_hd_inert=0
_hd_expand=0
_hd_probes=0
_hd_lines=0
case "$cmd" in
  *'<<'*) _hd_scan=1 ;;
  *) _hd_scan=0 ;;
esac
while [ "$_hd_scan" = 1 ] && IFS= read -r _line; do
  # BOUNDED WORK (#511): the ceiling is checked HERE, per line, instead of by
  # counting first — the loop is the only thing the count would protect, so
  # stopping inside it costs at most LINE_MAX cheap iterations and saves a
  # whole extra pass over the command on the way in.
  _hd_lines=$((_hd_lines + 1))
  if [ "$_hd_lines" -gt "$LINE_MAX" ]; then
    block "too many lines to inspect (> ${LINE_MAX}) — nothing in it was evaluated" oversize "split it into smaller commands the guard can inspect."
  fi
  if [ -n "$_hd_delim" ]; then
    # Inside a heredoc body. The terminator is compared whitespace-trimmed (a
    # `<<-` terminator may be indented); trimming can only end the body EARLIER
    # than the shell would, i.e. scan more, never less.
    _t="${_line#"${_line%%[![:space:]]*}"}"
    _t="${_t%"${_t##*[![:space:]]}"}"
    if [ "$_t" = "$_hd_delim" ]; then
      _hd_delim=""
      continue
    fi
    if [ "$_hd_inert" = 0 ]; then
      _sk+=("$_line")
      continue
    fi
    # An UNQUOTED delimiter (`<<EOF`) still runs `$(…)`/backticks inside the
    # body — plain prose there is inert, a substitution is a real invocation.
    # Keeping exactly those lines feeds the whole-command fallback below.
    if [ "$_hd_expand" = 1 ]; then
      case "$_line" in
        *'$('* | *'`'*) _sk+=("$_line") ;;
      esac
    fi
    continue
  fi
  _sk+=("$_line")
  # Fast path: no `<<`, no heredoc — a PreToolUse hook runs on EVERY Bash call,
  # so the sed probes below are worth paying only on the lines that can open one.
  case "$_line" in
    *'<<'*) ;;
    *) continue ;;
  esac
  # BOUNDED WORK (#511): every candidate line below pays two `sed` processes and
  # a `grep`, so a command made of thousands of `<<`-bearing lines is a way to
  # run the guard out of its timeout — the one failure mode that reads as
  # approval. A real command opens one to three heredocs; past the ceiling the
  # verdict is `block`, not silence.
  _hd_probes=$((_hd_probes + 1))
  if [ "$_hd_probes" -gt "$HEREDOC_PROBE_MAX" ]; then
    block "too many heredoc openers to inspect (> ${HEREDOC_PROBE_MAX}) — nothing in it was evaluated" oversize "split it into smaller commands the guard can inspect."
  fi
  # Heredoc opener? The probe marks the DELIMITER's own quotes first, then drops
  # every other quoted span, so `cat <<'EOF'` is told apart from a `<<` inside a
  # string; `<<<` (here-string) is neutralized so it can't pose as `<<`.
  _probe=$(printf '%s' "$_line" | sed -E \
    -e "s/<<(-?)[[:space:]]*'([A-Za-z_][A-Za-z0-9_]*)'/<<\1${_hd_q}\2/g" \
    -e "s/<<(-?)[[:space:]]*\"([A-Za-z_][A-Za-z0-9_]*)\"/<<\1${_hd_q}\2/g" \
    -e "s/<<(-?)[[:space:]]*\\\\([A-Za-z_][A-Za-z0-9_]*)/<<\1${_hd_q}\2/g" \
    -e "s/'[^']*'//g" -e "s/\"[^\"]*\"//g" -e "s/<<</ /g")
  # A quote left over in the probe means those two `sed` passes paired the quotes
  # somewhere the shell would not (an escaped `\"`, an odd count): the `<<` may
  # well sit inside a string, and INVENTING a heredoc here is the one failure
  # mode of this whole pass that scans LESS — it would elide every following line,
  # real commands included (`echo "a \" << EOF"` + a real `rm -rf ~/`). Treat the
  # line as a NON-opener; worst case the body is scanned, which is what the guard
  # did before #462.
  case "$_probe" in
    *'"'* | *"'"*) continue ;;
  esac
  # `^[^<]*` anchors on the FIRST `<` of the line: no match (a `<` redirect
  # before the heredoc) simply leaves the body under the rules.
  _open=$(printf '%s' "$_probe" \
    | sed -nE "s/^[^<]*(<<-?[[:space:]]*(${_hd_q})?[A-Za-z_][A-Za-z0-9_]*).*/\1/p")
  if [ -z "$_open" ]; then continue; fi
  _hd_delim=$(printf '%s' "$_open" | sed -E "s/^<<-?[[:space:]]*(${_hd_q})?//")
  _hd_inert=1
  _hd_expand=0
  case "$_open" in
    *"${_hd_q}"*) ;;
    *) _hd_expand=1 ;;
  esac
  # Writing a SCRIPT is not documenting: keep `cat > run.sh <<'EOF'` visible.
  # Case-INSENSITIVE (`-i`): macOS ships a case-insensitive filesystem, so
  # `cat > /tmp/p.SH` writes and runs the same file as `p.sh`.
  if printf '%s' "$_line" \
    | grep -qiE "\.(sh|bash|zsh|ksh|fish|py|rb|pl|js|jsx|mjs|cjs|ts|tsx|command|bat|ps1|scpt)([[:space:]]|[\"'\`]|\$)"; then
    _hd_inert=0
  fi
done <<< "$cmd"
# Join ONCE. `$(…)` strips trailing newlines, so the terminator is re-added: a
# trailing EMPTY line is the only thing that can be lost, and an empty line
# carries no command. The `${#_sk[@]}` guard is not cosmetic — under `set -u`,
# bash 3.2 treats `"${_sk[@]}"` on an EMPTY array as an unbound variable and
# aborts the guard, which the caller cannot tell apart from an approval.
if [ "$_hd_scan" = 1 ]; then
  if [ "${#_sk[@]}" -gt 0 ]; then
    skeleton=$(printf '%s\n' "${_sk[@]}")
    skeleton="${skeleton}${_nl}"
  fi
else
  skeleton="${cmd}${_nl}"
fi
}

navori_inert_live() {
# A `$(…)`/backtick substitution outside single quotes RUNS: `git commit -m
# "$(rm -rf ~)"` is an invocation wearing a message's clothes. This check must
# read the skeleton BEFORE the flag values are elided below — eliding first
# swallowed the `$(` and let exactly that command through.
#
# TWO probes, OR'd, because neither alone is enough:
#   · single-quoted spans dropped — catches a `$(` sitting outside every quote.
#   · the double-quoted spans ALONE — inside them an apostrophe is LITERAL, so
#     the first probe pairs `it's … it's` as if it were a quoted span and deletes
#     the `$(` between them. That is ordinary punctuation in the very messages
#     #462 exists to allow (`-m "it's fine $(rm -rf / ) it's"`), and it disarmed
#     the only check that catches an invocation disguised as a message.
# Over-reading here only falls back to scanning the whole command, i.e. to the
# pre-#462 behaviour: the safe side.
_hd_whole=0
if printf '%s' "$skeleton" | sed -E "s/'[^']*'//g" | grep -qE '\$\(|`'; then
  _hd_whole=1
else
  # Fast path, same idea as the `<<` one above: probe 2 costs two processes on
  # EVERY Bash call, and it can only ever fire when a substitution is present
  # somewhere in the first place.
  case "$skeleton" in
    *'$('* | *'`'*)
      if printf '%s' "$skeleton" | grep -oE '"[^"]*"' | grep -qE '\$\(|`'; then
        _hd_whole=1
      fi
      ;;
  esac
fi

# Message/body flag VALUES. The flag itself stays so rule 1 still sees the shape
# of the invocation (`git commit -m "" --no-verify` is still a skip-flag), and
# `--body-file` is untouched: `([[:space:]]+|=)` can't match its `-`.
_hd_flags='-m|--message|--body|--title|--description|--notes'
skeleton=$(printf '%s' "$skeleton" | sed -E \
  -e "s/(^|[[:space:]])(${_hd_flags})([[:space:]]+|=)'[^']*'/\1\2 ''/g" \
  -e "s/(^|[[:space:]])(${_hd_flags})([[:space:]]+|=)\"[^\"]*\"/\1\2 \"\"/g")

# The elision holds ONLY while nothing in the command can run what was written.
# A segment that STARTS with an interpreter or with a path is an execution, and
# reverts to the whole command — which is why `cat > x <<'EOF' … EOF; bash x` is
# still blocked. Anything else keeps only what the shell will interpret.
#
# `_hd_pre` — the runner may sit behind simple prefixes, WITH their own arguments:
# `sudo -u me bash x`, `env FOO=1 bash x`, `timeout 5 bash x`. Matching only a
# prefix glued to the interpreter turned every one of those into a free pass.
_hd_pre='(sudo|doas|env|command|nohup|timeout|time|nice|ionice|stdbuf|setsid)'
_hd_pre="${_hd_pre}([[:space:]]+(-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?"
_hd_pre="${_hd_pre}|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|[0-9][^[:space:]]*))*[[:space:]]+"
_hd_run='bash|sh|zsh|ksh|dash|ash|fish|tcsh|csh|source|eval|exec|xargs'
_hd_run="${_hd_run}|python[0-9.]*|node|deno|bun|perl|ruby|osascript"
_hd_exec='(^|[;&|])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*'
_hd_exec="${_hd_exec}(${_hd_pre})*"
# `\$[A-Za-z_]` covers a runner named by a plain VARIABLE (`$SHELL x`). The
# BRACED form (`${SH} x`) is NOT covered and is one of the declared escapes: the
# same wrapper normalization that puts `{ bash x; }` back in command position
# collapses `{` to a space, so `${SH}` reaches the tell as `$ SH`. Catching it
# would mean teaching that normalization about `$`-prefixed braces — a change to
# a security-sensitive transform, worth its own unit.
# Why catching the plain form is safe: a variable in command position is never a
# legitimate WRITER, so the false-positive cost is ~0 and the declared frontier
# stays complete — which is what the denylist trade-off rests on (#462).
_hd_exec="${_hd_exec}((${_hd_run})([[:space:]]|\$)|\.[[:space:]]|[.~]?/|\\\$[A-Za-z_])"
# The tell reads a NORMALIZED copy, never the raw skeleton: `_hd_exec` anchors on
# `^`/`;&|`, so any wrapper between the boundary and the interpreter used to hide
# it. The transforms are FIX C's (below) plus quote REMOVAL, which is what puts
# `(bash x)`, `{ bash x; }`, `\bash x`, `"bash" x` and `command bash x` back in
# command position. Unquoting is safe HERE and not below: its only effect is
# deciding whether to fall back to the whole command, i.e. to the pre-#462
# behaviour — it never reaches the rules, so a quoted skip-flag is untouched.
if [ "$_hd_whole" = 1 ] || printf '%s' "$skeleton" | sed -E \
  -e "s/(^|[;&|]|[[:space:]])command[[:space:]]+/\1/g" \
  -e "s/\\\\([A-Za-z])/ \1/g" \
  -e "s/[(){}]/ /g" \
  -e "s/'([^']*)'/\1/g" \
  -e 's/"([^"]*)"/\1/g' | grep -qE "$_hd_exec"; then
  live="$cmd"
else
  live="$skeleton"
fi
}

navori_inert_segments() {
# Normalized copy used ONLY by the rules below. `$cmd` stays intact for the
# messages. The transforms only add boundaries / drop noise, so they always push
# toward MORE blocking:
#   FIX B — join `\<newline>` continuations into a space and flatten any other
#           newline to `;` (a boundary the rules already handle) so a multi-line
#           `git commit \<NL> --no-verify` is matched as one logical command.
#   FIX C — neutralize wrappers into boundaries: a leading `command ` word, a
#           leading backslash (`\git`), and `(` runs, so `command git …`,
#           `\git …` and `(git …)` read as a plain `git …`.
# `scan` keeps quoted spans intact, so a quoted skip-flag (`git commit
# "--no-verify"`) is still caught — stripping the quotes there was a real bypass.
#
# LINEAR ONLY (#511): what used to be three bash `${var//pat/repl}` passes is
# now `sed`. Those substitutions are quadratic in bash 3.2.57 and `&&` alone
# cost 83s on a 2000-segment command — past the hook's timeout, so the guard was
# killed before evaluating a single rule and the command went through unopposed.
# The newline→`;` pass is simply gone: the split below turns separators BACK
# into newlines, so a newline that stays a newline lands in the same place.
scan=$(printf '%s' "$live" | sed \
  -e :a -e '/\\$/N' -e 's/\\\n/ /' -e ta)   # FIX B: join line continuations
scan=$(printf '%s' "$scan" | sed -E \
  -e "s/(^|[;&|]|[[:space:]])command[[:space:]]+/\1/g" \
  -e "s/\\\\([A-Za-z])/ \1/g" \
  -e "s/\(/ /g")

# SEGMENTS — one segment per LINE, shared by rules 1, 2 and 3.
#
# This is the backbone of the whole file: `grep` and `sed` match LINE BY LINE, so
# once a compound command is split one-segment-per-line, every rule below is
# scoped to a single segment for free — a pattern can no longer pair a `git
# commit` in one segment with a flag in another, and `$` means "end of this
# segment", not "end of the whole command line".
# #307 first did this for the force-push rule with a private copy of the split;
# rules 1 (#A2) and 3 (#A1) had the cross-segment bug it cured, so the split now
# happens ONCE, here, and all three rules read `$segments`.
#
# Each segment is peeled so it STARTS with its command word: leading whitespace
# and `VAR=value` env prefixes go away (`FOO=1 git push …` → `git push …`); the
# `(`, `\` and `command ` wrappers were already neutralized by FIX C above.
#
# Both halves are one `sed` pass each, for the reason stated above the `scan`
# block: the four `${_split//…}` substitutions AND the per-segment string
# builder that replaced them were the guard's whole time budget (37s just
# appending 20k segments). `sed` is linear in both.
# The peel loop is the `:a … ta` branch: it strips ONE `VAR=value` prefix per
# turn, exactly like the `while` it replaces, and `([[:space:]]+|$)` reproduces
# its two endings — more words follow, or the segment was nothing but the
# assignment and collapses to empty.
_split=$(printf '%s' "$scan" | sed \
  -e "s/&&/\\$_nl/g" -e "s/||/\\$_nl/g" -e "s/;/\\$_nl/g" -e "s/|/\\$_nl/g")
segments=$(printf '%s' "$_split" | sed -E \
  -e 's/^[[:space:]]+//' \
  -e :a -e 's/^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*([[:space:]]+|$)//' -e ta)
}
