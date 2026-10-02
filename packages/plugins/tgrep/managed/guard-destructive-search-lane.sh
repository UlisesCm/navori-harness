# tgrep search lane (spec 0039 D6): content search through the shell is routed
# to `tgrep search`. Runs after every destructive rule; the subshell isolates
# the script, so only its exit code 42 (block) or 43 (fail-open) is acted on.
case "$cmd" in
  *grep*|*rg*)
    navori_search_rc=0
    ( . "${CLAUDE_PROJECT_DIR:-.}/.claude/scripts/guard-search-routing.sh" ) || navori_search_rc=$?
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
