# Shared worktree resolver — inlined into each gate hook at render time (see the
# include directive in the source scripts + lib/hook-includes.ts). Requires the
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
  # reason: nothing to check it against.
  # Ceiling: two linked worktrees of the SAME repository are indistinguishable
  # this way, so naming a sibling worktree still beats the payload cwd. Both are
  # trees of the repo being protected, so the scan stays inside it. Walk the
  # segments to the one that actually carries the `git commit` if a real command
  # shows up where that is not enough.
  if [ -n "$named" ]; then
    anchor_repo=$(navori_repo_id "$anchor" || true)
    named_repo=$(navori_repo_id "$named" || true)
    if [ -z "$anchor_repo" ] || [ "$named_repo" != "$anchor_repo" ]; then
      named=""
    fi
  fi
  navori_first_tree "$named" "$payload_cwd" "$PWD" || true
}
