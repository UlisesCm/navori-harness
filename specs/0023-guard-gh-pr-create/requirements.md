# Guard sobre `gh pr create` — Requirements

**Status:** proposed · **Issue:** #750 (sale de #705; instrumento en #749)

## Context

El `commit-pr-pilot` es el dueño único de commit+PR según la doctrina, y el desglose por
repo que agregó #749 dice dónde no se cumple:

| repo | sesiones | pr-opp | pr-act | tasa |
|---|---:|---:|---:|---:|
| **navori-harness** | 17 | **117** | **1** | **0%** |
| navori-alertaciudadana-backend | 8 | 26 | 14 | 53% |
| navori-alertaciudadana-app | 11 | 48 | 13 | 27% |
| navori-health | 8 | 24 | 9 | 37% |

Global: 261 oportunidades, 38 activaciones, 14%. Las dos explicaciones alternativas están
descartadas en #705 y no se re-litigan aquí: no es azar (con 117 oportunidades y tasa base
15%, quedarse en cero es del orden de 10⁻⁸) y no es el operador (hay sesiones de este repo
que sí lanzaron subagentes y dejaron el pilot en cero). La hipótesis confirmada es que **el
pilot no se salta: nunca se entra a su antesala** — el PR se abre como continuación natural
del trabajo a mano, `git push && gh pr create` en el mismo comando, y nada lo interrumpe.

### Lo que ya se intentó, y cuánto movió

**La capa que este repo ya tiene desplegada no es doctrina: es un hook.** #712 entregó
`pr-pilot-confirm.sh`, un `PreToolUse(Bash)` que eleva a confirmación del usuario
(`permissionDecision: "ask"`) todo `gh pr create` que no venga de un subagente, y #716 le
quitó el costo por llamada. Su efecto está medido sobre el propio log de audit del parque:

| | |
|---|---:|
| veredictos `ask` emitidos desde #712 | **26** |
| veredictos `allow` (el PR venía de un subagente) | **6** |
| sesiones distintas en las que el hook elevó | **3** |
| `gh pr create` del hilo principal en esas 3 sesiones | **51** |
| invocaciones del `commit-pr-pilot` en esas 3 sesiones | **0** |
| `gh pr create` que el usuario negó en esas 3 sesiones | **0** |

**Conversión de la capa `ask` al pilot: 0 de 26.** Las tres sesiones corrieron en modo
`auto`, y de los eventos OTel de ese periodo no se conserva ninguno correlacionable con
esas sesiones (#763), así que **no es demostrable si la confirmación llegó a un humano o
se resolvió sin él**. Lo que sí es dato: en las tres, el PR se abrió a mano las 51 veces y
el pilot no se invocó ninguna.

La demostración positiva existe y es del mismo store: la sesión `560e01f4` invocó el pilot
7 veces, abrió **0** PRs desde el hilo principal, y produjo los 6 `allow` del hook. Cuando
se entra a la antesala, el mecanismo funciona.

Esto es coherente con la línea divisoria que este harness ya tiene medida — `guard-destructive`
14/14, `quality-gate-pre-commit` 7/7, `guard-search-routing` llevó el parque de 6.6% a 40.7%;
contra doctrina de búsqueda 4.0% y activación 24% — y la refina: **no basta con interrumpir,
hay que retirar la acción.** Un `ask` deja la acción disponible a un tecleo de distancia; es,
en la práctica, una sugerencia con fricción.

> **El "aviso de ruteo 0/1" NO se cita aquí, y es deliberado.** Ese dato aparece en la línea
> divisoria de `progress/current.md`, pero **#767** lo invalidó: `routing-watch.sh:119` acepta
> `Bash)`, y el matcher de `build-settings.ts:223` es `Edit|Write|NotebookEdit|Agent|Task`, con
> su propio comentario diciendo que Bash "never reaches it". El 0/1 no mide que el aviso
> fallara: mide que nunca se entregó en el carril donde ocurre el 84.9% de las llamadas. No es
> evidencia de nada todavía, y T1 tiene prohibido copiarlo al registro de investigación.

La vía de doctrina queda descartada por la **moratoria vigente** (`progress/current.md`):
reescribir prosa para cambiar conducta está refutado cuatro veces
(`docs/research/activacion-subagentes-y-skills.md`). Esta spec no toca `managed/`, `agents/`
ni `skills/`.

### El costo del falso positivo, medido

El riesgo real de bloquear es el `gh pr create` legítimo fuera del ciclo. Medido al
**2026-09-13** sobre los **263 `gh pr create` del hilo principal** de las 64 sesiones del
store, contados con la misma definición de disparo que usa el hook —partir el comando por
`&& || ; |` y casar a inicio de segmento—, que es la única que predice cuándo el guard
actuaría. (La regex del minero, más laxa, da 265; 0.8% de diferencia y ninguna conclusión
cambia. Las 261 "oportunidades" del minero son otra cosa: cuenta turnos, no comandos.)

| categoría | n | % |
|---|---:|---:|
| `revert` en el título | **0** | **0.0%** |
| `rollback` / `rollout` / `promote` en el título | **2** | **0.8%** |
| PR a un repo distinto del de la sesión (`--repo`) | **3** | **1.1%** |
| reintento del MISMO título dentro de la sesión | 10 | 3.8% |
| **sesión donde el `commit-pr-pilot` no sería resoluble** | **0** | **0.0%** |
| `fix` / `feat` / `chore` / `docs` / progreso | 260 | 98.9% |

Los tres casos que #705 nombró como el peligro —un PR de rollout, un revert, un PR de
docs— suman **2 de 263 (0.8%)** en las dos primeras filas; los de docs y de progreso (104
entre ambos, 40%) no son falsos positivos: todos son al propio repo, con título convencional,
y son exactamente el trabajo que el pilot empaqueta — su `description` dice "when the cycle
ends in a commit, a push or a PR", sin excepción por tipo de commit.

**La quinta fila es 0, y esa corrección importa más que su tamaño.** Una versión anterior de
esta spec declaró ahí un 7.5% (20 casos) leyendo "cwd que no es la raíz del repo" como
"sesión arrancada en un subdirectorio". Remedido: son **14 (5.3%)** cwds no-raíz, y los 14
salen de sesiones cuyo project dir **sí** es la raíz — el cwd de subdirectorio es deriva *por
llamada*, producida por el propio quality gate de este repo
(`… && cd packages/cli && pnpm check:size && …`). El ejemplo que la spec citaba,
`packages/cli/src/commands`, no aparece en los datos; la única sesión realmente enraizada en
un subdirectorio (`093cc299`, en `packages/cli`) abrió 0 PRs. Y aunque hubiera abierto uno, el
pilot le habría sido resoluble: **el host descubre `.claude/agents/` caminando hacia ARRIBA
desde el cwd**, hecho ya verificado en este repo y escrito en `lib/schema.ts:121-132`
("the upward discovery still finds the root's agents, hooks and settings").

El error iba en dirección conservadora —bloquear es **más** seguro de lo que aquella versión
afirmaba— pero una spec cuyo método es la medición no publica un número que su propio store
contradice. Consecuencia directa: **R3 deja de justificarse por incidencia y pasa a ser un
fail-safe declarado**, con su clase real escrita abajo.

Y la disponibilidad de la ruta alterna no es hipotética: **12 de 12 repos del parque tienen
`commit-pr-pilot.md` rendereado**, y el descubrimiento hacia arriba lo alcanza desde cualquier
subdirectorio de ellos.

### El mecanismo de distinción, verificado

`PreToolUse` es una fase de tool, y en las fases de tool el `agent_id` del payload es
estable — al contrario de `SubagentStop`, donde el host manda un id fresco por disparo
(112 ids para 117 disparos, 102 sin resolver). Verificado de punta a punta en este store:
el registro `allow` del hook lleva `agentId: a218173845aea2f1e`, y el propio host declara
en `subagents/agent-a218173845aea2f1e.meta.json` que ese id es
`{"agentType":"commit-pr-pilot"}`. En el hilo principal el host no manda el campo, y por eso
el recorder escribe el literal `orchestrator`.

El techo de precisión es conocido y se acepta a propósito: el campo dice **algún**
subagente, no específicamente el pilot. Coste medido de esa holgura: **6 `allow` en todo el
store, los 6 resueltos contra el meta del host como `{"agentType":"commit-pr-pilot"}`**, 0 de
otro subagente (`a218173845aea2f1e`, `aadf11634f0ab070b`, `ae0ed464e11d3be8f`,
`a7e44bf66e8ee0e12`, `a3706dde38394a16c`, `a17c478de00666eea`).

### La clase que R3 sí protege

El descubrimiento hacia arriba y los 12 de 12 repos rendereados dejan la incidencia medida de
"no hay a quién delegar" en **0 de 263**. Lo que queda no es el cwd: es la **configuración**.
`resolveHarnessPlan` materializa este hook **sin condición de config**, mientras que los
agentes pasan por `isAgentEnabled` (`harness-assets.ts:80`), así que
`harness.commitPrPilot: false` en `navori.config.json` produce exactamente un repo con el
guard puesto y sin pilot al que delegar. A eso se suman el `adopt` de un harness ajeno y un
borrado a mano del agente. Ninguno tiene incidencia medida; el que sea declarable en la config
es lo que lo separa de una hipótesis.

Público: el operador del harness. Esta spec toca un hook y el bloque managed que lo
materializa → **área crítica** por la definición de este repo.

## Requirements (EARS)

### El bloqueo

- **R1** — WHEN un `gh pr create` llega a `PreToolUse(Bash)` sin que el payload nombre a
  ningún subagente, y el `commit-pr-pilot` es resoluble para esa sesión, y no hay override
  válido, el sistema SHALL **bloquear** la llamada y SHALL entregar al modelo un mensaje que
  nombre la ruta alterna. Sustituye al `ask` de #712, cuya conversión medida es 0 de 26.

- **R2** — IF el payload nombra a un subagente (`agent_id` o `subagent_id` no vacíos), THEN
  el sistema SHALL dejar pasar la llamada y SHALL registrarla como `allow`. Es lo que hace
  que el hook no se bloquee a sí mismo cuando corre dentro del sidechain del propio pilot.

- **R3** — IF no existe `commit-pr-pilot.md` en ninguno de los directorios de agentes que el
  host consultaría para esa llamada —el ascenso por `.claude/agents/` desde el directorio sobre
  el que actúa el comando hasta la raíz del sistema de archivos, más `~/.claude/agents/`—, THEN
  el sistema SHALL dejar pasar la llamada y SHALL registrar el repliegue con esa razón.

  La condición es **la regla de descubrimiento del host, replicada**, no un proxy de ella: un
  resolvedor que conteste otra pregunta —por ejemplo la raíz de git— acierta siempre en un repo
  onboardeado y deja este requisito verde y sin mecanismo. Su clase medida es 0 de 263 y se
  declara así: es un fail-safe, y lo que lo justifica es la asimetría, no la frecuencia. Cuesta
  un puñado de `test -f` sin forks; no tenerlo cuesta un repo con `harness.commitPrPilot: false`
  donde ningún PR se puede abrir.

- **R4** — WHEN el sistema bloquea un `gh pr create`, el mensaje SHALL nombrar las **dos**
  salidas: delegar en el pilot, y el override con su razón. Un bloqueo cuya única salida no
  está escrita en el propio bloqueo es un callejón.

### El override contable

- **R5** — WHEN existe el archivo centinela declarado y su primera línea no está vacía, el
  sistema SHALL dejar pasar el `gh pr create` y SHALL registrar esa razón en el log de audit.
  SHALL consumir el centinela cuando el sistema de archivos lo permita, de modo que ampare
  **exactamente una** llamada; IF el borrado falla, THEN SHALL registrar el no-consumo de forma
  distinguible. Un override que ampara N llamadas sin que el log lo diga es un guard apagado
  que parece encendido.

- **R6** — IF el centinela existe pero no se le puede leer una razón, THEN el sistema SHALL
  bloquear igual y SHALL decir que el centinela necesita una razón. Sin esta cláusula, un
  `touch` es un bypass permanente y el override deja de ser contable.

### Que no se rompa nada

- **R7** — IF el guard no puede leer el payload, extraer el comando, o falta una de sus
  dependencias, THEN SHALL dejar pasar la llamada. Fail-open es obligatorio en un hook que
  bloquea: un guard que bloquea cuando falla él mismo vuelve el PR imposible.

- **R8** — El sistema SHALL registrar cada veredicto con una razón que distinga bloqueo,
  paso por subagente, repliegue y override, y SHALL NOT escribir registro alguno para una
  llamada Bash que no puede contener un PR — la vía rápida sin forks de #716 se conserva.

### La medición, antes del dato

- **R9** — El sistema SHALL proveer `scripts/mine-pr-routing.py`, que imprime por repo y
  global: bloqueos, reintentos por el pilot en la misma sesión tras un bloqueo, overrides con
  su razón, y repliegues; acotable por día con `--desde` / `--hasta`, igual que
  `mine-search-routing.py`.

- **R10** — Los criterios de decisión pre-registrados SHALL vivir en **un solo lugar**, y el
  minero SHALL imprimirlos junto a su resultado, de modo que no se puedan mover después de
  ver los datos. El pre-registro es parte del método: el 57% de un ciclo anterior se publicó
  mirando los datos primero, y por eso aguantó cinco sesiones y no dieciséis.
