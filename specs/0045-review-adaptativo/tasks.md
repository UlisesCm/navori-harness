# Review adaptativo — Tasks

Cuatro entregas → cuatro PRs contra `dev`, en el orden de design.md § "Entregas propuestas". Cada
milestone es un commit. El gate completo corre una vez por entrega, en el ciclo de cierre; los
ciclos intermedios corren `qualityGate.fast` más los `A<n>` del milestone (hasta que E1 esté
mergeada, a mano). Cada test lleva `// Covers: R<n>`. Las prosas de agentes se editan en
`packages/core/core-assets` y se aplican con `navori render --apply`.

## Cierre de #1275

E1 y E2 ya están integradas. E3 se completa al incorporar a `dev` la captura de T18:
el PR #1385 se fusionó a `fix/1275-expected-evidence` después de integrar esa rama, por lo
que su estado `merged` no acreditaba disponibilidad en `dev`. Esta integración conserva
los límites de D11: captura de comparación en Claude y rechazo sin señal en otros motores.
E4 se acredita con las implementaciones absorbidas por 0054 y con la validación de
`expected` de T22, ahora conectada al parser compartido. La correspondencia sigue abajo;
los comandos A10–A14 verifican el cierre funcional, no sólo las casillas.

## E1 — El gate completo corre una vez por aprobación
Estimated LOC: 1000

### M1 — Carril acotado del reviewer
- **A1** — schema, interpolación y render del reviewer en verde ·
  `cd packages/cli && bun run test src/lib/config/__tests__/config.test.ts src/lib/render/__tests__/interpolate.test.ts`
  → exit 0, 0 failed
- **A2** [observable] — el reviewer renderizado para Claude y Codex nombra `qualityGate.full` solo
  en la ronda que firma `APPROVED` · `bun run check:render && bun run check:doc-budgets`
  → exit 0
- [x] **T1** (R25) — `QualityGateSchema` acepta `scoped` opcional sin `.default()`; se regenera
  `navori.config.v1.json` · effect: schema · test:
  `lib/config/__tests__/config.test.ts`::"qualityGate.scoped"
- [x] **T2** (R8, R25) — variable derivada `navori.scopedGate` (`scoped ?? fast`) en `interpolate`
  · effect: behavior · test: `lib/render/__tests__/interpolate.test.ts`::"navori.scopedGate"
- [x] **T3** (R8, R9, R24) — `reviewer.md` (Setup 3, Pass 2 "Quality gate", "Content receipt"):
  `CHANGES_REQUESTED` usa `navori.scopedGate` + `A<n>`; `full` solo antes de firmar; tope de
  palabras subido con su porqué · effect: docs · test:
  `lib/render/__tests__/interpolate.test.ts`::"reviewer gate table claude y codex"

### M2 — `receipt gate` para workplans
- **A3** — decisión de gate y receipt en verde ·
  `cd packages/cli && bun run test src/lib/plan/__tests__/gate-decision.test.ts src/lib/diagnose/__tests__/receipt.test.ts`
  → exit 0, 0 failed
- [x] **T4** (R10, R11) — `decideWorkplanGate(plan, phase?)` puro en `lib/plan/gate-decision.ts`:
  `scoped` con `pendingLater` mientras quede una fase posterior con `A<n>` sin `cumplido`; `full`
  sin fases, en la última o ante un workplan ilegible · effect: behavior · test:
  `lib/plan/__tests__/gate-decision.test.ts`::"razones y fail closed"
- [x] **T5** (R10, R11) — `commands/receipt.ts`: rama sin `--spec`, `--phase`; `sign --gate-ran
  scoped` con decisión `full` sale 1 sin receipt · effect: behavior · test:
  `lib/diagnose/__tests__/receipt.test.ts`::"workplan scoped y full"

### M3 — Gate de este repo
- **A4** [observable] — una ronda intermedia corre el scoped sin tests ·
  `bun run check:scoped` → exit 0 sin correr vitest
- **A5** — config en verde ·
  `cd packages/cli && bun run test src/__tests__/repo-gate-config.test.ts`
  → exit 0, 0 failed
- [x] **T6** (R23) — `navori.config.json` y `package.json`: `full` ordenado de barato a caro con el
  mismo conjunto de checks, `test:coverage` al final; `fast` = lint + typecheck; script raíz
  `typecheck` · effect: behavior · test: `__tests__/repo-gate-config.test.ts`::"orden y conjunto"
- [x] **T7** (R25) — `check:scoped` = pasos estáticos de `full`, sin tests; los tests de una ronda
  son los `A<n>` · effect: behavior · test: `src/__tests__/repo-gate-config.test.ts`::"orden y conjunto"

## E2 — Los checks mecánicos viven en el hook nativo
Estimated LOC: 1150

### M4 — Omisión por config
- **A6** — hook, plugins y goldens en verde ·
  `cd packages/cli && bun run test src/__tests__/quality-gate-native.test.ts src/lib/config/__tests__/plugins.test.ts`
  → exit 0, 0 failed
- **A7** [observable] — los goldens de render con y sin flags no dependen del estado de git ·
  `bun run check:render` → exit 0
- [x] **T8** (R1) — `qualityGate.nativeHooks` y `plugins.<p>.nativeHook` opcionales en el schema;
  variable derivada `navori.nativeHooks` · effect: schema · test:
  `lib/config/__tests__/config.test.ts`::"nativeHooks"
- [x] **T9** (R2, R3) — `quality-gate-pre-commit.sh`: el bloque del gate queda bajo
  `navori_native_fast`; el tope de `progress/current.md` y la user-section siguen; el skip se
  audita como `skip` con razón `native-hook` · effect: behavior · test:
  `__tests__/quality-gate-native.test.ts`::"tope, user-section y gate omitido en claude y codex"
- [x] **T10** (R4) — `loadEnabledPlugins` carga un plugin con `nativeHook` sin hooks y con sus
  scripts; `build-settings` y `resolveCodexHooks` no lo registran · effect: behavior · test:
  `lib/config/__tests__/plugins.test.ts`::"nativeHook omite el registro"

### M5 — `doctor` detecta y la auditoría distingue
- **A8** — detección, doctor y auditoría en verde ·
  `cd packages/cli && bun run test src/lib/diagnose/__tests__/native-hooks.test.ts src/commands/__tests__/doctor-native-hooks.test.ts src/lib/audit/__tests__/outcomes.test.ts src/__tests__/hook-audit-instrumentation.test.ts`
  → exit 0, 0 failed
- [x] **T11** (R5, R6) — `detectNativeHooks(cwd)` en `lib/diagnose/native-hooks.ts`: husky (stub
  sin `.husky/<hook>` = ausente), lefthook, pre-commit, hook plano y `core.hooksPath` relativo, por
  worktree · effect: behavior · test: `lib/diagnose/__tests__/native-hooks.test.ts`::"fixtures por
  gestor y worktree"
- [x] **T12** (R5, R6, R7) — `scanNativeHooks` en `doctor`: reporta lo detectado, error si lo
  declarado no está activo, aviso de duplicado si no está declarado · effect: behavior · test:
  `commands/__tests__/doctor-native-hooks.test.ts`::"filas de D3". El error voltea
  `computeHealthVerdict` (salida 2) y las filas de plugin consumen `LoadedPlugin.nativeHookOmitted`
- [x] **T13** (R2) — razón `native-hook` en `HOOK_REASON_CODES` y en la allowlist de
  `audit-log.sh`; `outcomes.ts` reporta "no observado" en vez de cero · effect: behavior · test:
  `lib/audit/__tests__/outcomes.test.ts`::"skip native-hook"

### M6 — Este repo declara sus hooks nativos
- **A9** [observable] — `doctor` reconoce el pre-commit versionado ·
  `bun packages/cli/src/index.ts doctor` → sin error de hooks nativos y fila con
  `.git/hooks/pre-commit`
- [x] **T14** (R1) — `navori.config.json` declara solo `qualityGate.nativeHooks: true` (sin
  `plugins.<p>.nativeHook`; enmienda #1282); `prepare` corre `hooks:install`, que avisa y sale 0
  ante un hook ajeno · effect: behavior · test:
  `__tests__/repo-gate-config.test.ts`::"declaraciones nativas"
- [x] **T15** (R24) — fila `native-git-hooks` en `FLOWS` y `docs/native-overlap.md` regenerado;
  skills de semgrep y jscpd documentan la invocación desde un hook nativo · effect: docs · test:
  `engines/shared/__tests__/native-overlap.test.ts`::"native-git-hooks"

## E3 — La aceptación compara contra lo esperado
Estimated LOC: 1000

> Implementada por partes en #1275: parser, conservación de `request`, validación y captura de
> comparación en hooks de Claude. Codex y Pi conservan su soporte previo; no capturan comparaciones
> de salida. La entrega no acredita corridas con modelos vivos ni equivalencia entre motores.

### M7 — `expected` estructurado y `request`
- **A10** — parser, schema y render del workplan en verde ·
  `cd packages/cli && bun run test src/lib/plan/__tests__/expected.test.ts src/lib/plan/__tests__/render.test.ts`
  → exit 0, 0 failed
- [x] **T16** (R17) — `parseExpected(text)` puro en `lib/plan/expected.ts`: `exit <n>` anclado,
  `contains:` y `matches:`; texto libre sigue válido · effect: behavior · test:
  `lib/plan/__tests__/expected.test.ts`::"gramática y texto libre"
- [x] **T17** (R15) — `request` opcional en `WorkplanSchema` (tope de 20000 caracteres) y
  `renderWorkplan` lo muestra junto a `goal` · effect: behavior · test:
  `lib/plan/__tests__/render.test.ts`::"request"
  - Campo literal validado sin recortar espacios; cada línea se muestra citada después de `objective`.
    El CLI conserva el texto al renderizar y actualizar el plan. Los planes sin `request` siguen válidos.

### M8 — Carril de evidencia
- **A11** — carril y validación de evidencia en verde ·
  `cd packages/cli && bun run test src/lib/__tests__/expected-capture.test.ts src/lib/__tests__/routing-watch.test.ts src/lib/__tests__/bash-outcome-watch.test.ts src/lib/plan/__tests__/acceptance-index.test.ts src/commands/__tests__/plan.test.ts`
  → exit 0, 0 failed
- [x] **T18** (R18) — `bash-outcome.sh`, `routing-watch.sh` y `bash-outcome-watch.sh` registran
  código de salida y resultado de la comparación, nunca la salida; salida truncada o interrumpida
  da `unevaluated`; sin línea parcial · effect: behavior · test:
  `lib/__tests__/expected-capture.test.ts`::"Claude expected capture" y
  `lib/__tests__/routing-watch.test.ts`::"leaves no partial line when the hook is killed mid-fingerprint"
  - Índice de comparación con comando, directorio y binding exactos; regex acotada a 100 ms.
    Fallos estructurados con código conocido invalidan éxitos anteriores sin leer su salida.
    Respuestas mayores de 1 MiB usan el comando cacheado en el detector de escrituras para evitar
    sustituciones cuadráticas de Bash sobre la salida. No se persiste salida ni hash de salida.
- [x] **T19** (R19) — `validateEvidence`: gana la línea más nueva; `plan update
  --progress A<n>=cumplido` rechaza una comparación fallida o un `expected` editado · effect:
  behavior · test: `commands/__tests__/plan.test.ts`::"pass vieja no anula fail nueva"
  - Compara el `expected` actual y lo revalida antes de escribir. `plan check`, resume y entregas
    consumen el mismo veredicto; metadatos inválidos no recuperan una prueba anterior válida.
    La evidencia histórica de éxito conserva su forma y sirve para texto libre y `exit 0`.

### M9 — `plan check` y prosa del reviewer
- **A12** — `plan check` y sus consumidores en verde ·
  `cd packages/cli && bun run test src/lib/plan/__tests__/check.test.ts src/lib/master/__tests__/slice.test.ts src/lib/master/__tests__/part.test.ts src/lib/plan/__tests__/plan-gate.test.ts`
  → exit 0, 0 failed
- [x] **T20** (R20) — `checkWorkplan` en modo evidencia: `cumplido` sin evidencia es finding sin
  cambiar `ok` para master-plan ni bloquear el plan-gate · effect: behavior · test:
  `lib/plan/__tests__/check.test.ts`::"modo evidencia y consumidores"
- [x] **T21** (R16, R24) — `reviewer.md` Pass 1 compara el diff contra `request` cuando existe, en
  Claude y Codex · effect: docs · test: `lib/render/__tests__/interpolate.test.ts`::"reviewer
  request claude y codex"

## E4 — El ciclo de un cambio chico es proporcional (absorbida por 0054)
Estimated LOC: 450

> Implementada en la spec [0054 — ciclo de desarrollo](../0054-dx-ciclo-desarrollo/),
> excepto la conexión final de `parseExpected` en T22, completada con E3.
>
> | Tarea 0045 | Implementación integrada en 0054 |
> |---|---|
> | T22 | T35; validación estructurada completada al integrar E3 |
> | T23 | T36 |
> | T24 | T40 |
> | T25 | T37 |
> | T26 | T41; nota de integración en [0030](../0030-scribe-owns-markdown/design.md#enmienda-de-integración-00450054) |

### M10 — Nivel 0 y profundidad del review
- **A13** — plan-gate y `classify --diff` en verde ·
  `cd packages/cli && bun run test src/lib/plan/__tests__/plan-gate.test.ts src/commands/__tests__/plan.test.ts`
  → exit 0, 0 failed
- [x] **T22** (R12) — `NIVEL0_LINE`/`evaluateNivel0` exigen `| verify: \`<cmd>\` → <expected>`
  validado con `parseExpected`; sin `verify:` se niega el despacho · effect: behavior · test:
  `lib/plan/__tests__/plan-gate.test.ts`::"nivel-0 con y sin verify"
- [x] **T23** (R13, R14) — `classify --diff` emite `reviewDepth`: `light` solo con
  `criticalPaths` declarados y sin tocar; `full` ante un área crítica o sin declaración; este repo
  declara la lista aprobada · effect: behavior · test:
  `commands/__tests__/plan.test.ts`::"reviewDepth con config real"
- [x] **T24** (R12, R13, R14, R24) — `planificacion` fila 0 y `reviewer.md` Pass 2 con
  `reviewDepth`, en Claude y Codex · effect: docs · test:
  `__tests__/doctrine-contracts.test.ts`::"reviewer lanes by milestone, cached PASS reported as cached, reviewDepth, docs re-sign"

### M11 — Handoff determinista y nits
- **A14** [observable] — `impl_<f>.md` sale del JSON sin despachar al scribe ·
  `cd packages/cli && bun run test src/lib/handoff/__tests__/handoff-render.test.ts src/__tests__/asset-command-permissions.test.ts src/__tests__/doctrine-contracts.test.ts`
  → exit 0, 0 failed
- [x] **T25** (R21) — `navori handoff render <feature>` en `lib/handoff/render.ts`: falla con JSON
  faltante, inválido, de otra feature o con `scribeOwnsMarkdown` en `false`; permiso
  `Bash(navori handoff render:*)` · effect: behavior · test:
  `lib/handoff/__tests__/handoff-render.test.ts`::"snapshot y rechazos"
- [x] **T26** (R21, R22, R24) — `orchestrator.md` ("The `scribe` leg", "Frugal delegation"),
  `scribe.md` y `orquestacion`: scribe solo con `markdownRequests`; una observación menor a 80
  tras `APPROVED` va al PR; enmienda de 0030 R5/R8 anotada · effect: docs · test:
  `__tests__/doctrine-contracts.test.ts`::"scribe se despacha solo con markdownRequests no vacío"
