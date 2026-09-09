# La orquestación cabe en el arranque — Requirements

> **v2.** La primera versión de esta spec modeló "un bloque gordo contra el git log". La
> implementación falsificó ese modelo con dos hallazgos, ambos verificados en código y no
> solo razonados; esta versión los incorpora. Lo que la v1 acertó (los injertos de R5/R6 en
> `leader.md`) se conserva tal cual.

## Context

La spec 0015 sacó `Role: orchestrator` de `CLAUDE.md` al `additionalContext` del hook
`SessionStart`, por una razón que sigue viva: dentro de `CLAUDE.md` lo recibía cada
subagente (~60k tokens en una sesión de 19). El #624 arregló el orden doctrina-antes-que-
estado y el presupuesto (`NAVORI_CTX_BUDGET=8000`). Esta spec arregla lo que queda: el
bloque **no llega**.

**Hallazgo 1 — el canal está sobre-suscrito, y el perdedor lo decide el alfabeto.**
`.claude/context/` no lleva un archivo: lleva **cuatro** (todo bloque con
`audience: "orchestrator"` en `CORE_MANAGED_ASSETS`, más `agentes-disponibles` que el
engine enruta ahí por la misma razón). El hook los recorre con un glob (`"$ctxdir"/*.md`,
`session-start-context.sh`), que expande **alfabéticamente**:

| Orden de llegada | Archivo | chars (renderizado) | ¿Llega hoy? |
|---|---|---|---|
| 1 | `agentes-disponibles.md` | 1,086 | cuerpo |
| 2 | `arranque-sesion.md` | 1,317 | cuerpo |
| 3 | `cierre-sesion.md` | 3,159 | cuerpo |
| 4 | `orquestacion.md` | 12,587 | **puntero, siempre** |

La ironía que esta spec elimina: `CORE_MANAGED_ASSETS` declara `orquestacion` **primero**
(`render-plan.ts:105`) — la intención de prioridad existe, pero el nombre del archivo la
pierde en el glob. Recortar el bloque sin arreglar el orden no basta: recortado a 4,757 el
bloque **siguió cayendo a puntero** (verificado corriendo el hook), porque los otros tres
gastan 5,562 del presupuesto antes de que le toque.

**Hallazgo 2 — la tabla señal→mecanismo no puede salir del bloque.**
`analysis-cascade-wiring.test.ts` (#379 B) fija que la tabla viva en la capa always-on del
orquestador, con una razón de fondo: la decisión de cuánta ceremonia analítica merece una
tarea se toma **mientras se lee la tarea**, no después de decidir delegar — moverla a
`ticket-intake`/`solution-design` invierte la causalidad (tendrías que saber ya que es una
tarea de intake para leer la tabla que te lo dice). La tabla se queda; el recorte sale de
las secciones cuya doctrina ya tiene dueño en `leader.md`.

Restricción heredada que el recorte pisa: `handoff-namespaces.test.ts` (#409) exige el set
cerrado de namespaces de `.claude/progress/` declarado en DOS listas canónicas, hoy
`orquestacion.md` + `leader.md`. Al retirar §Synthesis del bloque, ambas listas quedan en
`leader.md` (§ Path separation + § Expected files) y el test se re-ancla ahí — el mecanismo
(un productor nuevo debe registrarse en ambas) se conserva.

Público: cualquier repo que renderice el harness de navori con subagentes habilitados.

## Requirements (EARS)

### El orden es doctrina, no alfabeto

- **R1** — El sistema SHALL entregar los archivos de `.claude/context/` en un orden de
  prioridad definido por el render (el de `CORE_MANAGED_ASSETS`: `orquestacion` primero),
  sin que el hook necesite conocer ids: el orden SHALL viajar en el **nombre de archivo**
  (prefijo numérico), de modo que el glob alfabético del hook lo produzca por construcción.
- **R2** — WHEN un repo ya renderizado tiene los archivos con nombre viejo (sin prefijo),
  el render SHALL retirarlos al escribir los nuevos: dos copias del mismo bloque en el
  directorio es doctrina entregada dos veces o dos hashes en drift.

### Que llegue lo que rutea

- **R3** — El bloque de orquestación renderizado SHALL medir a lo sumo **6,500 caracteres**,
  conservando la tabla señal→mecanismo (#379) y las cuatro piezas de R4.
- **R4** — El bloque SHALL conservar: el rol (incluida la prohibición de delegar `leader`),
  la tabla de rutas, la tabla señal→mecanismo con su párrafo R2-architectural, los umbrales
  de escalamiento, y la mecánica de emitir todas las llamadas `Agent` en un solo turno.
- **R5** — WHEN el hook compone el arranque de un repo con los cuatro bloques presentes y un
  `progress/current.md` de tamaño de campo, el sistema SHALL entregar como **cuerpo** al
  menos `orquestacion` y `agentes-disponibles` — la escalera y el catálogo al que rutea.
  Los bloques que no quepan SHALL degradar a puntero exactamente como hoy (nunca
  desaparecer), y `cierre-sesion` SHALL ser el primero en degradar: sus ceremonias aplican
  al cierre, no al arranque, y un puntero leído a tiempo las cubre.
- **R6** — IF el bloque de orquestación volviera a exceder el techo de R3, THEN la suite
  SHALL fallar nombrando el tamaño medido y el techo.

### Qué se mueve, sin perder nada

- **R7** — Toda sección retirada del bloque SHALL tener su contenido en `leader.md` ANTES
  del retiro, incluidas las cláusulas verificadas como únicas del bloque: reclamo de
  worktree, ancestría tras squash-merge, re-verificación de *load-bearing claims*, cap de 2
  ciclos `CHANGES_REQUESTED`, second opinion (`codex-cross-review`), y frugal delegation.
- **R8** — Las DOS listas canónicas de namespaces de handoff (#409) SHALL quedar en
  `leader.md`, y `handoff-namespaces.test.ts` SHALL seguir fallando cuando un productor
  invente un namespace que alguna lista no declare.
- **R9** — El bloque SHALL nombrar con **ruta literal** dónde vive la profundidad retirada.

### Que siga siendo lo que era

- **R10** — Cada archivo de contexto SHALL conservar su marcador managed con `id`, `hash` y
  `version` (el id NO cambia aunque el nombre de archivo gane prefijo), de modo que
  `doctor`, `sync` y el prune lo sigan tratando igual.
- **R11** — El sistema SHALL NOT entregar dos veces la misma doctrina: lo que quedó en el
  bloque no se repite en `leader.md`, y viceversa.
