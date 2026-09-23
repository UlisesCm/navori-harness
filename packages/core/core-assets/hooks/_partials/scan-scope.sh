# Shared scan scope — inlined into the diff-scanning gate hooks at render time
# (see the include directive in the source scripts + lib/render/hook-includes.ts).
# DO NOT copy this body back into a hook by hand: hand-synced copies are how the
# two scanners drifted apart in the first place (#225/#261, and #777 below).
#
# Single source of truth for the two questions every diff scanner answers before
# it runs: WHAT is the baseline, and WHICH files are in scope. `check-semgrep`
# and `check-jscpd` used to answer both with copies that had already diverged —
# jscpd never resolved its base to a sha, so its cache and its scan could name
# different commits.
#
# Requires, from the caller: `$base` (the configured base branch, shell-quoted
# at render time via the `shq:` marker) and a cwd already inside the working
# tree being scanned. `$navori_scan_label` names the caller in every message.

# --- Baseline (#777) ---------------------------------------------------------
# `origin/<base>` FIRST, the local ref only as a fallback.
#
# The local ref carries NO freshness guarantee. An agent worktree is cut from
# whatever `main` pointed at that moment and never moves again, and a main
# checkout nobody pulls is the same shape. A baseline taken from it drifts
# behind every change that lands meanwhile, and the scan then compares against
# a tree that no longer exists anywhere: the diff includes files OTHER changes
# merged, so the gate can BLOCK on findings that are not this diff's — or
# accept, as "already at the baseline", a finding this diff introduces. Both
# happened.
#
# NO network here, on purpose. This runs as a `PreToolUse` hook on every
# `git commit`, so a `fetch` would put a remote round-trip — and its timeouts,
# its auth prompts, its outages — in front of every commit in the repo.
# `origin/<base>` is kept fresh by the pre-flight of the reviewer and the
# publisher, which both fetch before they work; in that cycle the ref is
# already current when the hook reads it. Outside it (an offline clone, a repo
# with no remote) the fallback keeps the previous behaviour exactly.
#
# Sets `$base_ref` (the ref actually used, for messages) and `$base_sha` (its
# commit — resolved to a sha because it is BOTH the scan's baseline and part of
# the content cache's fingerprint, so it has to name one immutable commit).
# Returns 1 when neither ref resolves; the caller skips.
navori_resolve_base() {
  local local_sha="" local_short="" origin_short=""
  base_ref="$base"
  base_sha=$(git rev-parse --verify --quiet "origin/$base^{commit}" 2>/dev/null || true)
  if [ -n "$base_sha" ]; then
    base_ref="origin/$base"
    local_sha=$(git rev-parse --verify --quiet "$base^{commit}" 2>/dev/null || true)
    # The lag itself is normal; the lag being SILENT is what cost a day. One
    # line, only when the two refs actually disagree, so "why was that file
    # scanned" has an answer in the transcript instead of a reconstruction.
    if [ -n "$local_sha" ] && [ "$local_sha" != "$base_sha" ]; then
      local_short=$(git rev-parse --short "$local_sha" 2>/dev/null || printf '%s' "$local_sha")
      origin_short=$(git rev-parse --short "$base_sha" 2>/dev/null || printf '%s' "$base_sha")
      echo "ℹ $navori_scan_label: local '$base' ($local_short) ≠ origin/$base ($origin_short) — baseline is origin/$base" >&2
    fi
    return 0
  fi
  base_sha=$(git rev-parse --verify --quiet "$base^{commit}" 2>/dev/null || true)
  [ -n "$base_sha" ] || return 1
  return 0
}

# --- Files in scope (#777) ---------------------------------------------------
# `git diff` for tracked changes PLUS `git ls-files --others` for untracked
# ones.
#
# The untracked half is not an edge case. These hooks are `PreToolUse`: they run
# BEFORE the command they gate. With `git add new.ts && git commit -m x` in ONE
# Bash call — the batching the harness itself recommends in auto mode — the file
# is still untracked when the scan runs, so a list built from `git diff` alone
# reported `0 files to scan` and the gate went green over a file nobody read.
# Agent work is mostly new files, which made that the common case rather than
# the rare one. `--exclude-standard` keeps ignored build output out: generated
# artifacts are not new code.
#
# The two lists are disjoint by construction (`--others` is precisely what the
# index does not track), so there is nothing to de-duplicate.
#
# Both listings carry a sentinel with their exit status: they run inside a
# process substitution, whose status the shell never reports, so a FAILED
# listing (exit 128: unborn HEAD, a corrupt index, a base that vanished
# mid-run) would otherwise be indistinguishable from "nothing changed" — the
# gate printing `0 files to scan` and exiting 0 over a tree it never read
# (#511). The sentinel can never collide with a real record: the pathspec
# restricts both lists to `*.ts`/`*.tsx`.
#
# Sets `$files` (array) and, on failure, `$scan_files_status`. Returns 1 when
# either listing failed, so the caller can report it as "nothing was scanned"
# rather than as a verdict.
navori_collect_scan_files() {
  local sentinel='@navori-scan-status:' f=""
  scan_files_status=""
  files=()
  while IFS= read -r -d '' f; do
    case "$f" in
      "${sentinel}"*)
        scan_files_status="${f#"${sentinel}"}"
        continue
        ;;
    esac
    files+=("$f")
  done < <(
    # `|| rc=$?` and not a bare `$?`: the subshell inherits `set -e`, which
    # would kill it on a failing git call before the sentinel is ever written.
    rc=0
    git diff --name-only -z --diff-filter=ACMRT "$base_sha" -- '*.ts' '*.tsx' || rc=$?
    if [ "$rc" -eq 0 ]; then
      git ls-files --others --exclude-standard -z -- '*.ts' '*.tsx' || rc=$?
    fi
    printf '%s%s\0' "$sentinel" "$rc"
  )
  [ "$scan_files_status" = "0" ] || return 1
  return 0
}
