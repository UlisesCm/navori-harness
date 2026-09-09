# La orquestación cabe en el arranque — Tasks

> **v2 — COMPLETA** (PR #631). T1 de la v1 (injertos en `leader.md`) quedó hecho y se conserva; el T2 de la v1
> (mudar la tabla) quedó **revertido** — #379 la fija en el bloque. El orden entre lotes
> sigue siendo restricción: los injertos (lote 1) preceden a todo retiro (lote 2).

## Lote 1 — Injertar y re-anclar (antes de retirar nada)

- [x] **T1** (R7) — Injertos en `packages/core/core-assets/agents/leader.md`: frugal
  delegation, ejemplo ✅/❌ de paralelismo, reclamo de worktree, ancestría tras
  squash-merge, re-verificación de *load-bearing claims*, cap de 2 ciclos
  `CHANGES_REQUESTED`, second opinion (`codex-cross-review`). **Hecho en v1, conservado.**
  · test: `packages/cli/src/__tests__/orquestacion-doctrina.test.ts`::"cada cláusula
  retirada vive en leader.md" con `// Covers: R7`

- [x] **T2** (R8) — Re-anclar `packages/cli/src/lib/__tests__/handoff-namespaces.test.ts`:
  las DOS listas canónicas del set cerrado de `.claude/progress/` quedan en `leader.md`
  (§ Path separation, § Expected files). El mecanismo no se debilita: un namespace nuevo
  sin registrar en ambas sigue rompiendo la suite (verificado mutando un fixture del test,
  no el asset). · test: `handoff-namespaces.test.ts` (re-anclado) con `// Covers: R8`

## Lote 2 — El recorte y el orden

- [x] **T3** (R3, R4, R9, R11) — Recortar
  `packages/core/core-assets/managed/orquestacion.md` a ≤6,500 renderizado: quedan rol +
  prohibición de delegar `leader`, tabla de rutas, **tabla señal→mecanismo + párrafo
  R2-architectural (#379)**, umbrales, mecánica de un-solo-turno, y la tabla de punteros
  de ruta literal a la profundidad. Salen: §Synthesis, §Frugal delegation, §Continuous
  execution, second opinion, worktree (todo ya injertado por T1). · test:
  `orquestacion-doctrina.test.ts`::"el núcleo conserva sus piezas y no repite lo que vive
  en leader.md" con `// Covers: R4, R9, R11`

- [x] **T4** (R1, R2, R10) — El engine escribe `context/NN-<id>.md` (paso de 10, orden de
  `CORE_MANAGED_ASSETS`; el índice de agentes computado entra como `20-`), retira el nombre
  viejo en el mismo apply vía la maquinaria de removals existente, y el marcador managed
  conserva su `id` sin prefijo. Aplica a los dos sitios de `ORCHESTRATOR_CONTEXT_DIR` en
  `packages/cli/src/engines/claude/index.ts`; verificar si el engine codex enruta bloques a
  `.codex/context` y darle el mismo trato (si no lo hace, documentarlo como no-op). · test:
  `packages/cli/src/engines/claude/__tests__/render-engine.test.ts`::"context files carry
  their delivery order in the filename" y ::"a re-render removes the unprefixed
  predecessors" con `// Covers: R1, R2, R10`

- [x] **T5** (R3, R6) — Test de techo sobre el bloque **renderizado** (los placeholders
  expanden): falla sobre 6,500 nombrando tamaño y techo. · test:
  `packages/cli/src/engines/claude/__tests__/session-start-budget.test.ts`::"el bloque de
  orquestación cabe con el catálogo de agentes detrás" con `// Covers: R3, R6`

- [x] **T6** — Regenerar goldens (`__golden__/claude.snap`, `codex.snap`) y re-renderizar
  el espejo del repo (`pnpm render:apply`) para que `check:render` y
  `golden-render-tree.test.ts` queden verdes. Sin `R` propio: es la mecánica que fija T3+T4
  en los árboles de referencia.

## Lote 3 — Probar que llega, no que cabría

- [x] **T7** (R5) — Correr `session-start-context.sh` sobre un fixture con los CUATRO
  bloques renderizados y un `progress/current.md` de campo (~5,000 chars): la salida
  contiene una frase-marca de la escalera y una del catálogo como cuerpo, y las líneas de
  puntero (`no cabe en el contexto de arranque`) para `arranque-sesion` y `cierre-sesion`
  — nunca la de `orquestacion`. · test:
  `session-start-budget.test.ts`::"la escalera y el catálogo llegan como cuerpo; el cierre
  degrada a puntero" con `// Covers: R5`

## Trazabilidad

| R | Tareas |
|---|---|
| R1 | T4 |
| R2 | T4 |
| R3 | T3, T5 |
| R4 | T3 |
| R5 | T7 |
| R6 | T5 |
| R7 | T1 |
| R8 | T2 |
| R9 | T3 |
| R10 | T4 |
| R11 | T3 |
