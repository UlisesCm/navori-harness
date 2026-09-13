# Matcher `Skill` en `PostToolUse` — Tasks

## Lote 1 — el evento y su registro en todo repo

- [ ] **T1** (R1, R2, R3, R4, R5) — Escribir `packages/core/core-assets/hooks/skill-watch.sh`:
  `set -uo pipefail` sin `-e`, `navori:include extract-cmd` + `navori:include audit-log`,
  `navori_audit_name="skill-watch"`, `navori_audit_phase="PostToolUse"`, `navori_audit_tool="Skill"`.
  Orden obligatorio: `navori_audit_begin` primero y la lectura de `tool_input.skill` **después** de
  que quedó establecido que hay log donde escribir, para que una máquina sin audit-mode no pague un
  solo subproceso. El slug se acepta contra `[A-Za-z0-9._:-]` con tope de 64 caracteres; lo que no
  pasa se omite del `reason` **sin cancelar** el `navori_audit_log "invoke"`. Nunca se leen
  `tool_input.args` ni `tool_response`, ni en forma derivada (hash, largo, recorte). Todas las
  salidas son `exit 0` y nada va a stdout. · tests en
  `packages/cli/src/lib/__tests__/skill-watch.test.ts`, corridos en bash y zsh con `acrossShells`:
  `registra la invocación con el slug en reason`, `no escribe args ni el cuerpo de la skill en el
  log` (payload con `tool_input.args` largo y `tool_response` con texto reconocible, afirmando que
  ninguno aparece y que la línea no gana ningún campo derivado de ellos), `registra el evento sin
  nombre cuando el slug falta o no pasa la validación` (tres payloads: sin `skill`, con caracteres
  fuera de clase, y con 200 caracteres), `sale en 0 y no escribe cuando la sesión no está marcada`,
  y `no lanza ningún subproceso sin raíz de audits` (un `jq` señuelo en el `PATH` que toca un
  centinela; el centinela no debe existir al terminar). Todos con
  `// Covers: R1, R2, R3, R4, R5`.

- [ ] **T2** (R6, R7) — Registrar el hook en `packages/cli/src/engines/claude/build-settings.ts`
  bajo `PostToolUse` con `matcher: "Skill"`, `timeout: 10` y
  `statusMessage: "navori: skill invoked"`, y agregarlo a
  `packages/cli/src/engines/shared/harness-plan.ts` con `managedId: "skill-watch-base"` para que un
  repo ya inicializado lo materialice con `navori update` / `navori render --apply`. Actualizar los
  golden snapshots (`packages/cli/src/engines/__tests__/__golden__/claude.snap`) y el inventario de
  hooks que los tests de assets sostienen. · tests:
  `packages/cli/src/engines/claude/__tests__/build-settings.test.ts`::`registra el skill-watch con
  matcher Skill y ninguna otra tool` (afirma el matcher exacto y que ningún otro bucket de
  `PostToolUse` nombra `Skill`), `packages/cli/src/lib/__tests__/skill-watch.test.ts`::`el plan del
  harness materializa el hook sin opt-in de config` (plan resuelto con una config mínima, sin campo
  nuevo en `navori.config.json`) y `packages/cli/src/lib/__tests__/skill-watch.test.ts`::`el render
  no escribe settings.local.json` (render sobre un repo fixture con un `settings.local.json`
  preexistente, afirmando que su contenido y su mtime no cambian) — área crítica declarada del
  repo, así que la ausencia de escritura se afirma, no se asume. Todos con `// Covers: R6, R7`.

## Lote 2 — la conciliación de las dos fuentes

- [ ] **T3** (R8, R11, R13) — En `packages/cli/src/lib/audit/parse.ts`, reconocer los eventos
  `name === "skill-watch"` del log de sesión y construir la conciliación **de sesión contra
  sesión**: lado hook, todos los eventos sin mirar `agentId`; lado transcript, la unión de los usos
  de la herramienta `Skill` del orquestador y de cada subagente —lista que hoy no existe, porque
  `collectSkills` corre por transcript— reteniendo el instante de cada uso para poder compararlo
  con el horizonte en T4. En `model.ts`, agregar la variante `skill-hook` a `SkillSource` —por
  encima de `skill-tool` y por debajo de `host` en la precedencia de `collectSkills`—, el objeto de
  conciliación con sus tres cubetas y el conteo, y subir `schemaVersion` a 7. La ausencia de la
  fuente se representa **omitiendo el objeto**, no con ceros. · tests en
  `packages/cli/src/lib/audit/__tests__/parse.test.ts`::`concilia hook y transcript en las tres
  cubetas` (log sintético con una skill corroborada, una solo-hook y una solo-transcript en la
  misma sesión), `corrobora una invocación que solo existe en el transcript de un subagente` (el
  caso medido: 2 de las 14 invocaciones del corpus; sin la unión saldría como deriva), `la etiqueta
  de precedencia no borra la observación de la otra fuente` (una skill con las dos fuentes sale
  como `skill-hook` **y** aparece en `corroborated`), `una sesión sin log de hooks no trae objeto de
  conciliación` y `el reporte declara schemaVersion 7`, con `// Covers: R8, R11, R13`.

- [ ] **T4** (R9, R10) — Dos detectores en `packages/cli/src/lib/audit/signals.ts`. `hookOnly` no
  vacío → señal `warn` que nombra los slugs y apunta a `collectSkills` como lo que hay que revisar,
  porque lo que probablemente cambió es el formato del transcript. `transcriptOnly` con al menos un
  uso en o después del **horizonte** —definido como `session.hookLogFrom`, NO como
  `recorderWindow()`, que devuelve `null` en el caso sano y apagaría el detector en casi todas las
  sesiones— → señal `warn` de hueco de cobertura. · tests en
  `packages/cli/src/lib/audit/__tests__/signals.test.ts`::`declara la deriva cuando el hook vio una
  skill que el transcript no muestra`, `declara el hueco de cobertura cuando el transcript vio una
  invocación posterior al horizonte y el hook no`, `no reporta discrepancia por usos anteriores al
  horizonte` y `sigue reportando cuando el recorder ya corría antes de que la sesión empezara` (el
  extremo donde `recorderWindow()` es `null` y la ventana es la sesión completa), con
  `// Covers: R9, R10`.

- [ ] **T5** (R14, R15) — Las dos guardas, en `signals.ts` y en el modelo. R14: si el log de la
  sesión no registró **ningún** evento de hook, ninguno de los dos detectores emite — la fuente no
  está presente y toda skill del transcript sería un falso hallazgo. R15: publicar el conteo de
  eventos `skill-watch` sin identificador junto a las cubetas, y cuando **todos** los eventos de la
  sesión vienen sin identificador, emitir una señal **propia** —deriva del contrato del payload,
  con su propio `kind`, que no reusa ni depende de la señal de R9— y suprimir el hueco de cobertura
  de esa sesión, porque la causa está en el payload y no en el despliegue del hook. Las dos señales
  tienen que poder existir por separado: R9 es recortable y R15 no, así que R15 no puede invocar
  maquinaria de R9. · tests en
  `packages/cli/src/lib/audit/__tests__/signals.test.ts`::`calla cuando la sesión no registró
  ningún evento de hook` (sesión con transcript y log vacío: cero señales de discrepancia),
  `publica el conteo de eventos sin nombre sin alterar las cubetas` y `culpa al payload y no a la
  cobertura cuando ningún evento trae nombre` (el escenario de deriva real: el host renombra
  `tool_input.skill`, sale deriva y NO sale hueco de cobertura), con `// Covers: R14, R15`.

## Lote 3 — el cable trampa y el conteo honesto

- [ ] **T6** (R16) — Tercer detector en `packages/cli/src/lib/audit/signals.ts`: emitir la señal de
  regresión del sello `attributionSkill` cuando la sesión registró al menos un evento `skill-watch`
  cuyo identificador **nombra una skill del catálogo**, el transcript tiene registros `assistant`
  posteriores a ese evento, y la suma de `skillAttributionRecords` del orquestador y de sus agentes
  es 0. Nada de esto agrega parseo ni argumentos: el campo ya está en `SessionAudit` y en cada
  `AgentRun` (#725), y `detectSignals` ya recibe el `HarnessCatalog` que `deadCatalog` usa.

  La pertenencia al catálogo se prueba contra el identificador tal cual **y** contra el segmento
  posterior a un `:` inicial, para que una skill de plugin no se lea como inexistente; con el
  catálogo vacío el detector no emite. La evidencia de la señal debe nombrar las tres causas
  benignas que **no** se descartan —un tramo atribuido en un transcript de subagente que el parser
  no recibió; un subagente que murió antes de responder mientras el orquestador seguía produciendo
  registros; y una skill del catálogo que falló al cargar— y decir qué revisar (`collectSkills` lee
  el campo), no "algo cambió". Ninguna de las tres se afina: la segunda exigiría medir los registros
  posteriores por agente, o sea particionar por `agentId`, que R8 prohíbe.

  **Reparto con la salvedad de #725**: en las sesiones donde este detector emite, `deadCatalog` NO
  imprime la salvedad de atribución en cero —esa frase declara una ambigüedad que esta señal acaba
  de resolver—; en las demás queda exactamente como está. · tests en
  `packages/cli/src/lib/audit/__tests__/signals.test.ts`::`declara la regresión cuando hubo
  invocación de una skill del catálogo y ningún registro atribuido`, `calla cuando la atribución no
  es cero`, `calla cuando la sesión no produjo registros assistant después de la invocación`,
  `calla cuando el slug invocado no está en el catálogo` (la invocación fallida: la tool retornó con
  error y el hook la registró igual), `calla con catálogo vacío`, `cuenta como del catálogo un slug
  con espacio de nombres de plugin` y `no imprime la salvedad de atribución en cero en la sesión
  donde la señal emite`, con `// Covers: R16`.

- [ ] **T7** (R12, R13, R15) — En `packages/cli/src/lib/audit/report.ts`, renderear: el conteo de
  invocaciones del hook como cota inferior, con la causa escrita en la misma línea (invocación
  tecleada `/skill-name` no observable, `anthropics/claude-code#24858`) y **sin ningún porcentaje
  calculado sobre él**; la conciliación por cubeta; el conteo de eventos sin identificador, para que
  el total cuadre contra la suma de las cubetas; los slugs que `attributionSkill` selló y que
  ninguna vía de invocación nombra, publicados como candidatos a invocación tecleada *o* a tramo
  heredado por un subagente, con las dos causas dichas porque no se pueden separar; y "sin
  registro" —no cero— cuando la sesión no trae el objeto de conciliación. Mismo trato en la salida
  `--json`, que es la mitad que lee un CI. · tests en
  `packages/cli/src/lib/audit/__tests__/report.test.ts`::`presenta las invocaciones del hook como
  cota inferior y sin porcentaje` (afirma la palabra que lo declara y la ausencia de `%` en esa
  línea), `publica los sellos sin invocación como candidatos, nombrando las dos causas`, `imprime el
  conteo de eventos sin identificador junto a las cubetas` y `dice sin registro cuando la fuente del
  hook no estuvo presente`, con `// Covers: R12, R13, R15`.
