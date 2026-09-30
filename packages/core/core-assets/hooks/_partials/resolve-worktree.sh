# Shared worktree resolver — inlined into each gate hook at render time (see the
# include directive in the source scripts + lib/render/hook-includes.ts). Requires the
# `extract-cmd` partial to have run first ($payload and $cmd in scope).
#
# WHY (#454): settings.json invokes these hooks as
# `bash "$CLAUDE_PROJECT_DIR/.claude/scripts/check-semgrep.sh"`, so the hook
# PROCESS starts in the MAIN repo even when the commit happens inside an agent
# worktree under `.claude/worktrees/`. The old `cd "$(git rev-parse
# --show-toplevel)"` therefore resolved the main repo — whose tree is clean — so
# `git diff --name-only main` returned 0 files and the gate exited 0. Not a false
# negative from the scanner: the scanner never ran. A `cd` to an arbitrary tree
# is exactly the bug, so nothing below ever guesses: every candidate must prove
# it is a git working tree, or the next one is tried — and the one the COMMAND
# names must additionally prove it is part of the repository being protected
# (see the same-repository constraint in `navori_worktree`).
#
# `navori_worktree` prints the absolute root of the working tree the gated git
# command will act on, or nothing when none resolves. It is a FUNCTION, not a
# top-level assignment, because `quality-gate-pre-commit` inlines this partial on
# a path that runs on EVERY Bash tool call: callers pay the git/jq probes only
# after their own trigger matched.

# First shell token of $1: a leading single/double-quoted string (so a path with
# spaces survives) or an unquoted run of non-space characters.
navori_first_token() {
  local s="$1"
  case "$s" in
    \"*) s="${s#\"}"; printf '%s' "${s%%\"*}" ;;
    \'*) s="${s#\'}"; printf '%s' "${s%%\'*}" ;;
    *) printf '%s' "${s%%[[:space:]]*}" ;;
  esac
}

# Directory named by the command itself, if any. Two shapes, both real in this
# harness: `git -C <dir> commit …` (git names its own tree) and
# `cd <dir> && git commit …` (how an agent commits into its worktree from a
# session anchored elsewhere). Prints the raw token; the caller resolves it.
#
# TODO(scope): only the FIRST segment is inspected for `cd`. A `cd` buried
# mid-chain (`pnpm build && cd sub && git commit`) falls through to the payload
# cwd, which is right whenever that `cd` stays inside the same repo. Walk the
# segments if a real command shows up where it does not.
navori_cmd_dir() {
  local text="$1" rest="" head=""
  case "$text" in
    *"git -C "*)
      rest="${text#*git -C }"
      ;;
    *)
      head="${text%%&&*}"
      head="${head#"${head%%[![:space:]]*}"}"
      case "$head" in
        "cd "*) rest="${head#cd }" ;;
      esac
      ;;
  esac
  [ -n "$rest" ] || return 1
  rest="${rest#"${rest%%[![:space:]]*}"}"
  # A token that needs the shell to expand it ($VAR, `sub`, ~, globs) is NOT
  # resolved here: guessing wrong points the scan at the wrong tree, which is
  # the very failure this partial exists to kill. Ignoring it just falls through
  # to the next candidate.
  case "$rest" in
    ""|*'$'*|*'`'*|*'*'*|*'?'*|"~"*) return 1 ;;
  esac
  navori_first_token "$rest"
}

# Absolute, symlink-resolved path of a working tree's SHARED git dir, or nothing
# when $1 is not inside a git working tree. `--git-common-dir` names the `.git`
# of the MAIN checkout, so every linked worktree of one repository — and every
# subdirectory of it — reports the SAME value, while a different repository
# reports its own and a submodule reports `<main>/.git/modules/<name>`. That
# makes it an identity test for "same repository", which `--show-toplevel` (one
# per working tree) and `--git-dir` (one per worktree) are not.
navori_repo_id() {
  local dir="$1" common=""
  common=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null) || return 1
  [ -n "$common" ] || return 1
  # `git -C <dir>` chdirs to <dir> first, so a relative answer (`.git`,
  # `../../.git`) is relative to <dir>. `pwd -P` canonicalises both sides the
  # same way, which also settles macOS's /var vs /private/var symlink.
  (cd "$dir" && cd "$common" && pwd -P) 2>/dev/null
}

# First argument that resolves to a git working tree; prints its root.
navori_first_tree() {
  local candidate toplevel
  for candidate in "$@"; do
    [ -n "$candidate" ] || continue
    [ -d "$candidate" ] || continue
    toplevel=$(git -C "$candidate" rev-parse --show-toplevel 2>/dev/null) || continue
    [ -n "$toplevel" ] || continue
    printf '%s' "$toplevel"
    return 0
  done
  return 1
}

# Hook's own path, captured HERE at the partial's top level (every consumer inlines
# it at script top level). NEVER read `$0` inside a `navori_*` function: zsh sets it
# to the function's name there (FUNCTION_ARGZERO). Used only as a string, never
# resolved. A relative path is anchored on the hook's cwd, where the shell found it.
navori_hook_path="$0"
case "$navori_hook_path" in /*) ;; *) navori_hook_path="$PWD/$navori_hook_path" ;; esac
navori_home_id=""
navori_home_done=0

# HOME repository (#1099): the repo this hook protects, as a repo id in
# `navori_home_id` (empty = unknown). Known only if ALL hold:
#   - `CLAUDE_PROJECT_DIR` is non-empty;
#   - the hook's own path is exactly `${CLAUDE_PROJECT_DIR%/}/.claude/hooks/<file>`
#     or `.../.claude/scripts/<file>` (how settings.json registers it). A bare
#     prefix is not enough: a leaked variable plus a hook of a repo NESTED under it
#     would make the outer repo "home" and skip every gate of the inner one. `.codex/`
#     never qualifies, so a Codex hook is always home-unknown;
#   - that directory resolves to a repo id.
# Any doubt means unknown, and unknown never produces `foreign` without a `cd`/`-C`
# in the command. Memoised: the callers pay the git fork once. Sets a global (no
# subshell); declares locals once at the top (zsh prints a re-declared `local`).
navori_home_resolve() {
  local cpd rest file
  [ "$navori_home_done" = 0 ] || return 0
  navori_home_done=1
  cpd="${CLAUDE_PROJECT_DIR:-}"
  [ -n "$cpd" ] || return 0
  cpd="${cpd%/}"
  case "$navori_hook_path" in
    "$cpd"/*) rest="${navori_hook_path#"$cpd"/}" ;;
    *) return 0 ;;
  esac
  case "$rest" in
    .claude/hooks/*|.claude/scripts/*) file="${rest#.claude/*/}" ;;
    *) return 0 ;;
  esac
  case "$file" in ""|.|..|*/*) return 0 ;; esac
  navori_home_id=$(navori_repo_id "$CLAUDE_PROJECT_DIR" || true)
  return 0
}

# Resolution, most specific first:
#   1. the directory the command names (`git -C` / a leading `cd`), ONLY when it
#      belongs to the same repository as the anchor (see the constraint below);
#   2. the payload's `.cwd` — Claude Code sends the CURRENT working directory of
#      the tool call, a documented field distinct from $CLAUDE_PROJECT_DIR (the
#      project root). In an agent worktree these differ; that gap IS #454;
#   3. the hook process's own cwd — the pre-#454 behaviour, still correct for a
#      plain terminal or git-hook invocation.
navori_worktree() {
  local payload_cwd anchor named anchor_repo="" named_repo=""
  payload_cwd=$(payload_field cwd)
  # A relative `cd sub` resolves against the shell's cwd, which is the payload's
  # when Claude Code sends one and the hook process's otherwise.
  anchor="$payload_cwd"
  [ -d "$anchor" ] || anchor="$PWD"
  named=$(navori_cmd_dir "$cmd" || true)
  case "$named" in
    "") ;;
    /*) ;;
    *) named="$anchor/$named" ;;
  esac
  # SAME-REPOSITORY CONSTRAINT — DO NOT REMOVE (#454, review finding).
  # Candidate 1 is the only one the COMMAND controls, and it is tried first, so
  # accepting any git tree it happens to name lets that command OVERRIDE the
  # trustworthy candidates below it: `git -C <other-repo> log && git commit`,
  # `cd <other> && cd <wt> && git commit`, `cd <sub> && cd .. && git commit`, or
  # merely the bytes `git -C <path>` inside a commit MESSAGE, all aimed the scan
  # at a foreign tree with nothing to scan — exit 0 with the scanner never run,
  # which is the very failure #454 is about (and, for a commit in the main repo,
  # strictly worse than not resolving worktrees at all).
  # So a directory the command names is accepted only when it is part of the
  # repository the hook is protecting, i.e. the anchor's. Linked worktrees share
  # the main checkout's git dir, so every legitimate agent worktree passes; a
  # different repository and a submodule (its own git dir under
  # `<main>/.git/modules/`) do not, and fall through to the payload cwd — the
  # stricter direction. An unresolvable anchor drops candidate 1 for the same
  # reason: nothing to check it against — unless the named dir IS the hook's home
  # repo (#1099: the session sits in another repo but the command names the
  # protected one), which only ever moves the scan toward the protected repo.
  # Ceiling: two linked worktrees of the SAME repository are indistinguishable
  # this way, so naming a sibling worktree still beats the payload cwd. Both are
  # trees of the repo being protected, so the scan stays inside it. Walk the
  # segments to the one that actually carries the `git commit` if a real command
  # shows up where that is not enough.
  if [ -n "$named" ]; then
    anchor_repo=$(navori_repo_id "$anchor" || true)
    named_repo=$(navori_repo_id "$named" || true)
    navori_home_resolve
    if [ -z "$named_repo" ] || { [ "$named_repo" != "$anchor_repo" ] && [ "$named_repo" != "$navori_home_id" ]; }; then
      named=""
    fi
  fi
  navori_first_tree "$named" "$payload_cwd" "$PWD" || true
}

# ─── Where does the commit LAND? (#1095) ────────────────────────────────────────
# `navori_worktree` above answers "which tree do I scan"; this answers "is the
# commit even for the repository this gate protects". A commit that provably
# lands in ANOTHER repository (`cd <other> && git commit`, `git -C <other>
# commit`) must not be gated against the anchor's tree: that tree holds none of
# the diff. Classification is a POSITIVE grammar with a deny-list of ambiguity —
# `foreign` only when every step to the commit has a certain cwd effect and the
# resolved repository really differs; the commit message is never read (#454:
# `git commit -m "use git -C <other>"` lands in the anchor). Anything unsure is
# `ambiguous`, which callers treat exactly like `same-repo`: run the gate.
#
# Requires the `gate-trigger` partial (navori_count_triggers, $TRIGGER_RE) and
# `extract-cmd` (payload_field). Always returns 0 and sets, without a subshell:
#   navori_landing       same-repo | foreign | ambiguous
#   navori_landing_root  landing toplevel (foreign only)
# "foreign" means the command's landing repo differs from the repository this hook
# protects (#1099). With no `cd`/`-C` the landing dir IS the payload cwd, so a
# session anchored in another repo is foreign too. The protected repo is the HOME
# id (`navori_home_resolve`); when home is unknown the comparison degrades to the
# #1095 rule (payload-cwd repo, widened by the raw `CLAUDE_PROJECT_DIR` repo, which
# can only turn `foreign` into `same-repo`) and a command without `cd`/`-C` is
# `same-repo` with no fork. "commit" below means the one gated op.
#
# The gated op (#1098) is whatever the caller's $TRIGGER_RE counts: `git commit`
# for QG and jscpd, plus `git push` and `gh pr create` for semgrep. The walk
# matches that same regex, so there is no second copy to drift. `gh pr create`
# lands in the cwd's repo unless it names another one (`-R`/`--repo`/`GH_REPO`),
# which is `ambiguous` (the scan runs).
# Ceiling (#1115): several gated ops in one call (`git commit && git push`)
# stay `ambiguous`.

# Reads one shell token off the front of $1 into `navori_tok` / `navori_rest`.
# Returns 1 for anything the shell would expand or that is malformed, so the
# caller falls back to `ambiguous`.
navori_take_token() {
  local s="$1" nl=$'\n'
  navori_tok=""; navori_rest=""
  s="${s#"${s%%[![:space:]]*}"}"
  case "$s" in
    \'*)
      s="${s#\'}"
      case "$s" in *\'*) ;; *) return 1 ;; esac
      navori_tok="${s%%\'*}"; navori_rest="${s#*\'}"
      case "$navori_rest" in ""|[[:space:]]*) ;; *) return 1 ;; esac
      ;;
    \"*)
      s="${s#\"}"
      case "$s" in *\"*) ;; *) return 1 ;; esac
      navori_tok="${s%%\"*}"; navori_rest="${s#*\"}"
      case "$navori_rest" in ""|[[:space:]]*) ;; *) return 1 ;; esac
      ;;
    *)
      navori_tok="${s%%[[:space:]]*}"; navori_rest="${s#"$navori_tok"}"
      case "$navori_tok" in
        *';'*|*'|'*|*'&'*|*'<'*|*'>'*|*'('*|*')'*|*"'"*|*'"'*) return 1 ;;
      esac
      ;;
  esac
  case "$navori_tok" in
    ""|'~'*|*'$'*|*'`'*|*'\'*|*'*'*|*'?'*|*'['*|*'{'*|*"$nl"*) return 1 ;;
  esac
  return 0
}

navori_commit_landing() {
  local c rest seg first tailtxt p arg dir base pcwd top sub id_l id_a id_h
  local cd_dir="" c_dir="" found=0 more=1 cdcount=0 nc=0 rel=0 isgh=0 nl=$'\n'
  navori_landing="ambiguous"; navori_landing_root=""

  # A single gated op only: a second commit (or, in semgrep, a push) makes the
  # landing repo of "the" commit undefined.
  navori_count_triggers "$1" 0
  [ "$navori_trigger_hits" = 1 ] || return 0

  navori_strip_heredoc_bodies "$1"
  c="$navori_heredoc_stripped"
  c="${c//\\$'\n'/ }"

  # Walk the `&&` chain up to the commit segment; every earlier segment must be a
  # single `cd <literal>` (at most one) or a neutral `git …` that cannot move the
  # shell's cwd or env.
  rest="$c"
  while [ "$more" = 1 ]; do
    case "$rest" in
      *'&&'*) seg="${rest%%&&*}"; rest="${rest#*&&}" ;;
      *) seg="$rest"; rest=""; more=0 ;;
    esac
    seg="${seg#"${seg%%[![:space:]]*}"}"
    first="${seg%%"$nl"*}"
    case "$first" in
      git[[:space:]]*|gh[[:space:]]*)
        if printf '%s' "$first" | grep -qE "$TRIGGER_RE"; then found=1; break; fi
        ;;
    esac
    case "$seg" in *"$nl"*) return 0 ;; esac
    seg="${seg%"${seg##*[![:space:]]}"}"
    case "$seg" in
      cd[[:space:]]*)
        [ "$cdcount" = 0 ] || return 0
        cdcount=1
        navori_take_token "${seg#cd}" || return 0
        case "$navori_rest" in *[![:space:]]*) return 0 ;; esac
        cd_dir="$navori_tok"
        case "$cd_dir" in -*) return 0 ;; esac
        ;;
      git[[:space:]]*)
        case "$seg" in
          *';'*|*'|'*|*'&'*|*'<'*|*'>'*|*'('*|*')'*|*'$'*|*'`'*) return 0 ;;
        esac
        ;;
      *) return 0 ;;
    esac
  done
  [ "$found" = 1 ] || return 0

  case "$first" in
  gh[[:space:]]*)
    # `gh pr create`: no global -C, so it lands where the cwd (or the `cd`) is —
    # unless it names another repo, which the parser will not follow. Any `-R` or
    # `--repo` anywhere in the segment (message text included) reads as ambiguous.
    p="${first#gh}"
    navori_take_token "$p" || return 0
    [ "$navori_tok" = pr ] || return 0
    navori_take_token "$navori_rest" || return 0
    [ "$navori_tok" = create ] || return 0
    case "$seg" in *'-R'*|*'--repo'*) return 0 ;; esac
    [ -z "${GH_REPO:-}" ] || return 0
    isgh=1
    ;;
  *) p="${first#git}" ;;
  esac
  # The gated segment's own git global options, positionally. Text after
  # `commit`/`push` (the message) is never read; a gh segment was validated above.
  while [ "$isgh" = 0 ]; do
    navori_take_token "$p" || return 0
    arg="$navori_tok"; p="$navori_rest"
    case "$arg" in
      commit|push) break ;;
      -C)
        [ "$nc" = 0 ] || return 0
        nc=1
        navori_take_token "$p" || return 0
        c_dir="$navori_tok"; p="$navori_rest"
        ;;
      -c) navori_take_token "$p" || return 0; p="$navori_rest" ;;
      --no-pager|-p|--paginate|-P|--no-optional-locks|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-replace-objects) ;;
      *) return 0 ;;
    esac
  done

  # Anything that runs AFTER the commit and could re-enter git, cd or a shell
  # (a second, uncounted commit landing elsewhere) makes the verdict unsafe.
  tailtxt="${seg#"$first"}$nl$rest"
  case "$first" in *';'*|*'|'*|*'&'*) tailtxt="${first#*[;|&]}$nl$tailtxt" ;; esac
  if navori_mentions_shellish "$tailtxt"; then return 0; fi

  # No cd/-C: the landing dir is the payload cwd. Without a PROVEN home there is
  # nothing to compare it with, so today's answer (and zero forks) stands.
  if [ -z "$cd_dir" ] && [ -z "$c_dir" ]; then
    navori_home_resolve
    if [ -z "$navori_home_id" ]; then navori_landing="same-repo"; return 0; fi
  else
    navori_home_resolve
  fi

  pcwd=$(payload_field cwd)
  base="$pcwd"
  [ -d "$base" ] || base="$PWD"
  dir="$base"
  if [ -n "$cd_dir" ]; then
    case "$cd_dir" in
      /*) dir="$cd_dir" ;;
      *)
        rel=1; dir="$base/$cd_dir"
        # A non-empty CDPATH can make `cd <relative>` land somewhere else.
        [ -z "${CDPATH:-}" ] || return 0
        ;;
    esac
  fi
  if [ -n "$c_dir" ]; then
    case "$c_dir" in
      /*) dir="$c_dir"; rel=0 ;;
      *) rel=1; dir="$dir/$c_dir" ;;
    esac
  fi
  # `..` in a relative path resolves logically in the shell but physically in
  # the kernel; they differ when the base itself sits behind a symlink.
  if [ "$rel" = 1 ]; then
    case "$cd_dir$nl$c_dir" in
      *'..'*) [ "$(cd "$base" 2>/dev/null && pwd -P)" = "$base" ] || return 0 ;;
    esac
  fi

  [ -d "$dir" ] || return 0
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || return 0
  [ -n "$top" ] || return 0
  # A submodule target (or cwd) is deliberately not `foreign` (its commit is part
  # of the superproject's work): the anchor's gate runs.
  sub=$(git -C "$dir" rev-parse --show-superproject-working-tree 2>/dev/null) || return 0
  [ -z "$sub" ] || return 0
  id_l=$(navori_repo_id "$dir" || true)
  [ -n "$id_l" ] || return 0
  if [ -n "$navori_home_id" ]; then
    # Proven home: the one definition of foreign.
    if [ "$id_l" = "$navori_home_id" ]; then
      navori_landing="same-repo"
    else
      navori_landing="foreign"; navori_landing_root="$top"
    fi
    return 0
  fi
  # Home unknown: the #1095 rule.
  id_a=$(navori_repo_id "$base" || true)
  [ -n "$id_a" ] || return 0
  id_h=""
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    id_h=$(navori_repo_id "$CLAUDE_PROJECT_DIR" || true)
  fi
  if [ "$id_l" = "$id_a" ] || { [ -n "$id_h" ] && [ "$id_l" = "$id_h" ]; }; then
    navori_landing="same-repo"
  else
    navori_landing="foreign"; navori_landing_root="$top"
  fi
  return 0
}
