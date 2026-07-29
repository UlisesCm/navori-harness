## Session startup

Before touching code, validate the harness is healthy:

1. **Context**: read `CLAUDE.md` (your orchestrator role + the `## Available agents` catalog) and `progress/current.md` to resume the previous session. If the repo uses persistent memory, recover it.
2. **Healthy config**: if `navori.config.json` or `.claude/` look inconsistent, run `navori doctor` before continuing.
3. **Gates ready**: the quality gates the repo declares actually run (binaries on PATH, toolchains bootstrapped). A declared gate that doesn't execute is silent debt — install it or note it in `progress/current.md`.
4. **Working branch**: confirm you're not on the base branch (`{{branchBase}}`).
5. **Scoped task**: one **user** task at a time (don't mix requests); you decompose it into sub-tasks and, if they're independent, launch them in parallel — see your orchestrator role.

Mirror of **Session closeout** (below): start healthy, close clean.
