## Cierre de sesión

Antes de cerrar la sesión:

1. **Quality gate**: corré `{{qualityGate.full}}` y confirmá que pasa (o documentá deuda en `progress/current.md`).
2. **History**: agregá entrada en `progress/history.md` con `## YYYY-MM-DD HH:MM <agente> — <resumen>` + cambios + estado del gate.
3. **Vaciar current**: dejá `progress/current.md` en estado `idle` o con el siguiente paso explícito.
4. **Sin temporales**: borrá scratch files, no dejes `console.log`, `debugger`, ni código comentado.
5. **Commit Conventional**: `feat|fix|chore|docs(scope): mensaje`, español MX, atómico. Nunca commitear `.claude/` ni `CLAUDE.md`.
