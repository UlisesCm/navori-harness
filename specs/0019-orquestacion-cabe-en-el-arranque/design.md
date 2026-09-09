# La orquestación cabe en el arranque — Design

> **v2.** Reescrito tras falsificar el modelo de la v1 en implementación. Cambia el
> problema ("un bloque gordo" → "un canal sobre-suscrito sin orden de prioridad") y el
> mecanismo (recorte + prefijos de orden, en vez de solo recorte + mudanza de tabla).

## Approach

Dos movimientos que se necesitan mutuamente:

1. **El orden de entrega deja de ser alfabético.** El engine ya conoce la prioridad
   (`CORE_MANAGED_ASSETS` declara `orquestacion` primero); lo que la pierde es el nombre de
   archivo. El render pasa a escribir `.claude/context/NN-<id>.md` con `NN` = posición de
   prioridad (`10-orquestacion.md`, `20-agentes-disponibles.md`, `30-arranque-sesion.md`,
   `40-cierre-sesion.md`). El glob alfabético del hook produce entonces el orden correcto
   **por construcción** — el hook no cambia ni una línea, y sigue mudo respecto a ids, que
   es su contrato ("the hook stays dumb on purpose").
2. **El bloque se recorta a ≤6,500 conservando la tabla.** La tabla señal→mecanismo se
   queda (#379: la decisión se toma mientras se lee la tarea); sale la doctrina cuya casa
   natural es `leader.md` — synthesis, frugal delegation, continuous execution, worktree,
   second opinion — con injertos previos de lo que solo existía en el bloque.

La aritmética resultante, contra `NAVORI_CTX_BUDGET=8000`:

| Llega | chars |
|---|---|
| `10-orquestacion.md` (techo) | 6,500 |
| `20-agentes-disponibles.md` | 1,086 |
| Subtotal bounded | 7,586 ≤ 8,000 |
| `30-arranque-sesion.md`, `40-cierre-sesion.md` | punteros |
| Rama + commits + punteros (fuera del bound, tras los bloques) | ~1,500 |
| Total emitido | ~9,100 < 10,441 (corte mínimo observado) |

`cierre-sesion` y `arranque-sesion` degradan a puntero **por diseño**: las ceremonias de
cierre aplican horas después del arranque y un puntero leído a tiempo las cubre; el
arranque (leer `progress/current.md`, `doctor`) lo cubre en parte el propio hook. La
escalera y el catálogo de agentes — lo único que decide ruteo en el minuto cero — llegan
como cuerpo.

**Por qué no la alternativa obvia — subir `NAVORI_CTX_BUDGET`.** El límite del host no
está documentado para este canal: la doc oficial documenta 10,000 chars para el output de
`PostToolUse` (context-window.md) y nada para `SessionStart`; el corte se observó desde
10,441 bytes. El 8,000 viene de medición más margen y esta spec no lo toca — volver a
apostarle a un número que nadie publica es cómo nació #623.

**Por qué no una lista de orden interpolada en el hook.** El render podría inyectar
`{{contextFilesInOrder}}` al hook, pero eso acopla el hook al plan (un `blocks.exclude`
posterior lo deja iterando archivos muertos hasta el próximo render) y rompe su contrato de
mudez. El prefijo numérico deja la información donde el hook ya mira: el filesystem.

**Por qué no mudar la tabla señal→mecanismo (la v1 lo intentó).** Falsificado por
`analysis-cascade-wiring.test.ts` (#379 B): la tabla existe para leerse ANTES de decidir el
mecanismo, así que no puede vivir dentro del mecanismo. El intento además rompía
`empty-placeholder-render.test.ts` (los fallbacks de `{{project.criticalAreas}}` se
verifican sobre el bloque). Ninguno de esos tests se reescribe para que el cambio pase.

## Components

- `packages/cli/src/engines/claude/index.ts` — `ORCHESTRATOR_CONTEXT_DIR`: los dos sitios
  que escriben `context/<id>.md` (bloques `audience` y el índice de agentes computado)
  pasan a `context/NN-<id>.md`, con retiro del nombre viejo — cubre R1, R2.
- `packages/core/core-assets/managed/orquestacion.md` — recortado conservando la tabla;
  punteros de ruta literal — cubre R3, R4, R9, R11.
- `packages/core/core-assets/agents/leader.md` — recibe los injertos (hechos en v1 y
  conservados) — cubre R7, R8.
- `packages/cli/src/lib/__tests__/handoff-namespaces.test.ts` — re-anclado: ambas listas
  canónicas en `leader.md` (§ Path separation y § Expected files) — cubre R8.
- `packages/cli/src/engines/claude/__tests__/session-start-budget.test.ts` — techo del
  bloque + prueba de entrega real corriendo el hook — cubre R3, R5, R6.
- Goldens (`__golden__/claude.snap`, `codex.snap`) — regenerados: el árbol cambia de
  nombres de archivo y contenido — soporte, no requirement propio.

## Decisions

- **Prefijos con paso de 10** (`10-`, `20-`…): insertar un bloque futuro entre dos
  existentes no renombra los demás (mismo razonamiento que las líneas BASIC y las
  migraciones ordenadas).
- **El `id` managed no cambia** — solo el nombre de archivo. `doctor`/`sync`/prune operan
  sobre el marcador interno, y `isRemovableNavoriFile` valida por marcador, no por nombre,
  así que el retiro del archivo viejo usa la maquinaria existente (R2, R10).
- **`agentes-disponibles` va segundo, no primero.** La escalera sin catálogo rutea a
  agentes que no conoce; el catálogo sin escalera es una lista sin criterio. Pero si solo
  UNO cabe, tiene que ser la escalera: contiene la prohibición de delegar `leader` y los
  umbrales — el catálogo es recuperable con un `Read` y la escalera es la doctrina que
  #622 midió como nunca-entregada.
- **`.codex/context` recibe el mismo trato**: el hook ya itera ambos dirs con el mismo
  glob; el engine codex escribe con el mismo prefijo. Verificar en T2 si codex enruta
  bloques ahí hoy — si no, el cambio es un no-op para ese engine y se documenta.

## Failure modes

- **Doble entrega durante la migración** (viejo + nuevo nombre en el dir): el render retira
  el viejo en el mismo apply; `check:render` en CI ataja un repo a medias (R2).
- **Regresión de tamaño**: el techo de R6 con el número en el mensaje.
- **Pérdida de doctrina**: R7 — los injertos preceden al retiro; la suite anti-pérdida los
  fija por marca estable.
- **Un `blocks.exclude` de `orquestacion`**: la ruta de retiro existente cubre el nombre
  nuevo (el engine ya maneja `newContent === null` retirando el archivo del canal).

## Testing strategy

Cada test responde un riesgo nombrado:

- **Orden por construcción (R1)**: renderiza un repo fixture y afirma que los nombres en
  `.claude/context/` ordenados alfabéticamente producen `orquestacion` primero.
- **Migración (R2)**: fixture con los nombres viejos → `render --apply` → los viejos no
  existen, los nuevos sí, y no hay id duplicado en el dir.
- **Techo (R3, R6)**: bloque renderizado ≤ 6,500, tamaño y techo en el mensaje.
- **Entrega real (R5)**: correr `session-start-context.sh` sobre el fixture completo (4
  bloques + resume de campo) y afirmar: frase-marca de la escalera presente como cuerpo,
  frase-marca del catálogo presente, y punteros (no cuerpos) para `arranque-sesion` y
  `cierre-sesion`. Caber y llegar son cosas distintas — #623 se declaró inexistente por
  confundirlas.
- **Núcleo + tabla intactos (R4)**: marcas estables de las cinco piezas.
- **Anti-pérdida y anti-duplicación (R7, R11)**: tabla sección-retirada → marca-en-leader;
  marcas del núcleo ausentes de `leader.md`.
- **#409 re-anclado (R8)**: `handoff-namespaces.test.ts` corre verde con ambas listas en
  `leader.md` y sigue rojo ante un namespace no declarado (probarlo mutando un fixture, no
  el asset).

## NOT in scope

- **El A/B de activación** (punto 3 del plan) — después de que esto llegue, no antes.
- **Subir `NAVORI_CTX_BUDGET`** — ver Approach.
- **Encoger `leader.md`** — crece aquí; se lee por `Read` a demanda, no por el canal
  recortado.
- **Tocar el orden interno del hook** (doctrina→git→resume) — #624 lo dejó correcto.
