# Correcciones del mecanismo de planes tras la segunda auditoría — Requirements

**Estado:** borrador · **Fecha:** 2026-10-13 · **Base revisada:** `dev` sincronizado con `main`
(`chore/sync-main-into-dev-0050`, `c7062433`: incluye 0049, 0050 y 0051). El PR de esta spec apunta
a `dev`.

## Contexto

Tras cerrar 0051, una segunda auditoría de solo lectura (2026-10-13) cubrió todo el mecanismo de
planes, no solo el plan maestro: núcleo del workplan (`navori plan classify|render|check|update`),
enforcement (`plan-gate`, recibos, evidencia), plan maestro en segunda pasada, coherencia de la
doctrina con el CLI y el motor Codex. Cinco auditores reprodujeron cada hallazgo en repos temporales.
Los hallazgos de Codex se re-verificaron sobre la base sincronizada (0050 ya resolvió la
evidencia por rollout y la independencia del review en sesión Codex). Lo más grave: el plan-gate deja pasar un `implementer` sin plan cuando la configuración no se lee,
cuando el `cwd` es un subdirectorio o cuando el tipo de agente no es exactamente `implementer`.

Decisiones del usuario (2026-10-13):
- Configuración presente pero ilegible ⇒ el gate deniega con el error; solo la ausencia de
  configuración deja pasar (R1).
- Evidencia de `plan update`: fail-closed con configuración ilegible; quitar la variable de sesión
  del host queda como límite declarado, visible como advertencia (R12, R13).
- Dos `CHANGES_REQUESTED`: en nivel 0/1 se exigen los artefactos `solution_*`; en nivel ≥2 se escala
  al usuario, que autoriza otra ronda con un reinicio explícito del registro del gate (R8, R9).
- Base `dev` sincronizada con `main` en un PR aparte; esta spec es una sola entrega con commits
  atómicos.

Fuentes estables (símbolos): `packages/cli/src/lib/plan/gate.ts` (`evaluatePlanGate`,
`parsePayload`, `readDispatch`, `evaluateNivel0`, `evaluateWorkplan`, `evaluateEscalation`,
`recordAndCountRejections`), `packages/cli/src/lib/plan/check.ts` (`checkWorkplan`, `checkLevel`,
`checkStructural`, `checkEvidence`), `packages/cli/src/lib/plan/classify.ts` (`classify`,
`matchesCriticalPaths`, `rootDirsOf`, `declaredFlagsFromSignals`), `packages/cli/src/lib/plan/evidence.ts`
(`leadingCdDir`, `cdTargetCwd`, `candidateProblem`, `validateEvidence`),
`packages/cli/src/lib/plan/schema.ts` (`WorkplanSchema`), `packages/cli/src/lib/plan/render.ts`
(`applyWorkplanUpdate`), `packages/cli/src/commands/plan.ts` (`evidenceRequired`, `classifyDiff`,
subcomandos `update`, `check`, `classify`, `gate`), `packages/cli/src/lib/master/*` (`status.ts`
`renderMasterParts`/`masterPartsRegion`/`writeMasterStatus`, `part.ts` `changeMasterPart`,
`close.ts` `runMasterClose`, `checks.ts` `checkClosedStage`/`CODEBASE_HEADERS`, `slice.ts`,
`init.ts` `openNewStage`, `delivery.ts`, `delivery-checks.ts`, `stages.ts` `contextForArchitects`,
`schema.ts` `PartsSchema`), los hooks `packages/core/core-assets/hooks/{plan-gate,master-accept-confirm}.sh`
y la doctrina en `packages/core/core-assets/{managed,skills,agents}`.

## Requirements (EARS)

### Plan-gate (Claude y Codex)
- **R1** — IF `navori.config.json` existe en la raíz del checkout pero no se puede leer o validar,
  THEN `navori plan gate` SHALL denegar el despacho de un implementer nombrando el error de
  configuración. Solo la ausencia del archivo SHALL dejar pasar.
- **R2** — WHEN el gate evalúa un payload, the system SHALL resolver la raíz del checkout a partir
  del `cwd` del payload (o del proceso, si falta) antes de leer la configuración, de modo que un
  `cwd` en un subdirectorio reciba la misma decisión que la raíz.
- **R3** — The system SHALL reconocer como implementer, en Claude, cualquier `subagent_type` que
  normalizado (sin espacios, en minúsculas, sin prefijo `<plugin>:`) sea `implementer`; y, en Codex,
  cualquier spawn cuyo `agent_type` falte o no pertenezca a la lista de roles que no escriben
  (`scout`, `architect`, `auditor`, `reviewer`, `scribe`, `publisher`).
- **R4** — IF el payload del hook no es JSON válido o no tiene la forma esperada mientras
  `planTiers` está activo, THEN the system SHALL denegar con un mensaje que nombre el problema.
- **R5** — WHEN el encargo abre con `workplan: <feature>`, the system SHALL denegar si el campo
  `feature` del workplan no es `<feature>`, si su `level` es menor que el que `classify` calcula
  sobre sus `files` y señales declaradas, o si `solution.verdict` es `BLOCKED`.
- **R6** — WHEN el encargo abre con `nivel-0: <path>`, the system SHALL denegar si `<path>`
  coincide con `criticalPaths` de la configuración, y the doctrine SHALL declarar que el gate solo
  verifica la ruta declarada, no el diff real.
- **R7** — The system SHALL autorizar a lo más un spawn por cada archivo `dispatch_<f>.json` de
  Codex aunque varios hooks lo evalúen en paralelo, y SHALL tratar como vencido un `createdAt`
  posterior al reloj actual en más de 60 segundos.

### Escalación tras dos rechazos
- **R8** — WHEN una feature de nivel 0 o 1 acumula dos veredictos `CHANGES_REQUESTED`, the system
  SHALL exigir `solution_<f>.md` y `solution_review_<f>.md` antes del siguiente despacho, y la
  apertura `nivel-0:` SHALL pasar por la misma cuenta de rechazos.
- **R9** — WHEN una feature de nivel ≥2 acumula dos rechazos, the system SHALL denegar con la
  instrucción de escalar al usuario, y SHALL ofrecer un reinicio explícito del registro de rechazos
  que exija aprobación del usuario (confirmación del host) y quede auditado.

### CLI del workplan
- **R10** — IF `navori plan update` recibe un `--progress` que no cumple `A<n>=pendiente|cumplido|bloqueado`
  con un `A<n>` existente, un `--date` que no es fecha ISO, o `--progress` junto con `--decision`,
  THEN the system SHALL fallar con error de uso sin escribir. The system SHALL nunca escribir un
  workplan que no valide contra `WorkplanSchema`.
- **R11** — WHEN dos o más `navori plan update` de la misma feature corren en paralelo, the system
  SHALL conservar todas las actualizaciones o rechazar las que no pudo aplicar, nunca perderlas en
  silencio.
- **R12** — IF la configuración no se puede leer dentro de una sesión de host que registra
  evidencia (Claude, Codex o Pi), THEN `navori plan update` SHALL rechazar `cumplido` sin
  evidencia. (En la base sincronizada, `evidenceRequired` solo falla cerrado para Codex.)
- **R13** — The doctrine SHALL declarar que la exigencia de evidencia depende de una señal de
  entorno del host y que un `cumplido` aceptado sin evidencia aparece como advertencia en
  `navori plan check`.
- **R14** — WHEN el comando de un criterio cambia de directorio con `cd <dir>` dentro de una cadena
  `&&` (no solo al inicio), the system SHALL aceptar como `cwd` válido el destino del último `cd`,
  y IF la evidencia se rechaza por `cwd`, THEN el mensaje SHALL proponer una corrección distinta de
  repetir el mismo comando.
- **R15** — The system SHALL reportar en `navori plan check`, con exit 2: ids de criterio
  duplicados, `feature` distinto del nombre del archivo, `level` menor que el calculado por
  `classify`, `solution.verdict` `BLOCKED` y JSON ilegible (como hallazgo `schema`, sin traza).
- **R16** — WHEN `navori plan update` reescribe un workplan, the system SHALL conservar los campos
  que el esquema no declara.
- **R17** — IF `navori plan classify` se invoca sin `--files`, sin `--diff` y sin borrador con
  archivos, THEN the system SHALL fallar con error de uso en vez de devolver nivel 0.
- **R18** — WHEN se invoca `navori plan classify --diff`, the system SHALL clasificar los cambios
  del árbol de trabajo (commiteados, sin commitear y sin seguimiento) contra la base dada o, por
  defecto, contra `origin/<prTarget>` de la configuración.
- **R19** — The system SHALL normalizar las rutas de `classify` (prefijo `./`, separadores) antes
  de compararlas con `criticalPaths` y de contar directorios raíz.

### Plan maestro
- **R20** — IF un texto de una parte del workflow `legacy` en `parts.json` (título, objetivo,
  alcance o elementos de lista) contiene salto de línea o la secuencia `<!--`, THEN the system
  SHALL rechazar `parts.json` nombrando la parte y el campo. Las partes de `deliveries` no se
  renderizan en la región y quedan fuera, para no invalidar entregas en curso.
- **R21** — WHILE un cierre está iniciado (`state.outcome` definido), the system SHALL rechazar
  `navori master part`, `advance` y `ux` con el mensaje de reanudar con `navori master close`.
- **R22** — IF `navori master init` abre una etapa cuyo slug ya usó otra etapa, THEN the system
  SHALL fallar nombrando la etapa previa, para que los workplans de entrega no colisionen.
- **R23** — WHEN `navori master check --stage` revisa una etapa cerrada del workflow `deliveries`,
  the system SHALL validarla contra el esquema de entregas sin exigir `CLOSURE.md`.
- **R24** — The system SHALL generar `STATUS.md` de una etapa `deliveries` sin hashes de árbol
  (`scope=`, `presented=`); esos datos SHALL seguir en `navori master status --json`.
- **R25** — WHEN una prueba de entrega queda obsoleta porque el árbol cambió, the system SHALL
  nombrar esa causa en el bloqueo de `status`.
- **R26** — IF `parts.json` es ilegible o inválido en una etapa `deliveries`, THEN
  `navori master status --json` SHALL devolver `workflow` y un bloqueo que lo nombre, y
  `navori master init` SHALL reportarlo sin traza.
- **R27** — WHEN la línea base de entregas queda obsoleta con una cola autorizada, the system SHALL
  nombrar `navori master delivery-revoke` en el mensaje.
- **R28** — IF `parts.json.spec` apunta a un directorio inexistente o fuera de `specsDir` en una
  etapa `deliveries`, THEN `delivery-check` SHALL reportarlo como bloqueo.
- **R29** — IF la región `navori:master-parts` tiene apertura sin cierre, THEN `navori master check`
  SHALL indicar corregir el marcador a mano, no `navori master status`.
- **R30** — The system SHALL calcular `navori master status --line` y `--json` sin escribir objetos
  ni índices en `.git`.
- **R31** — WHEN el idioma declarado es `en`, the system SHALL aceptar los encabezados en inglés de
  `CODEBASE.md` y SHALL rotular en inglés `STATUS.md`, la región de partes y `CLOSURE.md`.
- **R32** — The system SHALL reemplazar los mensajes obsoletos del workflow `deliveries` (comando
  `master`, diagnóstico de `doctor` y el rótulo "Preparación") por textos que reflejen las fases
  disponibles.
- **R33** — IF `navori master close --reason` llega vacío o solo con espacios, THEN the system SHALL
  rechazarlo en ambos workflows.
- **R34** — The system SHALL listar en `architectContext` solo archivos que existen.
- **R35** — IF falta el workplan de una entrega, THEN los subcomandos `delivery-*` SHALL nombrar el
  workplan esperado sin traza ni ruta absoluta cruda.

### Confirmación del plan maestro
- **R36** — The hook `master-accept-confirm` SHALL detectar los subcomandos de `navori master` que
  requieren confirmación también cuando el comando va envuelto en `sh|bash|zsh -c|-lc`, `eval` o
  con argumentos entre comillas, y las reglas de Codex SHALL pedir confirmación para los
  `navori master delivery-*` que aprueban, deciden, publican o revocan.

### Doctrina
- **R37** — The doctrine SHALL indicar replanear cuando `navori plan classify --diff` devuelva un
  nivel mayor, y cómo actualizar `level` y `classification`.
- **R38** — The doctrine SHALL tener una sola regla para dos `CHANGES_REQUESTED` (R8, R9), igual en
  `orchestrator`, `planificacion` y `plan-advanced`.
- **R39** — The doctrine SHALL documentar la apertura válida para una spec sin entregas y cómo se
  escribe el workplan de una entrega de nivel 3.
- **R40** — The startup context SHALL entregar la precondición de plan, la regla sin ruta inline y la
  apertura `spec:` aunque `10-orquestacion` no quepa, y SHALL no remitir a una sección oculta.
- **R41** — The doctrine, `docs/native-overlap.md` and the engine capabilities SHALL describir el
  plan-gate de Codex como un gate que deniega, SHALL declarar que en Codex los implementers se
  despachan de uno en uno (con dos o más `dispatch_<f>.json` vigentes el gate deniega), y la
  capacidad `acceptance-evidence` de Codex SHALL reflejar el carril de evidencia por rollout que
  ya existe.
- **R42** — The reviewer doctrine SHALL rechazar solo `progress-unevidenced` y
  `progress-evidence-stale`, no `progress-unevidenced-accepted`.
- **R43** — The skill `plan-simple` SHALL nombrar un solo responsable de `navori plan update`,
  marcar justo tras correr el comando sobre el mismo árbol, e incluir un borrador mínimo con
  `classification` y los flags de señales declaradas.
- **R44** — The doctrine SHALL indicar que `solution.verdict: BLOCKED` impide despachar y qué
  significa `bloqueado` en un criterio.
- **R45** — The reviewer doctrine SHALL documentar `navori receipt gate --phase`.
- **R46** — The skill `master-plan` SHALL listar todos los subcomandos que mutan estado, cómo abrir
  una etapa `deliveries` y cuándo usar `delivery-revoke`.
- **R47** — The doctrine SHALL declarar que el recibo es una atestación local sin autenticación y
  que la independencia del review en Codex depende de `CODEX_THREAD_ID`.
- **R48** — The rendered Claude settings SHALL pre-aprobar `navori plan render` y
  `navori plan update`.

## Trazabilidad

Cada `R<n>` termina en al menos una tarea y una prueba nombrada en `tasks.md`, y cada prueba lleva
`// Covers: R<n>` sobre el caso.
