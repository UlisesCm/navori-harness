# Nudge espejo de búsqueda — Design

## Approach

Un hook `PostToolUse` nuevo —`memory-watch.sh`, del plugin `engram`— cuenta los
archivos fuente distintos que el hilo principal lee, y la primera vez que ese
número llega a 10 sin que la sesión haya llamado `mem_search` entrega una línea
consultiva por `additionalContext`. Nunca bloquea, se emite una vez por sesión,
y cualquier `mem_search` lo desarma.

Es la forma de `routing-watch` (spec 0020) sobre el canal de lectura: mismo
evento, mismo sello por sesión, mismo contrato de fallo abierto, misma
definición compartida de "archivo fuente". Lo que cambia es qué se cuenta —
lecturas en vez de escrituras— y la condición de desarme.

**El costo que NO paga, y por qué importa aquí.** Los cuatro intentos refutados
de este repo de mover conducta por sugerencia eran prosa always-on: contexto que
cada sesión paga esté o no en la situación. Este mecanismo agrega **cero líneas
al arranque**. Su texto llega a lo sumo una vez, en el 32% de las sesiones, y
solo cuando la condición ya se cumplió. Esa es la diferencia material con los
cuatro anteriores, y es la razón por la que se sostiene proponerlo bajo la
moratoria de doctrina: la moratoria prohíbe reescribir prosa para cambiar
conducta, y esto no agrega prosa.

### Por qué consultivo y no bloqueante

La tesis del repo es que lo que bloquea funciona (`guard-destructive` 14/14, en
`docs/research/activacion-subagentes-y-skills.md`; `guard-search-routing` llevó
el parque de 6.6% a 40.7% de búsquedas por la vía buena, en
`scripts/py/mine-search-routing.py:79` y en `progress/history.md`) y lo sugerido no
(doctrina de búsqueda 4.0%). Aquí igual conviene la vía consultiva, y la razón
no es timidez:

**Bloquear funciona cuando re-rutea una llamada hacia un equivalente; no
funciona como forma de exigir una llamada de más.** `guard-search-routing`
bloquea un `grep -r` y el agente tiene a mano un comando que hace *lo mismo*: el
trabajo se completa por otra ruta, el costo del bloqueo es cero. Aquí no hay
equivalente. Un `PreToolUse` que negara la lectura número 11 no estaría
corrigiendo una ruta: estaría exigiendo una acción distinta antes de dejar
avanzar. Y esa exigencia es falsable de tres maneras que un hook no puede
distinguir — la memoria del proyecto puede estar vacía (repo recién onboardeado,
cero observaciones), `mem_search` puede no estar disponible (plugin caído,
subagente sin la tool en su `tools:`), y la respuesta puede genuinamente no estar
en memoria. En cualquiera de las tres el bloqueo deja la sesión sin salida, que
es el mismo argumento con el que la spec 0020 descartó su propia versión
bloqueante y que allá tenía solo un caso.

Hay además el efecto de segundo orden que este repo ya nombró: un mecanismo que
se ignora erosiona la autoridad de los que sí se obedecen. Un bloqueo que el
operador tenga que desactivar para trabajar cuesta más que el aviso que se
ignora.

### El umbral

10 archivos fuente **distintos**. Distintos, no lecturas crudas, por la misma
razón que `routing-watch` cuenta archivos distintos: una pasada de `sed -n` por
ventanas relee el mismo archivo decenas de veces y no es más exploración.

El criterio no es una corazonada: es el frente de Pareto de dos ejes medidos
sobre las 174 sesiones. Eje uno, **cobertura**: cuántas de las 60 sesiones que
nunca buscaron alcanzarían el umbral (son la población que el aviso existe para
alcanzar). Eje dos, **pre-emption**: en cuántas sesiones el aviso se adelantaría
a un `mem_search` que llegaba igual — firings que no se pueden acreditar y que
son ruido puro.

| N | dispara en | cobertura de las 60 | pre-emption |
|---|---|---|---|
| 3 | 71 / 174 (41%) | 54 (90%) | 17 |
| 4 | 68 (39%) | 52 (87%) | 16 |
| 5 | 63 (36%) | 48 (80%) | 15 |
| 6 | 62 (36%) | 47 (78%) | 15 |
| 8 | 58 (33%) | 45 (75%) | 13 |
| **10** | **56 (32%)** | **45 (75%)** | **11** |
| 12 | 55 (32%) | 44 (73%) | 11 |
| 15 | 51 (29%) | 42 (70%) | 9 |
| 20 | 44 (25%) | 38 (63%) | 6 |

10 domina a 8 (misma cobertura, dos pre-emptions menos) y domina a 12 (una
sesión más de cobertura, mismas pre-emptions). Es el codo: el paso 8 → 10 quita
ruido sin costar nada, y el paso 10 → 12 cuesta sin quitar nada. Fuera de ese
punto el frente sigue siendo un trade-off legítimo (3 maximiza cobertura, 20
minimiza ruido) y la elección sería preferencia; en 10 no lo es.

**Lo que esto NO afirma**, porque la tabla no lo sostiene: 10 no es el único
punto no dominado. El frente no dominado son **seis** —{3, 4, 5, 10, 15, 20}—, y
solo 6, 8 y 12 están dominados. La propiedad que distingue a 10 es más estrecha
y es la única que se usa para elegirlo: es el único que domina a **sus dos
vecinos**.

**Sensibilidad, dicha antes de que alguien la pida**: entre 8 y 15 el
comportamiento es materialmente el mismo (±3 sesiones de cobertura). El número no
es frágil, y el embudo de R9 lo remide con datos propios.

**El umbral se calibró con exactamente la definición que el hook aplica** — la
misma `navori_is_source`, que excluye tests, docs y rutas fuera del repo. Esa
definición se escribió para ESCRITURAS y aplicada a lecturas sesga hacia abajo:
leer un test es leer código, y aquí no cuenta. Se reusa igual, porque la regla
del repo es que el término existe una sola vez y un segundo clasificador es un
clasificador que se desincroniza; y el sesgo se cancela porque medición y
mecanismo comparten la definición. Lo que el hook cuenta es un **piso**, no un
techo, y el número 10 está calibrado sobre ese piso.

La otra grieta del piso, dicha donde se hace el argumento: `codegraph_explore`
no nombra un archivo, así que entra al conteo como **una entrada por `query`**
—una unidad que no es conmensurable con "archivo fuente distinto", porque una
query devuelve varios archivos—. Es inmaterial en la práctica (49 lecturas por
codegraph contra decenas de miles por shell en la ventana medida) y se prefiere
sobre la alternativa, que sería no contar en absoluto una vía que sí entrega
fuente. Pero si el uso de codegraph crece, el umbral hay que recalibrarlo:
contar una query como un archivo **subestima** lo leído.

### Descartado: el disparador de hueco ("lecturas desde el último search")

Era el candidato fuerte, porque ataca la conducta que de verdad falta —buscar al
entrar a un área nueva, no al abrir la sesión— y el issue está a un paso de
pedirlo. Se descarta por una medición y por un problema de atribución.

1. **Dispara en el 78% de las sesiones** con N=12 (135/174), contra el 32% del
   elegido. Eso no es una señal, es papel tapiz — y este repo ya escribió que el
   ruido erosiona. Es el único de los dos ejes que **discrimina** entre los dos
   disparadores, y por eso es el que carga el descarte.

> **Argumento retirado, y dicho aquí para que no vuelva.** Una versión anterior
> descartaba el disparador de hueco porque su tasa base es "plana" (26% en N=3 →
> 16% en N=25), luego el tamaño del hueco no predice nada, luego es un
> temporizador disfrazado. Medido el **mismo eje sobre el disparador elegido**,
> la caída es mayor, no menor: hueco 25.9% → 17.0% (8.9pp) contra elegido 24.3%
> → 11.8% (12.5pp). La propiedad no distingue a uno del otro, así que no puede
> ser la razón para preferir uno; como argumento se volvía contra el propio
> diseño. Se retira. Lo que queda de esa medición es un hecho útil y modesto: en
> ninguno de los dos disparadores la tasa base es cero, que es justo por qué el
> embudo se pre-registra contra 20% y no contra nada.

El segundo motivo es el que lo cierra: **el embudo**. Con el disparador de
hueco, el `mem_search` que sigue a un aviso puede estar precedido por otros
`mem_search` de la misma sesión, así que atribuirlo exige ordenar eventos que la
señal de audit hoy no ordena (`routingNotice` en `signals.ts` compara
`session.agents.length` sin mirar el orden). Con el disparador elegido el
problema no existe: la condición incluye "cero `mem_search` en la sesión", así
que **cualquier** `mem_search` de la sesión es necesariamente posterior al
aviso. Numerador y denominador quedan sin discusión posible, que es la condición
que el pre-registro pedía.

Lo que el disparador elegido NO cubre queda dicho de frente: la búsqueda a mitad
de trabajo, en una sesión que ya hizo la ceremonial del primer mensaje. Son 114
sesiones de 174 y el aviso no las toca. Es una limitación real, no un descuido;
la conversación siguiente depende del resultado del embudo.

### El embudo pre-registrado

Escrito antes de que exista un dato nuevo, y esa es su función: el 57% de un
ciclo anterior se publicó mirando los datos primero y por eso aguantó cinco
sesiones y no dieciséis.

- **Denominador**: sesiones donde `memory-watch` registró `verdict: "notify"`.
- **Numerador**: de ésas, las que registran al menos una llamada `mem_search`
  (que por construcción del disparador es posterior al aviso).
- **Línea base H₀ = 20% (11 / 56)**. Sale de la tabla de arriba en N=10: de las
  56 sesiones donde el aviso habría disparado, 11 llamaron `mem_search` más
  tarde **sin ningún aviso**. Ése es el valor contra el que se compara; no es
  cero.

- **Sesgo conocido de H₀, nombrado antes y no después**: la línea base se calculó
  sobre el disparador **sin** el diferimiento de R6. Una sesión que cruza el
  umbral, difiere por colisión con el upstream y termina antes del siguiente
  cruce nunca notifica, así que el denominador vivo es un **subconjunto** del
  histórico. El desvío se espera chico (el diferimiento necesita que el nudge de
  guardado haya salido en los 900s previos), pero va en la dirección de excluir
  sesiones cortas, que son las de menor conversión — o sea que H₀ = 20% es, si
  acaso, un piso conservador. Si a las 40 emisiones el conteo de `#deferred` que
  nunca llegaron a emitir supera el 15% de los cruces, H₀ se recalcula sobre la
  población viva antes de aplicar los cortes.
- **Veredicto a las 40 emisiones** (≈17 días al ritmo medido de 7.3
  sesiones/día × 32% de disparo):
  - **≥ 40%** → el mecanismo movió la aguja; se queda y se recalibra N con datos
    propios.
  - **≤ 25%** → indistinguible de la línea base; **se retira el hook**, y el
    resultado se escribe junto a los otros cuatro intentos refutados.
  - **25–40%** → se extiende a 80 emisiones y se decide con el mismo corte, kill
    en ≤30%.
- **Este embudo responde por `memory-watch` y por nada más.** La versión
  anterior de esta regla decía que se leía junto al de `routing-watch` y que
  "dos nulos seguidos matan la palanca". Se retira **antes del primer dato**,
  que es la única forma de retirar una regla pre-registrada sin invalidarla, y
  por una razón de instrumento: el carril dominante de `routing-watch` nunca le
  llegó al hook (#767 — `Bash` es el 80.9% de las llamadas medidas y su
  `matcher` no lo admite). Un nulo producido por un instrumento desconectado no
  es una medición de la palanca: es una medición de nada, y sumarlo a uno real
  es el mismo error de inferencia que el § Veredicto se cuida de no cometer con
  la evidencia de bloqueo.

- **Cuándo SÍ se juzga la palanca** (inyección consultiva por
  `additionalContext`), escrito ahora para que nadie lo decida mirando el
  resultado: hacen falta **dos mediciones válidas**, y una medición es válida
  solo si su instrumento recibe el carril que domina las llamadas. Es decir:
  ésta, y la de `routing-watch` **después** de que #767 reconecte su carril
  shell y acumule sus propias 40 emisiones con el instrumento vivo. Si #767 no
  se arregla, la palanca queda **sin veredicto** — ni muerta ni viva —, y este
  embudo igual decide el destino de `memory-watch` por sí solo con los cortes de
  arriba.

## Components

- `packages/plugins/engram/scripts/memory-watch.sh` — el hook. Cuenta rutas
  fuente distintas por las tres vías, mantiene el sello por sesión, emite una
  vez. Cubre R1, R2, R3, R4, R5, R6, R7.
- `packages/plugins/engram/plugin.json` — entradas `scripts` y `hooks` que lo
  materializan y lo registran en `PostToolUse` con su `matcher`. Cubre R3, R8.
- `packages/core/core-assets/hooks/_partials/classify-source.sh` — ya existe; se
  incluye con `# navori:include classify-source`. Cubre R2.
- `packages/cli/src/engines/shared/ephemeral-paths.ts` — agrega
  `.claude/.memory-watch/` a `EPHEMERAL_HARNESS_PATHS`, que es la lista única de
  "esto nunca se versiona". Cubre R4.
- `packages/cli/src/lib/audit/signals.ts` — señal `memory-notice`, gemela de
  `routingNotice`. Cubre R9.
- `packages/cli/src/lib/audit/report.ts` — la fila del embudo en el bloque de
  engram, junto a las de escrituras/lecturas que ya separan ceremonia de
  contenido e inyección de llamada (#755). Cubre R9.
- `docs/research/nudge-busqueda-preregistro.md` — el pre-registro, versionado
  antes del primer dato. Cubre R9.

## Decisions

- **El `matcher` es la primera línea de defensa del costo, y tiene que admitir
  toda vía que el script cuente.** Va a ser
  `Read|NotebookRead|Bash|mcp__engram__mem_search|mcp__codegraph__codegraph_explore`.
  Incluye `mem_search` a propósito: el desarme (R5) necesita ver la búsqueda, y
  verla por el mismo evento evita un segundo hook. El test de R3 fija la
  correspondencia script↔matcher porque el hook gemelo tiene hoy justo ese
  defecto (ver *NOT in scope*).

- **El hilo principal, y nada más (R7).** `routing-watch` usa `agent_id` del
  payload para no avisar dentro de un subagente; aquí la razón es la misma y una
  más: el aviso es inaccionable en un subagente cuyo `tools:` no lleva
  `mcp__engram__*`. Además toda la medición de esta spec se hizo excluyendo
  `isSidechain`, así que el umbral solo está calibrado para el hilo principal.
  Extenderlo a subagentes depende de #761 —si `researcher` y `explorer` reciben
  las tools—, que esta spec menciona y no decide.

- **La vía `Bash` no es opcional.** 10,544 lecturas por shell contra 292 nativas.
  Un hook que solo mirara `Read` sería inalcanzable en el modo dominante, que es
  literalmente el defecto #722 A4. La extracción de rutas se abarata igual que
  allá: sin `Bash` no se paga nada (el `matcher` filtra), y con `Bash` un `case`
  libre de forks sobre el payload crudo descarta todo comando sin verbo de
  lectura antes de gastar un solo proceso.

- **El sello, con la forma que ya existe.** `.claude/.memory-watch/<session_id>`,
  una línea `path:<ruta>` por archivo distinto, más las marcas `#notified`,
  `#searched` y `#deferred`. Mismo patrón que `routing-watch`, incluida la barrida
  por `mtime +7` al crear el sello de la sesión (por `--resume`, que reusa el
  `session_id`: borrar al cerrar re-armaría el aviso en cada reanudación).

- **La no-colisión con el upstream se resuelve leyendo su propio sello (R6).** El
  nudge de guardado escribe su epoch en
  `${TMPDIR:-/tmp}/engram-claude-<session_id>-last-nudge` y su cooldown es
  `ENGRAM_NUDGE_COOLDOWN_SECS` (900s). Si ese archivo tiene menos de esa edad, el
  aviso se difiere: no se marca `#notified`, se marca `#deferred` y el siguiente
  cruce lo reintenta. Es acoplamiento a un detalle del upstream y hay que decirlo:
  si renombran el archivo, el chequeo deja de encontrarlo y el hook degrada a su
  conducta sin diferimiento —falla abierto, nunca ruidoso—. Un test fija la ruta
  para que el día que cambie se entere el repo y no el usuario.

- **El diferimiento está acotado a 3.** Un aviso que se difiere indefinidamente
  es un mecanismo que no existe. Tras el tercer `#deferred` se emite igual: dos
  líneas en un turno una vez por sesión es peor que una, pero mucho mejor que
  cero para siempre.

- **El texto nombra la salida, no solo la regla.** Igual que en 0020: cierra
  pidiendo que, si saltarse la memoria es deliberado —la respuesta no está ahí,
  el proyecto no tiene corpus—, se diga en el siguiente mensaje. Así el override
  queda escrito y deja de ser invisible, que es la mitad del valor del aviso
  independientemente de si el embudo se mueve.

## Failure modes

- **El hook no puede leer o escribir su sello** (FS de solo lectura, `$HOME`
  raro): sale 0 sin emitir. Corre después de cada lectura de cada sesión; fallar
  ruidoso ahí es peor que no avisar.
- **El servidor de engram está caído** y `mem_search` fallaría: el hook no lo
  sabe y avisa igual. Aceptado — el aviso es consultivo y el modelo ve el error
  del MCP mucho antes que el humano.
- **La sesión se compacta** y el aviso se pierde del contexto: el sello sigue en
  disco y no se re-emite. Deliberado; repetir es lo que erosiona. Lo que sobrevive
  para medir es la línea del log de audit (R9).
- **El proyecto no tiene memoria todavía** (repo recién onboardeado, cero
  observaciones): el aviso dispara y la búsqueda vuelve vacía. Es el costo de no
  consultar al servidor desde el hook, y se prefiere a un `curl` por lectura.
  Aparece en el embudo como una emisión sin conversión, que es honesto.
- **Costo por llamada.** El `matcher` deja pasar `Bash`, que es el **80.9%** de
  las llamadas del hilo principal en la ventana medida (32,943 / 40,742; el
  84.9% que cita el comentario de `routing-watch` viene de #722 y de un parque
  anterior). Este hook toca entonces un carril ~20× más transitado que
  el de `routing-watch`. El gasto está acotado por dos lados: el `case` sin forks
  descarta antes de gastar, y en cuanto el sello lleva `#notified` o `#searched`
  la salida cuesta dos lecturas de campo. La sesión que más paga es la que lee
  mucho y nunca busca — exactamente la que el aviso existe para alcanzar.

## Testing strategy

Cada test responde a un riesgo nombrado arriba:

- *El aviso nunca dispara* → secuencia sintética de payloads que lee 10 archivos
  fuente distintos; se espera una emisión con el conteo en el texto.
- *Dispara antes de tiempo o nunca por contar mal* → 10 lecturas del **mismo**
  archivo (se esperan cero emisiones) y 10 lecturas de rutas que la definición
  excluye —`docs/`, `__tests__/`, una ruta absoluta fuera del repo— (cero).
- *La vía shell no llega* → las 10 lecturas por `cat`/`head`/`sed -n`/`grep`, y
  una mezcla de las tres vías; se espera emisión en ambos casos.
- *El `matcher` no admite lo que el script cuenta* → test sobre
  `buildClaudeSettings`: el bucket que registra `memory-watch.sh` contiene
  `Read`, `Bash` y `mem_search`. Es el test que el hook gemelo no tiene.
- *El aviso repite y se vuelve ruido* → la misma secuencia continuada; se espera
  exactamente una emisión.
- *El aviso dispara habiendo buscado* → secuencia con un `mem_search` en medio;
  cero emisiones después.
- *El aviso se cuela en un subagente* → payload con `agent_id`; cero emisiones y
  el aviso de la sesión sigue disponible.
- *El aviso bloquea* → exit 0 y ausencia de `permissionDecision` en todos los
  caminos, incluido el de sello no escribible.
- *Colisión con el upstream* → con el archivo `-last-nudge` recién escrito, cero
  emisiones; con ese archivo viejo, emisión; tras 3 diferimientos, emisión.
- *El plugin deshabilitado deja el hook atrás* → render sin `engram` en la config;
  ni el script ni la entrada de `settings.json`.
- *El embudo no se puede leer* → la señal de audit convierte la línea del log en
  los dos estados (disparó y buscó / disparó y no).

## Migration

Ninguna en datos. El hook es nuevo, su sello es efímero y viaja por la ruta
managed del plugin, igual que `guard-search-routing.sh` de `tgrep`. Un repo ya
inicializado con `engram` habilitado lo recibe en el siguiente `render --apply`:

- `.claude/scripts/memory-watch.sh` se escribe nuevo (no había archivo previo, así
  que no hay hash managed que invalidar y `sync` no tiene nada que reconciliar).
- `.claude/settings.json` gana un bucket en `PostToolUse` por el deep-merge de
  fragmentos de plugin, sin tocar buckets ajenos.
- `.gitignore` gana `.claude/.memory-watch/` en el cubo A del bloque managed. Ese
  bloque **sí** cambia de hash, así que un repo con el `.gitignore` editado a mano
  verá el conflicto normal de `sync` — es el camino que el modelo híbrido ya
  define, no uno nuevo.
- Un repo **sin** `engram` no ve ningún cambio (R8).

## NOT in scope

- **El disparador de hueco.** Ver *Descartado*. Si el embudo se mueve, esa es la
  conversación siguiente, y entra con su propia medición de orden de eventos.
- **Los triggers de save del upstream, `engram-protocol.md` y los assets de
  subagente.** Moratoria de doctrina; y el volumen de escritura no es el problema.
- **#761 — que `researcher` y `explorer` no llevan `mcp__engram__*`.** R7 lo roza
  (el aviso no entra a subagentes, en parte por eso) pero no lo decide.
- **Defecto encontrado en el hook gemelo, que NO se arregla aquí — issue #767.**
  `routing-watch.sh` maneja `Bash` en su `case` desde #722 A4, pero su
  registración en `build-settings.ts:222` usa
  `matcher: "Edit|Write|NotebookEdit|Agent|Task"` — que no admite `Bash`. Los
  tests de #722 alimentan payloads `Bash` **al script directamente**, saltándose
  el matcher, y el test de wiring solo afirma `Edit|Write|NotebookEdit|Agent`. O
  sea: el carril shell de `routing-watch` sigue inalcanzable en producción y el
  fix de #722 no llegó a la parte que importa. Importa para esta spec por dos
  razones —es el defecto que R3 existe para no repetir, y significa que el único
  precedente de esta palanca todavía no se ha probado en serio—, pero arreglarlo
  es del hook de la spec 0020. Es también la condición de la que depende la
  regla de lectura conjunta del § *El embudo pre-registrado*.

## Veredicto

**Se sostiene, con la salvedad dicha y una condición de muerte escrita.**

El argumento a favor no es "lo mecánico funciona". Esa evidencia —
`guard-destructive` 14/14, `guard-search-routing` 6.6% → 40.7% — es evidencia de
**mecanismos que BLOQUEAN**. La palanca de esta spec es otra: inyección
consultiva por `additionalContext`, y su único precedente (`routing-watch`, spec
0020) **no ha reportado resultado**, encima con el carril dominante desconectado
por el defecto de matcher de arriba. Presentar esto como "la palanca validada"
sería exactamente el quinto intento disfrazado de mecanismo.

Lo que sí lo separa de los cuatro refutados, y es concreto:

1. **No agrega contexto always-on.** Los cuatro eran prosa que toda sesión paga.
   Éste es un texto que llega a lo sumo una vez, en el 32% de las sesiones, y
   solo cuando la condición ya se cumplió.
2. **Llega en el momento de la decisión**, no en el arranque, que es la
   diferencia que la propia doc del host nombra entre contexto y hook.
3. **Nace medible y con denominador indiscutible**, con la línea base escrita
   (20%) antes del primer dato y un corte de muerte declarado (≤25% a las 40
   emisiones).

Mi expectativa honesta es efecto pequeño. La búsqueda que este disparador puede
provocar es la de apertura —la que compite con los ~10K caracteres que
`SessionStart` ya inyectó—, y no la valiosa de mitad de trabajo, que el
disparador con denominador limpio no puede pedir.

Si el embudo sale nulo, el hallazgo es que **este** nudge no movió la conducta, y
el hook se retira. No es más que eso, y conviene no estirarlo: para concluir algo
sobre la palanca consultiva en general hacen falta dos instrumentos vivos, y hoy
hay uno —`routing-watch` no cuenta hasta que #767 le reconecte el carril que
domina las llamadas—. La regla que decide eso está escrita arriba, antes del
primer dato. Lo que sí compra el corte pre-escrito es el tiempo: el destino de
`memory-watch` se resuelve en 17 días en vez de en cinco meses.
