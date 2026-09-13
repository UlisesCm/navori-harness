# Disparadores de skill — Design

## Approach

**El mecanismo del issue #758 no se construye TODAVÍA: moratoria de secuencia,
no refutación.** Medido sobre los 197 transcripts del parque, el mecanismo tiene
puntos de operación viables y una tasa base de cero que le es favorable. Lo que
no tiene es **turno**: hoy no existe ni una sola medición válida de la palanca
consultiva que usaría —`routing-watch` ve la mitad de sus cruces por un matcher
sin `Bash` (#775), `memory-watch` no está construido (#770)—, así que un tercer
inyector no puede enseñar nada que los dos primeros no deban enseñar antes.

Lo que sí se entrega es el **instrumento**: `scripts/mine-skill-triggers.py`,
que calcula el embudo del issue —condición cumplida → invocación— sobre los
transcripts que ya existen, más el pre-registro que fija H₀ y la condición de
reevaluación. Cero hooks, cero campo de config, cero líneas de contexto
always-on, cero cambios en el harness renderizado.

Esto **cumple** la razón por la que el issue existe, no la esquiva. #758 pide
que el mecanismo nazca con su embudo para no repetir #674/#679. El embudo se
construye primero; resulta que dice que el orden correcto es otro. Eso es el
instrumento haciendo su trabajo — es exactamente lo que #674 costó por no
tenerlo a tiempo.

**Dos argumentos de versiones anteriores de esta spec se retiraron por falsos**
—uno sobre el contrato del host, otro sobre un frente de Pareto que era un solo
eje—, y los dos empujaban hacia una conclusión más fuerte de la que la evidencia
aguanta. Quedan escritos en sus bloques `> Argumento retirado`; el recuento está
en § *Veredicto*.

## La medición

Corpus: `~/.claude/projects`, 197 transcripts, ventana 2026-08-12 → 2026-09-13
(32 días, 6.16 sesiones/día; 195 con actividad real, 57 de navori-harness / 56
activas). Invocación = uso de la herramienta `Skill` en el hilo principal.

### Lo que las candidatas hacen hoy

| slug | usos de la tool `Skill` | sellos `attributionSkill` |
|---|---|---|
| `babysit-prs` | **0** | **0** |
| `citty` | **0** | **0** |
| cualquier lib-skill | 2 sesiones / 195 (**1%**) | idem |
| cualquier skill | 47 sesiones / 195 (24%) | — |

Las 47 sesiones que invocan algo invocan **flujo**: `spec-bootstrap` (18),
`artifact-design` (7), `ticket-intake` (6), `dominio` (4). Las lib-skills son
dos one-offs (`drizzle-orm`, `playwright-cli`).

### Los anchos medidos, y el eje que NO existe

| candidata | condición | dispara | firings/día | 20 emisiones en |
|---|---|---|---|---|
| `babysit-prs` | menciona PR/merge/rebase | 123/195 (63%) | 3.9 | 5 días |
| `babysit-prs` | URL de PR o `PR #n` | 45/195 (23%) | 1.4 | **14 días** |
| `babysit-prs` | "check en rojo" / "CI falla" | 6/195 (3%) | 0.19 | 108 días |
| `citty` | toca `commands/*.ts` | 20/56 (36%) | 0.64 | **31 días** |
| `citty` | payload trae `defineCommand` | 17/56 (30%) | 0.53 | 38 días |
| `citty` | crea comando **o** registra en `index.ts` | 4/56 (7%) | 0.13 | 160 días |
| `citty` | crea `commands/*.ts` con `Write` | 1/56 (2%) | 0.03 | 640 días |

> ### Argumento retirado (2) — el "frente de Pareto" era un solo eje
>
> La v2 de esta spec presentaba esta tabla como un frente de dos ejes "los
> mismos que la 0024" y concluía que estaba **vacío**: ningún punto dominaba a
> sus vecinos, luego no había ancho defendible. **Era vacuo, y por álgebra, no
> por los datos.**
>
> Las tres últimas columnas son **el mismo conteo transformado**: con la ventana
> de 32 días, `firings/día = conteo/32` y `días para 20 = 640/conteo`. Verificado:
> `640/45 = 14.2`, `640/20 = 32.0`, `640/4 = 160.0` — idénticos a la columna de
> días. Pedir que un punto "domine en los dos ejes" es pedir **menos disparos y
> más disparos a la vez**: insatisfacible para cualquier dato posible. Una
> refutación apoyada en un criterio imposible es una refutación permanente
> disfrazada, y peor: la cláusula 2 de revival colgaba de ese criterio, así que
> la puerta de vuelta que esta spec anunciaba como "alta falsabilidad" **no la
> podía abrir nadie**.
>
> Los ejes de la 0024 sí eran dos, y distintos (`0024/design.md:59-64`):
> **cobertura** (cuántas de las 60 sesiones que nunca buscaron alcanza el umbral)
> y **pre-emption** (en cuántas el aviso se adelantaría a un `mem_search` que
> llegaba igual). Dos conteos independientes, con trade-off real.
>
> **Por qué aquí no se pueden replicar — y esto sí es un hallazgo.** Los dos
> degeneran precisamente porque **H₀ = 0**:
>
> - *cobertura* = sesiones donde la condición se cumplió y la skill NO se invocó.
>   Como nunca se invocó, **es idéntica al conteo de disparos**.
> - *pre-emption* = sesiones donde la skill iba a invocarse igual. Es **0 en todos
>   los anchos**, por definición de H₀ = 0.
>
> La cifra que esta spec celebra como favorable al mecanismo es exactamente la
> que impide construirle un frente con datos históricos. Queda **un solo eje**
> medible —con qué frecuencia dispara— y **el costo del falso positivo queda sin
> medir**: es un costo conductual (entrenar al lector a ignorar) que ningún
> recuento de transcripts puede cuantificar. La v2 afirmaba una medición que
> nunca hizo.

**Lo que la tabla sí sostiene, y lo que no.**

**No** sostiene un listón de "papel tapiz" en 23%, 30% ni 36%. La spec 0024
**aceptó** un disparador al **32%** (`0024/design.md:73,118`) y su frente no
dominado va de 25% a 41%; su "papel tapiz" era el 78%, no el tercio. Aplicar
aquí un listón más duro que el del precedente —y usar al mismo tiempo el 32%
como comparador aceptable en § *La no-colisión*— sería elegir el resultado. Se
retira. De los siete anchos, el único que cae del lado del 78% es el de 63%.

**Sí** sostiene, como hecho de un solo eje y sin juicio de ruido, **cuánto
tardaría cada candidata en producir evidencia**:

- `babysit-prs` con "URL de PR o `PR #n`" — 23%, **20 emisiones en 14 días**.
  Menos ruidoso que el punto que 0024 aceptó y más rápido que su presupuesto
  (17 días para 40). **Este punto es viable y hay que decirlo.**
- `citty` con "toca `commands/*.ts`" — 36%, **31 días** para 20 (62 para 40).
  Lento pero alcanzable. Sus anchos semánticamente correctos —crear un comando o
  registrarlo, 7%— piden **160 días**: ésos sí quedan fuera de cualquier
  horizonte útil, y es un límite del volumen de este repo, no del mecanismo.

### El contraste que fija el techo

La pregunta obvia es si las candidatas rinden poco porque están mal elegidas. Se
midió contra la skill que **sí** se invoca — `spec-bootstrap`, la más usada del
parque con 18 invocaciones — usando su condición natural en el prompt
(`spec`, `especificación`, `requirements.md`, `EARS`):

| medida | valor |
|---|---|
| el patrón dispara en | 32/195 sesiones (16%) |
| de ésas, invocaron `spec-bootstrap` | **9/32 (28%)** |
| de las 18 invocaciones reales, capturadas por el patrón | **9/18 (50%)** |

O sea: incluso para la skill con mejor condición y mayor uso, un patrón sobre el
prompt acierta 28% y **se pierde la mitad de las invocaciones que ya ocurren**.
Ése es el techo del mecanismo **en la vía de prompt**, medido sobre su mejor
caso y no sobre las candidatas. Un instrumento con 50% de recall es una base
pobre para un embudo cuyo numerador es "¿invocó?" — y si algún día se usa, ese
50% hay que declararlo como cota igual que la del `/skill-name`.

**No aplica a la vía de archivo.** Una ruta matchea o no matchea: no hay
inferencia sobre lenguaje natural que perder. Por eso este techo golpea a
`babysit-prs` y no a `citty`, y por eso las dos candidatas no empatan (ver
§ *Las dos candidatas divergen*).

## Por qué no se construye todavía

**Tres motivos que acotan, y una razón de secuencia que es la que decide.**
Ninguno de los tres primeros basta solo, y ninguno refuta el mecanismo: mandan el
diseño hacia otro evento, señalan una duplicación y ponen un requisito de
entrada. Lo que cierra el caso **no es una refutación sino un orden**: hoy no
existe ni una sola medición válida de la palanca consultiva, así que un tercer
inyector no puede enseñar nada que los dos primeros no deban enseñar antes.

Dos argumentos de versiones anteriores se retiraron por falsos —uno sobre el
contrato del host, otro sobre el frente de Pareto—; los dos quedan escritos en
sus bloques `> Argumento retirado` para que no vuelvan.

> ### Argumento retirado, y escrito aquí para que no vuelva
>
> La primera versión de esta spec abría con un motivo que decía: *"el payload de
> `UserPromptSubmit` trae `user_prompt`, `session_id` y `cwd`; no hay información
> de archivos, luego la vía de archivo es inobservable en ese evento **por
> construcción**"*. Era **falso**, y se declaraba una de las dos patas suficientes
> solas. Tres cosas lo desmienten, las tres dentro de este repo:
>
> - `transcript_path` es un campo común del payload de **todos** los hooks, y
>   `host-contracts.ts:140` ya lo tenía registrado como tal.
> - `hooks/audit-mode-trigger.sh:152` —el archivo que aquella versión citaba como
>   evidencia— **lee `.transcript_path`**, con el comentario "the payload is the
>   ONLY place it is stated". Hay un test que lo fija
>   (`__tests__/audit-hooks.test.ts:219`).
> - `progress/history.md:555` dice lo contrario de lo que se le atribuía:
>   *"`user_prompt` nunca existió: la clave del payload es `prompt`. Y
>   `transcript_path` estaba ahí sin usarse"*. El hook acepta las dos claves por
>   defensa, no porque el host mande `user_prompt`.
>
> Con `transcript_path` un hook puede extraer cada ruta tocada — que es
> exactamente lo que hace el minero de esta misma spec. El error de método fue
> leer 80 líneas de un script de 160 y afirmar sobre el resto.
>
> **Lo que sobrevive de ese motivo es rezago, no imposibilidad**, y el rezago es
> una cara del motivo 1 de abajo, no una pata aparte. Se absorbe ahí.

### 1. El evento llega antes del trabajo del turno — y la vía de archivo, rezagada

De las 64 invocaciones de `Skill` del hilo principal:

| medida | valor |
|---|---|
| ocurren después del primer turno | **57/64 (89%)** |
| herramientas ya usadas antes de invocar | mediana **105**, p90 **322**, máx 394 |
| invocada como primera herramienta de la sesión | **0/64 (0%)** |
| dentro de las 4 primeras herramientas | 5/64 (8%) |

Cargar una skill es una decisión de mitad de trabajo. La spec 0020 ya escribió
esta objeción al elegir su evento: *"`UserPromptSubmit` dispara antes de que el
modelo haya hecho nada ese turno, o sea a destiempo."* Aquí la medición la
confirma con el dato que 0020 no tenía: **ni una sola** invocación del parque
ocurrió antes de la primera herramienta.

**El rezago de la vía de archivo es la misma observación, contada desde el lado
de la condición.** Un hook en `UserPromptSubmit` lee el transcript y ve las rutas
de los turnos *anteriores*; las del turno que está por empezar todavía no
existen, y la propia doc del host advierte que el transcript "may lag the
in-memory conversation". Así que la condición disponible no es "estoy editando un
comando citty" sino "en algún turno previo se tocó uno" — más débil, y desfasada
por hasta un turno entero, que en este corpus es mucho trabajo (mediana 105
herramientas antes de una invocación).

**Hasta dónde llega este motivo, dicho sin inflarlo.** No dice que el mecanismo
no pueda funcionar. El hook dispara en **cada** turno, no solo en el primero, así
que por el turno 3 o 4 ya tiene evidencia acumulada y su aviso llegaría antes del
punto mediano de invocación. Lo que el motivo establece es que
`UserPromptSubmit` **no puede ser el momento de la decisión** y que
`PostToolUse` —donde la ruta llega en el payload, sin rezago— sería
estrictamente mejor. Es un argumento sobre **cuál evento**, no sobre si construir.

### 2. La tabla duplica un bloque que ya viaja always-on

`buildSkillsIndexBody` (`packages/cli/src/engines/claude/index.ts:202`, vía
`buildSkillRows` en `engines/shared/skills-index.ts`) renderiza el bloque
managed `## Skills disponibles` en cada `CLAUDE.md`. Ese bloque ya publica, en
cada sesión, la línea exacta:

```
- `citty` — library (detected) · Use when adding or editing a CLI command with citty
```

La tabla entregaría **el mismo texto, al mismo modelo, más tarde**. Los cuatro
intentos refutados de este repo (`progress/history.md`, 2026-09-11: "cuatro
releases atacaron una hipótesis que resultó falsa: no es que el modelo no reciba
la doctrina") fueron "decirlo otra vez, distinto". Éste sería "decirlo otra vez,
después" — y el motivo 1 dice que ese "después" no es el momento de la decisión.

Esto es además la moratoria de doctrina mordiendo por el lado que no se ve: el
mecanismo no agrega prosa nueva a `CLAUDE.md`, pero **re-entrega prosa que ya
está ahí**. Un mecanismo cuyo contenido es una copia de un bloque always-on paga
el cuerpo dos veces, que es justo lo que el issue pide evitar al excluir las
normas de la tabla. El argumento aplica igual a las lib-skills: su trigger ya
viaja en el índice.

> **Los dos roles de H₀, que esta spec usa y hay que separar.** El título de este
> motivo decía antes "*y no dispara*", y esa segunda mitad **es H₀ leído como
> evidencia en contra** — la misma cifra que el § *Veredicto* declara favorable al
> mecanismo. Las dos lecturas son defendibles y no se contradicen (favorable:
> no hay techo, cualquier conversión mejora; en contra: la entrega always-on lleva
> 195 sesiones sin producir una invocación), pero afirmar una mientras se usa la
> otra sin nombrarlo es hacer trampa con una sola cifra.
>
> Se separan así: **el núcleo de este motivo es la duplicación**, que es
> estructural y no depende de H₀ — la tabla repetiría el texto aunque la tasa
> base fuera 40%. La lectura "en contra" queda disponible como refuerzo, marcada
> como tal, y **no se cuenta como motivo aparte**.

### 3. El numerador no es el resultado que importa

"¿Invocó `citty`?" es una métrica de actividad, no de calidad. Nadie ha mostrado
que una sesión que editó `packages/cli/src/commands/foo.ts` sin cargar `citty`
produjera peor código — el repo tiene 21 subcomandos escritos correctamente sin
que la skill se invocara nunca. El propio repo ya fijó la vara correcta
(`docs/research/activacion-subagentes-y-skills.md`, Fase 0): *"'No se usó' no es
el defecto; 'no se usó cuando aplicaba' sí"*, y la unidad es la **oportunidad
perdida**. Un embudo que mueva las invocaciones de 0% a 40% habría probado que
un aviso produce obediencia al aviso — que es exactamente lo que cada uno de los
cuatro intentos refutados probó localmente antes de no importar.

**Su límite, dicho de frente:** esta objeción aplica **igual** a `routing-watch`
—construido y en producción— y a `memory-watch` —spec aprobada y mergeada
(#770)—, los dos con numeradores de actividad ("¿delegó?", "¿buscó?"). O sea que
el repo ya aceptó dos veces un embudo de esta forma. Usarla como razón única para
rechazar ésta sería
incoherente. Lo que sí sostiene es una exigencia: la cláusula 2 de la *Condición
de reevaluación* pide que alguien nombre un defecto concreto que la no-invocación
haya producido. Es un requisito de entrada, no un veredicto por sí solo.

### 4. La razón de secuencia — cero mediciones válidas de la palanca, y ésta es la que decide

Los tres anteriores acotan. Éste no refuta el mecanismo: dice que **este no es su
turno**, y es el único verificable hoy de punta a punta.

La regla es de la spec 0024 y esta spec la adopta sin descuento: *una medición
vale solo si su instrumento recibe el carril que domina las llamadas*. Por esa
vara, el número de mediciones válidas de la inyección consultiva por
`additionalContext` es **cero**:

- **`routing-watch`** (0020) está construido y **no ha reportado**, con su carril
  dominante desconectado. Verificado hoy:
  `engines/claude/build-settings.ts:222` registra
  `matcher: "Edit|Write|NotebookEdit|Agent|Task"` mientras
  `routing-watch.sh` acepta `Bash` en su `case` desde #722 A4. El issue **#775**
  —que absorbe #767 y trae la medición completa— lo cuantifica: **19 cruces de
  umbral visibles hoy contra 40 con el carril conectado, o sea 21 sesiones
  (52.5%) invisibles**. Su propio comentario de #722 decía que sin `Bash` el
  umbral era *"structurally unreachable"*.
- **`memory-watch`** (0024) tiene spec mergeada (#770) y **no existe en el árbol**:
  `packages/plugins/engram/scripts/memory-watch.sh` no está en disco.

Construir un tercer inyector consultivo mientras el primero mide la mitad de lo
que cree y el segundo no existe es multiplicar instrumentos sin multiplicar
evidencia — el error exacto que #673/#674/#675 documentaron tres veces en este
repo, donde tres instrumentos rotos produjeron un 57% que sobrevivió cinco meses.

**Por qué esto decide y los otros tres no.** Los motivos 1-3 son objeciones de
diseño: se responden rediseñando (cambiar de evento, quitar la duplicación,
nombrar un defecto). Éste no se responde rediseñando, sino **esperando un dato
que ya está en el tablero**. Y a diferencia del "frente vacío" que esta spec
afirmaba antes, no exige creer ninguna medición que no se haya hecho: #775 tiene
la suya, reproducida, y su criterio de cierre incluye publicar el antes/después
del carril.

**Es también el más satisfacible de los cuatro**, y eso es deliberado: se cumple
cuando #775 aterriza y `routing-watch` acumula sus emisiones con el instrumento
vivo, o cuando `memory-watch` se construye y reporta su embudo. Trabajo que
existe, con issue, no un criterio que nadie puede cumplir.

## Descartado: la versión que sí podría sostenerse

**`PostToolUse` con patrón de archivo, gemelo de `routing-watch`.** Es la
versión que el motivo 1 señala como correcta: el evento ve la ruta que se acaba
de tocar, sin rezago, y llega en el momento de la decisión. Es lo que
`routing-watch` (0020) y `memory-watch` (0024) hacen. **Tras retirar el argumento
falso, ésta es la variante viva de la propuesta**, y por eso su descarte carga
más peso que en la primera versión de esta spec. Se descarta **ahora**, no en
principio, por dos razones:

1. **No resuelve los motivos 2 y 3.** Seguiría re-entregando el texto del índice
   always-on, y su numerador seguiría siendo actividad y no calidad. Los dos son
   objeciones reales y ninguna basta sola.
2. **No resuelve el motivo 4, que es el que decide** — y ésta es la razón que
   pesa. Cambiar de evento mejora el *momento*; no crea la medición de la palanca
   que hoy no existe. Un `PostToolUse` nuevo sería el tercer inyector consultivo
   con cero lecturas válidas de los dos primeros, y encima competiría por el
   mismo evento y la misma atención que `routing-watch` y `memory-watch`.

Lo que **ya no** se le reprocha, porque el argumento se retiró: que "no exista un
punto de operación". Esa afirmación descansaba en un frente de Pareto que era un
solo eje disfrazado de dos (ver *Argumento retirado (2)*). Medido con honestidad,
**`PostToolUse` con `toca commands/*.ts` (36%, 31 días para 20 emisiones) es un
punto de operación viable**, menos ruidoso que el 78% que 0024 llamó papel tapiz
y apenas por encima del 32% que 0024 aceptó. Que sea viable es justamente por qué
el descarte tiene que apoyarse en la secuencia y no en una imposibilidad
inventada.

La condición bajo la cual esta versión vuelve a la mesa está escrita abajo, en
*Condición de reevaluación*, para que no se re-litigue desde cero.

**Descartado también: construir el hook "solo observador"** (loguear la
condición sin inyectar nada). Era la salida cómoda —instrumento sin ruido— y no
pasa el primer peldaño de la escalera: el minero calcula lo mismo sobre los
transcripts que ya existen, sin hook, sin costo por llamada y sin campo de
config. Lo único que un hook añadiría sobre el minero es cobertura del hueco
`/skill-name`, y **no la añade**: un `PostToolUse(Skill)` sufre el mismo bug del
host (`anthropics/claude-code#24858`) que el transcript. Cero ganancia, costo
real.

## Lo que sí se entrega

`scripts/mine-skill-triggers.py`, hermano de `mine-search-routing.py` y
`mine-activation.py`, con la misma doctrina que ese primero escribió para sí:
*"una medición que no se puede repetir no es una línea base, es una anécdota."*

Publica, por candidata declarada en el propio script: sesiones donde la
condición se cumplió, cuántas de ésas invocaron la skill, el denominador de
sesiones activas, y el ancho del patrón. Las dos vías —prompt y archivo— salen
con la misma forma (R3), así que un ancho nuevo se agrega editando una tabla de
patrones y no el cuerpo del minero.

Y el pre-registro, `docs/research/disparadores-de-skill.md`, con el veredicto de
moratoria, sus tablas y la condición de reevaluación.

## El embudo pre-registrado

Escrito antes de que exista un dato nuevo, que es lo único que lo hace un
pre-registro. Se registra aunque el mecanismo no se construya: su función aquí es
fijar contra qué se compararía el día que alguien lo reabra, para que la decisión
no se tome mirando primero el resultado — el error que costó los cinco meses del
57% de #674.

- **Denominador**: sesiones donde la condición del disparador se cumplió, con el
  ancho de patrón declarado en el momento de fijarlo.
- **Numerador**: de ésas, las que registran al menos un uso de la herramienta
  `Skill` con ese slug. La fuente es el evento `skill-watch` que la spec 0022
  entrega en `PostToolUse(Skill)`; el minero lee la misma señal desde el
  transcript, que es de donde 0022 la contrasta.
- **H₀ = 0**, para las dos candidatas y en **todos** los anchos medidos:
  `babysit-prs` 0/123, 0/45, 0/6; `citty` 0/20, 0/17, 0/4, 0/1. No es una tasa
  baja: es la ausencia total, en 32 días y 195 sesiones activas.

  Aplicando la regla de tres a la muestra más grande de cada candidata, la cota
  superior al 95% de la tasa base es ~2.4% (`babysit-prs`, 0/123) y ~15%
  (`citty`, 0/20). La segunda es floja: con 20 observaciones no se puede afirmar
  mucho, y decirlo ahora evita que una futura conversión de 3/20 se presente como
  un triunfo.

- **Cota inferior, declarada igual que en la spec 0022 R12.** El numerador cuenta
  invocaciones del modelo; una skill tecleada `/skill-name` no aparece como
  `tool_use` (bug del host, `anthropics/claude-code#24858`) y el conteo no la ve.
  A diferencia de 0022, aquí hay una medición del hueco en vez de solo la
  advertencia: en todo el parque, **cero** slugs tienen sello `attributionSkill`
  sin un uso correspondiente de la herramienta, y los únicos comandos slash
  tecleados son `/model` (28), `/clear` (8), `/compact` (3) y `/exit` (1) —
  ninguno nombra una skill. El hueco no tiene instancia observada en este corpus;
  eso **no** lo acota en general, y ningún porcentaje sobre este numerador se
  publica sin la salvedad.

### Qué carril domina, y si el instrumento lo recibe

La vara es de la spec 0024 y se aplica aquí sin descuento.

- **Carril de la condición (vía archivo)**: `Bash` es el **80.9%** de las
  llamadas del hilo principal en la ventana medida. El minero lo recibe: extrae
  rutas del `command` además del `file_path` nativo (R3). Sin eso, la fila
  "`citty` toca `commands/*.ts`" habría salido cerca de cero y la conclusión
  habría sido correcta por el motivo equivocado.
- **Carril de la condición (vía prompt)**: el texto del usuario, que el minero
  lee completo del transcript. No hay carril alternativo que se le escape.
- **Carril de la invocación**: la herramienta `Skill`. El minero la recibe; el
  hueco `/skill-name` queda fuera para él **y para cualquier hook**, así que no
  es una desventaja del instrumento elegido sino una cota del contrato del host.

Los tres carriles dominantes llegan. **Esta medición es válida por esa vara** —
que es más de lo que hoy puede decir el precedente `routing-watch`.

### Condición de reevaluación

No es una "condición de revival" de algo refutado: es la **puerta de una
moratoria de secuencia**, y su diferencia con la v2 es que se puede abrir. Son
dos cláusulas, y la primera es la que manda.

1. **Existe al menos UNA medición válida de una palanca consultiva** — "válida"
   por la vara que esta spec aplicó a su propio instrumento y que 0024 adoptó:
   *el instrumento recibe el carril que domina las llamadas*. Se cumple con
   cualquiera de estos dos, que ya son trabajo en el tablero:

   - **#775 aterriza** (reconecta el carril `Bash` de `routing-watch` con la
     salida temprana que su propio 98.7% de trabajo inútil exige, y aterriza
     `hook-matcher-wiring.test.ts`) **y `routing-watch` acumula sus emisiones con
     el instrumento vivo**. Su criterio de cierre ya obliga a publicar el
     antes/después del carril, así que la medición sale por construcción.
   - **o `memory-watch` (0024) se construye y reporta su embudo** contra su H₀
     pre-registrado del 20%, con los cortes que esa spec dejó escritos.

   **Por qué ahora es satisfacible**: no pide un criterio, pide que termine un
   issue abierto con su medición ya hecha y reproducida. Si esa medición sale
   nula, esta spec se cierra como refutada —y entonces sí de forma permanente,
   con un dato detrás—. Si sale positiva, el mecanismo entra a discusión con
   evidencia de que la palanca funciona.

2. **Alguien nombra el defecto que la no-invocación produce.** Un bug, una
   convención rota, un `file:line` — la *oportunidad perdida* que la vara del repo
   define. Es requisito de **entrada**, no veredicto: el motivo 3 no basta solo
   (aplica igual a `routing-watch`, construido, y a `memory-watch`, spec
   mergeada), pero sin esta pieza el mecanismo entraría sin saber qué mejora.

**Lo que ya NO es cláusula**, y su retiro importa: *"aparece un ancho de patrón
con codo"*. Colgaba del frente de Pareto falso, así que era insatisfacible por
álgebra (ver *Argumento retirado (2)*). Se retira **antes del primer dato**, que
es la única forma de retirar una regla pre-registrada sin invalidarla. En su
lugar no va nada: la tabla de anchos ya muestra puntos viables, así que no hay
nada que exigirle.

Cuando la puerta se abra, el mecanismo entra como `PostToolUse`, nunca como
`UserPromptSubmit`: el motivo 1 es sobre el evento y no caduca.

### Las dos candidatas divergen, y hay que decirlo

La conclusión única de la v2 solo aguantaba para una. Medidas por separado:

| | `babysit-prs` (vía prompt) | `citty` (vía archivo) |
|---|---|---|
| mejor ancho | URL de PR o `PR #n` — 23% | toca `commands/*.ts` — 36% |
| tiempo a 20 emisiones | **14 días** | 31 días (62 para 40) |
| ruido vs. el precedente | **por debajo** del 32% que 0024 aceptó | apenas por encima |
| precisión del instrumento | **mala y medida**: 28% de conversión, **50% de recall** sobre el mejor caso (`spec-bootstrap`) | no medida; un path matchea o no, sin inferencia sobre lenguaje natural |
| lo que la frena | el instrumento: un patrón de prompt se pierde la mitad | el volumen: sus anchos semánticamente correctos (7%) piden 160 días |

**`babysit-prs`**: barata de probar, **instrumento débil**. La única medición de
recall que existe dice que un patrón sobre el prompt captura la mitad de las
invocaciones incluso donde la skill sí se usa. Si algún día se prueba, el embudo
tiene que declarar ese 50% como cota, igual que declara la del `/skill-name`.

**`citty`**: **instrumento preciso, corpus corto**. Una ruta matchea o no, sin la
ambigüedad del lenguaje natural — por eso el techo del 50% no le aplica. Lo que
la frena es que este repo no genera suficientes sesiones de comando CLI: al ancho
que de verdad significa "estoy escribiendo un comando citty" (crear o registrar,
7%) hacen falta 160 días. Es un límite del volumen del repo, no del mecanismo, y
se arreglaría midiendo sobre más repos o aceptando el ancho de 36%.

Ninguna de las dos está refutada. Las dos están en moratoria por la misma razón
—la cláusula 1—, y si la puerta se abre entran con veredictos distintos:
`citty` como candidata de primera elección por `PostToolUse`, `babysit-prs` solo
si alguien acota su recall.

### Criterio de muerte

**Todavía no se aplicó, y ésa es la diferencia con una refutación.** El mecanismo
muere cuando la cláusula 1 se cumple y la medición sale nula: si `routing-watch`
con el carril reconectado (#775), o `memory-watch` con su embudo, reportan que la
inyección consultiva no mueve la conducta, entonces esta spec se cierra como el
quinto intento refutado y se escribe junto a los otros cuatro. Ese es el corte, y
está escrito antes del dato.

Lo que queda vivo mientras tanto es el minero, y su propio criterio de muerte es
el de cualquier instrumento del repo — si mide mal, se arregla o se retira, con
issue, como pasó con los tres instrumentos rotos de #673/#674/#675. Esta spec ya
ejerció ese criterio sobre sí misma dos veces.

## La no-colisión con los otros inyectores

El issue la plantea como colisión de evento; **es colisión de atención**, y la
distinción cambia la respuesta. Inventario real de inyectores en una sesión de
este repo:

| inyector | evento | frecuencia |
|---|---|---|
| `audit-mode-trigger.sh` (navori) | `UserPromptSubmit` | por prompt, silencioso salvo al armar |
| nudge de guardado de engram (upstream) | `UserPromptSubmit` | ≤1 por ventana de 900s (`ENGRAM_NUDGE_COOLDOWN_SECS`, `~/.claude/plugins/.../user-prompt-submit.sh:314`) |
| `routing-watch` (0020) | `PostToolUse` | ≤1 por sesión |
| `memory-watch` (0024, si se implementa) | `PostToolUse` | ≤1 por sesión |

**Corrección al planteo del issue**: `memory-watch` es `PostToolUse`, no
`UserPromptSubmit`, así que los "dos inyectores de `UserPromptSubmit`" son en
realidad uno solo que habla (el de engram). Eso no salva el diseño: tres avisos
compitiendo por la atención en un turno es igual de malo vengan del evento que
vengan, y un aviso que dispara en el 63% de las sesiones colisiona con los otros
dos mucho más seguido que uno que dispara en el 32%.

El mecanismo de no-colisión que 0024 diseñó —leer el sello del upstream y
diferir— **no se hereda aquí**, porque no hay aviso que diferir. Si la moratoria
se levanta, se hereda entero y con su acoplamiento declarado: la ruta
`${TMPDIR:-/tmp}/engram-claude-<session_id>-last-nudge` es un detalle del
upstream y hay que fijarla con un test para que el día que cambie se entere el
repo.

## Área crítica: qué cambia en render y sync

**Nada.** Es la respuesta completa y es la que R6 fija con un test.

- `.claude/settings.json` — sin bucket nuevo. `UserPromptSubmit` sigue con su
  único hook (`audit-mode-trigger.sh`).
- `CLAUDE.md` — ningún bloque managed cambia de contenido, así que ninguno cambia
  de hash. Un repo con `CLAUDE.md` editado a mano **no** ve un conflicto nuevo de
  `sync`, y el guard anti-rollback no tiene nada que evaluar.
- `navori.config.json` — sin campo nuevo. Un repo que ya escribió su config no
  necesita migrarla, y un `navori update` no reescribe nada.
- `.gitignore` — sin cubo nuevo: no hay sello efímero que excluir.
- Los goldens (`engines/__tests__/__golden__/claude.snap`, `codex.snap`) quedan
  byte a byte iguales. Ése es el test de R6: si un futuro cambio de esta spec
  moviera un golden, la suite lo dice.

Lo que se agrega vive **fuera** del territorio renderizado: un script en
`scripts/` y un documento en `docs/research/`. Ninguno viaja a los repos del
usuario, ninguno entra a `harness-plan.ts`, ninguno se materializa en un
`render`.

## Components

- `scripts/mine-skill-triggers.py` — el minero. Recorre los transcripts, evalúa
  las candidatas por las dos vías, publica el embudo y la línea base
  pre-registrada. Cubre R1, R2, R3, R4, R5.
- `docs/research/disparadores-de-skill.md` — el pre-registro y el veredicto de
  **moratoria de secuencia** (no una refutación: el mecanismo no está descartado,
  está esperando turno). Lleva las tablas de arriba, los dos bloques
  `> Argumento retirado`, el **veredicto por candidata** —`citty` y `babysit-prs`
  no empatan— y las **cuatro declaraciones que R7 manda**: H₀ = 0 con sus
  denominadores, la declaración de carril dominante, la condición de reevaluación
  anclada a #775 o al embudo de 0024, y el criterio de muerte. Cubre R5, R7, R8.
- `packages/cli/src/__tests__/` — el test de "el harness no cambió": los goldens
  de los dos motores intactos y la ausencia de `skillTriggers` en el schema.
  Cubre R6.
- `packages/cli/src/lib/schema.ts` — **no se toca**. Se nombra aquí porque la
  ausencia es el entregable, y porque `ProjectSchema` es `.passthrough()`: un
  `skillTriggers` escrito a mano en una config **no falla la validación**, se
  ignora en silencio. El test de R6 fija que navori no lo lee, para que nadie
  concluya de un config aceptado que la feature existe.

  **El `.passthrough()` es deliberado y no se toca**: los plugins extienden
  `project.*` con claves arbitrarias vía sus `prompts[]`, así que quitarlo
  rompería ese mecanismo. La forma correcta de cerrar el hueco general —avisar de
  claves `project.*` que nadie reclama— es un check de `doctor`, no un cambio de
  schema, y es una conversación aparte con su propio issue. Esta spec solo fija
  que `skillTriggers` en particular no hace nada.

## Decisions

- **El minero declara sus candidatas en el propio script, no en la config.**
  Poner los patrones en `navori.config.json` sería construir `skillTriggers` por
  la puerta de atrás: un campo que el usuario escribe y navori lee es la feature,
  independientemente de si además hay un hook. El minero es una herramienta de
  investigación del repo de navori, como sus dos hermanos, y sus candidatas son
  parte de la hipótesis que prueba.

- **Python y no TypeScript**, contra la regla general del repo. Los tres mineros
  que ya existen son Python, corren fuera del bundle, no entran al presupuesto de
  tamaño del CLI y no los toca `check-coverage-floor.mjs`. Un cuarto en otro
  lenguaje sería la segunda forma de hacer lo mismo — el defecto que este repo
  llama "una copia que se desincroniza".

- **El denominador excluye sesiones vacías y lo dice (R4).** 2 de las 197 no
  tienen ni prompt ni archivo: son arranques abortados. Incluirlas bajaría cada
  tasa ~1% y ninguna conclusión cambia, pero el número publicado dejaría de
  coincidir con el que una re-corrida produce si el corpus crece en sesiones
  vacías. Se declara en vez de decidirse en silencio.

- **La invocación se cuenta por sesión, no por evento.** La pregunta del embudo
  es "¿esta sesión terminó invocando?", no "¿cuántas veces?". Contar eventos
  premiaría una sesión que invoca la misma skill cinco veces, que no es más
  conversión.

- **La vía de archivo mira `Bash` además del `file_path` nativo.** Ver *Qué
  carril domina*. Es la R3 de la spec 0024 aplicada al minero, y es la diferencia
  entre medir el hábito y medir un carril abandonado.

- **El agregado por sesión une el transcript del orquestador con los de sus
  subagentes**, por la misma razón que la R8 de la spec 0022: 2 de las 14
  invocaciones de aquel corpus vivían solo del lado subagente, y una comparación
  contra la ficha del orquestador las habría reportado como desacuerdo. Aquí el
  efecto sería peor —un falso "no convirtió"— porque el numerador es justo lo que
  vive en esos archivos.

## Failure modes

- **El corpus no existe** (`~/.claude/projects` ausente, máquina nueva): el
  minero sale declarando cero transcripts, sin publicar tasas. Una tasa sobre
  denominador cero es la clase de número que este repo ya retiró dos veces.
- **Un transcript tiene líneas corruptas**: se saltan las líneas ilegibles y la
  sesión se procesa con el resto. Un JSONL truncado por un crash es normal, no
  un error; abortar el minero por una línea perdería las 196 sanas.
- **El host renombra `tool_input.skill`**: el numerador cae a cero en silencio y
  el minero reportaría una refutación más fuerte de la real. Es el mismo riesgo
  que la R15 de la spec 0022 cubre del lado del hook; aquí se mitiga imprimiendo
  el total bruto de usos de la herramienta `Skill` junto al embudo, para que un
  cero estructural se vea como cero total y no como cero de conversión.
- **El corpus crece y cambia de composición** (más repos, otro perfil de
  trabajo): las tasas se mueven sin que nada del mecanismo cambie. Por eso las
  tablas de esta spec no se citan como verdad congelada: cuando la moratoria se
  levante, los anchos se remiden con este mismo minero sobre el corpus de
  entonces.

## Testing strategy

Cada test responde a un riesgo nombrado arriba:

- *El minero no es reproducible* → dos corridas sobre un corpus sintético fijo
  producen salida idéntica byte a byte.
- *El embudo miente porque la vía shell no llega* → corpus sintético donde el
  único toque a `commands/foo.ts` viene dentro de un `command` de `Bash`; se
  espera que la sesión cuente como disparo.
- *El numerador se publica como total* → la salida contiene la salvedad de cota
  inferior en la misma sección que el porcentaje; un corpus con conversión > 0
  no la omite.
- *Una sesión vacía infla o desinfla el denominador* → corpus con sesiones sin
  prompt ni archivo; se espera que queden fuera y que el conteo de excluidas se
  imprima.
- *La invocación en un subagente se pierde* → corpus con la invocación solo en
  `subagents/agent-*.jsonl`; se espera que la sesión cuente como conversión.
- *H₀ se redefine en silencio* → la salida imprime la línea base pre-registrada
  (H₀ = 0 con sus denominadores) junto a la medición fresca.
- *El harness cambió sin querer* → los goldens de `claude` y `codex` intactos, y
  una config con `skillTriggers` escrito a mano no produce ningún hook ni ninguna
  diferencia de render.

## NOT in scope

- **El campo `project.skillTriggers` y su hook.** Es el objeto de la moratoria.
  Su condición de reevaluación está escrita arriba; entrar sin cumplirla es
  re-litigar.
- **La variante `PostToolUse`.** Ver *Descartado*. Es la forma correcta del
  mecanismo y espera el mismo dato que todo lo demás.
- **#775 — la clase `matcher ⊂ script`, que absorbe #767.** Es la **dependencia**
  de esta spec: su aterrizaje es lo que abre la puerta de la cláusula 1, y su
  medición (19 cruces visibles de 40) es la evidencia que sostiene el veredicto.
  Arreglarlo no es de aquí — tiene su propio issue con su alcance y sus criterios
  de aceptación.
- **Podar las lib-skills que nunca se invocan.** El dato de 1% (2/195) lo
  sugiere fuerte y la Fase 1 del research de #736 ya lo anticipó ("si sale ≥80%,
  el problema es chico y esto termina podando las skills que nunca aplican").
  Es una conversación de presupuesto de contexto con su propia medición —cuánto
  cuesta el índice contra cuánto rinde—, no un corolario de ésta.
- **Reescribir descriptions o agregar `when_to_use`.** Moratoria de doctrina, y
  además ya medido: 40 de 40 descriptions cumplen (spec 0020, *Descartado*).

## Veredicto

**No se construye TODAVÍA — moratoria de secuencia, no refutación.** El issue
#758 no procede hoy, y la razón no es que el mecanismo sea malo: es que **no
existe ni una sola medición válida de la palanca que este mecanismo usaría**, y
construir el tercer inyector consultivo antes de poder leer el primero es
multiplicar instrumentos sin multiplicar evidencia.

### Cómo llegó el veredicto hasta aquí, en tres versiones

Esta spec se equivocó dos veces y las dos correcciones apuntan en la misma
dirección: cada argumento que prometía una refutación *estructural* resultó
apoyarse en algo no verificado.

| | v1 | v2 | ahora |
|---|---|---|---|
| qué se afirmaba | el mecanismo **no puede** funcionar | **no tiene punto de operación** | **no es su turno** |
| qué lo cargaba | motivos 1 y 2, suficientes solos | el "frente vacío" | la ausencia de mediciones válidas de la palanca |
| por qué cayó | `transcript_path` **sí** está en el payload | el frente era **un solo eje** (`640/conteo`), luego el criterio era imposible | — |
| falsabilidad | baja (contrato del host) | **nula** (cláusula insatisfacible por álgebra) | **alta**: la abre #775 o el embudo de 0024 |

**Las dos retiradas, dichas juntas porque comparten causa:**

1. *"El payload no trae archivos"* — falso. `transcript_path` es campo común de
   todos los hooks (`host-contracts.ts:140`), el propio `audit-mode-trigger.sh`
   lo lee, y `history.md:555` registra que la clave del prompt es `prompt`.
2. *"El frente de operación está vacío"* — vacuo. Los "dos ejes" eran el mismo
   conteo: `firings/día = conteo/32` y `días = 640/conteo`. Exigir dominancia en
   ambos es exigir menos y más disparos a la vez. Y de ese criterio colgaba la
   cláusula de revival que la spec vendía como "alta falsabilidad": una puerta de
   vuelta que nadie podía abrir.

La lección es una y el repo ya la escribió sobre sus instrumentos
(#673/#674/#675): **un argumento apoyado en algo no verificado es un instrumento
roto** — aquí el instrumento era el razonamiento. Las dos veces el error iba en
la misma dirección, hacia una conclusión más fuerte de la que la evidencia
aguantaba, que es la dirección en la que hay que desconfiar de uno mismo.

### Lo que sí sostiene la evidencia

**Tres objeciones de diseño, ninguna suficiente sola:**

1. **El evento.** 89% de las invocaciones ocurren tras el primer turno, mediana
   105 herramientas antes, **0/64** como primera herramienta. `UserPromptSubmit`
   no es el momento de la decisión y la vía de archivo le llega con un turno de
   rezago. Argumenta **cuál evento** (`PostToolUse`), no si construir.
2. **La duplicación.** El trigger ya viaja always-on en `## Skills disponibles`
   de cada `CLAUDE.md`. Estructural, independiente de H₀.
3. **El numerador.** "¿Invocó?" es actividad, no calidad — pero aplica igual a
   `routing-watch` y `memory-watch`, que el repo aceptó. Requisito de entrada, no
   veredicto.

**Y la razón de secuencia, que es la que decide y la única verificable de punta a
punta hoy:** cero mediciones válidas de la inyección consultiva. `routing-watch`
ve **19 cruces de umbral donde hay 40 — 52.5% de las sesiones invisibles**
(#775, que absorbe #767 y trae la medición reproducida), porque
`build-settings.ts:222` sigue sin `Bash` en su matcher. `memory-watch` tiene spec
mergeada (#770) y no existe en el árbol.

### Lo que NO sostiene, y se retira

- **Que no haya punto de operación.** Lo hay: `citty` con `toca commands/*.ts`
  dispara en 36% y junta 20 emisiones en 31 días; `babysit-prs` con "URL de PR"
  dispara en **23%**, *menos* que el 32% que 0024 aceptó, y junta 20 en 14 días.
- **El listón de "papel tapiz" en el tercio.** El papel tapiz de 0024 era el
  **78%**; su punto elegido fue 32% y su frente no dominado va de 25% a 41%. De
  los siete anchos medidos aquí, solo el de 63% cae de ese lado.

### H₀ = 0: favorable al mecanismo, y lo que cuesta

Sigue siendo favorable: no hay techo, no hay pre-emption que descontar,
cualquier conversión sería mejora estricta. Lo que la v2 no vio es el **precio**
de esa misma cifra: con base cero, la cobertura degenera al conteo de disparos y
la pre-emption es idénticamente cero, así que **ningún frente de dos ejes se
puede construir con datos históricos**. El costo del falso positivo queda **sin
medir** — es conductual, y solo un experimento vivo lo cuantifica. Ésa es, en el
fondo, otra forma de decir por qué hace falta primero una medición válida de la
palanca.

### Las dos candidatas no empatan

`citty` es la candidata fuerte: instrumento preciso (un path matchea o no), sin
el techo de recall del lenguaje natural, frenada solo por el volumen del repo.
`babysit-prs` es barata de probar (14 días) pero su instrumento es débil y está
medido: sobre el mejor caso del parque, un patrón de prompt convierte 28% y
**captura la mitad** de las invocaciones. Si la puerta se abre, entran distinto —
`citty` primero y por `PostToolUse`; `babysit-prs` solo si alguien acota ese 50%.

### Qué queda escrito

Esta spec entrega el minero y el pre-registro, y deja el issue #758 en moratoria
con **una puerta que se abre sola** cuando #775 aterrice o `memory-watch`
reporte. Si esa medición sale nula, #758 se cierra como el quinto intento
refutado, con dato. Si sale positiva, vuelve con `citty` por `PostToolUse` y con
el defecto que la no-invocación produce ya nombrado.

Lo que el ciclo compró, y es lo que #758 pedía al decir que el instrumento nace
con el mecanismo: el embudo se construyó **antes**, costó una tarde de minería en
vez de cuatro releases, y de paso el propio razonamiento pasó por el mismo
criterio de instrumento roto que la spec le aplica a todo lo demás.
