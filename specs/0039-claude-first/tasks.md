# Claude first — Tasks

Una fase por PR (o dos, donde [design.md](design.md) § Fases lo indica), en el orden de
dependencias de esa tabla. Cada lote cierra con `qualityGate.full` (`bun check`) verde y un review
`APPROVED`. Cada test lleva `// Covers: R<n>`. Toda fase que agrega una unidad distribuida agrega
en el mismo PR su fila de la matriz (D2) y el nombre de su mecanismo en `mechanismSection` (R70).
Las tareas marcadas *carry-over* aplican la tarea citada de
[0038 tasks.md](../0038-aprendizajes-curso-harness/tasks.md) con los R-ids renumerados.

**Decisiones del usuario (2026-09-30)** sobre las open questions de design.md:
- R41: `maxTurns: 160`, que se recalcula si T2 muestra otra unidad de conteo.
- D6: el guard corre como carril del plugin tgrep dentro de `guard-destructive.sh`.
- Pre-registros confirmados: R34 (≥ 15% de la mediana de contexto con corrección ≥ la textual),
  R43 (−10% por lanzamiento con n ≥ 100) y el disparador de reversión de R41.
- Supuestos que siguen el design: R58 cuenta `master close` en sus tres formas; el default de R44
  sale de la instantánea de T9 (hoy 150,000 según T9).

## F0a — Verificación

- [x] **T1** (R3, R34, R43) — `docs/research/claude-first-verificacion.md`: cada capacidad de
  [evidence.md](evidence.md) con URL oficial, fecha, versión de CC y cita; las filas sin
  verificar quedan `complementa`. Pre-registro de R34, R43 (con la banda de ruido entre dos
  ventanas base, m10) y del disparador de R41, en un commit anterior a cualquier medición.
  · test: artefacto; `bun run check:links` verde.
- [ ] **T2** (R17) — Sondas live en un repo scratch, **con autorización del usuario**: payload de
  `PostToolUseFailure`; forma de la marca parcial y unidad de conteo de `maxTurns` (agente con
  `maxTurns: 3`); `effort` en `Stop`; `CLAUDE_CODE_SESSION_ID` en Bash; `Agent(<nombre>)` como
  `if` y `ask` dentro de un subagente; flags de `tgrep search`/`status` y de `codegraph status`;
  registro de compactación en el transcript. Capturas redactadas como fixtures. Resultado en T1.
  **Gate:** si `error` no trae la salida del comando, T23 y T24 se difieren (R17).

## F0b — Medición

Lote 1:

- [x] **T3** (R48, R49, R64, R65, R71) — `lib/audit/parse.ts` y `model.ts`: `AgentRun` con
  `turns` (dedupe por `message.id`), `turnLimitHit`, `toolResultBytes`, `contextPeak`,
  `compactions`; `schemaVersion: 10`, `rangeMetrics`, `byAgentType[*].sessions`, fila
  `main-thread`, web por agente; sesión Codex con `null` y `unavailable: "transcript"`.
  · test: `lib/audit/__tests__/range-metrics.test.ts` con fixtures (sesión Codex incluida) con
  `// Covers: R48, R49, R64, R65, R71`.
  · nota: `turnLimitHit` y `compactions` detectan formas de transcript no verificadas
  (`error_max_turns`/`max_turns`, `compact_boundary`/`isCompactSummary`); T2 las confirma. Ninguna
  escritura marca aún `host: "codex"` en el `start` del log de audit, así que las sesiones Codex
  reales siguen como huérfanas hasta que un hook de sesión Codex llame `--host codex` (ver T8).
- [x] **T4** (R46, R47, R63, R66, R70) — `lib/audit/report.ts`: `agentRangeSection` con ceros,
  candidatos managed sin uso con N sesiones, hooks por rango (`hooks.perBashCall` por
  `toolUseId`), bloqueos por regla con ≤ 3 ejemplos truncados a 160 y redactados, y el **marco**
  `mechanismSection` (`name × verdict` de hooks y eventos CLI, nombres fixture).
  · test: `lib/audit/__tests__/report.test.ts` con `// Covers: R46, R47, R63, R66, R70`.

Lote 2:

- [x] **T5** (R61, R62) — `lib/audit/discovery.ts`: todos los repos de `~/.navori/audits/` con
  fila por repo; denominador de cobertura con el slug del repo más sus `--claude-worktrees-*`;
  colisión de basenames como advertencia. · test: `lib/audit/__tests__/discovery.test.ts` con
  `// Covers: R61, R62`.
- [x] **T6** (R68, R69) — `lib/audit/snapshot.ts` y `commands/audit.ts` (`--all-repos`,
  `--snapshot`, `--copy-to`, `--compare`) según D10. · test: `snapshot.test.ts` (bajo la raíz de
  audit por defecto; `--copy-to` existente → error; `--all-repos` con ruta dentro de un repo →
  error; sin texto de comando ni basename de repo; métrica faltante → `n/a`) con
  `// Covers: R68, R69`.
- [x] **T7** (R67) — Ports de `mine-search-routing.py` y `mine-activation.py` a
  `lib/audit/signals.ts`; activación junto al % de ediciones del hilo principal. Los scripts
  Python se borran en el mismo PR al pasar la paridad. · test: `routing-parity.test.ts` contra las
  cifras fijadas de los scripts con `// Covers: R67`. · nota: mine-activation.py se conserva hasta portar su fase 2 (plan tiers, spec 0032 R32), la tabla por sesión y los ejemplos

Lote 3:

- [x] **T8** (R55, R70) — `lib/audit/cli-event.ts`: `appendCliEvent(cwd, { name, verdict })` al
  log de la sesión de `CLAUDE_CODE_SESSION_ID`; sin variable o sin log, no escribe (fail-open). Además, el `start` del log de audit registra `host` (`claude`/`codex`) para que R71 reconozca sesiones Codex reales.
  · test: `lib/audit/__tests__/cli-event.test.ts` con `// Covers: R55, R70`.
  · nota: el writer de `host` es `navori audit --start <id> --host claude|codex`; ningún caller pasa `--host codex` todavía (no existe hook de inicio de sesión Codex), así que R71 queda listo del lado del lector pero sin sesiones Codex marcadas en la práctica.
- [x] **T9** (R43) — Instantánea base `navori audit --snapshot claude-first-base`: cache read
  mediano por sesión y por lanzamiento de `implementer`, `hooks.perBashCall` y tamaños de
  resultado de R33, cada uno con su n. Cifras y default de R44 (mediana del pico redondeada a 25k)
  en el doc de T1. · test: `snapshot.test.ts` verifica que la instantánea trae las tres métricas de
  R43 con n, con `// Covers: R43`. · nota: cifras en "Línea base (T9)" de `docs/research/claude-first-verificacion.md`; el default de R44 pasa de 175,000 a 150,000.

## F1 — Matriz

Lote 1:

- [x] **T10** (R2, R3, R57) — `engines/shared/native-overlap.ts`: `OVERLAP_ROWS` (agentes,
  skills, hooks, bloques managed, plugins y los flujos de R57), `OverlapRowSchema.superRefine` de
  D2. · test: `engines/shared/__tests__/native-overlap.test.ts` (refine sobre todas las filas;
  exactamente una fila por unidad del roster, plan, managed, plugins y flujos) con
  `// Covers: R2, R3, R57`.
- [x] **T11** (R4) — `filterInventory` y `nativeEmissionsFor`; `buildClaudeSettings(config,
  inventory)` registra solo desde el inventario filtrado (B1); mismo filtro en `global-plugin.ts`
  y en la resolución de `engines/codex/hook-registrations.ts`. · test:
  `render-native-overlap.test.ts` con una fila fixture `native` (ausente del plan y de
  `settings.json` en Claude, presente en Codex y agents-md) con `// Covers: R4`.
  · nota: `buildClaudeSettings` conserva la firma dual `FilteredInventory | LoadedPlugin[]` por ~60 llamadas de test sin migrar.
  · nota: Codex no filtra al escribir archivos (solo `resolveCodexHooks`); sin efecto mientras no haya filas nativas en Codex.
  · nota: ids de hooks, bloques managed y plugins van hardcodeados en la matriz, vigilados por el test de cobertura de `native-overlap.test.ts`.

Lote 2:

- [x] **T12** (R5) — §8.7e en `engines/claude/index.ts`; `isRemovableNavoriFile(…,
  { requirePristine })`; `removeManagedSectionGuarded` en `lib/render/marker.ts`;
  `reportKeptRetired` con `newer` y `modified` (D3). · test: mismo archivo que T11 (versión mayor,
  hash distinto, texto fuera del marcador y ruta en `pending` → se conserva; backup existe) y
  `removal-parity.test.ts` sin vías nuevas, con `// Covers: R5`.
  · nota: un bloque dentro de `CLAUDE.md` solo se poda en corridas donde ese archivo no se reescribe.
- [x] **T13** (R1, R2) — `docs/native-overlap.md` generada con URL y fecha por fila, fijada por
  golden; párrafo "Claude primero, nativo primero" en `docs/DIRECTION.md` § `Criterio de admisión
  por superficie`. · test: `direction-claude-first.test.ts` y golden de la doc con
  `// Covers: R1, R2`.

## F2 — Hooks

Lote 1:

- [x] **T14** (R23, R24) — `guard-destructive.sh` regla 3 (`rm_kill`): variable como destino
  exige `-r`, `-R` o `--recursive`. · test: `guard-destructive.test.ts` con los casos de design.md
  § Testing strategy (incluida la frontera `rm -f "$X"/*`, m3) con `// Covers: R23, R24`.
- [x] **T15** (R25, R26) — `plan-gate.sh` con `# navori:include audit-log` y trap de veredicto;
  `subagent-stop-handoff.sh` con stamp por (ruta, hash). · test:
  `hook-audit-instrumentation.test.ts` con `plan-gate`; mismo handoff dos veces → 1 aviso;
  contenido cambiado → aviso, con `// Covers: R25, R26`.

Lote 2:

- [x] **T16** (R27) — `model-advisor.sh` en modo `claude-stop`, registrado en `Stop`;
  `host-contracts.ts` (`claude-model-advisor-payload`) y JSDoc de `MAIN_THREAD_ONLY_HOOKS`.
  · test: `model-advisor.test.ts` (`effort.level: high` en Opus → 1 aviso; sin campo y con
  `CLAUDE_EFFORT=high` → 1 aviso) con `// Covers: R27`.
- [x] **T17** (R28) — `lib/__tests__/hooks-per-bash.test.ts`: cuenta `B_pre`/`B_post` por camino
  sobre dos fixtures (default con tgrep y coexist) evaluando cada `if`. Fija la cuenta de
  después de T16; T21, T23 y T28 actualizan lo esperado según D5. · test: el propio, con
  `// Covers: R28`.

## F3 — Evidencia y atasco

Lote 1 (carry-over 0038 Lote 1):

- [x] **T18** (R7, R8, R9) — *carry-over 0038 T1*: `WorkplanSchema.evidence`,
  `lib/plan/evidence.ts` y rechazo ERROR / WHY / FIX de `updateSubCommand`, sin ejecutar el
  `command`. El WHY "no run recorded" trae un FIX que menciona repos grandes (D5).
  · nota: la huella no usa `git add`; cada llamada a git lleva `-c core.fsmonitor=false -c core.hooksPath=/dev/null` para que `plan update` nunca ejecute código configurado en el repo. Archivos de `ls-files --cached --others --exclude-standard`, excluyendo `.navori/state`, `.claude/progress`, `.codex/progress` y `.claude/worktrees`; blobs con `hash-object --no-filters` (modo 100755 si hay algún bit de ejecución, si no 100644; symlink = hash del destino con modo 120000; gitlinks y directorios se omiten); índice scratch `.git/navori-fp-index` con `read-tree --empty` + `update-index --index-info -z` + `write-tree`. T21 debe reutilizar el mismo helper (`fingerprintTree` en `lib/plan/evidence.ts`).
- [x] **T19** (R11) — *carry-over 0038 T2*: `renderAcceptance` y `checkWorkplan` distinguen con y
  sin evidencia; `CheckResult.warnings` aditivo, `ok` intacto.
- [x] **T20** (R10) — *carry-over 0038 T3*: regla de engine con `CLAUDE_CODE_CHILD_SESSION`;
  control `acceptance-evidence` (Claude `advisory`, Codex y prosa `unsupported`).

Lote 2:

- [x] **T21** (R6, R7) — *carry-over 0038 T4 con D5*: `lib/plan/acceptance-index.ts` reescrito en
  `writeWorkplanAndRender`; `_partials/bash-outcome.sh`; carril de éxito en `routing-watch.sh`
  justo después de confirmar `Bash` (M3), solo con `claude-post-tool-use`, sin
  `run_in_background`, una línea con un solo `printf >>`; `timeout` de 10 a 30. Sin hook nuevo en
  `PostToolUse`. · test: `routing-watch.test.ts` (comando exacto → línea; sesión `#delegated` →
  registra; `run_in_background` → no; sin argumento → no; kill simulado → sin línea parcial;
  centinela `touch` ausente; shims de PATH en la ruta rápida) con `// Covers: R6, R7`; T17
  actualizado.
  · nota: el PR de F3 lote 1 queda en draft hasta que T21 entre: sin el hook, `plan update` rechaza `cumplido` en Claude.
  · nota (implementación): `acceptance-index` escanea los directorios de estado neutral, legacy y explícitos, y se escribe en el neutral; el hook compara contra el valor JSON exacto del comando; la huella del árbol se porta a shell (`_partials/bash-outcome.sh`) y difiere de `fingerprintTree` solo en la prueba del bit de ejecución (`[ -x ]` vs `mode & 0o111`); el registro de `routing-watch` ahora pasa `claude-post-tool-use` y `timeout` 30; los conteos de `hooks-per-bash` no cambian (`bPost` sigue en 2).
- [x] **T22** (R6, R12) — *carry-over 0038 T5*: prosa de `plan-simple.md`, `plan-advanced.md`,
  `implementer.md` y `reviewer.md` Pass 1 (`plan check --json`, cada `cumplido` sin evidencia es
  hallazgo). El tope `maxWords` final lo fija T27.

Lote 3 (sujeto al gate de T2):

- [ ] **T23** (R13, R14, R15) — *carry-over 0038 T9*: `bash-outcome-watch.sh` solo en
  `PostToolUseFailure(Bash)`; el reset en éxito va en el carril de T21. · test:
  `bash-outcome-watch.test.ts` con la fixture live de T2 con `// Covers: R13, R14, R15`; T17
  actualizado (fallo = base).
- [ ] **T24** (R16, R70) — *carry-over 0038 T10*: fila `unsupported` en
  `CODEX_HOOK_REGISTRATIONS` y control `repeat-failure-advice`; nombres de evidencia, rechazo y
  atasco en `mechanismSection`. · test: `control-inventory.test.ts`, pinned-hash de Codex sin
  cambio y fixture de mecanismos con `// Covers: R16, R70`. Incluye el evento CLI de cada rechazo de `plan update`.

## F4 — Reviewer

- [x] **T25** (R18, R19, R20) — *carry-over 0038 T6*: `ImplHandoffSchema.doubts`, `Closing
  report` del implementer y sección `Coverage` del reviewer.
- [x] **T26** (R21) — *carry-over 0038 T7*: `lib/handoff/review-schema.ts`, `navori handoff
  log-review` con dedupe por hash y allow en `settings-base.json`.
- [x] **T27** (R22) — `maxWords` de `reviewer` e `implementer` = conteo medido tras T22 y T25
  + 10. · test: `agents-assets.test.ts` con `// Covers: R22`.

## F5a — Guard de búsqueda

- [ ] **T28** (R29, R30, R31) — `packages/plugins/tgrep/scripts/guard-search-routing.sh`
  restaurado de `7c6930dc^` con los cambios de D6 (remedio `tgrep search -n`, `--no-index` con
  el servidor apagado, `fail-open`, ROOT fuera del repo, `rg --files`/`--version`/`--help`, sin
  `git grep`, sin codegraph); `plugin.json` `scripts` + `hookExtensions`; `lib/config/plugins.ts`;
  sub-bloque managed en `# navori:user-section` de `guard-destructive.sh`, que sale con
  `removeSubBlock` al deshabilitar tgrep. · test: suite portada más los casos de design.md §
  Testing strategy (error de sintaxis → pasa y la suite destructiva sigue verde) con
  `// Covers: R29, R30, R31`.
- [ ] **T29** (R28, R70) — T17 con el camino bloqueado ≤ base − 1; nombre del mecanismo de
  redirección; diff revisado de `claude.snap`. · test: `hooks-per-bash.test.ts` con
  `// Covers: R28, R70`.

## F5b — codegraph

- [x] **T30** (R32) — `lib/diagnose/codegraph-wiring.ts` en `navori doctor` (índice fresco,
  agentes con grant, regla `projectPath`) y señal `codegraph-projectpath-mismatch` sobre R64.
  · test: `codegraph-wiring.test.ts` con `// Covers: R32`.
  · nota: la señal está expuesta como métricas en `navori audit` (`codegraph.calls`, `codegraph.projectpath.mismatch` via `extraMetrics`), no en `report.signals` porque los transcript miners corren fuera de `buildReport`.
- [ ] **T31** (R33, R34) — Medición con `claude -p`, **con autorización del usuario** (costo):
  ≥ 12 tareas, brazos textual, `maxFiles: 4` y `maxFiles: 12`, métricas de `navori audit`.
  Resultado en `docs/research/codegraph-costo-neto.md`, cuyo commit es posterior al del
  pre-registro de T1.
- [ ] **T32** (R35, R38) — Veredicto como fila de la matriz con `evaluation.evidence` hacia T31;
  si es `quitar-del-default`, codegraph pasa a plugin opt-in. · test: refine de T10 con
  `// Covers: R35`.

## F6 — Agentes

- [x] **T33** (R36, R37) — `architect.md` con `Agent(scout, scribe)`; split de `tools:` que
  respeta paréntesis en `rewriteAgentTools` y `mergeFrontmatter`; fila de despacho anidado;
  fallback en `orquestacion.md`. · test: `frontmatter-merge.test.ts` (ida y vuelta sin
  reescritura) y `agents-assets.test.ts` con `// Covers: R36, R37`.
- [ ] **T34** (R38, R39) — `scout` con `WebFetch, WebSearch`; acceso del `architect` a tgrep y
  codegraph según T32; nota en la skill local `author-agent`. · test: `agents-assets.test.ts`
  con `// Covers: R38, R39`.
- [ ] **T35** (R40, R70) — `general-purpose-confirm.sh` calcado de `pr-publisher-confirm`,
  `PreToolUse` `Agent` con `if: Agent(general-purpose)` y `ask` con razón; control y mecanismo.
  · test: hook (`general-purpose` → `ask`; `scout` → nada) y `claude.snap` con `if`, con
  `// Covers: R40, R70`.

## F7 — Tokens

- [x] **T36** (R41) — `implementer.md` con `maxTurns: 160`; Codex no emite la clave porque
  `buildAgentToml` arma el TOML con una lista explícita de claves. · test: frontmatter Claude con el valor, agente Codex sin la clave, con
  `// Covers: R41`.
- [ ] **T37** (R42) — Carril de parcial en `subagent-stop-handoff.sh` con la fixture de T2; sin
  fallback por `impl_*.json` ausente (M6); doctrina `SendMessage` en `orquestacion.md`. · test:
  fixture → aviso; handoff ausente sin marca → sin aviso, con `// Covers: R42`.
- [ ] **T38** (R44, R70) — Carril de compactación (modo Claude, hilo principal, despacho de
  `publisher`, última línea completa con `usage` en la cola de 256 KB);
  `harness.compactAdviceTokens` en `lib/config/schema.ts`; control `compact-advice`. · test:
  casos de design.md § Testing strategy y `schema.test.ts` con `// Covers: R44, R70`.

## F8 — Memoria

- [ ] **T39** (R50) — `docs/research/engram-vs-memoria-nativa.md` con las cinco comparaciones y
  evidencia de sesiones reales (solo lectura).
- [ ] **T40** (R51) — Fila de engram en la matriz con su veredicto. · test: refine de T10 con
  `// Covers: R51`.

## F9 — Master plan

- [x] **T41** (R52, R53, R54) — `status --json` vacío con exit 0; `closeBlockers` extraído de
  `runMasterClose` y reusado; `runMasterInit` escribe `STATUS.md`; `sin parte activa`. · test:
  `lib/master/__tests__/status.test.ts` con `// Covers: R52, R53, R54`.
  · nota: `STATUS.md` sigue escribiendo 'Parte activa: ninguna'; R54 solo cubre la línea de estado.
- [x] **T42** (R55, R58, R70) — `advance`, `close` y `part --accept` llaman `appendCliEvent`;
  `master-accept-confirm.sh` cubre `--approved-by` (`=` o espacio) y `close` en sus tres formas,
  vía `navori`, `npx`, `bunx`, `pnpm exec`/`dlx` o `…/navori`, con tokens `approved-by|navori
  master` (m14). · test: `master-accept-confirm.test.ts` (`git push origin master` y
  `master status` → nada) con `// Covers: R55, R58, R70`.
  · nota: eventos emitidos desde la capa de comandos (commands/master.ts): `master-advance` (allow|block), `master-part-accept` y `master-close`; lib/master/close.ts y part.ts sin cambios.
- [x] **T43** (R56, R59, R60) — Prosa de `master-plan.md` (`sdd.enabled: false`, variantes de
  confirmación, `maxWords` declarado); `master-first-use.test.ts` con el escenario completo y el
  chequeo de cobertura de comandos del skill; master-plan sigue Codex `unsupported`. · test: el
  escenario, `skills-assets.test.ts` y `control-inventory.test.ts` con
  `// Covers: R56, R59, R60`.

## Cierre

- [ ] **T44** (R28, R43) — `navori audit --compare` contra la instantánea de T9 para
  `hooks.perBashCall` y el cache read de R43; resultado en el doc de T1. Arranca la ventana del
  disparador de R41.

## Trazabilidad

| R | Tareas |
|---|---|
| R1 | T13 |
| R2 | T10, T13 |
| R3 | T1, T10 |
| R4 | T11 |
| R5 | T12 |
| R6 | T21, T22 |
| R7 | T18, T21 |
| R8, R9 | T18 |
| R10 | T20 |
| R11 | T19 |
| R12 | T22 |
| R13, R14, R15 | T23 |
| R16 | T24 |
| R17 | T2 |
| R18, R19, R20 | T25 |
| R21 | T26 |
| R22 | T27 |
| R23, R24 | T14 |
| R25, R26 | T15 |
| R27 | T16 |
| R28 | T17, T21, T23, T29, T44 |
| R29, R30, R31 | T28 |
| R32 | T30 |
| R33 | T31 |
| R34 | T1, T31 |
| R35 | T32 |
| R36, R37 | T33 |
| R38 | T32, T34 |
| R39 | T34 |
| R40 | T35 |
| R41 | T36 |
| R42 | T37 |
| R43 | T1, T9, T44 |
| R44 | T38 |
| R45 | retirado (B3) |
| R46, R47 | T4 |
| R48, R49 | T3 |
| R50 | T39 |
| R51 | T40 |
| R52, R53, R54 | T41 |
| R55 | T8, T42 |
| R56 | T43 |
| R57 | T10 |
| R58 | T42 |
| R59, R60 | T43 |
| R61, R62 | T5 |
| R63 | T4 |
| R64, R65 | T3 |
| R66 | T4 |
| R67 | T7 |
| R68, R69 | T6 |
| R70 | T4, T8, T18, T24, T29, T35, T38, T42 |
| R71 | T3 |
