## Cierre de sesión

Antes de cerrar la sesión:

1. **Quality gate**: corre `{{qualityGate.full}}` y confirma que pasa (o documenta deuda en `progress/current.md`).
2. **History**: agrega entrada en `progress/history.md` con `## YYYY-MM-DD HH:MM <agente> — <resumen>` + cambios + estado del gate.
3. **Vaciar current**: deja `progress/current.md` en estado `idle` o con el siguiente paso explícito.
4. **Sin temporales**: borra scratch files, no dejes `console.log`, `debugger`, ni código comentado.
5. **Commit Conventional**: `feat|fix|chore|docs(scope): mensaje`, español MX, atómico. Nunca commitear `.claude/` ni `CLAUDE.md`.
