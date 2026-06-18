## Arranque de sesión

Antes de tocar código, validá que el harness está sano (checkpoint de arranque):

1. **Contexto**: leé `CLAUDE.md`, `.claude/AGENTS.md` (si existe) y `progress/current.md` para retomar dónde quedó la sesión anterior. Si el repo usa memoria persistente, recuperá contexto previo.
2. **Config sana**: si `navori.config.json` o `.claude/` se ven inconsistentes, corré `navori doctor` antes de seguir.
3. **Gates listos**: los quality gates que el repo declara corren de verdad (binarios en PATH, toolchains opt-in bootstrapeados). Un gate declarado que no ejecuta es deuda silenciosa — instalalo o anotá la deuda en `progress/current.md`.
4. **Branch de trabajo**: confirmá que no estás sobre la branch base (`{{branchBase}}`).
5. **Tarea acotada**: tené claro el alcance de ESTA tarea antes de empezar. Una tarea a la vez; si el pedido trae varias, descomponé primero.

Este checkpoint es el espejo de **Cierre de sesión** (más abajo): arrancás sano, cerrás limpio.
