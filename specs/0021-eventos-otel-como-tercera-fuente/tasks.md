# Eventos OTel como tercera fuente de `navori audit` — Tasks

## Lote 1 — el receptor

- [x] **T1** (R1, R2, R6, R7) — Escribir `lib/audit/collect.ts`: servidor `node:http` ligado a
  `127.0.0.1`, ruta `POST /v1/logs`, que aplana el sobre OTLP
  (`resourceLogs → scopeLogs → logRecords`, atributos como pares `{key,value}`) y escribe una línea
  JSON por evento con `appendFileSync` en el log de la sesión que el evento nombra en `session.id`.
  El log se localiza escaneando los directorios del store por `session-<id>.log`, cacheando el
  resultado por id. Cablear `--collect` en `commands/audit.ts`: imprime dirección, store de salida y
  el bloque de entorno del contrato; ante `EADDRINUSE` termina con código distinto de 0 nombrando la
  dirección y sin tocar disco. · tests: `collect.test.ts`::`escribe cada evento del lote en el log
  de su sesión` (levantando el receptor en puerto efímero y hablándole con `fetch`, no llamando al
  handler) y `collect.test.ts`::`falla sin crear archivos cuando la dirección está ocupada`, ambos
  con `// Covers: R1, R2, R6, R7`.

- [x] **T2** (R3, R4) — El receptor descarta el evento cuando la sesión que nombra no tiene log, y
  **no lo crea**: crearlo volvería a la tercera fuente un activador de audit-mode por la puerta de
  atrás. La primera vez que escribe en el log de una sesión, antepone un registro
  `{"event":"otel-start"}` con la dirección en la que escucha. · tests: `collect.test.ts`::`no crea
  el log de una sesión que nadie marcó` (afirma que el archivo sigue sin existir después de la
  petición) y `collect.test.ts`::`marca su horizonte la primera vez que escribe en una sesión` con
  `// Covers: R3, R4`.

- [x] **T3** (R5, R8) — Allowlist en el aplanado: se persisten `ts`, `tsMs`, `event` (nombre del host
  sin el prefijo `claude_code.`), y por tipo — `tool`/`decision`/`source` para `tool_decision`,
  `skill`/`agent`/`model` para `api_request`. `api_request` sin `skill.name` se descarta entero: ese
  evento dispara en cada request y guardarlo sería volumen sin lector. Campos ausentes se omiten,
  nunca se escriben vacíos. Un cuerpo que no se puede interpretar responde 200, no escribe nada y
  suma al contador de descartes que la salida del receptor reporta. · tests: `collect.test.ts`::
  `descarta un cuerpo que no es OTLP y responde 200` (dos casos: texto no-JSON y JSON válido sin
  forma OTLP) y `collect.test.ts`::`no persiste el texto del prompt aunque el emisor lo mande` con
  `// Covers: R5, R8`.

## Lote 2 — el invariante y la configuración

- [x] **T4** (R9) — Test estructural que recorre `packages/cli/src` y los assets enviados y exige que
  ninguna ruta fuera de `lib/audit/collect.ts` abra un puerto de escucha. Debe fallar nombrando el
  archivo infractor. Sin este test, "navori no levanta procesos" es una promesa que el siguiente PR
  puede romper en silencio. · test: `collect.test.ts`::`solo el receptor escucha en un puerto` con
  `// Covers: R9`.

- [x] **T5** (R10, R11) — Emitir el bloque de entorno del contrato en el fragmento de `settings.json`
  únicamente cuando el repo declara `audit.mode: always`, sin habilitar métricas ni cuerpos crudos.
  En cualquier otro modo, no emitir nada. Actualizar los golden snapshots de render. · tests:
  `render-engine.test.ts`::`emite el entorno OTel con audit.mode always` y `render-engine.test.ts`::
  `no emite el entorno OTel en audit.mode opt-in` con `// Covers: R10, R11`.

## Lote 3 — los dos puntos ciegos

- [x] **T6** (R12) — Reconocer el evento `tool_decision` en el lector del log de sesión, agregar
  `PermissionDecisions` al modelo y contarlas por `source`, separando las humanas
  (`user_permanent`, `user_temporary`, `user_reject`, `user_abort`) de las automáticas (`config`,
  `hook`). Renderearlo en el reporte y **retirar de `parse.ts` la nota que declara indetectables las
  aprobaciones manuales** cuando la marca de R4 está presente, dejándola en pie cuando falta —
  porque ahí sigue siendo cierta. · test: `parse.test.ts`::`separa la aprobación humana de la
  automática` con `// Covers: R12`.

- [x] **T7** (R13, R14) — Reconocer el evento `api_request`, agregar la variante `host` a
  `SkillSource`, hacerla ganar sobre `skill-tool` y `skill-md` al resolver la procedencia de una
  skill, y atribuirla al agente que nombra el campo `agent`. Agregar `otelFrom` al modelo desde la
  marca de R4 y que el reporte declare la ausencia cuando no está. Sin marca, la detección
  heurística queda intacta. · tests: `parse.test.ts`::`la skill declarada por el host gana a la
  inferida del transcript` y `parse.test.ts`::`sin marca de tercera fuente, la heurística de skills
  no cambia y el reporte declara la ausencia` con `// Covers: R13, R14`.

- [x] **T8** (R2, R12, R13) — Test de integración del orden mezclado: un log que intercala eventos de
  hook y eventos OTel con `tsMs` desordenado respecto al orden de archivo, afirmando que el reporte
  los presenta en orden real. Es lo que verifica que escribir en el mismo archivo —en vez de un
  sidecar— se sostiene, y depende del `chronological()` que entró en #689. · test:
  `parse.test.ts`::`ordena eventos de hook y de OTel en un mismo log` con `// Covers: R2, R12, R13`.
