# Disparadores de skill — Requirements

## Context

El issue #758 (A6 de #736) pide una tabla de disparadores de skill en la config
(`project.skillTriggers`) leída por un hook de `UserPromptSubmit`: cada match
escribe al audit-log y una señal aparea el match con la invocación subsiguiente.
El campo no existe hoy — ni en el schema (`lib/schema.ts`, `ProjectSchema`), ni
en el render, ni en ningún hook. El módulo homónimo `lib/skill-triggers.ts` es
otra cosa: un check de `doctor` sobre el `description` de las skills
project-local. Nombre igual, mecanismo distinto.

La razón declarada del issue es correcta y no se discute: la lección de
#674/#679 es que **el instrumento nace CON el mecanismo**, o se repite el ciclo
de publicar un número que el propio instrumento invalida seis semanas después.
Esta spec cumple esa lección de la única forma que la medición permite: midiendo
**antes** de construir.

### Lo medido, que es el contrato de esta spec

Corpus: los 197 transcripts de `~/.claude/projects` de esta máquina, ventana
2026-08-12 → 2026-09-13 (32 días, 6.16 sesiones/día; 195 con actividad real).
Invocación = uso de la herramienta `Skill` en el hilo principal, que es la fuente
que la spec 0022 instrumenta.

**Hecho 1 — las dos candidatas del issue nunca se han invocado.** Ni una vez, en
ningún repo, en toda la ventana:

| slug | invocaciones en el parque |
|---|---|
| `babysit-prs` | **0** (ni herramienta `Skill`, ni sello `attributionSkill`) |
| `citty` | **0** (idem) |

Y no es un accidente de esas dos: de 195 sesiones activas, **2 (1%)** invocaron
alguna lib-skill. Las 47 sesiones (24%) que invocan *algo* invocan skills de
flujo — `spec-bootstrap` (18), `ticket-intake` (6), `dominio` (4).

**Hecho 2 — los anchos medidos, con puntos de operación viables.**

| candidata | condición | dispara | H₀ (invocó sin tabla) | 20 emisiones en |
|---|---|---|---|---|
| `citty` | toca `packages/cli/src/commands/*.ts` | 20/56 (36%) | **0** | **31 días** |
| `citty` | payload trae `defineCommand` | 17/56 (30%) | **0** | 38 días |
| `citty` | crea comando **o** registra en `index.ts` | 4/56 (7%) | **0** | 160 días |
| `citty` | crea `commands/*.ts` con `Write` | 1/56 (2%) | **0** | 640 días |
| `babysit-prs` | menciona PR/merge/rebase | 123/195 (63%) | **0** | 5 días |
| `babysit-prs` | URL de PR o `PR #n` | 45/195 (23%) | **0** | **14 días** |
| `babysit-prs` | "check en rojo" / "CI falla" | 6/195 (3%) | **0** | 108 días |

**Dos puntos son viables**, y la v2 de esta spec se equivocó al negarlo:
`babysit-prs` al 23% junta 20 emisiones en 14 días y es **menos ruidoso que el
32% que la spec 0024 aceptó** para su propio disparador; `citty` al 36% las junta
en 31 días. El "papel tapiz" de 0024 era el **78%**, no el tercio — de estos
siete anchos solo el de 63% cae de ese lado. Lo que sí queda fuera de horizonte
son los anchos semánticamente estrictos de `citty` (7%, 2%: 160 y 640 días), que
es un límite del volumen de este repo y no del mecanismo.

> **Corrección sobre la v2.** Aquí se presentaba esta tabla como un frente de
> Pareto de dos ejes y se concluía que estaba vacío. Los "dos ejes" eran el mismo
> conteo: `firings/día = conteo/32` y `días = 640/conteo`, así que "dominar en
> ambos" pedía menos y más disparos a la vez — insatisfacible por álgebra. Con
> H₀ = 0 los ejes reales de 0024 no se pueden replicar (la cobertura degenera al
> conteo de disparos y la pre-emption es idénticamente cero), así que **el costo
> del falso positivo queda sin medir**, no medido-y-malo. Detalle en `design.md`
> § *Argumento retirado (2)*.

**Hecho 3 — `UserPromptSubmit` llega antes del trabajo del turno.** De las 64
invocaciones de `Skill` del hilo principal en el parque:

| medida | valor |
|---|---|
| ocurren después del primer turno | **57/64 (89%)** |
| herramientas ya usadas antes de invocar | mediana **105**, p90 **322** |
| invocada como PRIMERA herramienta de la sesión | **0/64 (0%)** |
| invocada dentro de las 4 primeras herramientas | 5/64 (8%) |

Cargar una skill es una decisión de **mitad de trabajo**, no de prompt. Es
literalmente la objeción que la spec 0020 ya dejó escrita al elegir `PostToolUse`
para `routing-watch`: *"`UserPromptSubmit` dispara antes de que el modelo haya
hecho nada ese turno, o sea a destiempo."*

La vía de archivo hereda el mismo desfase: un hook en ese evento lee el
transcript vía `transcript_path` y ve las rutas de los turnos *anteriores*, no
las del que empieza. La condición disponible es "en algún turno previo se tocó un
comando", no "estoy editando uno".

> **Corrección sobre la v1 de esta spec.** Aquí se afirmaba que el payload trae
> solo `user_prompt`/`session_id`/`cwd` y que por eso la vía de archivo era
> "inobservable **por construcción**". Es falso: `transcript_path` es campo común
> del payload de todos los hooks (`host-contracts.ts:140`), el propio
> `hooks/audit-mode-trigger.sh:152` lo lee con un test que lo fija
> (`audit-hooks.test.ts:219`), y `progress/history.md:555` registra que la clave
> del prompt es `prompt` — `user_prompt` nunca existió. Lo que sobrevive es
> **rezago, no imposibilidad**, y el rezago es una cara de este mismo Hecho 3, no
> un hecho aparte. El detalle y su efecto sobre el veredicto: `design.md`
> § *Argumento retirado* y § *Veredicto*.

**Hecho 4 — el disparador ya viaja always-on.** El bloque managed
`## Skills disponibles` que `buildSkillsIndexBody`
(`packages/cli/src/engines/claude/index.ts:202`) renderiza en cada `CLAUDE.md`
ya publica, en cada sesión, la línea `citty — library (detected) · Use when
adding or editing a CLI command with citty`. La tabla entregaría **el mismo
texto, al mismo modelo, más tarde**. Los cuatro intentos refutados de este repo
(`progress/history.md`, 2026-09-11) fueron "decirlo otra vez, distinto"; éste
sería "decirlo otra vez, después", y la medición del Hecho 3 dice que ese
"después" no es el momento de la decisión.

El núcleo de este hecho es la **duplicación**, que no depende de H₀: la tabla
repetiría el texto aunque la tasa base fuera alta. Que además la entrega
always-on lleve 195 sesiones sin producir una invocación es H₀ leído como
evidencia en contra — refuerzo legítimo, pero es la misma cifra que el veredicto
declara favorable al mecanismo, así que se marca y no se cuenta dos veces.

**Hecho 5 — cero mediciones válidas de la palanca consultiva, y es el que
decide.** La vara es de la spec 0024 y esta spec la aplica también a sí misma:
*una medición vale solo si su instrumento recibe el carril que domina las
llamadas*. Por esa vara no existe hoy ninguna medición de la inyección consultiva
por `additionalContext`:

- **`routing-watch`** (0020) está construido y no ha reportado, con su carril
  dominante desconectado: `engines/claude/build-settings.ts:222` registra
  `matcher: "Edit|Write|NotebookEdit|Agent|Task"` mientras el script acepta `Bash`
  desde #722 A4. El issue **#775** lo cuantifica: **19 cruces de umbral visibles
  donde hay 40 — 21 sesiones (52.5%) invisibles**.
- **`memory-watch`** (0024) tiene spec mergeada (#770) y no existe en el árbol.

Es el único hecho que no se responde rediseñando el mecanismo, sino **esperando
un dato que ya está en el tablero**.

**Hecho 6 — el techo del instrumento, en la vía de prompt.** Medido sobre el
mejor caso del parque: `spec-bootstrap` —la skill más invocada— con su condición
natural en el prompt dispara en 32/195, convierte **9/32 (28%)** y captura solo
**9/18 (50%)** de las invocaciones que ya ocurren. Un patrón sobre el prompt es
mal predictor incluso donde la skill sí se usa. **No aplica a la vía de archivo**,
donde una ruta matchea o no sin inferencia sobre lenguaje natural.

### El veredicto, arriba y no al final

**El mecanismo del issue #758 no se construye TODAVÍA — moratoria de secuencia,
no refutación**, y lo carga el Hecho 5: construir el tercer inyector consultivo
antes de poder leer el primero es multiplicar instrumentos sin multiplicar
evidencia. Los Hechos 3 y 4 acotan y mandan el diseño hacia `PostToolUse`, pero
ninguno basta solo.

**El veredicto se movió dos veces, las dos hacia abajo**, y las dos correcciones
tumbaron un argumento que prometía una refutación estructural: primero la premisa
falsa sobre el payload (v1), después el frente de Pareto de un solo eje (v2). El
recuento completo está en `design.md` § *Veredicto* → *Cómo llegó el veredicto
hasta aquí*. Lo que queda es **satisfacible y con puerta**: la condición de
reevaluación se cumple cuando #775 aterrice o `memory-watch` reporte.

Lo que sí se entrega es el **instrumento** que convierte esa conclusión en algo
re-verificable. La razón es la misma que `scripts/py/mine-search-routing.py` escribió
para sí mismo: *"una medición que no se puede repetir no es una línea base, es una
anécdota."* El argumento completo, con los descartes, vive en `design.md`
§ *Por qué no se construye todavía* y § *Veredicto*.

Público: quien mantenga navori y tenga que decidir si `project.skillTriggers`
se construye. Issue: #758, salido de #736 punto A6.

## Requirements (EARS)

### El instrumento — lo que esta spec sí entrega

- **R1** — El sistema SHALL entregar un minero reproducible que, sobre los
  transcripts del parque y por cada candidata declarada, publique las tres
  cantidades del embudo: (a) sesiones donde la condición del disparador se
  cumplió, (b) de ésas, cuántas invocaron la skill, y (c) el denominador de
  sesiones con actividad real. Dos corridas sobre el mismo corpus SHALL producir
  la misma salida.

  La unidad es la **oportunidad perdida** —un punto donde la condición escrita se
  cumplía y la invocación no ocurrió—, no "la skill no se usó". Esa definición ya
  es la del repo (`docs/research/activacion-subagentes-y-skills.md`, Fase 0) y no
  se reinventa aquí.

- **R2** — El minero SHALL contar como invocación **únicamente** los usos de la
  herramienta `Skill`, y SHALL declarar ese conteo como **cota inferior**
  nombrando su causa: una skill tecleada `/skill-name` no aparece como `tool_use`
  (`anthropics/claude-code#24858`). El minero SHALL NOT publicar ningún
  porcentaje cuyo numerador sea ese conteo sin la salvedad impresa junto al
  número. Es la misma regla que la R12 de la spec 0022, heredada porque la fuente
  es la misma y el hueco también.

- **R3** — El minero SHALL evaluar las **dos vías** de condición con la misma
  forma de salida: patrón sobre el texto del prompt y patrón sobre las rutas que
  la sesión tocó. Las dos candidatas del issue ejercitan una cada una
  (`babysit-prs` por prompt, `citty` por archivo) y la comparación entre vías no
  SHALL requerir reconciliar dos formatos distintos.

  El lado "archivo" SHALL contar las rutas de **las dos vías** por las que el
  modelo toca archivos —la herramienta nativa y el comando de shell—, por la
  misma razón que la R3 de la spec 0024: en este parque el 80.9% de las llamadas
  del hilo principal son `Bash`, y un contador que solo mire la vía nativa mide
  un carril abandonado.

- **R4** — IF una sesión no tiene transcript legible, o no tiene actividad —ni
  prompt del usuario ni archivo tocado—, THEN el minero SHALL excluirla del
  denominador y SHALL declarar cuántas excluyó. Una sesión vacía y una sesión que
  no convirtió SHALL NOT contarse igual.

- **R5** — El minero SHALL imprimir la **línea base pre-registrada** junto a la
  medición fresca, de modo que una corrida futura no pueda redefinir H₀ en
  silencio. La línea base es **H₀ = 0** para las dos candidatas, con su
  denominador y su ventana escritos en `design.md` § *El embudo pre-registrado*
  antes de que exista un dato nuevo.

### Lo que NO se construye, y el cable que lo sostiene

- **R6** — Esta spec SHALL NOT agregar el campo `skillTriggers` al schema de
  config, SHALL NOT registrar ningún hook nuevo en `UserPromptSubmit`, y SHALL
  NOT modificar ningún bloque managed de `CLAUDE.md` ni de `.claude/`.

  WHEN un repo ya inicializado corre `navori render --apply` o `navori update`
  después de esta spec, el sistema SHALL producir **cero** cambios en su
  `.claude/settings.json`, en sus hooks y en su `CLAUDE.md`. Ningún bloque
  managed cambia de hash, así que `sync` no tiene nada que reconciliar y ningún
  repo con ficheros editados a mano ve un conflicto nuevo.

- **R7** — El pre-registro SHALL declarar, escrito antes del primer dato: la
  hipótesis nula con su denominador, la **condición de reevaluación** que levanta
  la moratoria, y el criterio por el cual el mecanismo se daría por muerto.

  La condición de reevaluación SHALL ser **verificable contra trabajo que existe**
  —el aterrizaje de #775, o el embudo de `memory-watch` (0024)— y SHALL NOT
  depender de un criterio que ningún dato pueda satisfacer. Es un requisito con
  causa: la v2 de esta spec fijó como llave "un ancho de patrón con codo" sobre un
  frente que era un solo eje, o sea una puerta que nadie podía abrir.

  SHALL declarar además **qué carril domina** la decisión que se quiere mover y
  si el instrumento propuesto lo recibe — la vara que la spec 0024 estableció
  (*"una medición vale solo si su instrumento recibe el carril que domina"*) y
  que el defecto #767/#775 hizo necesaria. Un pre-registro que omita esa
  declaración SHALL NOT considerarse completo.

- **R8** — El pre-registro SHALL publicar el veredicto **por candidata**, no uno
  solo para las dos. `citty` y `babysit-prs` ejercitan vías distintas y sus
  límites son distintos —el techo de recall del 50% (Hecho 6) aplica a la vía de
  prompt y no a la de archivo, y los tiempos de acumulación difieren en 2×—, así
  que una conclusión única SHALL NOT presentarse como si cubriera a las dos.
