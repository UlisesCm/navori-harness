## Session startup

On Claude, a `SessionStart` hook injects the live context — branch, recent commits, and the previous session's `progress/current.md` — at the top of the session; read it to resume. Otherwise, read `progress/current.md` yourself. Then, before touching code:

1. **Healthy config**: run `navori doctor` if `navori.config.json` / `.claude/` look inconsistent, or to confirm the declared quality gates can actually run.
2. **Scoped task**: one **user** task at a time; decompose and parallelize per your orchestrator role.
