# Eventos OTel como tercera fuente de `navori audit` — Tasks

## Lote 1 — el receptor

- [ ] **T1** (R1, R2, R4, R5) — Escribir `lib/audit/collect.ts`: servidor `node:http` ligado a
  `127.0.0.1`, ruta `POST /v1/logs`, que aplana el sobre OTLP
  (`resourceLogs → scopeLogs → logRecords`, atributos como pares `{key,value}`) y escribe una
  línea JSON por evento en `otelLogPath(repo, sessionId)` con `appendFileSync`. Agregar
  `otelLogPath` a `lib/audit/paths.ts` con la misma validación de id que `sessionLogPath`.
  Cablear `--collect` en `commands/audit.ts`: imprime dirección, directorio de salida y el
  bloque `export` del contrato; ante `EADDRINUSE` termina con código distinto de 0 nombrando la
  dirección y sin tocar disco. · tests: `collect.test.ts`::`recibe un lote OTLP por HTTP y
  escribe una línea por evento` y `collect.test.ts`::`falla sin crear archivos cuando la
  dirección está ocupada`, ambos con `// Covers: R1, R2, R4, R5` — el primero levantando el
  receptor en puerto efímero y hablándole con `fetch`, no llamando al handler.

- [ ] **T2** (R3, R6) — Aplicar la allowlist al aplanado: de cada registro se persisten `ts`,
  `event` (nombre del host sin el prefijo `claude_code.`), `sessionId`, y por tipo —
  `toolName`/`decision`/`source` para `tool_decision`, `skillName`/`agentName`/`model` para
  `api_request`. Campos ausentes se omiten, nunca se escriben vacíos. Un cuerpo que no se puede
  interpretar responde 200, no escribe nada y suma al contador de descartes que la salida del
  receptor reporta. · tests: `collect.test.ts`::`descarta un cuerpo que no es OTLP y responde
  200` (dos casos: texto no-JSON y JSON válido sin forma OTLP) y `collect.test.ts`::`no
  persiste el texto del prompt aunque el emisor lo mande` con `// Covers: R3, R6`.

- [ ] **T3** (R7) — Test estructural que recorre `packages/cli/src` y los assets enviados y
  exige que ninguna ruta fuera de `lib/audit/collect.ts` abra un puerto de escucha. Debe fallar
  nombrando el archivo infractor. Es el invariante 9 en forma ejecutable: sin este test,
  "navori no levanta procesos" es una promesa que el siguiente PR puede romper en silencio. ·
  test: `collect.test.ts`::`solo el receptor escucha en un puerto` con `// Covers: R7`.

## Lote 2 — la ingesta

- [ ] **T4** (R8, R9) — Escribir `lib/audit/otel.ts`: lee el JSONL de eventos de una sesión con
  la misma tolerancia que `readJsonl` (cuenta líneas malformadas, no lanza) y lo une a la
  `SessionAudit` por igualdad de `session.id`. Agregar al modelo `otelEventsFrom: string | null`
  — la ruta del archivo leído, o `null` cuando no hubo — y que `report.ts` renderee esa ausencia
  como una línea explícita. Sin archivo, el reporte sale idéntico al de hoy más esa línea. ·
  tests: `otel.test.ts`::`une los eventos a la sesión por session.id` y `otel.test.ts`::`genera
  el reporte y declara la ausencia cuando no hay archivo de eventos` con `// Covers: R8, R9`.

## Lote 3 — los dos puntos ciegos

- [ ] **T5** (R10) — Agregar `PermissionDecisions` al modelo y contar los eventos
  `tool_decision` por `source`, separando los humanos (`user_permanent`, `user_temporary`,
  `user_reject`, `user_abort`) de los automáticos (`config`, `hook`). Renderearlo en el reporte
  y **retirar de `parse.ts` la nota que declara indetectables las aprobaciones manuales** cuando
  la tercera fuente está presente — dejándola en pie cuando falta, porque ahí sigue siendo
  cierta. · test: `otel.test.ts`::`separa la aprobación humana de la automática` con
  `// Covers: R10`.

- [ ] **T6** (R11, R12) — Agregar la variante `host` a `SkillSource`, hacerla ganar sobre
  `skill-tool` y `skill-md` al resolver la procedencia de una skill, y poblarla desde el
  atributo `skill.name` de los eventos `api_request`, atribuida al agente que nombra
  `agent.name`. El reporte debe mostrar las tres procedencias distintas. Sin tercera fuente, la
  detección heurística queda intacta. · tests: `otel.test.ts`::`la skill declarada por el host
  gana a la inferida del transcript` y `otel.test.ts`::`sin eventos, la heurística de skills no
  cambia` con `// Covers: R11, R12`.
