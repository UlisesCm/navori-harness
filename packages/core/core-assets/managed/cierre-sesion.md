## Cierre de sesión

Antes de cerrar la sesión:

1. **Quality gate**: {{qualityGate.full}} — confirma que pasa (o documenta deuda en `progress/current.md`).
2. **History**: agrega entrada en `progress/history.md` con `## YYYY-MM-DD HH:MM <agente> — <resumen>` + cambios + estado del gate.
3. **Vaciar current**: deja `progress/current.md` en estado `idle` o con el siguiente paso explícito.
4. **Sin temporales**: borra scratch files, no dejes `console.log`, `debugger`, ni código comentado.
5. **Commit Conventional**: `feat|fix|chore|docs(scope): mensaje`, español MX, atómico. El harness (`.claude/`, `CLAUDE.md`, `AGENTS.md`, `progress/`) se versiona por default; solo `.claude/settings.local.json` es per-user (gitignored). Si el repo optó por gitignorear el harness, respeta su `.gitignore`.
