# Redefinición de `navori audit` — Tasks

Lote A y lote B son independientes entre sí (CLI vs. hooks) y pueden ir en paralelo. El
lote C lee lo que B escribe, así que va después de B. El lote D depende de A.

## Lote A — la falla abierta y la activación explícita

- [x] **A1** (R2) — Validar las banderas antes de actuar en `commands/audit.ts`: `--start`
  y `--stop` con cadena vacía terminan con `exit 2` y un mensaje que nombra la bandera sin
  id, sin escribir reporte. Respeta el contrato de `--json` (error como JSON, no como
  prosa), igual que hace hoy `auditPathOrExit`.
  · test: `commands/__tests__/audit.test.ts`::"--start sin id sale con error y no escribe
  reporte" y ::"--stop sin id sale con error y no escribe reporte" con `// Covers: R2`
- [x] **A2** (R3, R4) — Quitar de `audit-mode-trigger.sh` la detección por subcadena
  (`matched`/`off_intent`, `audit_subcommand_available` y los cuatro mensajes de
  activación/desactivación). Conservar íntegra la rama que registra el prompt cuando el log
  ya existe, incluida la lectura de `transcript_path`.
  · test: `__tests__/audit-hooks.test.ts`::"un prompt que menciona audit mode no propone
  activar nada" y ::"con el log presente el prompt tecleado se registra" con
  `// Covers: R3, R4`
- [x] **A3** (R1) — Confirmar que `--start <id>` sigue nombrando el log creado y que la
  guarda de idempotencia se mantiene, ahora que es la única vía de activación.
  · test: `commands/__tests__/audit.test.ts`::"--start nombra el log que creó" con
  `// Covers: R1`

## Lote B — el log como fuente de verdad

- [x] **B1** (R5, R6, R7, R22) — Crear `core-assets/hooks/_partials/audit-log.sh`, incluido
  con `# navori:include audit-log`, exponiendo `navori_audit_log <verdict> [reason]`:
  resuelve el log por `$NAVORI_AUDITS_ROOT`/`$HOME` y el `session_id` del payload, escribe
  una línea JSON con el contrato de `design.md`, mide `ms` desde el arranque del hook, y
  vuelve 0 sin escribir cuando el log no existe o no es escribible. Nunca toca stdout.
  · test: `__tests__/audit-hooks.test.ts`::"no escribe ni altera la salida sin audit-mode
  activo" y ::"un log no escribible no cambia el código de salida del hook" con
  `// Covers: R5, R6, R7`
- [x] **B2** (R5) — Cablear el helper en los hooks managed no-audit de core
  (`guard-destructive`, `managed-drift-watch`, `precompact-session-summary`,
  `quality-gate-pre-commit`, `session-start-context`, `stop-verify-reminder`,
  `subagent-stop-handoff`, `worktree-reclaim`) y en los de plugin
  (`jscpd/scripts/check-jscpd.sh`, `semgrep/scripts/check-semgrep.sh`): un `source` y una
  llamada con el veredicto que ya calcula cada uno. No cambiar la lógica de ninguno.
  · test: `__tests__/audit-hooks.test.ts`::"todo hook managed cableado registra su
  ejecución con audit-mode activo" con `// Covers: R5`
- [x] **B3** (R5) — Derivar la lista de hooks a cablear del render en vez de fijarla en el
  test, para que un hook managed nuevo que no llame al helper haga fallar la suite en vez
  de quedar mudo en los reportes.
  · test: `__tests__/audit-hooks.test.ts`::"ningún hook managed renderizado queda sin
  registrar" con `// Covers: R5`

- [ ] **B4** (R21, R22) — Emitir `agent-start` / `agent-stop` desde
  `subagent-stop-handoff.sh` y el punto de arranque que el host exponga, con el contrato de
  `design.md`, y confirmar que el helper registra los veredictos `skip`.
  · test: `__tests__/audit-hooks.test.ts`::"un subagente deja agent-start y agent-stop en el
  log" y ::"un hook que no actúa deja su evento skip" con `// Covers: R21, R22`

## Lote C — leer y mostrar

- [ ] **C1** (R5) — Leer los eventos `hook` del log en `parse.ts` y colgarlos del agente o
  del orquestador según la ventana temporal en que caen. Un evento sin campo obligatorio
  suma a `parseErrors` sin abortar la lectura.
  · test: `lib/audit/__tests__/parse.test.ts`::"asocia cada evento hook a la corrida en
  cuya ventana cae" y ::"un evento hook incompleto suma a parseErrors" con `// Covers: R5`
- [ ] **C2** (R9, R10, R11) — En `parse.ts`: agrupar las tools `mcp__<servidor>__<op>` por
  servidor con sus operaciones, y rehacer `collectSkills` para devolver procedencia
  (`skill-tool` | `skill-md`) descartando las vistas por listado de directorio o glob, con
  el conteo de descartadas.
  · test: `lib/audit/__tests__/parse.test.ts`::"agrupa las llamadas MCP por servidor",
  ::"distingue una skill invocada de una leída" y ::"descarta las skills vistas al listar
  el índice y las cuenta" con `// Covers: R9, R10, R11`
- [ ] **C3** (R8, R12) — Renderizar la ficha por agente en `report.ts` con tipo,
  descripción, modelo, duración, tokens desglosados, `cache_read`, skills con procedencia,
  tools, MCP por servidor, hooks y veredicto. Extender `AgentRun` y subir
  `schemaVersion` a `2`.
  · test: `lib/audit/__tests__/report.test.ts`::"la ficha de un agente incluye sus skills,
  su MCP y sus hooks" con `// Covers: R8, R12`
- [ ] **C4** (R13, R14) — Distinguir suma de duraciones y reloj de pared usando
  `overlapsWith`, y corregir el resumen del comando para que nombre el total facturable.
  · test: `lib/audit/__tests__/report.test.ts`::"agentes solapados no suman su duración al
  reloj de pared" y `commands/__tests__/audit.test.ts`::"el resumen nombra el total
  facturable" con `// Covers: R13, R14`
- [ ] **C5** (R17) — Subir `schemaVersion` a `2` en `model.ts` y en el render JSON.
  · test: `lib/audit/__tests__/report.test.ts`::"el JSON declara schemaVersion 2" con
  `// Covers: R17`
- [ ] **C6** (R19, R20) — Resolver en `harness.ts` el alcance MCP por servidor (un
  `mcp__codegraph__*` no concede engram; un `tools:` ausente los concede todos) y cruzarlo
  en la ficha con las llamadas observadas: cada servidor sale como usado con sus
  operaciones, disponible-sin-usar, o vedado. Para el vedado, atribuir los tokens de las
  secciones MCP de `CLAUDE.md` que ese agente pagó en su arranque, reusando la medición que
  ya hace la señal `unreachable-instructions`.
  · test: `lib/audit/__tests__/report.test.ts`::"distingue un servidor MCP vedado de uno
  disponible y no usado" y ::"atribuye al agente vedado los tokens de instrucciones que no
  puede ejecutar" con `// Covers: R19, R20`

## Lote D — la estructura de salida

- [ ] **D1** (R15, R16) — Añadir a `paths.ts` los constructores
  `sessionReportDir(repo, fecha, id)` y `rangeReportDir(repo, desde, hasta)`, con la misma
  validación de id que `sessionLogPath`, y escribir desde `audit.ts` bajo el layout nuevo.
  El reporte de rango incluye el índice de las sesiones que agrega.
  · test: `lib/audit/__tests__/paths.test.ts`::"un id path-shaped no compone una ruta fuera
  del audit root" y `commands/__tests__/audit.test.ts`::"una sesión auditada deja log, json
  y md en su propio directorio" con `// Covers: R15, R16`
- [ ] **D2** (R18) — Confirmar que los logs y reportes con el layout viejo se siguen
  leyendo para generar reportes y que ninguna ruta los borra, mueve ni reescribe.
  · test: `commands/__tests__/audit.test.ts`::"los reportes del layout viejo sobreviven a
  una corrida nueva" con `// Covers: R18`

## Trazabilidad

| R | Tareas |
|---|---|
| R1 | A3 |
| R2 | A1 |
| R3 | A2 |
| R4 | A2 |
| R5 | B1, B2, B3, C1 |
| R6 | B1 |
| R7 | B1 |
| R8 | C3 |
| R9 | C2 |
| R10 | C2 |
| R11 | C2 |
| R12 | C3 |
| R13 | C4 |
| R14 | C4 |
| R15 | D1 |
| R16 | D1 |
| R17 | C5 |
| R18 | D2 |
| R19 | C6 |
| R20 | C6 |
| R21 | B4 |
| R22 | B1, B4 |
