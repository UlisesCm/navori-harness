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

**H-A · "El bloque de orquestación no llega a la sesión."** FALSO. El `SessionStart` hook
inyecta `## Role: orchestrator (organic routing)` con sus seis subsecciones — verificado en
el contexto de la sesión `42f06139`. El bloque llega, y es bueno: escalera R1/R2/R2-fan,
regla de 4 archivos, regla de sesión larga, delegación frugal, rutas de handoff literales.
72 líneas de doctrina precisa. **El problema no es que falte doctrina.**

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
