<!-- navori:managed id="arranque-sesion" hash="653a3a64" version="0.12.5" source="@navori/core" -->
## Session startup

On Claude, a `SessionStart` hook injects the live context at the top of the session; read it to resume. Then, before touching code:

1. **Healthy config**: run `navori doctor` if `navori.config.json` / `.claude/` look inconsistent, or to confirm the declared quality gates run.
2. **Scoped task**: one **user** task at a time; decompose and parallelize per your orchestrator role.

**Audit mode on request**: when the user asks for it in any wording ("audit mode", "con auditoría", "navori audit"), run `navori audit --start <this session's id>` as that turn's FIRST action, before any skill or pipeline, and confirm the log path it prints. The phrase alone activates nothing; the command is the only switch. If the injected context says audit-mode is ACTIVE (`navori audit --arm`, which also reaches a RUNNING session on its next message), do not start it again or ask the user to reopen the session.
<!-- /navori:managed id="arranque-sesion" -->
