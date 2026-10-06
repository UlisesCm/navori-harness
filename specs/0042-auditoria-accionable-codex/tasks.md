# Auditoría accionable con paridad Codex — Tasks

El único tablero de avance es este archivo. Cada lote pasa por implementer y reviewer. Los tests agregan `// Covers: R<n>` junto al caso que demuestra el requisito. Ningún resultado parcial declara paridad completa.

## Lote 1 — Contención y captura

- [x] **T1** (R12) — Preservar plist y reportar fallo cuando launchd no confirma descarga; impedir reemplazo de job activo y éxito falso en CLI. Tests: `launchd.test.ts` y tests del comando global, con controlador falso: bootout fallido, consulta fallida, job ausente, bootstrap fallido y descarga confirmada. Sin servicios reales.
  - Estado: implementado y aprobado por review independiente. Evidencia: reviewer T1 `APPROVED`; gate completo exit 0; receipt fresco sobre `51046a00` el 2026-10-03.
- [x] **T2** (R1, R2, R3, R9) — Propagar host/identidad en activaciones y eventos CLI, validar fuente e identidad y recuperar headers históricos solo con evidencia. Tests: `discovery.test.ts`, `cli-event.test.ts` y fixtures de hooks: Claude/Codex, IDs contradictorios, rollout con host omitido, formato incorrecto, paths inseguros y contexto explícito exacto.
  - Estado: integrado en main. Evidencia: PR #1203, merge commit `c45c535bb9ef0fd56d8ae6bedbc2b6a832963611`.
- [x] **T3** (R6, R7, R8) — Incorporar disponibilidad/procedencia y ventanas de fuentes al reporte, con cobertura temporal por host y roots/children. Tests: `parse.test.ts`, `discovery.test.ts`, `report.test.ts`: ausencia distinta de cero, errores rollout, ventana no nula y denominador desconocido sin porcentaje ficticio.
  - Estado: integrado en main. Evidencia: PR #1217, commit `0a753cfd504410ac00c7993cf30b7ab0cf631f66`.

## Lote 2 — Privacidad

- [x] **T4** (R10, R11) — Crear logs, spools y reportes privados; minimizar payloads y hacer opt-in el contenido humano. Tests: `paths.test.ts`, `cli-event.test.ts`, `report.test.ts` y tests de comandos/hook: umask permisivo, archivos existentes no privados, symlinks y reporte metadata-only. No chmod histórico.
  - Estado: aprobado para privacidad de CLI. Evidencia: suites de paths, eventos CLI, reportes, comandos y hooks; gate completo exit 0, 7,734 pruebas aprobadas y 2 omitidas. T9–T12 siguen abiertos.
- [x] **T5** (R13, R22) — Validar allowlist y límites OTLP, acotar caches/conexiones y cerrar listeners idempotentemente, exponiendo pérdidas/estado. Tests: `collect.test.ts`: contenido rechazado, sobrepresupuesto, TTL/LRU, shutdown repetido y salud sin afirmar fuga por KeepAlive.
  - Estado: integrado en main. Evidencia: PR #1202, merge commit `58957b6e2adcad9aa35ddb2ee156d0ae572e562e`.

## Lote 3 — Usage y velocidad

- [x] **T6** (R4, R5) — Mapear usage Codex numérico y deduplicar respuestas/historia heredada con ownership verificable; conservar semántica Claude. Tests: `parse.test.ts`, `report.test.ts`: response IDs repetidos, acumulados versus deltas, fork/resume, reasoning subset y ownership insuficiente parcial.
  - Estado: aprobado para usage numérico y fork/resume con fixtures fijados a Codex v0.160.0. Evidencia: suites de parse y report; 13 casos de integración, incluidas 2 variantes pre/post-resume; gate completo exit 0, 7,747 pruebas aprobadas y 2 omitidas. No afirma reconciliación universal de exports en vivo; T9–T12 siguen abiertos.
- [x] **T7** (R14, R15) — Corregir población reviewer/gate y distinguir trabajo de hooks de peaje concurrente, con cobertura de herramientas wrappers. Tests: `reviewer-lifecycle.test.ts`, `range-metrics.test.ts`: sesiones sin gates no satisfacen piso, grupos concurrentes y exec no equivale a herramientas internas.
  - Estado: integrado en main. Evidencia: PR #1205, merge commit `d216f9a0862219603f44d78364f60e04198e7db1`.
- [x] **T8** (R21) — Filtrar temprano, indexar fallback una vez y leer entradas incrementalmente con presupuestos/truncamiento explícitos. Tests: `discovery.test.ts`, `parse.test.ts` y benchmark sintético reproducible de RSS/tiempo: rango excluido, archivo grande, límite de línea y exceso de eventos.
  - Estado: aprobado para miners acotados y alineación con main. Evidencia: suites de discovery, parse y miners; gate completo exit 0, 7,750 pruebas aprobadas, 2 omitidas, 361 archivos, piso de cobertura de 118 módulos (1 excepción documentada) y bundle de 1,228,783/1,228,800 bytes. Las mediciones de RSS son muestreadas, no pico continuo; T9–T12 siguen abiertos.

## Lote 4 — Outcomes de trabajo

- [x] **T9** (R16) — Persistir outcomes mínimos de revisión/findings/receipt y unir feature/diff exacto con procedencia y dedup. Tests nuevos de outcomes y tests handoff/receipt: revisión cero findings, diff distinto, receipt stale, ausencia de fuentes y episodios ambiguos. No fetch/check adicional desde reportes.
- [ ] **T10** (R17, R18) — Calcular eficiencia por tarea aceptada y lifecycle/esperas con N/cobertura; censurar abiertas y no repartir usage ambiguo. Tests nuevos de outcomes y `range-metrics.test.ts`: aceptación local mismo diff, rondas incompletas, tareas abiertas, múltiples features y ausencia de ownership.

## Lote 5 — Comparación y cierre

- [ ] **T11** (R19, R20) — Snapshots con cohortes/disponibilidad y preflight por métrica; recomendaciones con evidencia/impacto separado de hipótesis. Tests: `snapshot.test.ts`, `signals.test.ts`: snapshots legacy desconocidos, cohortes incompatibles, ventanas solapadas y muestras insuficientes sin mejora causal.
- [ ] **T12** (R1–R22) — Verificar trazabilidad completa, regresión Claude/Codex y gate completo; documentar contratos/versionado y límites observados sin prometer mediciones aún no capturables. Tests: conjunto de casos anteriores; receipt fresco sobre el diff que se entrega.

## Evidencia inicial

Baseline sin cambios de fuente: gate completo verde el 2026-10-03, 349 archivos de test, 6964 tests aprobados y uno omitido; piso de cobertura intacto, bundle 1099.8 KB. Esto no verifica cambios nuevos.
