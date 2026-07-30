## Session startup

On Claude, a `SessionStart` hook injects the live context — branch, recent commits, and the previous session's `progress/current.md` — at the top of the session; read it to resume. Otherwise, read `progress/current.md` yourself. Then, before touching code:

1. **Healthy config**: run `navori doctor` if `navori.config.json` / `.claude/` look inconsistent.
2. **Gates ready**: the declared quality gates actually run (binaries on PATH). A gate that doesn't execute is silent debt — install it or note it in `progress/current.md`.
3. **Working branch**: confirm you're not on the base branch (`{{branchBase}}`).
4. **Scoped task**: one **user** task at a time; decompose and parallelize per your orchestrator role.
