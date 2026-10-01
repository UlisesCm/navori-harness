# Shared Bash-outcome helpers (spec 0039 R6/R7, carry-over 0038 D1) — inlined at
# render time. Defines functions only: nothing runs on include, so a hook that
# carries this partial pays parse time and no process.
#
# Depends on `payload`/`payload_field` (`extract-cmd`) and `nv_project_dir` /
# `nv_progress_dir` (`hook-input`); include both in the same script.
#
# THE SUCCESS LANE. The host runs a criterion's `command` in its own Bash tool;
# `PostToolUse` fires only on success, so this lane's very firing is the success
# signal. It appends ONE line per matching pending criterion to
# `<state dir>/workplan_<feature>.evidence.jsonl`, which `plan update` compares
# against the criterion and the current tree (`lib/plan/evidence.ts`). It never
# runs the criterion's command and never writes anything but that line.
#
# FAIL-OPEN, NO PARTIAL LINE. Every path returns 0. The line is built entirely in
# memory and written by a single `printf >>` as the LAST step, so a kill at any
# earlier point (the tree fingerprint is the slow part) leaves no line at all and
# `plan update` rejects with "no run recorded".
#
# FAST PATH, BUILTINS ONLY. `acceptance-index` (rewritten by the CLI) holds
# `<command JSON-escaped>\t<feature>\t<A<n>>\t<state dir>` per pending
# criterion. The command is matched as the EXACT JSON string value of
# `"command"` in the raw payload — no decoding, no normalization, no process.
# A `tool_response` cannot forge a match: inside it every quote is `\"`.

# Git with the repo-controlled code paths neutralized (invariant 9): fsmonitor is
# a command git runs on index refresh, hooksPath redirects hooks. Same flags as
# `GIT_HARDENING` in `lib/plan/evidence.ts`.
navori_git() {
  git -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
}

# Content hash of the whole working tree — the SAME procedure as
# `fingerprintTree` in `lib/plan/evidence.ts`, which `plan update` re-runs to
# compare (change one, change both): no `git add` (filters/fsmonitor), blobs by
# `hash-object --no-filters`, a scratch index, `write-tree`. Prints the tree hash
# or returns 1. Exec bit is `[ -x ]` where the TypeScript side tests
# `mode & 0o111`; they differ only for a file executable by group/other but not
# by its owner, which then fails safe (plan update asks for a rerun).
navori_tree_fingerprint() {
  (
    cd "$1" 2>/dev/null || exit 1
    scratch=$(navori_git rev-parse --path-format=absolute --git-path navori-fp-index 2>/dev/null) || exit 1
    [ -n "$scratch" ] || exit 1
    [ ! -e "$scratch.lock" ] || exit 1
    work=$(mktemp -d "${TMPDIR:-/tmp}/navori-fp.XXXXXX" 2>/dev/null) || exit 1
    trap 'rm -f "$work"/list "$work"/files "$work"/links "$work"/paths "$work"/shas; rmdir "$work" 2>/dev/null' EXIT
    navori_git ls-files -z --cached --others --exclude-standard --deduplicate -- . \
      ':(exclude).navori/state' ':(exclude).claude/progress' ':(exclude).codex/progress' \
      ':(exclude).claude/worktrees' > "$work/list" 2>/dev/null || exit 1
    : > "$work/links"
    while IFS= read -r -d '' p; do
      case "$p" in *$'\n'*) exit 1 ;; esac
      if [ -L "$p" ]; then
        target=$(readlink "./$p") || exit 1
        sha=$(printf '%s' "$target" | navori_git hash-object -w --no-filters --stdin 2>/dev/null) || exit 1
        [ -n "$sha" ] || exit 1
        printf '120000 %s\t%s\n' "$sha" "$p" >&3
      elif [ -f "$p" ]; then
        if [ -x "$p" ]; then mode=100755; else mode=100644; fi
        printf '%s\t%s\n' "$mode" "$p"
      fi
    done < "$work/list" > "$work/files" 3>> "$work/links"
    if [ -s "$work/files" ]; then
      cut -f2- "$work/files" > "$work/paths"
      navori_git hash-object -w --no-filters --stdin-paths < "$work/paths" > "$work/shas" 2>/dev/null || exit 1
      [ "$(wc -l < "$work/paths" | tr -d ' ')" = "$(wc -l < "$work/shas" | tr -d ' ')" ] || exit 1
      awk -F'\t' 'NR==FNR { m[FNR]=$1; p[FNR]=substr($0, index($0, "\t")+1); next } { printf "%s %s\t%s\n", m[FNR], $0, p[FNR] }' \
        "$work/files" "$work/shas" >> "$work/links" || exit 1
    fi
    export GIT_INDEX_FILE=$scratch
    navori_git read-tree --empty >/dev/null 2>&1 || exit 1
    if [ -s "$work/links" ]; then
      tr '\n' '\0' < "$work/links" | navori_git update-index --add -z --index-info >/dev/null 2>&1 || exit 1
    fi
    navori_git write-tree 2>/dev/null
  )
}

# Escapes backslash and double quote for a JSON string value; prints it.
navori_json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

# Called by `routing-watch.sh` once it knows the tool is `Bash`, and only under
# `claude-post-tool-use` (Codex fires PostToolUse on failure too, so no signal).
navori_bash_success_lane() {
  local idx=$nv_project_dir/$nv_progress_dir/acceptance-index
  [ -s "$idx" ] || return 0
  # A backgrounded call "succeeds" when it LAUNCHES, not when it finishes; an
  # interrupted one did not complete.
  case "$payload" in
    *'"run_in_background":true'* | *'"interrupted":true'*) return 0 ;;
  esac
  local c f i d hits=
  while IFS=$'\t' read -r c f i d; do
    [ -n "$c" ] || continue
    case "$payload" in
      *'"command":"'"$c"'"'[,}]*) hits="$hits$c"$'\t'"$f"$'\t'"$i"$'\t'"$d"$'\n' ;;
    esac
  done < "$idx"
  [ -n "$hits" ] || return 0

  # Slow path: exactly one criterion command ran. Everything is computed first,
  # the write is last.
  local cwd tree head wt htree dirty sid agent ts root
  cwd=$(payload_field cwd)
  [ -n "$cwd" ] || return 0
  tree=$(navori_git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || return 0
  case "$cwd$tree" in *[[:cntrl:]]*) return 0 ;; esac
  head=$(navori_git -C "$tree" rev-parse HEAD 2>/dev/null) || head=
  wt=$(navori_tree_fingerprint "$tree") || return 0
  [ -n "$wt" ] || return 0
  htree=$(navori_git -C "$tree" rev-parse 'HEAD^{tree}' 2>/dev/null) || htree=
  dirty=true
  [ "$wt" = "$htree" ] && dirty=false
  sid=$(payload_field session_id | tr -cd 'A-Za-z0-9._-')
  agent=$(payload_field agent_id | tr -cd 'A-Za-z0-9._-')
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  root=$(pwd -P 2>/dev/null) || root=$nv_project_dir

  local line extra file
  while IFS=$'\t' read -r c f i d; do
    [ -n "$f" ] || continue
    # The index is CLI-written state, but the hook is the one that opens a path
    # taken from it: slug and id shapes, an absolute directory inside this
    # project, no symlinks.
    case "$f" in *[!a-z0-9._-]* | [!a-z0-9]*) continue ;; esac
    case "$i" in
      A[0-9]*) case "${i#A}" in *[!0-9]*) continue ;; esac ;;
      *) continue ;;
    esac
    case "$d" in "$root"/* | "$nv_project_dir"/*) ;; *) continue ;; esac
    case "$d" in *[[:cntrl:]]* | */../* | */..) continue ;; esac
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    file=$d/workplan_$f.evidence.jsonl
    [ ! -L "$file" ] || continue
    # `$c` is already JSON-escaped: it is the index's own field.
    extra=
    [ -z "$sid" ] || extra=$extra',"sessionId":"'$sid'"'
    [ -z "$agent" ] || extra=$extra',"agentId":"'$agent'"'
    line='{"ts":"'$ts'","feature":"'$f'","id":"'$i'","command":"'$c'","tree":"'$(navori_json_str "$tree")'","cwd":"'$(navori_json_str "$cwd")'","head":"'$head'","worktreeTree":"'$wt'","dirty":'$dirty$extra'}'
    printf '%s\n' "$line" >> "$file" 2>/dev/null || true
  done <<NAVORI_HITS
$hits
NAVORI_HITS
  return 0
}
