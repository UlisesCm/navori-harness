# La orquestación cabe en el arranque — Tasks

El orden entre lotes es una restricción, no una preferencia: **R6 obliga a injertar antes de
retirar.** El lote 1 completo tiene que estar verde antes de que el lote 2 borre una línea.

## Lote 1 — Injertar en los dueños (antes de retirar nada)

- [ ] **T1** (R5, R6) — Llevar a `packages/core/core-assets/agents/leader.md` la sección
  `Frugal delegation` completa, el ejemplo ✅/❌ de paralelismo, y las **tres cláusulas que hoy
  existen solo en el bloque**: el protocolo de reclamo de worktree (`git worktree remove` +
  `prune`, preguntar una vez, nunca `rm -rf`), el gotcha de que un squash-merge no deja
  ancestría (`git log <base> --grep="(#<PR>)"` en vez de `merge-base --is-ancestor`), y la
  re-verificación de *load-bearing claims* tras un `done -> file`. Injertar además el cap de
  **2 ciclos `CHANGES_REQUESTED`**, que la sección `Continuous execution` de `leader.md` no
  tiene. · test: `packages/cli/src/__tests__/orquestacion-doctrina.test.ts`::"cada cláusula
  huérfana aterrizó en leader.md" con `// Covers: R5, R6`

- [ ] **T2** (R5) — Partir la tabla señal→mecanismo por dueño: las tres filas de ticket
  (llega un ticket · toca área crítica → `ticket-audit` · evidencia en 2+ repos → un audit por
  área) a `packages/core/core-assets/skills/ticket-intake.md`; la fila arquitectónica y
  el párrafo `R2-architectural` a
  `packages/core/core-assets/skills/solution-design.md`. · test:
  `packages/cli/src/__tests__/orquestacion-doctrina.test.ts`::"cada fila retirada aparece en
  la skill que la dueña" con `// Covers: R5`

## Lote 2 — El recorte

- [ ] **T3** (R1, R4, R7, R8, R9) — Recortar
  `packages/core/core-assets/managed/orquestacion.md` a las cuatro piezas del núcleo (rol +
  prohibición de delegar `leader`, tabla de rutas, umbrales de escalamiento, mecánica de
  emitir todas las llamadas `Agent` en un solo turno), agregar los punteros de **ruta
  literal** a `.claude/agents/leader.md` y a las dos skills, y conservar el marcador managed
  con `id`/`hash`/`version`. Re-renderizar el espejo (`navori render --apply`) para que
  `check:render` quede verde. · test:
  `packages/cli/src/__tests__/orquestacion-doctrina.test.ts`::"el núcleo conserva sus cuatro
  piezas y no repite lo que ya vive en leader.md" con `// Covers: R4, R7, R8, R9`

- [ ] **T4** (R1, R3) — Test de techo sobre el bloque **renderizado** (no la fuente: los
  `{{placeholders}}` expanden): falla si supera 5,000 caracteres, y el mensaje nombra el
  tamaño medido y el techo. · test:
  `packages/cli/src/engines/claude/__tests__/session-start-budget.test.ts`::"el bloque de
  orquestación cabe en el presupuesto con margen para rama y commits" con `// Covers: R1, R3`

## Lote 3 — Probar que llega, no que cabría

- [ ] **T5** (R2) — Correr el hook `session-start-context.sh` sobre un fixture con un
  `progress/current.md` de tamaño de campo (~5,000 chars) y afirmar que la salida contiene una
  frase que **solo** existe en el cuerpo del bloque y **no** contiene su línea de puntero
  (`no cabe en el contexto de arranque`). Caber y llegar son cosas distintas: #623 se declaró
  inexistente por confundirlas. · test:
  `packages/cli/src/engines/claude/__tests__/session-start-budget.test.ts`::"la escalera de
  ruteo llega como cuerpo, no como puntero" con `// Covers: R2`

- [ ] **T6** (R5, R9) — Cerrar la suite anti-pérdida: una tabla `sección retirada → asset
  dueño` en el test, que falle nombrando la sección si alguna sale del bloque sin dueño
  declarado o si una marca del núcleo reaparece en `leader.md`. · test:
  `packages/cli/src/__tests__/orquestacion-doctrina.test.ts`::"ninguna sección se retira sin
  dueño y ninguna doctrina se entrega dos veces" con `// Covers: R5, R9`

## Trazabilidad

| R | Tareas |
|---|---|
| R1 | T3, T4 |
| R2 | T5 |
| R3 | T4 |
| R4 | T3 |
| R5 | T1, T2, T6 |
| R6 | T1 |
| R7 | T3 |
| R8 | T3 |
| R9 | T3, T6 |
