# Blocking classification (#1117):
#   - content search that should go through the index (exit 42 -> exit 2): hard — the remedy
#     (`tgrep search`) is printed on stderr. Missing tgrep or no index fails open (exit 43): advisory.
# tgrep search lane (spec 0039 D6): content search through the shell is routed
# to `tgrep search`. Runs after every destructive rule; the subshell isolates
# the script, so only its exit code 42 (block) or 43 (fail-open) is acted on.
# The script sits in `scripts/`, next to this hook's own `hooks/` directory, under
# both `.claude/` and `.codex/`: resolving it from `$0` keeps the lane engine-neutral.
case "$cmd" in
  *grep*|*rg*)
    navori_search_rc=0
    ( . "$(dirname "$0")/../scripts/guard-search-routing.sh" ) || navori_search_rc=$?
    if [ "$navori_search_rc" -eq 42 ]; then
      navori_audit_verdict="block"
      navori_audit_reason="content search routed to the index"
      exit 2
    fi
    if [ "$navori_search_rc" -eq 43 ]; then
      navori_audit_verdict="fail-open"
      navori_audit_reason="search index unavailable"
    fi
    ;;
esac
