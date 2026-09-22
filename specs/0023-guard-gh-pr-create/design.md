# Guard sobre `gh pr create` — Design

## Approach

**Veredicto: construirlo.** La medición del costo lo sostiene —los falsos positivos que
#705 temía suman 2 de 263 (0.8%), y `revert` en particular es 0— y la capa que ya está
desplegada tiene su conversión medida en 0 de 26. La pieza no es nueva: `pr-publisher-confirm.sh`
existe desde #712 y está registrado en `PreToolUse(Bash)` desde entonces. Lo que cambia es
**el veredicto que emite**, de `permissionDecision: "ask"` a un bloqueo con salida escrita.

**Sobre qué descansa el veredicto, porque se va a volver a preguntar.** Dos de los datos que
esta spec podría haber usado están contaminados: del `ask` no se puede probar que llegara a un
humano (no hay `tool_decision` en esas 3 sesiones, #763), y el "aviso de ruteo 0/1" quedó
invalidado por #767 — el hook nunca se entregó en el carril dominante. Ninguno de los dos
sostiene nada aquí. Lo que sostiene el veredicto es un **resultado de ruteo observado**: en las
3 sesiones donde el guard elevó se abrieron 51 PRs a mano y el pilot se invocó 0 veces,
mientras que la sesión que sí lo invocó (7 veces) abrió 0 PRs a mano. Ese 0% es 0% con
independencia de quién vio qué. Lo que #767 y #763 debilitan es la **corroboración** —la teoría
de por qué lo consultivo falla—, no la medición primaria; y el downside queda acotado por un
embudo pre-registrado con reversión escrita.

Tres piezas, y las tres son necesarias para que la cuarta —la medición— signifique algo:

1. **Bloquear** el `gh pr create` del hilo principal cuando hay a quién delegar.
2. **Replegarse** sin ruido cuando no la hay (repo sin pilot, cwd que no resuelve el harness,
   llamada que ya viene de un subagente).
3. **Override contable**: un centinela de un solo uso que exige una razón y la escribe en el
   log de audit. No prohíbe el PR a mano — lo vuelve contable.

**Descartado: subir el `ask` a `deny` dejando el resto igual.** Es lo mismo que bloquear, pero
sin las piezas 2 y 3: un guard sin salida escrita se desactiva solo, y entonces no sirve para
nada. Las tres piezas viajan juntas o no viaja ninguna.

**Descartado: que el hook invoque al publisher.** Un hook no puede lanzar un subagente; solo el
modelo puede. Por eso el mensaje del bloqueo es la pieza de diseño, no un adorno (ver la
decisión del circuit-breaker, abajo).

**Descartado: re-atar el disparador en la doctrina del pilot.** Era la opción 2 de #705. La
moratoria vigente la prohíbe, y el `description` del pilot ya dice "when the cycle ends in a
commit, a push or a PR" desde la spec 0020 — la prosa ya apunta bien y la conducta no se movió.

## Components

- `packages/core/core-assets/hooks/pr-publisher-confirm.sh` — el hook existente pasa de `ask` a
  bloqueo, gana el repliegue por ausencia de ruta y el override. Cubre R1–R8.
- `packages/cli/src/lib/__tests__/pr-publisher-confirm.test.ts` — la suite existente; su caso
  `NUNCA bloquea — el exit es 0 incluso cuando eleva` se **invierte**, no se borra: pasa a
  fijar el contrato nuevo. Cubre R1–R8.
- `scripts/mine-pr-routing.py` — el instrumento del embudo, calcado de
  `mine-search-routing.py`. Cubre R9, R10.
- `docs/research/ruteo-del-pr.md` — el pre-registro y, después, el resultado contra él,
  **salga como salga**. Cubre R10.

**Lo que NO cambia en bytes emitidos, y es la mitad del valor de que esta pieza ya existiera:**
el matcher `PreToolUse(Bash)` que invoca el hook, su `timeout: 10` y su `statusMessage` ya
están en el `settings.json` managed (`build-settings.ts:128-143`), y el plan ya materializa el
script con `managedId: "pr-publisher-confirm-base"` (`harness-plan.ts:189`). **Ninguno de los dos
codifica el veredicto**, así que pasar de `ask` a bloqueo no toca el bloque managed de ningún
repo onboardeado.

Lo que sí cambia en esos dos archivos son **dos comentarios que quedarían mintiendo**:
`build-settings.ts:123-127` ("It does not block: it answers `ask`, which routes the call to the
user") y `harness-plan.ts:183-184` ("to a user confirmation"). `hook-claims-vs-scripts.test.ts`
valida cabeceras de scripts shell, no comentarios TS, así que el gate no los caza — y son área
crítica de este repo. Van asignados a T9.

## Decisions

- **`exit 2`, no `permissionDecision: "deny"`.** Los dos bloquean, pero `exit 2` es el idioma
  que este harness ya tiene medido: `guard-destructive` (14/14) y `guard-search-routing` (el
  que movió el parque de 6.6% a 40.7%) bloquean así, mandan su razón a stderr y esa razón
  llega al modelo, que es quien tiene que reintentar por el pilot. Y no se pierde
  observabilidad por ello: el host registra un `exit 2` como
  `tool_decision decision=reject source=hook` —**16** de esos eventos al 2026-09-13, todos en
  la única sesión con tercera fuente viva—, así que la spec 0021 sigue viendo el bloqueo sin
  que este hook haga nada especial.

- **El mensaje tiene que esquivar el circuit-breaker de la propia doctrina, y esto es el
  mayor riesgo del diseño.** El bloque `operaciones-seguras` le dice al modelo: *"Command
  blocked by permission/policy → STOP — 0 retries... si solo faltó una pre-aprobación tienes
  UNA vía alterna, que cambia el camino"*. Leído de frente, un `gh pr create` bloqueado
  manda al agente a parar, no a delegar — y el embudo mediría 0% por doctrina, no por
  conducta. El mensaje, entonces, se redacta como **esa única vía alterna**, con la forma que
  ya funcionó en `guard-search-routing`: nombra la acción concreta que sí procede
  (`Agent` con `subagent_type: publisher`), no repite la regla ni regaña. Un bloqueo
  que solo dice "no deberías" es un callejón, y un callejón se paga con un override.

- **La frontera es "¿viene de un subagente?", no "¿viene del pilot?".** El payload de
  `PreToolUse` trae `agent_id` estable, y con él se sabe si la llamada nace en un sidechain;
  no se sabe de cuál. Se acepta a propósito: el coste medido de la holgura es 0 (los 6
  `allow` del store resuelven los 6 al publisher), y cerrarla exigiría leer
  `~/.claude/projects/*/<session>/subagents/agent-<id>.meta.json`, un archivo interno del
  host que no está documentado y que el propio `audit-log.sh` trata con esa cautela.
  `// TODO(precision): si un subagente que no es el pilot empieza a abrir PRs —el minero lo
  vería como bloqueos ausentes en sesiones con PR—, resolver el tipo por ese meta.`

- **El centinela es de un solo uso, y sin razón no vale.** `.claude/progress/pr-override`,
  primera línea = la razón. El hook la lee, la escribe en el log de audit y **borra el
  archivo**. Un override permanente es indistinguible de desactivar el guard, que es
  exactamente el fracaso que esta spec quiere poder ver en los datos en vez de sufrir en
  silencio. Y vive bajo `.claude/progress/`, que ya está en `EPHEMERAL_HARNESS_PATHS`: hereda
  `.gitignore`, exclusión del backup y el check de `doctor` sin tocar tres sitios.

- **Dos preguntas distintas, dos resolvedores distintos — y confundirlas dejaba R3 sin
  mecanismo.** El partial `resolve-worktree.sh` responde *sobre qué árbol actúa este comando
  git* (#454), y lo hace con `git rev-parse --show-toplevel`. Esa es la pregunta correcta para
  **el centinela del override**: el archivo vive en el árbol donde el agente trabaja, y por eso
  R5 lo resuelve así. **No** es la pregunta de R3. Si el repliegue probara
  `<toplevel-de-git>/.claude/agents/publisher.md`, acertaría desde cualquier
  subdirectorio de cualquier repo onboardeado, el repliegue no dispararía jamás y R3 quedaría
  verde y hueco. Una versión anterior de este diseño tenía exactamente ese defecto.

  La pregunta de R3 es *de dónde carga el host sus agentes*, y la respuesta está verificada en
  este repo: **ascenso por `.claude/agents/` desde el cwd**, más `~/.claude/agents/`
  (`lib/schema.ts:121-132`, "agents are discovered by walking UP from the cwd, never down…
  the upward discovery still finds the root's agents, hooks and settings"). El repliegue
  replica ese ascenso —`test -f` por nivel, sin forks, con tope en la raíz del FS— y no el
  toplevel de git: los dos coinciden en el caso común y divergen justo donde R3 tiene que
  actuar (un `.claude/` por encima de la raíz de git, o un workspace anidado con el suyo).

- **El repliegue mira el disco, no la config.** El hook no lee `navori.config.json` —sería un
  parseo por llamada—, aunque la clase que R3 protege sea precisamente
  `harness.commitPrPilot: false`. La presencia del archivo es la condición que de verdad
  importa y es más barata: es lo que el host va a buscar, y cubre también el borrado a mano y
  el harness ajeno. Todo detrás del atajo de #716: solo corre cuando el comando ya demostró
  ser un PR.

- **El repliegue es un fail-safe declarado, no una tapa para una clase medida.** Su incidencia
  en el store es **0 de 263**: ningún `gh pr create` medido salió de una sesión donde el pilot
  fuera irresoluble. Lo que lo justifica es la asimetría —cuesta un puñado de `test -f`, y no
  tenerlo cuesta un repo donde ningún PR se puede abrir—, no la frecuencia. Se registra en vez
  de solo callar porque sin registro "no había ruta" y "no era un PR" se leen igual en el log,
  y porque es lo que permitirá saber si la clase deja de ser 0 alguna vez.

## Contracts

**El centinela.** `.claude/progress/pr-override`, relativo al árbol que resuelve
`navori_worktree` — aquí sí, porque la pregunta es dónde trabaja el agente. Texto plano;
**la primera línea es la razón** y es lo único que se lee. Se consume: el hook lo borra tras
honrarlo, y si el borrado falla lo dice en el registro (R5). Ausente = sin override. Presente
con primera línea vacía o solo espacios = R6 (bloquea y lo dice).

**El registro de audit.** El hook ya usa `navori_audit_log <verdict> <reason>` del partial
compartido; no se inventa un tipo de evento nuevo. Los veredictos y su significado:

| verdict | cuándo | reason |
|---|---|---|
| `block` | R1 | `PR abierto fuera del publisher` |
| `allow` | R2 | `el PR viene de un subagente` |
| `allow` | R3 | `no hay publisher al que delegar` |
| `override` | R5 | la primera línea del centinela, truncada a 200 caracteres |
| `override` | R5, borrado fallido | la misma razón + ` (centinela no consumido)` |
| `block` | R6 | `el centinela de override no declara una razón` |
| `skip` | comando que no abre un PR, solo si el atajo de #716 ya se pasó | `el comando no abre un PR` |

`parse.ts` lee `verdict`/`reason` genéricamente, así que `override` no exige tocar el
consumidor; lo que sí exige es que el minero del embudo sepa distinguirlo (R9).

## Failure modes

- **El guard falla por dentro** (sin `jq`, payload ilegible, comando vacío): deja pasar.
  R7 es explícito porque la dirección del fail-open cambia respecto a #712: antes "callarse"
  significaba no molestar, ahora significa no bloquear, y es la diferencia entre un PR que se
  abre y una sesión sin salida.
- **El centinela no se puede borrar** (FS de solo lectura): se honra el override igual, pero
  el registro lleva la razón con el sufijo `(centinela no consumido)`, para que el minero
  pueda ver un override que se quedó pegado en vez de contarlo como uno nuevo cada vez.
- **El hook se pasa del timeout de 10 s**: ser matado es indistinguible de aprobar, así que
  todo el trabajo caro queda detrás del atajo sin forks de #716 (`has_trigger_token` sobre
  el payload en memoria) y las comprobaciones nuevas son `test -f` y una lectura de una línea.
- **Dos sesiones concurrentes y un solo centinela**: la carrera existe y se acepta — el
  override lo escribe un humano o el agente en un turno, y su ventana es de segundos. Lo que
  NO se acepta es que quede pegado, que es lo que resuelve el consumo.
- **#764 parte el denominador del embudo.** Un bloqueo dentro de un worktree de agente se
  escribe hoy en `~/.navori/audits/<nombre-del-worktree>/`, un repo fantasma. El minero del
  embudo tiene que normalizar `.claude/worktrees/<id>` a la raíz del repo, o el mismo
  experimento aparecerá repartido entre `navori-harness` y `agent-a2a999b59fde9ce6c`.

## Testing strategy

Cada caso responde a un riesgo nombrado arriba:

- *El guard no bloquea* → payload de hilo principal con `git push && gh pr create`, se espera
  exit 2 y el nombre del pilot en stderr.
- *El guard se bloquea a sí mismo dentro del pilot* → payload con `agent_id`, exit 0 y
  registro `allow`.
- *El guard bloquea donde no hay ruta* → repo sin `publisher.md` en ningún nivel ni en
  `~/.claude/agents/`: exit 0 y registro con la razón del repliegue.
- *El repliegue se vuelve un agujero* — el riesgo opuesto, y el que una versión anterior de
  este diseño tenía abierto → comando lanzado desde un **subdirectorio** de un repo que sí
  tiene el pilot en su raíz: **bloquea**. Es la mitad del test que prueba que el ascenso está
  implementado y no sustituido por un proxy que siempre acierta.
- *El override no se puede descubrir* → el stderr del bloqueo contiene la ruta del centinela.
- *El override se vuelve un interruptor de apagado* → centinela con razón: pasa una vez y el
  archivo desaparece; segundo intento en la misma sesión: bloquea.
- *El override sin razón es un bypass* → centinela vacío: bloquea y lo dice.
- *El guard rompe la sesión cuando falla él* → sin `jq` en el PATH, exit 0.
- *La vía rápida se pierde* → payload de `git status`: exit 0, cero registros, y ningún fork
  (el caso que #716 dejó fijado ya existe en la suite).
- *La prosa del hook promete lo que no hace* → `hook-claims-vs-scripts.test.ts` ya exige que
  una cabecera que dice "blocks" contenga `exit 2`; la cabecera actual dice "is raised to a
  user confirmation" y tiene que cambiar con el mecanismo.
- *Los criterios se mueven después de ver los datos* → test que compara los umbrales que
  imprime `mine-pr-routing.py` contra los escritos en `docs/research/ruteo-del-pr.md`.

## El embudo pre-registrado

Se escribe **antes** de que el guard entre a `main`, calcado del criterio de la Fase 1: sin
denominador discutible.

> **De los `gh pr create` que el guard bloquea, ¿qué fracción se reintenta por el pilot en la
> misma sesión?**

- **Denominador**: registros `pr-publisher-confirm` con `verdict: block` (R1 y R6).
- **Numerador A (éxito)**: bloqueos seguidos, en la misma sesión y después de su `tsMs`, de
  una invocación de `Agent`/`Task` con `subagent_type: publisher`.
- **Numerador B (fuga)**: bloqueos seguidos de un `override` en la misma sesión.
- **Ventana**: los primeros **20 bloqueos** del parque, o **14 días** desde el merge, lo que
  ocurra primero.

La tabla es **exhaustiva sobre el plano (A, B)** a propósito: una región sin veredicto se
adjudica después de ver los datos, que es justo lo que R10 existe para impedir. Los dos ejes se
leen juntos, nunca uno primero.

| | **B ≤ 30%** | **B > 30%** |
|---|---|---|
| **A ≥ 50%** | **éxito** — se queda, y se remide `pr-act/pr-opp` por repo | **éxito con fuga** — se queda, y se abre un issue con las razones de override agrupadas: toda clase legítima que se repita se convierte en un repliegue automático (un caso más de R3), no en un override recurrente |
| **25% ≤ A < 50%** | **gris** — se extiende la ventana a 40 bloqueos. **El umbral no se mueve** | **fracaso** |
| **A < 25%** | **fracaso** | **fracaso** |

Fracaso = se revierte a `ask` y se escribe por qué, en el mismo PR que publica el número.

El cuadrante de arriba a la derecha es el que faltaba, y no es un caso rebuscado: es "rutea
bien pero el override se fuga", el escenario más plausible después del éxito limpio. Su
veredicto no es revertir —A ≥ 50% significa que la palanca funcionó— sino tratar la fuga como
lo que es: una lista de clases legítimas que el guard todavía no sabe reconocer. Ahí es donde
el override contable paga su costo.

**Y si las razones resultan ser genéricas, la tabla NO lo cubre**, porque sus tres filas se
seleccionan por A —la fracción que se reintentó por el pilot— y ninguna mira la calidad de la
razón. El cuadrante sigue diciendo "se queda". Eso es deliberado y tiene su propio remedio: un
override recurrente con razón vacía de contenido (`"PR a mano"`, `"rápido"`) no es un fracaso
del embudo, es que **R6 se está cumpliendo en la letra y no en el fondo** — el centinela exige
una razón no vacía, no una razón buena, y ningún test puede juzgar lo segundo. Lo que sí es
ejecutable es leerlas: el issue que abre este cuadrante revisa las razones agrupadas **una por
una**, y su salida es una de dos —convertir la clase en un repliegue de R3, o endurecer R6 con
la forma concreta que se vio abusar—. Nunca "se queda como está".

El 50% no es un número redondo elegido a ojo: es la tasa de
`navori-alertaciudadana-backend` (53%), el repo del parque donde el ciclo sí llega al final.
Si el guard mete a `navori-harness` —hoy en 1 de 117— en el rango del repo que ya funciona,
la palanca hizo su trabajo. El 30% de B es el punto donde el override deja de ser una
excepción y empieza a ser la vía: casi uno de cada tres bloqueos.

**Secundario, y solo secundario**: `pr-act/pr-opp` de `navori-harness` en
`python3 scripts/py/mine-activation.py`, desde la línea base de **1/117 (0%)**. Es el número que
importa a largo plazo, pero su denominador depende de cuántas sesiones haya —y la revisión
del 2026-09-13 ya mostró que con 4 sesiones no se puede concluir nada—, así que no es el
criterio de salida.

**El resultado se escribe contra el pre-registro salga como salga, incluido nulo o inverso.**
Es la regla que `docs/research/activacion-subagentes-y-skills.md` ya se puso.

## Migration

**Ninguna en `settings.json`, y esa es la mejor propiedad de esta spec.** El hook ya está
registrado en el `PreToolUse(Bash)` managed desde #712, así que el bloque de settings de
todos los repos onboardeados se queda con el mismo cuerpo y el mismo hash: cero drift, cero
re-consentimiento.

Lo que cambia es el cuerpo del script, que es un bloque managed propio
(`id="pr-publisher-confirm-base"` en `.claude/hooks/pr-publisher-confirm.sh`). Por lo tanto:

- `navori render --apply` reescribe el bloque y el repo queda con el guard nuevo.
- Un repo cuyo CLI sea anterior conserva su versión: la regla anti-rollback de `marker.ts`
  (`downgrade-skipped`) no deja que un navori viejo pise un bloque que escribió uno más
  nuevo. El repo se queda con el `ask` hasta que actualice, que es el estado correcto.
- Un repo que editó el script a mano queda como `drifted`; `navori sync` lo reconcilia con
  el modelo híbrido de siempre.
- `managed-drift-watch` avisa en la siguiente sesión de los repos que aún no rendereron.

**El cambio de conducta es real y hay que decirlo en el changelog**: un comando que antes
pasaba con una confirmación ahora no pasa. No es un fix silencioso.

## NOT in scope

- **Cerrar la asimetría del render que hace posible la clase de R3.** Esta spec la *rodea* con
  un fail-safe en runtime, pero el origen es un defecto de render: `harness-plan.ts:69` filtra
  agentes por `isAgentEnabled`, mientras el hook vive en el array **incondicional** de
  `harness-plan.ts:182-189` —su propio comentario lo dice, *"Unconditional, like the guard: it
  has no config dependency"*—, así que `harness.commitPrPilot: false` (perilla real,
  `schema.ts:164`, ya ejercitada con `false` en `render-engine.test.ts`) materializa el guard
  sin el agente que el guard exige. Se arregla aplicando ahí el mismo `isAgentEnabled` que está
  110 líneas más arriba. **Complemento, no sustituto de R3**: el fix del render cubre el repo
  que navori rendereó, y R3 cubre además el `adopt` de un harness ajeno y el borrado a mano —
  dos casos que ningún render puede evitar. Issue aparte.
- **Resolver el TIPO de subagente** desde `subagents/agent-<id>.meta.json`. Su coste medido
  hoy es 0 y depende de un formato interno del host. Tiene disparador escrito arriba.
- **Los otros motores.** El hook se registra para Claude; Codex y los motores de prosa no
  tienen `PreToolUse`. Extenderlo es su propio análisis.
- **`git push` y `git commit`.** El pilot también los cubre en doctrina, pero el disparador
  medido —y el único con línea base— es `gh pr create`. Ampliar el guard antes de tener el
  resultado del embudo sería mover dos variables a la vez.
- **Arreglar #763 y #764.** Los dos afectan la medición y están abiertos; el minero del
  embudo normaliza los worktrees por su cuenta (ver Failure modes) y no espera a #764.
- **La doctrina.** Moratoria vigente. Esta spec no toca `managed/`, `agents/` ni `skills/`.
  La cabecera del hook y el texto de su bloqueo no son doctrina: son el mecanismo.
