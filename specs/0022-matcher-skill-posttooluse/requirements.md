# Matcher `Skill` en `PostToolUse` — Requirements

## Context

`navori audit` sabe qué skill estuvo activa en una sesión por dos caminos, y los dos salen del
**mismo archivo**: el transcript JSONL del host. `collectSkills` lee los usos de la herramienta
`Skill` (`source: "skill-tool"`) y los sellos `attributionSkill` de cada registro `assistant`
(`source: "attribution"`, entregado en #731/#732). La tercera fuente prevista —el atributo
`skill.name` del evento OTel `api_request`— está implementada y **nunca ha producido un dato**:
#736 midió cero ocurrencias en todos los logs del parque, porque exige un `navori audit --collect`
corriendo que nadie levanta.

El problema no es la calidad de esas señales, es su **base contractual**. La documentación del
host declara el formato del transcript *interno y libre de cambiar en cualquier release*, y
`parse.ts` lo repite en dos comentarios. `attributionSkill` es además un campo sin documentar. O
sea: dos features entregadas dependen de un campo que puede desaparecer en una actualización del
host **sin que nada lo note** — el reporte simplemente empezaría a decir que no hubo skills.

Existe la misma señal desde un contrato público y estable: el matcher `Skill` de `PostToolUse`.
Verificado contra la doc oficial en #736 — dispara en las invocaciones del modelo y trae
`tool_input.skill` en el payload. Hoy **ningún hook lo matchea**: `PreToolUse` solo cubre `Bash`,
y `PostToolUse` cubre `Bash` (drift watcher) y `Edit|Write|NotebookEdit|Agent|Task` (routing
watcher). Por eso la invocación de una skill no deja rastro en el audit-log, y una sesión cuyo
transcript ya no resuelve (`orphanSessions`, #675) no tiene absolutamente ninguna señal de skills.

El recorder ya está listo: `_partials/audit-log.sh` escribe `name/phase/tool/verdict/reason/agentId`
y #736 verificó que recibe el evento nuevo **sin cambios estructurales**. Falta el evento, no la
infraestructura.

**Lo medido en este repo** (56 transcripts en `~/.claude/projects/…navori-harness`), que es la línea
base contra la que se juzga lo que sigue:

| Señal | Medición |
|---|---|
| Usos de la herramienta `Skill` | **14** en 56 sesiones (~0.25 por sesión): **12** en el transcript raíz y **2** en `subagents/agent-*.jsonl` |
| De los 12 del hilo principal, con `args` de texto libre | **7** — uno lleva la descripción completa de un ticket |
| Registros con sello `attributionSkill` | **337**, sobre **5** slugs distintos |
| Slugs que nombra cada fuente | los **mismos 5** (`spec-bootstrap`, `playwright-cli`, `artifact-design`, `solution-design`, `artifact-diagramming`) |
| Invocaciones tecleadas `/skill-name` | **0** rastros: los únicos `<command-name>` del corpus son `/model` (22), `/clear` (3), `/compact` (2) y `/auto-mode-setup` (1) |

Tres lecturas de esa tabla importan. Una: las dos fuentes de hoy coinciden en **qué** skills, y
difieren en un orden de magnitud en **volumen**, porque miden cosas distintas — la invocación
contra el tramo trabajado bajo la skill. Otra: la comparación es transcript contra transcript, o
sea **no prueba nada sobre el hook**; es la base contra la que el hook se va a medir, no evidencia
de que vaya a coincidir.

La tercera define el alcance de la conciliación y es la que obliga a R8. **2 de las 14 invocaciones
solo existen del lado subagente** (`solution-design`, en `subagents/agent-*.jsonl`). El log de
hooks es de la sesión entera —un archivo por sesión, cada evento con su `agentId`—, pero
`collectSkills` corre por separado sobre cada transcript: hay `orchestrator.skills` y
`agents[].skills`, y **no existe una lista de skills a nivel sesión**. Comparar el log de la sesión
contra la lista del orquestador reportaría esas 2 invocaciones como desacuerdo entre fuentes el
primer día, cuando lo único que difiere es el alcance de cada lado.

**Hueco conocido y documentado, que esta spec no puede cerrar.** Una skill invocada tecleando
`/skill-name` no aparece como `tool_use` (`anthropics/claude-code#24858`, bug del host). El hook no
la ve, y —esto es lo que obliga a las R12/R13— **tampoco existe contador de lo que se pierde**: el
corpus de este repo no tiene un solo `<command-name>` que nombre una skill, así que ni siquiera hay
un proxy con el que estimar la fracción. El conteo del hook es una **cota inferior de invocaciones
del modelo**, y renderizarlo como total sería exactamente el error que #673, #674 y #730 ya
corrigieron tres veces en este reporte.

Público: el operador del harness auditando sus propias sesiones. Issue: #736, punto A4.

## Requirements (EARS)

### El evento

- **R1** — WHEN el modelo invoca la herramienta `Skill` en una sesión con log de audit, el sistema
  SHALL registrar en ese log un evento con `name: "skill-watch"`, `phase: "PostToolUse"`,
  `tool: "Skill"`, `verdict: "invoke"` y el identificador de la skill invocada.

- **R2** — El evento SHALL persistir del payload **únicamente** el identificador de la skill. El
  sistema SHALL NOT persistir `tool_input.args` ni ninguna parte de la respuesta de la herramienta,
  **en ninguna forma derivada**: ni un hash, ni su largo, ni un recorte. El audit guarda claves y
  conteos, nunca contenido — y aquí las dos cosas prohibidas son texto libre del modelo (medido: 7
  de las 12 invocaciones del hilo principal traen `args`) y el cuerpo entero de la skill. Un largo
  parece inofensivo y es el primer escalón de guardar contenido, así que la prohibición es del
  requisito y no de una nota de diseño.

- **R3** — IF el identificador no viene en el payload, o no cumple la clase de caracteres y el
  largo que el diseño declara, THEN el sistema SHALL registrar el evento igual, sin identificador.
  El conteo de invocaciones no SHALL depender de la forma del nombre.

- **R4** — El hook SHALL terminar siempre con código 0, SHALL NOT escribir en stdout y SHALL NOT
  bloquear ni alterar la invocación de la skill.

- **R5** — IF audit-mode nunca se activó en la máquina, THEN el hook SHALL terminar sin lanzar
  ningún subproceso.

### El registro en todo repo

- **R6** — `render` SHALL registrar el hook en el `settings.json` generado con un matcher que lo
  confine a la herramienta `Skill`, y SHALL materializar el script, sin que el repo declare nada en
  `navori.config.json`. Ninguna otra herramienta SHALL disparar este hook.

- **R7** — WHEN un repo ya inicializado corre `navori update` o `navori render --apply`, el sistema
  SHALL agregar el hook y su matcher al `settings.json` generado sin intervención manual, y SHALL
  NOT tocar `settings.local.json`.

### La corroboración entre las dos fuentes

- **R8** — WHEN una sesión tiene eventos `skill-watch` y transcript legible, el reporte SHALL
  publicar, por slug, la conciliación de las dos fuentes en tres cubetas: corroborada (las dos la
  vieron), solo-hook, solo-transcript. Los dos lados de la comparación SHALL ser de **sesión
  entera**:
  - lado hook: todos los eventos `skill-watch` del log de la sesión, **cualquiera que sea su
    `agentId`**;
  - lado transcript: la **unión** de los usos de la herramienta `Skill` del transcript del
    orquestador y de los de cada subagente.

  La conciliación SHALL NOT hacerse contra la lista de skills de una sola ficha, ni particionarse
  por `agentId`. Comparar contra una ficha convierte una diferencia de alcance en un desacuerdo
  entre fuentes — medido, 2 de las 14 invocaciones del corpus viven solo en sidechain. Y
  particionar por agente cambia la pregunta: la que el reporte responde es de conjunto —¿las dos
  fuentes vieron las mismas skills?—, mientras que el particionado la vuelve un join por agente
  cuyo fallback es la ventana temporal, y las ventanas de agentes en paralelo se traslapan.

- **R9** — IF un slug aparece del lado hook y no aparece del lado transcript tal como R8 los
  define, THEN el reporte SHALL emitir una señal que lo declare como posible deriva del formato del
  transcript. Una discrepancia silenciosa SHALL NOT ocurrir.

- **R10** — El **horizonte del recorder** de una sesión SHALL ser el instante del primer evento de
  hook registrado en su log (`hookLogFrom`), y la ventana SHALL ser el intervalo de ese instante al
  final de la sesión — definida siempre que el log tenga al menos un evento, incluido el caso en
  que el recorder ya corría antes de que la sesión empezara, donde la ventana es la sesión
  completa.

  IF un slug aparece del lado transcript con al menos un uso **en o después** de ese horizonte y no
  aparece del lado hook, THEN el reporte SHALL emitir una señal que lo declare como hueco de
  cobertura del recorder. IF todos sus usos son **anteriores** al horizonte, THEN el sistema SHALL
  NOT contarlo como discrepancia.

- **R11** — El sistema SHALL conservar por separado la observación de cada fuente. La etiqueta de
  precedencia de `SkillUse` SHALL NOT ser el único registro de qué fuente vio la skill.

### La cobertura parcial, declarada

- **R12** — El reporte SHALL presentar el conteo de invocaciones del hook como **cota inferior**,
  declarando que una invocación tecleada `/skill-name` no es observable, y SHALL NOT renderizarlo
  como total ni como porcentaje de las invocaciones de skills de la sesión. Los slugs que
  `attributionSkill` selló y que ninguna vía de invocación nombra SHALL publicarse como
  **candidatos** a invocación tecleada *o* a tramo heredado por un subagente, con las dos causas
  declaradas: producen el mismo rastro y el sistema no puede separarlas.

- **R13** — IF una sesión no tiene log de hooks, o su log no registró ningún evento, THEN el
  reporte SHALL declarar "sin registro" para la fuente del hook en vez de cero invocaciones. "No se
  observó" y "no ocurrió" SHALL NOT renderizarse igual.

### Lo que la conciliación no puede confundir

- **R14** — IF el log de una sesión no registró **ningún** evento de hook —de `skill-watch` o de
  cualquier otro—, THEN el sistema SHALL NOT emitir señal de discrepancia de ninguna de las dos
  clases. La fuente del hook no está presente, y toda skill del transcript sería un falso hallazgo:
  es el caso de una máquina sin `jq`, donde el recorder entero calla y el reporte gritaría una
  alarma por cada skill de la sesión.

- **R15** — El reporte SHALL publicar, junto a las cubetas de R8, el conteo de eventos
  `skill-watch` registrados **sin identificador** (los que R3 admite), de modo que el total de
  invocaciones del hook se pueda reconciliar con la suma de las cubetas.

  IF una sesión tiene eventos `skill-watch` y **ninguno** trae identificador, THEN el sistema SHALL
  emitir **una señal propia de deriva del contrato del payload** —distinta de la de R9, y que SHALL
  NOT depender de que R9 exista ni de que R9 haya emitido— y SHALL NOT emitir hueco de cobertura
  por los slugs que en esa sesión quedaron solo del lado transcript. Las dos señales nombran causas
  distintas: R9 dice que cambió el formato del transcript, ésta dice que cambió el payload del
  hook. Sin esta regla, el día que el host renombre `tool_input.skill` el reporte culparía a la
  cobertura del recorder: la alarma correcta apuntando al culpable equivocado.

### La contradicción que tensa el cable

- **R16** — IF una sesión registró al menos un evento `skill-watch` cuyo identificador **nombra una
  skill del catálogo del harness**, el transcript tiene registros `assistant` **posteriores** a ese
  evento, y la suma de `skillAttributionRecords` del orquestador y de sus agentes es **0**, THEN el
  sistema SHALL emitir una señal que declare la ausencia del sello `attributionSkill` como
  regresión del host.

  La pertenencia al catálogo SHALL evaluarse contra los slugs que el catálogo del repo enumera,
  comparando el identificador tal cual y —si trae espacio de nombres de plugin, la forma
  `<ns>:<slug>` que R3 admite— también el segmento posterior al `:`. IF el catálogo no enumera
  ninguna skill, THEN R16 SHALL NOT emitir: sin catálogo no hay con qué discriminar, y una alarma
  que no puede distinguir su causa no se emite.

  IF R16 emite para una sesión, THEN el reporte SHALL NOT imprimir para esa sesión la salvedad de
  atribución en cero: esa salvedad declara una ambigüedad que esta señal acaba de resolver, y las
  dos juntas se contradicen. Fuera de ese traslape la salvedad SHALL seguir imprimiéndose sin
  cambios.

  Es la única forma en que esta spec vigila la vía que de verdad carga la medición. R9 solo se
  tensa si desaparecen los `tool_use` de la herramienta `Skill` — la vía que el propio código llama
  documentada pero apenas usada. Si el host quita `attributionSkill` y conserva los `tool_use`, el
  slug sale **corroborado** y R9 calla: los 337 registros de atribución del corpus se vuelven 0 sin
  que nada lo diga.

  Hoy ese cero no es del todo mudo —`signals.ts` adjunta una salvedad cuando la atribución suma 0—,
  pero esa salvedad no puede ser más que `info`, porque "el campo desapareció" y "nadie trabajó bajo
  una skill" imprimen igual y ninguna fuente las separa. Una invocación confirmada por un contrato
  público y cero registros atribuidos **sí** las separa: es una contradicción, no un cero ambiguo.
  R16 SHALL NOT reemplazar esa salvedad, que sigue siendo lo correcto para las sesiones sin evento
  de hook.

  Las dos cláusulas que acompañan al cero **no son adorno y tampoco lo cierran del todo**. Hay tres
  causas benignas por las que la atribución puede sumar 0 habiendo invocación, y esta spec las trata
  distinto:

  - **La sesión termina justo después de invocar** y no alcanza a producir un registro sellado —el
    sello vive en los `assistant` posteriores—. La descarta la cláusula de registros posteriores.
  - **El modelo invocó una skill que no existe**: slug mal escrito, plugin no instalado. La
    herramienta retorna con error, `PostToolUse` dispara igual, y el hook registra la invocación
    **con** identificador porque R2 le prohíbe mirar `tool_response`, que es donde vive el error.
    La descarta la cláusula de catálogo.
  - **El tramo atribuido vive en un transcript de subagente que el parser no recibió.** No es
    discriminable con lo que hay, y queda como **falso positivo aceptado y declarado**: la señal
    SHALL nombrar esta causa en su evidencia, para que el lector la descarte antes de culpar al
    host.
  - **La invocación ocurrió dentro de un subagente que murió antes de responder**, mientras el
    orquestador siguió produciendo registros. Es la primera causa medida a otra granularidad: la
    cláusula de registros posteriores mira el transcript de la sesión, así que las cuatro
    condiciones se cumplen y la señal emite. Tampoco es discriminable —separarla exigiría casar
    cada evento con su agente, o sea particionar por `agentId`, que es lo que R8 prohíbe con
    argumento propio— y SHALL declararse por la misma vía que la anterior.

  La cláusula de catálogo tampoco cubre la invocación de una skill que **sí** está en el catálogo y
  aun así falla al cargar. Ese residuo se declara junto con los anteriores por la misma vía.

  **Alcance del catálogo, declarado:** R16 solo alcanza las skills que el catálogo del repo
  enumera, o sea las de `.claude/skills`. Una skill personal o traída por un plugin lo deja
  callado, así que en un repo cuyas skills vengan mayoritariamente de plugins este cable trampa
  cubre poco o nada. Es el lado conservador a propósito —silencio antes que falso positivo—, pero
  es una limitación de cobertura y se declara como tal.
