## Arranque de sesión

Antes de tocar código, valida que el harness está sano (checkpoint de arranque):

1. **Contexto**: lee `CLAUDE.md`, `.claude/AGENTS.md` (si existe) y `progress/current.md` para retomar dónde quedó la sesión anterior. Si el repo usa memoria persistente, recupera contexto previo.
2. **Config sana**: si `navori.config.json` o `.claude/` se ven inconsistentes, corre `navori doctor` antes de seguir.
3. **Gates listos**: los quality gates que el repo declara corren de verdad (binarios en PATH, toolchains opt-in bootstrapeados). Un gate declarado que no ejecuta es deuda silenciosa — instálalo o anota la deuda en `progress/current.md`.
4. **Branch de trabajo**: confirma que no estás sobre la branch base (`{{branchBase}}`).
5. **Tarea acotada**: ten claro el alcance de ESTA tarea antes de empezar. Una tarea a la vez; si el pedido trae varias, descompón primero.

Este checkpoint es el espejo de **Cierre de sesión** (más abajo): arrancas sano, cierras limpio.
