# La orquestación cabe en el arranque — Requirements

## Context

La spec 0015 sacó `Role: orchestrator` de `CLAUDE.md` y lo mandó al `additionalContext` del
hook `SessionStart`, por una razón que sigue siendo correcta: dentro de `CLAUDE.md` lo
recibía **cada subagente**, y una sesión de 19 subagentes gastaba ~60k tokens entregando
doctrina de ruteo a agentes que no rutean.

El #623/#624 encontró que el host recorta ese canal y arregló el orden y el presupuesto
(`NAVORI_CTX_BUDGET=8000`, doctrina primero). Lo que **no** arregló es el tamaño: el bloque
mide **12,728 caracteres** contra un presupuesto de 8,000, así que `add_bounded` lo degrada a
**puntero en toda sesión de todo repo** — nunca al cuerpo. El arranque de esta misma sesión
lo dice literal:

```
[navori] '.claude/context/orquestacion.md' no cabe en el contexto de arranque (12587 caracteres).
```

El resultado es que la escalera de ruteo pasó de *truncada en silencio* (pre-#624) a
*explícitamente no entregada* (post-#624). Mejor, porque ahora es accionable; sigue sin
llegar.

Medición del bloque por sección, que es lo que fija el corte:

| Sección | chars | Vive también en |
|---|---|---|
| `Role: orchestrator` | 652 | — |
| `The routes` | 1,134 | — |
| `Thresholds that make you STEP UP` | 1,114 | — |
| `Analytical parallelism` | 1,259 | `leader.md` § *How to launch in parallel* |
| `How much analysis does this task deserve` | 2,316 | — |
| `Frugal delegation` | 1,407 | — |
| `Continuous execution` | 811 | `leader.md` § *Continuous execution* (casi literal) |
| `Synthesis without broken telephone` | 3,939 | `leader.md` § *Anti-broken-telephone* (parcial) |

`.claude/agents/leader.md` (15,370 chars) ya es la referencia de profundidad y ya carga 6 de
esas secciones. Pero la superposición es **parcial**, y tres cláusulas existen **solo** en el
bloque: el protocolo de reclamo de worktree, el gotcha de que un squash-merge no deja
ancestría, y la re-verificación de *load-bearing claims*. Borrar el duplicado sin injertar
esas tres las pierde.

Público: cualquier repo que renderice el harness de navori con subagentes habilitados.

## Requirements (EARS)

### Que llegue

- **R1** — El bloque de orquestación renderizado SHALL medir a lo sumo **5,000 caracteres**,
  de modo que quepa en `NAVORI_CTX_BUDGET` junto con la rama y los commits recientes.
- **R2** — WHEN el hook `SessionStart` compone el contexto de arranque de un repo con
  `progress/current.md` de tamaño típico, el sistema SHALL entregar el bloque **como cuerpo**
  y no como puntero.
- **R3** — IF el bloque volviera a exceder el techo de R1, THEN la suite SHALL fallar
  nombrando el tamaño medido y el techo, para que la regresión no pueda volver en silencio.

### Qué se queda en el núcleo

- **R4** — El bloque SHALL conservar las cuatro piezas que deciden el ruteo y que ninguna
  otra vía entrega al agente principal: el rol (incluida la prohibición de delegar `leader`),
  la tabla de rutas, los umbrales de escalamiento, y la mecánica de emitir todas las llamadas
  `Agent` en un solo turno.

### Qué se mueve, sin perder nada

- **R5** — El sistema SHALL declarar, para cada sección retirada del bloque, el asset que
  pasa a ser su dueño, y la suite SHALL fallar si una sección se retira sin dueño declarado.
- **R6** — IF una cláusula retirada no existe en su asset destino, THEN la migración SHALL
  injertarla ahí ANTES de retirarla del bloque. Aplica nominalmente a las tres verificadas
  como únicas del bloque: reclamo de worktree, ancestría tras squash-merge, y re-verificación
  de *load-bearing claims*.
- **R7** — El bloque SHALL nombrar con **ruta literal** dónde vive la profundidad que ya no
  contiene, para que el agente pueda leerla cuando el momento la pida.

### Que siga siendo lo que era

- **R8** — El bloque SHALL conservar su marcador managed con `id`, `hash` y `version`, de
  modo que `doctor` y `sync` detecten drift sobre él exactamente como hoy.
- **R9** — El sistema SHALL NOT entregar dos veces la misma doctrina: una sección que quedó
  en el bloque SHALL NOT repetirse en `leader.md`, y viceversa.
