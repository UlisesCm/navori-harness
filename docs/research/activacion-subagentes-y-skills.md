# Por qué no se activan los subagentes ni las skills — plan de investigación

> Estado: **plan**, sin intervención todavía. Escrito 2026-09-09 sobre navori 0.8.0.
> Documentación de Claude Code consultada el 2026-09-09 (Subagents, Skills, Settings).

## El problema, medido

`navori audit` sobre **13 sesiones en 3 repos** (rango 2026-08-27 → 2026-09-09):

| repo | sesiones | lanzamientos de subagente | skills usadas |
|---|---|---|---|
| moonar-medusa-monorepo | 2 | **0** | 0 de 14 |
| navori-health | 3 | **0** | 1 de 16 (`spec-bootstrap`, una vez) |
| navori-harness | 8 | **4**, en solo 2 sesiones (3× `implementer`, 1× `reviewer`) | 3 de 17, en la sesión más activa |

En **11 de las 13 sesiones** el reporte dice "8 de 8 agentes declarados no se lanzaron".

El caso más grave: **`reviewer` se lanzó 1 vez en 13 sesiones.** El harness documenta el
flujo SDD como `leader → implementer → reviewer`; en la práctica el mismo agente que
escribe el código es el que lo aprueba, que es justo lo que un reviewer separado existe
para evitar.

Contraste que vale la pena tener presente: **el SDD documental sí funciona.** 19 specs en
navori-harness, 4 completas con todas sus tareas cerradas, y trazabilidad real —
86 referencias `Covers: R<n>` en navori-harness, 100 en moonar sobre 17 archivos de test.
Lo que no se activa es la mitad del flujo que vive en agentes, no la que vive en documentos.

## Hipótesis descartadas (con número, antes de gastar tiempo)

**H-A · "El bloque de orquestación no llega a la sesión."** ~~FALSO~~ → **ERA VERDADERA.
Ver "La causa raíz" más abajo.** La descarté por un error de método: grepeé el archivo
persistido del hook y concluí que el bloque llegaba. Ese archivo es exactamente lo que NO
llega. La corrección está al final del documento y supersede todo lo que sigue en esta
sección.

**H-C · "Los índices de skills de harnesses ajenos confunden al agente."** FALSO, con
evidencia sobre 185 transcripts. Ver "Una hipótesis más, descartada con evidencia" al final.

**H-B · "Las descriptions se están truncando por presupuesto."** FALSO. La doc advierte que
al pasar de 15,000 tokens de descriptions de agentes, Claude Code las recorta empezando por
las menos usadas — un círculo vicioso que explicaría el 0%. No aplica aquí:

```
agentes  1,495 chars  ≈   373 tokens   (límite 15,000)
skills   3,814 chars  ≈   953 tokens   (cap 1,536 chars POR skill; ninguna se acerca)
```

Descartada por dos órdenes de magnitud.

## Lo que dice la documentación oficial

**Subagents** — la delegación automática la decide un campo concreto:

> "Claude uses each subagent's `description` to decide when to delegate tasks. When you
> create a subagent, write a clear description so Claude knows when to use it."

> "To encourage proactive delegation, include phrases like **'use proactively'** in your
> subagent's `description` field."

**Skills** — mismo mecanismo, más un campo que navori no usa:

> "`description` (Recommended): What the skill does and when to use it. Claude uses this to
> decide when to apply the skill. **Put the key use case first.**"

> "`when_to_use`: Additional context for when Claude should invoke the skill, **such as
> trigger phrases or example requests**."

Y el límite del enfoque declarativo, que conviene aceptar desde el principio:

> There is no way to *force* Claude to use a skill beyond good description design.

## Hipótesis vivas

### H1 — Las descriptions de los agentes describen QUÉ son, no CUÁNDO usarlos

**7 de 8 agentes no traen ningún disparador.** El único que sí:

```
auditor      "…Trigger it when the user says 'audit X', 'deep audit',
              'find bugs in X', 'review X thoroughly'."          ← tiene trigger
reviewer     "Strict reviewer. Approves or rejects the implementer's
              work against CLAUDE.md. Does not edit code."       ← no dice cuándo
implementer  "Worker. Implements ONE scoped task…"               ← no dice cuándo
```

Si el campo que decide la delegación no contiene la condición de disparo, el mecanismo que
la doc describe no tiene con qué operar. Es la hipótesis más barata de probar y la que más
directamente contradice la documentación.

**Predicción falsable:** reescribir las 7 descriptions con disparador + "use proactively"
sube la tasa de delegación en sesiones comparables. Si no sube, H1 queda descartada y el
costo fue de una hora.

**Contraevidencia que hay que respetar:** `implementer` se lanzó 3 veces *sin* trigger y
`auditor` 0 veces *con* trigger. La correlación va al revés. Eso no mata H1 —esas 3 fueron
delegaciones explícitas del usuario, no automáticas— pero obliga a separar en la Fase 1 las
invocaciones automáticas de las pedidas.

### H2 — Las skills tienen disparador en `description` pero ninguna declara `when_to_use`

**0 de 17 skills** usan el campo. Sus descriptions sí son trigger-shaped ("Use when about to
declare a task done", "Use when a fix doesn't work the first time"), así que esto es una
mejora incremental, no la causa raíz. Vale medirlo junto a H1, no antes.

### H3 — El ruteo se evalúa por turno y el trabajo se acumula entre turnos

La escalera R1/R2 clasifica **la tarea**. Pero estas sesiones avanzan con mensajes como
"sigamos", "resuelve el issue pendiente", "haz el rollout": **cada turno aislado parece R1**
(1–3 archivos, cambio mecánico), y la jornada completa era R2 sin que ningún turno cruzara
el umbral.

El bloque ya anticipa esto — y ahí está el detalle:

> "**Long-session rule (qualitative):** if the session grows without closing […] stop,
> re-evaluate, step up to R2."

**Cualitativa.** Es la única regla de la escalera sin umbral objetivo, y es exactamente la
que gobierna el modo en que se trabaja en la práctica. Una regla que depende de que el
agente decida que "la sesión creció" es una regla sin mecanismo.

**Predicción falsable:** si H3 domina, las sesiones con un prompt inicial de scope grande
("implementa la feature X") deberían mostrar más delegación que las de scope incremental
("sigamos"). Medible sobre las 13 sesiones ya auditadas, sin correr nada nuevo.

### H4 — Instrucción rival: auto mode ordena trabajar por Bash

Las 13 sesiones corrieron en `auto`, donde el host instruye hacer el trabajo por shell. El
mismo audit reporta `tool-mix` en **0% de lecturas nativas** en todas. Si el turno ya va por
la vía "hazlo tú con Bash", delegar es un cambio de vía que nada empuja.

**Predicción falsable:** sesiones en `default` / `acceptEdits` deberían mostrar otra tasa.
Hay grupo de control: el audit de la spec 0016 ya midió los tres modos.

### H5 — No existe ningún gate; todo es advisory

navori tiene 9 hooks y **ninguno** condiciona el cierre de un ciclo a que haya pasado un
reviewer. El `commit-pr-pilot` exige el gate de calidad verde, pero acepta un diff R1 que
nunca vio un reviewer — por diseño, con su "R1 exception". Cuando el ruteo se equivoca y
clasifica como R1 algo que era R2, no hay nada que lo detecte.

## Qué aportan las fuentes de inspiración

Revisadas contra `docs/inspiration.md`, quedándome con lo que ataca este problema:

**gentle-ai — Organic Implementation Routing.** Es el pariente más cercano y su ruteo tiene
umbrales explícitos donde el de navori tiene una regla cualitativa:

> "**Delegated Direct Route**: when understanding requires 4+ files, reading must precede
> writing, broad research is needed, **or 2+ non-trivial files change**, the agent hands
> work to one focused sub-agent."

navori tiene la regla de 4 archivos *para leer*; no tiene la de **2+ archivos no triviales
que cambian**. Ese segundo umbral es de escritura, y es el que habría disparado en las
jornadas medidas. Coincide con navori en lo importante: *"Size never selects SDD."*

**superpowers — la comprobación previa obligatoria.**

> "The agent checks for relevant skills **before any task**. Mandatory workflows, not
> suggestions."

Es un paso de pre-vuelo, no más prosa: convierte "acuérdate de las skills" en un momento
fijo del ciclo.

**gstack — `gstack-verify-gate`.** Un `Stop` hook que bloquea el fin de turno hasta que pase
el verify. Es la forma-mecanismo de H5: si algo debe ocurrir, un hook lo hace obligatorio en
vez de pedirlo. navori ya tiene el hook `Stop` opt-in (`hooks.verifyOnStop`) — la
infraestructura existe y está apagada.

**Advertencia honesta de gentle-ai**, que aplica a todo lo anterior:

> "No mechanism **forces** skill or agent usage — configuration and optional hooks guide
> behavior within agent-owned decision-making."

## El plan

### Fase 0 — Definir qué cuenta como defecto

"No se usó" no es el defecto; **"no se usó cuando aplicaba"** sí. La unidad de medida es la
**oportunidad perdida**: un punto del transcript donde la condición de disparo escrita se
cumplía y la invocación no ocurrió. La vara no se inventa — cada skill ya declara su trigger:

| disparador observable | debió activar |
|---|---|
| segundo intento del mismo fix | `loop-back-debug` |
| "listo/done" sin evidencia fresca del comando | `verify-before-done` |
| `gh pr create` / revisión de diff | `review-diff`, `commit-pr-pilot` |
| ráfaga de errores de tsc/lint/test | `debug-error` |
| 2+ archivos no triviales cambiando en un turno | `implementer` |
| código nuevo listo para merge | `reviewer` |

**Sesgo a restar:** las 13 sesiones son jornadas de *operación del harness* (releases,
rollouts, auditorías), no de features. Parte del 0% puede ser correcto. La Fase 1 lo separa
en vez de suponerlo.

### Fase 1 — Minería de los transcripts que ya existen (~2-3 h, no toca nada)

1. Recorrer los 13 transcripts marcando eventos-disparador con heurísticas verificables.
2. Cruzar contra las invocaciones reales (`Skill`, `Agent`) que el audit ya cuenta,
   **separando las automáticas de las pedidas explícitamente por el usuario** — sin esa
   separación H1 no es evaluable.
3. Clasificar cada sesión por forma del prompt inicial (scope grande vs incremental) para
   evaluar H3, y por modo de permisos para H4.

**Salida:** la tasa de activación **sobre oportunidades**, no sobre sesiones. Es el número
que hoy no existe y del que depende todo lo demás. Si sale ≥80%, el problema es chico y
esto termina podando las skills que nunca aplican.

### Fase 2 — Una intervención por hipótesis dominante, una variable a la vez

Método T7 de la spec 0017: un solo cambio, medir con `navori audit` sobre las siguientes
sesiones reales, veredicto con número.

| si domina | intervención | costo |
|---|---|---|
| H1 | reescribir las 7 descriptions con disparador + "use proactively"; `auditor` es la plantilla | 1 h |
| H2 | `when_to_use` en las skills con trigger ambiguo | 1 h |
| H3 | agregar el umbral de **escritura** (2+ archivos no triviales) a la escalera, y convertir la regla de sesión larga en algo con umbral | media sesión |
| H4 | hallazgo para la spec 0016 (paridad de modos), no un parche aquí | — |
| H5 | pre-vuelo estilo superpowers, o gate en el `commit-pr-pilot` que exija veredicto de reviewer salvo R1 declarado | 1 sesión |

**Orden recomendado: H1 primero.** Es una hora de trabajo, contradice directamente la
documentación oficial, y no toca ningún mecanismo. Si mueve la aguja, lo demás sobra.

### Fase 3 — Veredicto

- Si alguna intervención mueve la tasa → **spec 0019** con el mecanismo y rollout estándar.
- Si ninguna la mueve → el hallazgo es que el modelo de subagentes no encaja con jornadas
  interactivas dirigidas turno a turno, y lo honesto es **recortar** el harness a lo que sí
  se activa — lo mismo que la spec 0018 acaba de hacer con el render por workspace.

## Resultados de la Fase 1 (2026-09-09)

Instrumento: `scripts/mine-activation.py`, sobre las 13 sesiones auditadas.

### La tasa que faltaba

| | sesiones | oportunidades | activadas | tasa |
|---|---|---|---|---|
| **TOTAL** | 13 | 68 | 2 | **2%** |

Desglose por disparador:

| disparador | oportunidades | activadas |
|---|---|---|
| PR abierto → `review-diff` / `commit-pr-pilot` | 44 | 0 |
| `reviewer` (fuente editada + commit) | 11 | 1 |
| `implementer` (2+ archivos fuente en un turno) | 9 | 1 |
| `loop-back-debug` (mismo comando falla 2×) | 4 | 0 |

**El 2% es un techo, no una estimación.** El instrumento detecta escrituras por
`Edit`/`Write`, y en estas sesiones **el 66% de las escrituras van por Bash**
(heredoc, `sed -i`, `write_text`): 192 por herramienta nativa contra 360 por shell.
Las oportunidades reales son más, las activaciones son las mismas, así que la tasa
verdadera es menor.

### El hallazgo que reordena las hipótesis

**Las 9 invocaciones registradas fueron automáticas. Cero fueron pedidas por el usuario.**

```
implementer      automática=3   pedida=0
spec-bootstrap   automática=4   pedida=0
reviewer         automática=1   pedida=0
playwright-cli   automática=1   pedida=0
```

Esto **debilita H1**. `implementer` no tiene disparador en su `description` y aun
así se delegó solo tres veces; `auditor`, el único con disparador explícito, cero.
El campo `description` no es la barrera: cuando el orquestador decide delegar, el
mecanismo automático funciona. Simplemente casi nunca decide.

Reescribir las 7 descriptions sigue siendo correcto —lo pide la documentación
oficial— pero **deja de ser la primera intervención**: se predijo que era la causa
y el dato dice que no lo es.

### La única estratificación que separa

| estrato | sesiones | oportunidades | activadas | tasa |
|---|---|---|---|---|
| solo `auto` | 9 | 43 | 0 | **0%** |
| mezcla con `acceptEdits` / `default` | 4 | 25 | 2 | **8%** |

Las dos activaciones vienen de las dos sesiones que salieron de `auto` en algún
momento. **Fortalece H4.** Con 2 eventos en total no es una conclusión — es la
señal que merece la siguiente medición, y conecta directo con la spec 0016.

### H3 no es evaluable con esta muestra, y eso es un hallazgo

Las **13 de 13** sesiones se clasifican como *scope incremental*: arrancan con
"sigamos", "resuelve el issue pendiente", "haz el rollout". Ninguna empieza con
"implementa la feature X". No hay grupo de contraste para medir si un prompt de
scope amplio dispara más delegación.

Lo que sí queda establecido: **el 100% de las jornadas medidas avanzan turno a
turno**, que es exactamente el régimen donde la escalera R1/R2 clasifica cada
mensaje aislado como R1 y la única regla que lo cubriría —la de sesión larga— es
la única sin umbral objetivo.

### Límites del instrumento, escritos a propósito

- Ve el **34%** de las escrituras (el resto va por shell).
- `loop-back-debug` depende de `is_error` del bloque `tool_result`; un comando que
  falla pero sale con 0 no se cuenta.
- La atribución automática/pedida busca el nombre del agente en el texto del
  usuario: una petición parafraseada ("delega esto") cuenta como automática.
- 68 oportunidades y 2 eventos positivos: cualquier corte fino es ruido.

### Hipótesis después de la Fase 1

| | antes | después |
|---|---|---|
| H1 · descriptions sin disparador | principal | **debilitada** — 3 delegaciones automáticas sin trigger |
| H4 · auto mode como instrucción rival | secundaria | **principal** — 0/43 contra 2/25 |
| H3 · ruteo por turno | secundaria | no evaluable; el 100% incremental es el hallazgo |
| H5 · no hay gate | secundaria | intacta |
| H2 · `when_to_use` | menor | menor |

**Siguiente intervención propuesta:** no tocar descriptions todavía. Medir H4 con
un A/B honesto —la misma clase de jornada en `auto` contra `acceptEdits`— porque
es la única variable que hoy separa los datos. Si H4 se confirma, el hallazgo
pertenece a la spec 0016 (paridad de modos) y no a un parche de prosa aquí.

## Criterio de éxito

Tasa de activación sobre oportunidades, antes contra después, en condiciones comparables.
No "se siente mejor".

## Riesgo de método, escrito a propósito

Dos veces en este mismo proyecto la conclusión fácil fue "falta doctrina" y las dos veces el
dato dijo otra cosa: con codegraph la causa era fricción y la prosa no movía nada (T9/T7 de
la spec 0017); con las skills de workspace, un hallazgo entero se cayó al leer la
documentación oficial. **Este plan no empieza por escribir prosa nueva.** Empieza por
medir sobre transcripts que ya existen, y la primera intervención candidata es corregir un
campo que la documentación dice que es el mecanismo — no agregar otro párrafo pidiendo que
se use.


---

# La causa raíz (2026-09-09, posterior a la Fase 1)

**El bloque de orquestación nunca llegó al agente. En ninguna sesión real, desde que la
spec 0015 lo movió al hook.**

## El mecanismo

1. La spec 0015 sacó `Role: orchestrator (organic routing)` del `CLAUDE.md` always-on y lo
   pasó al `additionalContext` de un hook `SessionStart`. La razón era buena y estaba
   medida: 73 líneas × 19 subagentes ≈ **60k tokens** entregados a agentes que no orquestan.
2. Ese mismo hook emite también el *resume* de `progress/current.md`, y lo emite **antes**.
3. Claude Code **trunca** el `additionalContext` de un hook grande: entrega un **preview de
   los primeros ~2 KB** y escribe el resto en un archivo persistido que el agente no lee.
4. `progress/current.md` ocupa los primeros ~6 KB, así que el bloque cae más allá del corte.

## La evidencia

Sobre **todas** las sesiones con hook registrado en `~/.claude/projects`:

| sesión | hook (bytes) | offset del bloque | ¿llegó? |
|---|---|---|---|
| `42f06139` (esta) | 24,529 | 6,588 | **NO** |
| `04eed7b1` | 24,055 | 6,109 | **NO** |
| `fa4dd30b` | 22,991 | 6,709 | **NO** |
| `163302ed` (moonar) | 33,534 | 16,096 | **NO** |
| `9a5656bd` (health) | 32,570 | 14,664 | **NO** |
| `e0b2f2fc` | 48,821 | 33,129 | **NO** |
| … 40+ sesiones más | 20k–48k | 4,511–33,129 | **NO** |
| `56d92579` (fixture vacío) | 18,414 | **1,030** | **SÍ** |

**El único SÍ es el control.** Una sonda desechable en un fixture recién creado, sin
`progress/current.md` que empuje: el bloque cae en el byte 1,030, dentro del preview, y
llega. Mismo harness, mismo hook, misma versión — la única diferencia es cuánto texto lo
precede.

## Qué explica

Todo lo medido en la Fase 1 era corriente abajo de un bloque que no existía para el agente:

- La escalera R1/R2, la regla de 4 archivos y la de sesión larga **nunca se entregaron**.
  Un agente sin escalera de ruteo no "decide no escalar": no tiene escalera.
- `## Agentes disponibles` cae en el byte 6,479 — **tampoco llega**. El agente no recibe el
  catálogo; solo ve los agentes por el listado nativo de Claude Code, sin la doctrina de
  cuándo usarlos.
- `## Session startup` y `## Session closeout` corren la misma suerte.

Esto **supersede H1 a H5**. No es que la doctrina no convenza: es que no se entrega.

## Por qué no lo vio la Fase 1

Porque verifiqué la premisa contra el archivo equivocado. `grep "Role: orchestrator"` sobre
el archivo persistido del hook da 4 coincidencias, y de ahí concluí "el bloque llega". El
archivo persistido es, literalmente, la parte que el agente **no** recibe. La lección de
método: **un hook no se verifica por lo que emite, sino por lo que queda dentro del corte.**

## El experimento que ahora corresponde

El A/B de `auto` vs `acceptEdits` (H4) queda en segundo plano. El primero es el que aísla
esta variable, y el fixture de `scripts/ab-activation/` ya sirve tal cual:

- **Brazo A** — `progress/current.md` inflado hasta empujar el bloque fuera del preview
  (reproduce el estado de campo).
- **Brazo B** — fixture como está, con el bloque dentro del preview (el estado que el
  harness cree tener).

Mismo prompt, mismo modo, misma tarea que cruza el umbral R2. Mide: ¿delega?

## La corrección de fondo, independiente del experimento

Sea cual sea el resultado, el hook está roto como canal: emite 20–48 KB por un conducto que
entrega 2 KB. Las salidas posibles, en orden de cuánto conservan de la spec 0015:

1. **Ordenar el hook**: la doctrina primero, el resume volátil al final. Una línea de cambio,
   y lo que se pierda al truncar será lo reconstruible.
2. **Acotar el resume**: `progress/current.md` entra recortado, no completo.
3. **Devolver el bloque a `CLAUDE.md`** y resolver el costo de los subagentes con
   `skills[].injectInto`, el mismo mecanismo que el #614 usó para jscpd/semgrep — que
   entrega a quien debe recibirlo sin pagarlo en todos.

La 1 y la 2 son compatibles y baratas. La 3 revierte parcialmente la spec 0015 y merece su
propia discusión, porque su medición de 60k tokens sigue siendo válida.

---

# La línea base del "antes" (2026-09-10, posterior al arreglo de entrega)

El arreglo de entrega está cerrado y verificado **como mecanismo**: la spec 0019 (#631)
encontró que, aun con el orden y el presupuesto del #624 corregidos, el bloque seguía sin
llegar porque el hook recorre `.claude/context/` con un glob —que expande alfabéticamente—
y `orquestacion.md` quedaba último **por empezar con "o"**. Prueba de que no era tamaño:
recortado a 4,757 caracteres **seguía cayendo a puntero**. Con el orden en el nombre
(`10-`, `20-`, `30-`, `40-`), medido corriendo el hook en repos reales:

| repo | arranque | escalera | catálogo de agentes |
|---|---|---|---|
| moonar | 8,281 bytes | **cuerpo** | **cuerpo** |
| navori-health | 8,559 bytes | **cuerpo** | **cuerpo** |

(el corte mínimo del host observado son 10,441 bytes)

**Pero el criterio de éxito de este documento no es que el mecanismo funcione**, es la tasa
de activación antes contra después. Esto es el "antes", medido sobre trabajo real.

## Método

19 sesiones de `moonar-medusa-monorepo` y `navori-health`, los dos repos que el usuario
trabajó de verdad durante el día. La variable independiente **no se dedujo de la versión de
navori**: se leyó de cada transcript, buscando en los `attachment` de tipo
`SessionStart` si el bloque llegó como cuerpo (`navori:managed id="orquestacion"`) o como
puntero (`no cabe en el contexto de arranque`). Los 4 hooks de `SessionStart` se concatenan
antes de decidir — mirar solo el primero da un falso negativo, porque el de navori no es
el primero.

## Los números

| Muestra | Oportunidades | Activadas | Tasa |
|---|---|---|---|
| Fase 1 (#622, 13 sesiones, sobre todo navori-harness) | 68 | 2 | **2%** |
| Las 19 de moonar + navori-health | 80 | 6 | **7%** |
| Solo las 5 **con** harness navori (bloque = puntero) | 8 | 3 | **37%** |

Desglose de las 19, por disparador: `implementer` 4/28 (14%), `pr → review-diff/pilot` 1/26
(3%), `reviewer` 1/25 (4%), `loop-back-debug` 0/1.

Todas las invocaciones reales fueron **automáticas**; ninguna la pidió el usuario.

## Lo que estos números NO dicen

- **Ninguna de las 19 tuvo el bloque como cuerpo.** Verificado por transcript: las sesiones
  más recientes traen los nombres SIN prefijo, o sea que corrían con el harness anterior —
  el arreglo aún no había aterrizado en su working tree. **Las 19 son "antes". El brazo
  "después" empieza en cero.**
- **El 37% se apoya en n=8.** Un caso más o menos mueve la tasa 12 puntos. Es una pista de
  que el harness ya hacía trabajo *sin* la escalera —probablemente por el puntero accionable
  que introdujo el #624—, no un resultado.
- **El minero subcuenta por construcción**, y está escrito arriba: cuando el orquestador sí
  delega, el trabajo ocurre en el sidechain y el detector, que mira el hilo principal, queda
  ciego.

## Cómo se cierra

Los dos repos ya corren 0.8.2 con los archivos prefijados, así que el brazo "después" se
acumula solo con el uso normal. Cuando haya sesiones suficientes, se corre
`scripts/mine-activation.py` sobre ellas y se compara contra esta tabla. **No hace falta el
A/B sintético** de `scripts/ab-activation/`: la observación natural mide trabajo real en vez
de un fixture, que es justamente lo que el criterio de éxito pide.

Reserva deliberada: **no rodar otras specs a esos dos repos mientras se acumula la data.**
La 0018 solo cambia monorepos, o sea exactamente estos dos, y meterla ahora agregaría una
segunda variable justo donde se quiere aislar una.

## Una hipótesis más, descartada con evidencia

**H-C · "Los índices de skills de harnesses ajenos (`.atl/skill-registry.md`) confunden al
agente."** FALSO, y por una razón estructural.

Cuatro repos del workspace lo traen commiteado con 22–48 rutas de skills, **todas muertas**.
El issue #625 planteaba que un agente que buscara "skills" en el repo se llevaría esas rutas.
Barridos **185 transcripts** de toda la máquina: **cero lecturas del registry como guía**.
Las únicas apariciones son salidas de `git status`, diffs históricos, un plan que lo
regenera a propósito en `alertaciudadana_app` (uso real de gentle-ai), y las sesiones que
investigaron el propio issue.

La razón de que no ocurra: `.atl/` es un **dot-directory**, y tanto el `Grep` nativo como el
wrapper de tgrep los saltan por defecto. Está fuera de toda búsqueda de contenido salvo con
`--hidden`. El aviso de `doctor` (#633) queda como higiene —el contenido es basura rancia—
pero no es un problema de activación.

---

# El "después", medido (2026-09-10)

El brazo que faltaba. Se cierra con observación natural, sin el A/B sintético, tal como
quedó escrito arriba.

## La corrección de método que hubo que hacer primero

El "Método" de la línea base dice que la variable independiente se lee de los `attachment`
de tipo `SessionStart`. **Eso no basta, y por poco vuelve a fallar del mismo modo que #623.**
El transcript guarda dos cosas distintas y solo una responde la pregunta:

| Registro | Qué es | Sirve de evidencia |
|---|---|---|
| `hook_success.stdout` | lo que el hook **imprimió** | no |
| `hook_additional_context.content` | lo que el host **inyectó**, ya recortado | sí |

La diferencia no es teórica. En `50f01529` (navori-health, 2026-09-08) el `stdout` del hook
mide 28,643 bytes y trae la escalera entera; el contexto realmente inyectado mide **2,276
bytes** y no la trae. Clasificar por `stdout` la habría contado como "después". Es
exactamente el defecto que este documento investiga —un artefacto que afirma algo que el
host no cumplió— cometido por el instrumento que lo mide.

Un detalle más, de implementación: `hook_additional_context.content` es una **lista de
bloques**, no un string. Leerlo como string devuelve vacío en silencio, que se lee igual que
"no llegó".

Con el criterio corregido, los dos brazos se separan sin ambigüedad — no hay casos
intermedios:

| Brazo | Contexto inyectado | Sesiones |
|---|---|---|
| antes | 2,247–2,322 bytes (el corte del host) | 14 |
| después | 8,160–8,461 bytes, escalera y catálogo como cuerpo | 5 |

(Las 5 "antes" de agosto en navori-health inyectan 4,336–8,397 bytes: son de un harness
previo, sin escalera. Cuentan como "antes" por ausencia del bloque, no por tamaño.)

## La tabla del "antes" mezcla los dos brazos

La sección anterior afirma que **ninguna** de las 19 tuvo el bloque como cuerpo. Con el
criterio corregido, **5 de esas mismas 19 sí lo tuvieron**. Ya existían cuando se escribió
—la más antigua arrancó a las 15:56 hora local y el documento se commiteó a las 20:19—, y
se clasificaron por los nombres de archivo del contexto; el problema es que las sesiones que
hicieron el rename traen los nombres viejos **y** los nuevos a la vez, así que ese signo no
distingue.

Sus 80 oportunidades tampoco son las 93 que suman hoy los dos brazos: cuando corrió aquel
minero, tres de esas sesiones seguían abiertas y crecieron después.

Conclusión: el 7% de esa tabla **no es la línea base del "antes"** —es una mezcla de los dos
brazos medida a mitad de camino, y por eso queda por debajo de ambos extremos reales—. El 4%
de aquí abajo la reemplaza.

## Los números

Mismo minero, mismos dos repos, ambos brazos remedidos para que la comparación sea interna
y no contra la tabla de la sección anterior:

| Brazo | Sesiones | Oportunidades | Activadas | Tasa |
|---|---|---|---|---|
| antes | 14 | 72 | 3 | **4%** |
| después | 5 | 21 | 12 | **57%** |

Por disparador, en el "después": `implementer` 4/4, `reviewer` 4/4, `pr → review-diff/pilot`
4/13 (30%). En el "antes": `implementer` 3/27 (11%), `reviewer` 0/24, `pr` 0/20.

Las 12 invocaciones del "después" fueron **automáticas**; ninguna la pidió el usuario. Igual
que en el "antes".

## Cómo reproducirlo

El criterio de clasificación quedó en un script, para que la remedición no dependa de
recordar la distinción `stdout` / `hook_additional_context`:

```
python3 scripts/classify-activation-arm.py <dir-de-proyecto> [<dir> ...]
python3 scripts/classify-activation-arm.py --ids-after <dir> ... > after.txt
python3 scripts/mine-activation.py after.txt
```

`<dir-de-proyecto>` es un directorio bajo `~/.claude/projects`. Sin `--ids-after` imprime la
tabla de brazos con los bytes inyectados de cada sesión, que es lo que permite auditar la
clasificación a mano.

## La distribución, que es la mitad del resultado

**En los dos brazos las activaciones salen de una sola sesión.**

| Brazo | Sesión que activó | Las demás |
|---|---|---|
| antes | `790b12db` — 3/9 | 13 sesiones, 0/63 |
| después | `52b9891d` — 12/13 | 4 sesiones, 0/8 |

O sea que lo que se movió con certeza es el **techo**: la mejor sesión pasó de 3/9 (33%) a
12/13 (92%), y esa sesión corrió el ciclo completo `implementer` → `reviewer` →
`commit-pr-pilot` sin que nadie se lo pidiera. Lo que **no** se puede afirmar con n=5 es que
se haya movido la fracción de sesiones que activan algo: 1/14 antes contra 1/5 después no
distingue nada.

## Lo que estos números NO dicen

- **n=5 sesiones, 21 oportunidades.** Una sesión más o menos mueve la tasa decenas de
  puntos. Es un resultado direccional, no una medición estable.
- **El sesgo de observación no separa los brazos** —5 de las 14 "antes" y 4 de las 5
  "después" son sesiones auditadas a propósito—, así que no explica la diferencia; pero
  tampoco está controlado.
- **El minero sigue subcontando por construcción** (el trabajo delegado ocurre en el
  sidechain). Ambos brazos comparten el sesgo, así que el cociente aguanta mejor que los
  valores absolutos.
- **Dos sesiones largas del "después" quedaron en 0** (`d71392e5`, 31 turnos, 0/3;
  `92123149`, 6 turnos, 0/3) **con la escalera entregada como cuerpo.** La entrega es
  necesaria y no es suficiente; ahí queda la siguiente pregunta, y la regla de este
  documento sigue en pie: si el número no se mueve, la respuesta no es escribir más prosa.

## Veredicto

> ⚠️ **SUPERADO por la remedición del 2026-09-11** (sección siguiente). El 57% era artefacto
> de n=5 y queda retirado; la cifra vigente es **24%** sobre 16 sesiones. Esta sección se
> conserva sin editar porque su propia condición de revisión es la que disparó la remedición.

El criterio de éxito se cumple en dirección y magnitud —4% → 57% sobre oportunidades, con
el `reviewer` y el `pr → pilot` pasando de 0 a activarse— pero descansa en una sola sesión
por brazo. **Se declara cumplido y se deja abierta la remedición** cuando haya ~15 sesiones
del brazo "después", que es lo que hace falta para que deje de depender de un caso.

# La remedición (2026-09-11, n=16): el 57% no se sostiene

> El veredicto de arriba dejó escrita su propia condición de revisión: *"se deja abierta la
> remedición cuando haya ~15 sesiones del brazo 'después'"*. Ya hay **16**. Esto es esa
> remedición, con el mismo método y los mismos dos scripts.

## Los números

| Brazo | Sesiones | Oportunidades | Activadas | Tasa |
|---|---|---|---|---|
| antes | 14 | 72 | 3 | **4%** |
| después — lo publicado | 5 | 21 | 12 | **57%** |
| **después — remedido** | **16** | **107** | **26** | **24%** |

Por disparador cae todo al quintuplicar la muestra:

| Disparador | n=5 | n=16 |
|---|---|---|
| `implementer` | 4/4 (100%) | 8/26 (**30%**) |
| `reviewer` | 4/4 (100%) | 8/23 (**34%**) |
| `pr → review-diff/pilot` | 4/13 (30%) | 10/55 (**18%**) |
| `loop-back-debug` | — | 0/2 |
| `verify-before-done` | — | 0/1 |

Los dos 100% eran **cuatro de cuatro**. La sección "Lo que estos números NO dicen" ya lo había
advertido —"una sesión más o menos mueve la tasa decenas de puntos"— y es exactamente lo que
pasó.

## La versión del harness no es la variable

Las 16 sesiones abarcan cinco releases, y el resultado no es monótono:

| Versión renderizada | Activadas / oportunidades | |
|---|---|---|
| 0.8.0 | 0/26 | 0% |
| 0.8.1 | 0/5 | 0% |
| 0.8.2 | 21/32 | **66%** |
| 0.8.3 | 2/33 | 6% |
| 0.8.4 | 0/2 | n insuficiente |
| sin log de audit | 3/9 | 33% |

El pico está en 0.8.2 y 0.8.3 se desploma. Cuando la variable que se cree explicativa no ordena
el resultado, no es la variable.

## Lo que sí ordena: el repo

| Repo | Activadas / oportunidades | |
|---|---|---|
| navori-health | 21/33 | **64%** |
| navori-harness | 5/60 | 8% |
| moonar-medusa-monorepo | **0/14** | 0% en cinco sesiones |

Mismo harness, versiones solapadas, tres regímenes. `moonar` no ha delegado **nunca**, de 0.8.1
a 0.8.4. Y el caso extremo vive en navori-harness: `53c8808a`, la sesión más grande del brazo
(46 turnos, `auto:190`), con **26 oportunidades y cero activaciones**.

Versión y repo están confundidos por construcción: cada sesión corrió la versión que su repo
tenía ese día. **Este diseño observacional no puede atribuir un cambio de conducta a un
release**, ni al 0.8.4 ni a ninguno.

## Los tres eslabones, y cuál falló

El programa del 0.8 encadenaba tres condiciones antes de la conducta. Las cuatro están medidas:

| Eslabón | Estado | Evidencia |
|---|---|---|
| La doctrina **llega** | ✅ | 7,448–8,657 bytes inyectados como cuerpo, no puntero (desde 0.8.2) |
| Se **entiende** | ✅ | la sesión que produjo el mejor análisis de tgrep del parque siguió yéndose por shell en 9 de cada 10 búsquedas (#668) |
| Se **nota** | ✅ | `routing-watch` emitió `notify — "4 archivos del hilo principal, sin subagente"` (0.8.4, sesión `8701ecd8`) |
| **Cambia la conducta** | ❌ | tras ese aviso: 219 eventos, todos `Bash`, y **cero eventos de subagente** en toda la sesión |

**La hipótesis "no delega porque la doctrina no le llega o no la nota" queda refutada.**
Recibió, entendió, fue avisado, y no cambió.

Que la ausencia de subagente sea un hecho y no una falla de instrumento lo prueba el control:
en `8719afdd`, mismo hook y misma versión, el `SubagentStop` sí quedó registrado.

## El A/B controlado apunta igual

El 2026-09-11, dos sesiones simultáneas sobre la misma tarea — una con harness `--full`
(7 plugins) y otra sin nada:

| Brazo | Turnos | Bash | Skills | Subagentes |
|---|---|---|---|---|
| `con-harness` | 155 | 108 | **0** | **0** |
| `sin-harness` | 121 | 104 | **0** | **0** |

No es concluyente y no debe citarse como si lo fuera: el harness llevaba menos de una hora
instalado, está en su forma más débil (greenfield, sin stack detectado ni quality gate), y la
tarea era de browser, que legítimamente puede no merecer delegación. Pero la dirección coincide
con lo observacional.

## El instrumento está roto, y eso acota todo lo anterior

Tres defectos encontrados el 2026-09-11, los tres con issue abierto:

1. **`subagent-stop-handoff` infla ~10×**: 518 disparos contra 49 `Task` reales en 48 h. En
   `4935c4d7`, 112 disparos con 111 `agentId` distintos para 4 subagentes reales. Cualquier
   conteo de agentes derivado de ese hook está inflado.
2. **La heurística de oportunidades no distingue trabajo generado de trabajo de lógica.**
   Cuenta por archivos tocados + commit, así que las 46 rutas que reescribe un `render --apply`
   puntúan igual que 46 archivos de lógica. El propio release de 0.8.4 es ese caso, y es R1
   legítimo.
3. **Los dos instrumentos se contradicen sobre la misma sesión**: `mine-activation.py` puntúa
   `8719afdd` como 0/1, el hook registró un `SubagentStop`, y el transcript no tiene ni un
   `Task` ni un sidechain. El hook mintió.

Por el punto 2, **el 24% es un piso y no una medición**: una parte desconocida de esas 81
no-activaciones era la ruta correcta. Calibrarlo exige auditar a mano una muestra, y hasta
entonces el número no distingue deuda de acierto.

## Veredicto corregido

- **En dirección el efecto se sostiene**: 24% sigue siendo 6× el 4% del brazo "antes".
- **En magnitud, el 57% era artefacto de n=5** y queda retirado.
- **La entrega de doctrina está resuelta y agotada como palanca.** Los tres eslabones se
  cumplen y la conducta no cambia: seguir escribiendo mejor prosa no tiene mecanismo de acción
  disponible.
- **La pregunta abierta ya no es "cómo hacer que la doctrina llegue"**, sino por qué un repo
  delega el 64% y otro el 0% con el mismo harness — y si la respuesta es el tipo de trabajo
  (feature-ticket contra release-ops), entonces la métrica está mal definida y el 24% no es
  deuda.

Lo que sigue no es otra iteración de prosa: es **convertir en mecanismo lo que hoy se sugiere**
—el patrón que en este harness funciona 14/14 (`guard-destructive`) y 7/7
(`quality-gate-pre-commit`), contra 0/1 del aviso— y reparar el instrumento antes de volver a
confiar en un número. La regla de este documento —*"si el número no se mueve, la respuesta no
es escribir más prosa"*— se aplica por segunda vez, ahora a sí misma.
