## Arranque de sesión

Antes de tocar código, valida que el harness está sano:

1. **Contexto**: lee `CLAUDE.md` (tu rol de orquestador + el catálogo `## Agentes disponibles`) y `progress/current.md` para retomar la sesión anterior. Si el repo usa memoria persistente, recupérala.
2. **Config sana**: si `navori.config.json` o `.claude/` se ven inconsistentes, corre `navori doctor` antes de seguir.
3. **Gates listos**: los quality gates que el repo declara corren de verdad (binarios en PATH, toolchains bootstrapeados). Un gate declarado que no ejecuta es deuda silenciosa — instálalo o anótalo en `progress/current.md`.
4. **Branch de trabajo**: confirma que no estás sobre la branch base (`{{branchBase}}`).
5. **Tarea acotada**: una tarea **de usuario** a la vez (no mezcles pedidos); tú la descompones en sub-tareas y, si son independientes, las lanzas en paralelo — ver tu rol de orquestador.

Espejo de **Cierre de sesión** (más abajo): arrancas sano, cierras limpio.
