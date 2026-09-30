# Aprendizajes del curso de harness engineering — Tasks

Lotes en orden de prioridad (calidad > tokens > velocidad). Cada lote cierra con
`qualityGate.full` (`bun check`) verde y un review `APPROVED`. Anclas y decisiones en
[design.md](design.md); cada test lleva `// Covers: R<n>`.

## Lote 1 — G: `plan update` exige evidencia (CLI)

- [ ] **T1** (R2, R3, R4, R6) — `WorkplanSchema.evidence` opcional; `lib/plan/evidence.ts` lee
  `workplan_<feature>.evidence.jsonl`, valida árbol, `HEAD`, huella y `cwd` (design.md § D1, D2);
  `updateSubCommand` acepta `cumplido` solo con evidencia válida y, si falta, rechaza sin escribir
  con ERROR / WHY / FIX que muestra el comando exacto. Ningún camino ejecuta el `command`.
  · test: `lib/plan/__tests__/evidence.test.ts` (huella estable ante el log, sensible a edits y
  archivos nuevos) y `commands/__tests__/plan.test.ts` (worktree ajeno, `HEAD` movido, `command`
  editado, subdirectorio → rechazo con JSON byte-idéntico; caso válido → escrito; centinela
  `touch` nunca creado) con `// Covers: R2, R3, R4`.
- [ ] **T2** (R6) — `renderAcceptance` y `checkWorkplan` distinguen los cuatro casos de D4;
  `CheckResult.warnings` aditivo, `ok` intacto. · test: `lib/plan/__tests__/check.test.ts`,
  `render.test.ts` y `plan-gate.test.ts` (sin evidencia sigue `allow`) con `// Covers: R6`.
- [ ] **T3** (R5) — Regla de engine de D3: con `CLAUDE_CODE_CHILD_SESSION=1` y `claude` en
  `config.engines` se exige evidencia; en otro caso se escribe `{kind:"unevidenced"}` con
  WARNING. Control `acceptance-evidence` en `CONTROL_DEFINITIONS` / `ENGINE_CAPABILITIES`
  (Claude `advisory`, Codex y prosa `unsupported`). · test: `commands/__tests__/plan.test.ts`
  con y sin la variable; `engines/__tests__/control-inventory.test.ts` y `scanControlGaps` lo
  listan para Codex, con `// Covers: R5`.

## Lote 2 — G: el hook registra la evidencia

- [ ] **T4** (R1, R4) — `lib/plan/acceptance-index.ts` se reescribe en `writeWorkplanAndRender`;
  `core-assets/hooks/bash-outcome-watch.sh`, carril de evidencia, en `PostToolUse(Bash)`
  (coincidencia exacta con el índice; anexa a `workplan_<feature>.evidence.jsonl`); registro en
  `build-settings.ts` y fila en `harness-plan.ts`; presupuesto de latencia de D7. · test:
  `lib/__tests__/bash-outcome-watch.test.ts` (comando exacto → línea; espacio extra,
  `interrupted` o `PostToolUseFailure` → nada; payload con `touch` → centinela ausente; shims de
  PATH: la ruta rápida no lanza procesos) con `// Covers: R1, R4`; diff revisado de `claude.snap`.
- [ ] **T5** (R1, R2, R6b) — Prosa: `plan-simple.md`, `plan-advanced.md` e `implementer.md`
  (encargo `workplan:`) piden correr cada `A<n>` textual desde la raíz del árbol y luego
  `plan update`; `reviewer.md` Pass 1 (bullet `planTiers`) corre `navori plan check <feature>
  --json` y reporta cada `cumplido` sin evidencia. `maxWords` = conteo medido + 10 (D9).
  · test: `lib/__tests__/agents-assets.test.ts` y `skills-assets.test.ts` (presencia de las
  instrucciones y tope) con `// Covers: R1, R2, R6b`.

## Lote 3 — V y P: reviewer adversarial y captura de hallazgos

- [ ] **T6** (R11, R12, R13) — `ImplHandoffSchema.doubts` opcional; `implementer.md`
  `Closing report` con `doubts`; `reviewer.md` lee `impl_<feature>.json`, responde cada duda y
  agrega la tabla `Coverage` en `APPROVED`. `maxWords` medido + 10. · test:
  `lib/handoff/__tests__/check.test.ts` (con y sin `doubts`, mal formado falla) y
  `agents-assets.test.ts` (secciones `Implementer doubts` y `Coverage`) con
  `// Covers: R11, R12, R13`.
- [ ] **T7** (R14) — `lib/handoff/review-schema.ts`; subcomando `navori handoff log-review`
  que anexa hallazgos ≥ 50 a `findings.jsonl` con dedupe por hash; allow
  `Bash(navori handoff log-review:*)` en `settings-base.json`; `reviewer.md` escribe el sidecar y
  lo registra. · test: `commands/__tests__/handoff.test.ts` (anexa ≥ 50, ignora < 50,
  idempotente, categoría inválida falla) y entrada allow en `claude.snap` con `// Covers: R14`.

## Lote 4 — U: uso agregado

- [ ] **T8** (R16, R17) — `tallyAgents` por sesión con ceros declarados; `DeclaredAgent.managed`;
  `agentRangeSection`; línea de candidatos managed sin uso con N sesiones en ambas secciones de
  rango. · test: `lib/audit/__tests__/report.test.ts` (agente declarado sin uso aparece con 0 y
  como candidato con N; uno propio no se marca) con `// Covers: R16, R17`.

## Lote 5 — S: detección de atasco

Precondición: capturar un payload live de `PostToolUseFailure` en un repo scratch (U1). Si
`error` no trae la salida del comando, T9 y T10 se difieren según requirements.md § S.

- [ ] **T9** (R7, R8, R9) — Carril de atasco en `bash-outcome-watch.sh` sobre
  `PostToolUseFailure(Bash)`: clave comando + hash de `cwd` + `agent_id`, firma normalizada, aviso
  aditivo único al tercer fallo, estado por sesión con tope de 50 líneas, fail-open (D6).
  · test: `lib/__tests__/bash-outcome-watch.test.ts` (fixture del ejemplo oficial; 3 fallos misma
  firma → 1 aviso; timestamps/tmp distintos → misma firma; otro `agent_id` o `cwd` → contador
  aparte; éxito intermedio reinicia; `is_interrupt` no cuenta; 51 claves → 50 líneas; symlink,
  FS de solo lectura o payload corrupto → exit 0 sin stdout) con `// Covers: R7, R8, R9`.
- [ ] **T10** (R10) — Fila `unsupported` al final de `CODEX_HOOK_REGISTRATIONS` y control
  `repeat-failure-advice` (Claude `advisory`, Codex y prosa `unsupported`). · test:
  `control-inventory.test.ts`, pinned-hash de `render-codex.test.ts` sin cambio y diff revisado de
  `codex.snap` con `// Covers: R10`.

## Trazabilidad

| R | Tareas |
|---|---|
| R1 | T4, T5 |
| R2 | T1, T5 |
| R3 | T1 |
| R4 | T1, T4 |
| R5 | T3 |
| R6 | T1, T2 |
| R6b | T5 |
| R7, R8, R9 | T9 |
| R10 | T10 |
| R11, R12, R13 | T6 |
| R14 | T7 |
| R15 | diferido (design.md § NOT in scope) |
| R16, R17 | T8 |
