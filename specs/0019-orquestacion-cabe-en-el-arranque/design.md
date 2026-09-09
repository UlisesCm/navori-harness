# La orquestación cabe en el arranque — Design

## Approach

**Recortar el bloque a la escalera y mudar la profundidad al asset que ya es dueño del
momento** (el patrón de #615). El bloque queda con lo que ninguna otra vía entrega al agente
principal —rol, rutas, umbrales, mecánica de paralelismo— y cada sección retirada aterriza en
la skill o el agente que se carga justo cuando esa doctrina aplica.

La aritmética que fija el techo de R1, sobre `NAVORI_CTX_BUDGET=8000`:

| Sección del arranque | chars |
|---|---|
| Bloque de orquestación (techo propuesto) | 5,000 |
| Rama + 15 commits recientes + fences | ~1,700 |
| Margen | ~1,300 |

El núcleo medido son **4,159 chars** de contenido + ~150 de marcadores managed ≈ **4,310**,
así que el techo de 5,000 deja ~690 para los punteros que R7 agrega. `progress/current.md`
sigue cayendo a puntero, que es **el diseño y no un daño**: el hook ya declara que esa es la
sección que debe perder cuando algo tiene que perder, porque el agente la recupera con un
`cat` y la doctrina no.

**Descartado — partir en dos archivos dentro de `.claude/context/`.** Es la lectura literal de
"partir `orquestacion.md`" y sí funcionaría a medias: el loop del hook recorre `context/*.md` y
pasa **cada uno** por `add_bounded` contra el **mismo `ctx` acumulado**, así que un
`orquestacion.md` de 4.3 KB llegaría y un `orquestacion-profundidad.md` de 8.4 KB caería a
puntero. Se descarta por dos razones: deja 8.4 KB de doctrina en un canal que por construcción
nunca entrega, y no toca la duplicación con `leader.md` — que es la mitad del problema, no un
efecto colateral.

**Descartado — subir `NAVORI_CTX_BUDGET`.** El límite del host no está documentado; el 8,000
se fijó por medición (el corte más chico observado fue 10,441 bytes) más margen deliberado.
Subirlo a ~13,000 para que quepa el bloque actual es volver a apostarle a un número que
nadie publica, que es exactamente cómo nació #623.

## Components

- `packages/core/core-assets/managed/orquestacion.md` — queda solo con rol, rutas, umbrales y
  la mecánica de un-solo-turno; agrega punteros literales a los dueños — cubre R1, R4, R7, R8.
- `packages/core/core-assets/agents/leader.md` — recibe `Frugal delegation`, el ejemplo ✅/❌
  de paralelismo, y las tres cláusulas huérfanas (worktree, squash-merge, *load-bearing*) —
  cubre R5, R6.
- `packages/core/core-assets/skills/ticket-intake.md` — recibe las tres filas de ticket
  de la tabla señal→mecanismo — cubre R5.
- `packages/core/core-assets/skills/solution-design.md` — recibe la fila arquitectónica
  y el párrafo `R2-architectural` — cubre R5.
- Suite nueva sobre el asset renderizado — cubre R3, R9.

## Decisions

- **La tabla señal→mecanismo se parte por dueño, no se muda entera.** Sus 2,316 chars mezclan
  dos momentos distintos: "llegó un ticket" (lo dueña `ticket-intake`, que es la pipeline que
  encadena el resto) y "esto tiene señal arquitectónica" (lo dueña `solution-design`). Mudarla
  completa a una sola la deja anunciando decisiones que esa skill no toma.
- **El cap de 2 ciclos `CHANGES_REQUESTED` se injerta en `leader.md` antes de borrarlo.** La
  sección `Continuous execution` del bloque es casi literal a la de `leader.md`, pero ese cap
  existe **solo** en la del bloque. Es el caso concreto que R6 gobierna.
- **`codex-cross-review` no es una cláusula huérfana.** Aparece 0 veces en `leader.md` porque
  navori inyecta ese sub-bloque **solo** cuando el repo renderiza el engine `codex`, y este
  repo renderiza Claude. El puntero del bloque ya lo dice y ya enseña cómo comprobarlo
  (`grep -n codex-cross-review .claude/agents/leader.md`): se preserva tal cual.
- **El techo se mide sobre el asset renderizado, no sobre la fuente.** La fuente lleva
  placeholders (`{{qualityGate.*}}`, `{{project.criticalAreas}}`) que se expanden a texto más
  largo; medir la fuente reportaría un tamaño que ninguna sesión recibe.

## Failure modes

- **Pérdida silenciosa de doctrina.** Es el riesgo dominante: retirar una sección cuyo destino
  no la contenía. Contención: R6 obliga a injertar antes de retirar, y la suite de R5 falla si
  una sección sale sin dueño declarado.
- **Regresión de tamaño.** Cualquier PR futuro que engorde el bloque lo devuelve a puntero sin
  avisar —el hook sale 0 igual— y el síntoma reaparecería recién en la próxima auditoría de
  activación. Contención: R3, un test de techo con el número medido en el mensaje.
- **Duplicación reintroducida.** Alguien vuelve a escribir en el bloque algo que ya vive en
  `leader.md`. Contención: R9.

## Testing strategy

Cada test responde a un riesgo nombrado arriba, no a una cuota:

- **Techo (R1, R3)**: renderiza el bloque con la config de este repo y afirma `length ≤ 5000`,
  con el tamaño medido y el techo en el mensaje de fallo.
- **Entrega real (R2)**: corre el hook `session-start-context.sh` sobre un fixture con un
  `progress/current.md` de tamaño típico y afirma que la salida contiene el **cuerpo** del
  bloque (una frase que solo está en él) y **no** su línea de puntero. Es la única forma de
  probar entrega: el tamaño solo prueba que cabría.
- **Núcleo intacto (R4)**: afirma que las cuatro piezas siguen presentes por una marca estable
  de cada una.
- **Anti-pérdida (R5, R6)**: por cada sección retirada, afirma que su marca estable aparece en
  el asset dueño declarado. Las tres cláusulas huérfanas entran nominalmente.
- **Anti-duplicación (R9)**: afirma que ninguna marca del núcleo aparece en `leader.md`.

## NOT in scope

- **El A/B de activación** (`scripts/ab-activation/`). Correrlo es el punto 3 del plan y va
  **después**: medir hoy sería medir un harness roto contra sí mismo.
- **Encoger `leader.md`.** Crece con esta spec, y a 15,370 chars ya es grande — pero se lee
  por `Read` a demanda, no por el canal recortado, así que su tamaño no es este problema.
- **Tocar `NAVORI_CTX_BUDGET` o el orden del hook.** #624 los dejó correctos; esta spec vive
  entera del lado del contenido.
