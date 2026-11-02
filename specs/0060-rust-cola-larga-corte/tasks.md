# Migración a Rust, fase 4: cola larga — Tasks

**Estado:** aceptada para desarrollo; reestructurada el 2026-10-31 (Q26–Q29 en `design.md`) ·
**Base:** `migration/rust`. Fase 4 del programa (ver `specs/0057-migracion-rust/requirements.md`
§ "Fases del programa"), partida en dos: esta spec porta la cola larga de comandos y hooks, y
`specs/0062-rust-activacion-corte/` hace la activación, la distribución y el corte (antes E4–E6
de esta spec). Tres entregas, todas contra `migration/rust`. El LOC es una referencia gruesa.

**PRs** (uno por entrega y por flujo; los flujos están en la política de velocidad)

| PR | Flujo | Entrega | Contenido | Rama (2026-11-01) | Se mergea cuando |
|---|---|---|---|---|---|
| 1a | — | E1 | Mergeado (#1454) | — | — |
| 1b | Hooks | E1 | T13 y T14 en un solo PR | Mergeado (#1471) | — |
| 1c | Comandos | E1 | La infraestructura compartida (T17, T18) y el avance de T8 (mapeo de `spec check` a `parts.json`), por Q30. #1466 (T11 parte 2) ya entró | `feat/0060-rust-e1c-comandos`: T17 y T18 cerrados, A6 verde | A6 verde y la CI en verde |
| 1d | Comandos | E1 | Acotado por Q31: los productores paralelos, `attest` y los flags de evidencia de `handoff check` (T10), `plan acknowledge`, `plan resume` y `classify --diff` (T11) y el grupo `master` (avance de T8) | `feat/0060-rust-e1d-comandos` (#1477): T10 y T11 cerrados, A4 verde (oráculo 384 casos, replay 723, fuzz 10 000) | A4 verde y la CI en verde |
| 1e | Comandos | E1 | El resto de E1 (Q31): `master init` y los diez `master delivery-*` (T8) y el inventario T16 | Sin rama; sale de `migration/rust` cuando entre 1d | A3 y A5 completos y la CI en verde |
| 2 | Hooks | E2 y E3 | T21 y T25: los siete hooks de E2 y E3 en `shadow` | Sin rama; empieza cuando entre 1b | El replay de A7 y A8 de esos hooks y la CI en verde |
| 3 | Comandos | E2 | T19, T20 y T22 | Sin rama; sale de `migration/rust` cuando entre 1c | A7 verde; entra después del PR 2 (el inventario de R77 exige los hooks en `shadow`) |
| 4 | Comandos | E3 | Acotado por Q32: M8 (T23 y T24), con el avance de T26 (`preset init`) y T28 (`registry`) | `feat/0060-rust-e3-comandos` (#1473): `backup`, `migrations`, `preset init`, `registry` y `scan` nativos | La mitad de oráculo de A8 verde y la CI en verde |
| 4b | Comandos | E3 | El resto de M9 (Q32): T26–T29 | Sin rama; sale de `migration/rust` cuando entre el PR 4 | A9 verde; entra después del PR 2 |

**Precondiciones de entrada (trabajo en paralelo, D47):**
- **E2 y M8 de E3:** empiezan ya. Sus comandos usan la infraestructura compartida de M6 (T17, T18),
  que entra con el PR 1c; mientras 1c no esté en `migration/rust`, su rama sale de la de 1c. Los
  hooks de E2 y E3 (PR 2) no la necesitan y pueden empezar en cuanto entre el PR 1b.
- **M9 de E3:** `init`, `add`, `configure`, `update` y `refresh` esperan a 0059 E2 (render
  multi-engine), porque escriben por ese render. 0059 E2 está en la ruta crítica de esta spec. Lo ya
  avanzado de los comandos de M9 que no escriben por el render (`preset init`, `registry`) entra con
  el PR 4; el resto de M9 va en el PR 4b (Q32).
- **0062** corre en paralelo con esta spec (ver sus precondiciones); solo su corte (E3) espera a que
  esta spec termine.

**Política de velocidad (D47 de `design.md`):**
- **Un PR por entrega y por flujo**, con commits atómicos y una revisión cruzada por PR. Ninguna
  tarea abre su propio PR, y dos flujos nunca comparten rama.
- **Evidencia de un hook:** el replay nativo del corpus (`hook-verdict-replay --impl rust`). Se
  siembra corpus solo si falta una clase de veredicto. No se escribe un test Rust que repita el
  corpus. Fuzz al portar: 10 000 casos, solo para hooks con compuerta que analizan texto; el de
  100 000 corre una vez, en lote, antes de activar (0062).
- **Evidencia de un comando:** el oráculo con diferencial cero en el camino feliz y los errores
  comunes. Los errores raros (mensajes de zod o V8, estados corruptos, condiciones de carrera) se
  delegan al TS de forma permanente y se declaran en `scripts/js/rust-areas.mjs` (D48).
- **Gate:** en cada commit, `bun run check:fast` y los tests del área (`oracle:rust --only <área>`,
  el replay del hook). El gate completo (`bun run check` y `cargo test --workspace`) corre en la CI
  del PR y no se exige en local.
- **Herramientas primero:** `bun run rust:hooks-sync` y `bun run rust:verify` (T17) sustituyen los
  pasos manuales de hashes, render y binario, y los casos del oráculo pasan a un archivo por área
  para que dos sesiones no choquen en el mismo arreglo.
- **Flujos de trabajo y dueños** (cada flujo es el único que toca su zona):

  | Flujo | Tareas | Zona exclusiva |
  |---|---|---|
  | Hooks | T13, T14, T21, T25 de esta spec; E1 de 0062 | `crates/navori-hooks/**`, la sección `hooks` de `crates/ported.json`, los scripts renderizados, el corpus de hooks y `hook-fuzz.mjs` |
  | Comandos | T8, T10, T11, T16, T17, T18, T19, T20, T22, T23, T24, T26, T27, T28, T29 | `crates/navori-cli/src/<comando>*.rs`, `navori-core` del área, la sección `commands` de `ported.json` y `scripts/js/rust-oracle/cases/<área>.json` |
  | Render y distribución | 0059 E2; E2 de 0062 | `crates/navori-core/src/render/**`, los casos de render, Codex y Pi, los workflows de release y el empaquetado |

  T17 lo escribe el flujo de comandos (son scripts y el archivo de casos por área) y lo usa el de
  hooks; el reparto de `cases.json` va en un commit propio, antes de que los demás flujos agreguen
  casos. Cada flujo integra `origin/migration/rust` a diario. Con dos sesiones, el tercer flujo lo
  toma la que se desocupe primero; 0059 E2 conviene empezarlo pronto porque bloquea M9.

Reglas de ejecución:
- `tasks.md` es el tracking canónico. Cada prueba nueva lleva `// Covers: R<n>`.
- Hooks, render, markers y escrituras son área crítica: un commit por mecanismo. Ningún hook pasa a
  `active` en esta spec (eso es 0062).
- Sin subagentes por instrucción del usuario mientras no se resuelva Q23: la revisión independiente
  es la revisión cruzada entre sesiones.

**Pendiente heredado de 0058:** el plazo del sondeo de hechos de `hook_facts` vence bajo carga y
rompe `facts_cache.rs`, `hook_facts.rs`, el fuzz y el replay de forma intermitente. T17 lo corrige.

## E1 — Orquestación y gobierno de agentes
Estimated LOC: 16000

### M1 — Slice de referencia de hooks: `general-purpose-confirm`
Entregable: `general-purpose-confirm` decide en Rust en `shadow` en Claude y Codex, y existe el
inventario por área.

Cerrado (2026-10-28): A1 verde. Replay `--impl rust` de 15 casos idénticos con auditoría `off` y
`active` (el corpus suma la clase `skip` de Codex); fuzz semilla 1 contra las copias renderizadas,
100 000 casos en Claude y 20 000 en Codex, idénticos; `rust-areas` asigna los 29 comandos raíz y
los 22 hooks.
- **A1** [observable] — el hook reproduce el corpus y el fuzz, y todo subcomando y hook tiene área · `node scripts/js/hook-verdict-replay.mjs --impl rust --only general-purpose-confirm.sh && bun run fuzz:hooks --hook general-purpose-confirm.sh --engine claude --seed 1 --cases 100000 && bun run fuzz:hooks --hook general-purpose-confirm.sh --engine codex --seed 1 --cases 20000 && cd packages/cli && bun run vitest run src/__tests__/rust-areas.test.ts` → exit 0; 0 divergencias
- [x] **T1** (R77, R78) — `scripts/js/rust-areas.mjs` con `inventory()` (subcomandos y flags de `cli.ts` desde `dist/`, hooks de `core-assets` y plugins), `areaOf()` con la tabla de D40 y `areaInventoryCheck(area, manifest)`, que también corre con las otras áreas de la fase retiradas del manifiesto (D41, F39) · effect: behavior · test: `packages/cli/src/__tests__/rust-areas.test.ts`::"todo subcomando, flag y hook tiene un área"
- [x] **T2** (R71) — corpus de `general-purpose-confirm` con al menos un caso por clase de veredicto (`skip`, `ask`, `deny`) en Claude y Codex; `coverage.json` regenerado · effect: tests · test: `packages/cli/src/__tests__/hook-verdict-replay.test.ts`::"general-purpose-confirm cubre cada clase de veredicto por engine"
- [x] **T3** (R70) — `navori-hooks` (`hooks/general_purpose_confirm`): la vía rápida por subcadena, `subagent_type` con respaldo en `agent_type`, la rama por engine y el evento de auditoría igual que el shell; entrada `mode: "shadow"` en `ported.json` con sus `blocks` · effect: behavior · test: `crates/navori-hooks/tests/general_purpose_confirm.rs`::"veredictos del corpus en shadow"
- [x] **T4** (R70) — gramática de fuzz de `general-purpose-confirm` en `hook-fuzz.mjs`: `subagent_type` y `agent_type` con `general-purpose`, otros roles, valores no texto y la subcadena fuera de esos campos · effect: tests · test: `packages/cli/src/__tests__/hook-fuzz.test.ts`::"la gramática de general-purpose-confirm cubre cada campo y sus formas inertes"

### M2 — Slice de referencia de comandos: `spec`
Entregable: `navori-rust spec` (todos sus subcomandos y flags) es nativo con diferencial cero.

Cerrado (2026-10-29): A2 verde. Oráculo `--only spec` con 91 casos y 0 diferencias: `spec check
--json` sobre cada spec real del checkout (fixture `@repo-specs`), fixtures con cada regla de
`check`, errores de lectura, `--cwd`, uso, ayuda y subcomando desconocido de citty. Los casos
`native` corren el lado Rust con un TS señuelo, así que una delegación aparece como diferencia.
Delegan al TS, antes de escribir nada: una config que `readConfig` rechaza, un argv que citty podría
leer distinto, un archivo que no es UTF-8, un extracto de 60 unidades que parte un par sustituto y
una spec con `_master/index.json` (el mapeo a `parts.json` pasa a T8).
- **A2** [observable] — `spec` es nativo y su área no tiene pendientes de `spec` · `bun run oracle:rust --only spec && cd packages/cli && bun run vitest run src/__tests__/rust-areas.test.ts -t spec` → exit 0; 0 diferencias
- [x] **T5** (R73) — `spec` nativo (check, classify y el resto), con la gramática E/M/A/T y la clasificación de `lib/spec` · effect: behavior · test: `packages/cli/src/__tests__/rust-oracle.test.ts`::"spec check y classify sobre las specs reales y fixtures con errores"
- [x] **T6** (R77) — `spec` sin subcomandos ni flags fuera del manifiesto · effect: tests · test: `packages/cli/src/__tests__/rust-areas.test.ts`::"spec no tiene subcomandos ni flags pendientes"

### M3 — Master plan
Entregable: `navori-rust master` es nativo y `master-plan-context` y `master-accept-confirm` deciden
en Rust en `shadow`.
- **A3** [observable] — `master` es nativo y sus dos hooks reproducen el corpus · `bun run oracle:rust --only master && node scripts/js/hook-verdict-replay.mjs --impl rust --only master-plan-context.sh,master-accept-confirm.sh && bun run fuzz:hooks --hook master-accept-confirm.sh --seed 1 --cases 10000` → exit 0; 0 diferencias
- [x] **T7** (R71) — corpus de `master-plan-context`, `master-accept-confirm`, `implementer-no-markdown`, `role-guard`, `engram-write-guard`, `comment-draft-confirm` y `pr-publisher-confirm` por clase de veredicto y modo en cada engine registrado · effect: tests · test: `packages/cli/src/__tests__/hook-verdict-replay.test.ts`::"los hooks de E1 cubren cada clase de veredicto y modo por engine"
  - Corrección (2026-10-30): el corpus de `role-guard` y `engram-write-guard` se había grabado con `{{rolePolicy}}` y `{{engramPolicy}}` sin renderizar, así que sus veredictos eran el script fallando (`command not found`, error de sintaxis en zsh). El replay y la generación renderizan ahora esas dos políticas como `navori render` para el roster por defecto (`scripts/js/corpus-asset.mjs`) y los dos corpus se regeneraron: 152 casos con veredictos reales de la política.
- [ ] **T8** (R73, R74) — `master` nativo (todos sus subcomandos), con sus escrituras de estado por la capa `Fs`, y el mapeo de `spec check` a los `parts.json` de la etapa activa (R22 de 0044), que M2 delega al TS · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"master status, part, close y el resto"
  - Avance (2026-10-29): nativos: `master status` (`--json`, `--line` y sin flags, que regenera `STATUS.md`, la región de `MASTER.md` e `INDEX.md` por la capa `Fs`), `master check` completo (etapa activa en cada fase, `--stage`, `--part`, `--fit`), `master template`, `master advance`, `master mode` y `master ux`. Todo se valida antes del primer byte y delega si el TS se comportaría distinto; `advance` también delega mientras haya una sesión de auditoría en el entorno, porque su evento (`appendCliEvent`) depende del escritor de T18. Delegan además: evidencia `run` (su antigüedad sale de `git`, por el transporte de D42), el contenido de `UX.md`/`ux.json`, etapas `deliveries` en `status`/`check --stage`, e índice, estado o config inválidos. `master part` en etapa legacy (estado, razón, spec, issue y `--accept` manual) reescribe `parts.json` normalizado como zod y los derivados, calculados en memoria antes de la primera escritura; delega el `--accept` de `test`/`comando` al llegar a `git` (D42), el evento de auditoría de `--accept` (T18) y cualquier `parts.json` o `state.json` ausente o inválido. `master close` (2026-10-30) es nativo en etapa legacy o sin etapa activa, con `finishRender` (config con `harness.masterPlan` apagado y render) planeado antes de la primera escritura; delega fuera de los engines donde el render es nativo, con workspaces de monorepo, con una sesión de auditoría en el entorno, evidencia `run` y etapas `deliveries`. Oráculo `--only master`: 330 casos, 0 diferencias (incluye la reconciliación de `master close` sobre cada fixture de render aplicable). Faltan `init`, `delivery-*` y el mapeo de `spec check` a `parts.json` (PR 1b).
  - Avance (2026-10-31): el mapeo de `spec check` a los `parts.json` de la etapa activa en modo deliveries (R22 de 0044) es nativo: `master::delivery_parts` valida `DeliveryPartsSchema` como zod y porta `deliveryIdsForSpec`, y `spec check` suma `master-delivery-unmapped` y `master-target-mismatch`; delega un índice o un `parts.json` que Rust no juzga. Siguen en el TS `master init` (la señal sale de `git` y de `detectProject`, sin puerto, y cierra con el render) y los `delivery-*` (recibos, evidencia y `git`): esperan el `ProcessRunner` de T18 (D42).
  - Avance (2026-11-02): el grupo `master` (uso, ayuda y subcomando desconocido de citty) es nativo; un subcomando conocido fuera del manifiesto sigue en el TS. `master init` y los diez `master delivery-*` pasan al PR 1e (Q31).
- [x] **T9** (R70, R72) — `master-plan-context` y `master-accept-confirm` en `shadow`, con `master` en proceso bajo la condición de versión de R53 de 0059 y por el `navori` de `PATH` en otro caso · effect: behavior · test: `crates/navori-hooks/tests/master_hooks.rs`::"veredictos del corpus en shadow"
  - Avance (2026-10-30): los dos hooks entran al manifiesto en `shadow`. `master-accept-confirm` (Claude, Codex y Pi) reproduce el corpus (289 casos) y el shell en vivo con los cuatro extractores y los dos locales; su escaneo usa `gate_trigger::scan` sin quitar heredocs, como el script. `master-plan-context` (Claude y Codex) es de solo lectura, así que la sombra evalúa el hook completo: la línea sale de `master::status_line` en proceso cuando el `navori` de `PATH` es la versión del TS de este build y del subproceso en otro caso (`crates/navori-cli/tests/master_plan_context.rs` compara el carril en proceso con el comando nativo); difiere un `cd` que fallaría, un índice que es directorio, un NUL, un puntero no ASCII y una línea cuyo largo depende del locale. Replay `--impl rust` de los dos hooks: 308 casos idénticos con auditoría `off` y `active`; oráculo `--only master`: 330 casos, 0 diferencias; fuzz de `master-accept-confirm` semilla 1: 100 000 casos idénticos (A3 verde).

### M4 — Handoff y plan
Entregable: `navori-rust handoff` y `plan` son nativos e `implementer-no-markdown` decide en Rust en
`shadow`.
- **A4** [observable] — `handoff` y `plan` son nativos y el hook reproduce el corpus · `bun run oracle:rust --only handoff,plan && node scripts/js/hook-verdict-replay.mjs --impl rust --only implementer-no-markdown.sh && bun run fuzz:hooks --hook implementer-no-markdown.sh --seed 1 --cases 10000` → exit 0; 0 diferencias
- [x] **T10** (R73, R74) — `handoff` nativo (check, render, prepare-parallel, finalize-parallel y el resto) · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"handoff en todos sus subcomandos"
  - Avance (2026-10-30): nativos: el grupo `handoff` (uso, ayuda y subcomando desconocido de citty), `handoff check` para el orquestador y el scribe (JSON de `impl_<feature>.json` con `ImplHandoffSchema`, el `.md` legacy con `scribeOwnsMarkdown` apagado, `head` contra `git rev-parse HEAD`, worktree, rama y la regla de rutas de R16), `handoff render` (plantilla y escritura atómica del estado por la capa `Fs`, con los mensajes de `resolveStateRoot` que el TS captura) y `handoff log-review` (sidecar con `ReviewSidecarSchema`, deduplicado por sha256 y anexado a `findings.jsonl` por `Fs::append`). `resolveStateRoot` con raíz neutral, legacy, recibo y `--dir` explícito vive en `navori_core::state_files`. Todo se valida antes del primer byte y de la primera escritura. Delegan al TS: un JSON que `JSON.parse` o zod rechazan (sus mensajes son de V8 y de zod), `--for publisher`, `--produced-by`, `--since` y `--parallel` (evidencia de revisión), una raíz de estado que el TS lanza sin capturar en `check`, una config ausente o inválida en `check`, `log-review` con una sesión de auditoría en el entorno (evento de T18), y los productores paralelos (`prepare-parallel`, `begin-parallel`, `complete-parallel`, `finalize-parallel`) y `attest`, que no están en el manifiesto. Oráculo `--only handoff`: 91 casos (67 nativos), 0 diferencias. Faltan `--for publisher`, `--produced-by reviewer`, los productores paralelos y `attest` (dependen de `review-evidence` y de `git`, D42).
  - Cerrado (2026-11-02): `handoff check` con `--for publisher`, `--produced-by reviewer` y `--since`, `handoff attest` con `nativeActor`, los productores paralelos (`prepare-parallel`, `begin-parallel`, `complete-parallel` y `finalize-parallel`) y `check --for scribe --parallel` son nativos; `parallelOwnershipValid` sigue en el TS. Ningún subcomando ni flag de `handoff` queda fuera del manifiesto. Oráculo `--only handoff,plan`: 384 casos, 0 diferencias.
- [x] **T11** (R73, R74) — `plan` nativo en lo que 0059 no porta (classify, render, check, update, escalation-reset, resume y el resto) · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"plan sin subcomandos pendientes"
  - Avance (2026-10-30): nativos: el grupo `plan` (uso, ayuda y subcomando desconocido de citty), `plan classify` con `--files`, el borrador del workplan y los siete flags declarados en sus dos grafías (`--criticalArea` y `--critical-area`), `plan check` con el reporte completo de `checkWorkplan` en modo `finding` (reglas estructurales, nivel recalculado con `criticalPaths` y `localSkills`, y notas de evidencia) y `plan render` (Markdown de `renderWorkplan`, `acceptance-index` y `acceptance-expected.jsonl` de todos los directorios de estado, con el lock `.plan-update.lock` y las escrituras por la capa `Fs`). Todo se valida antes del primer byte y de la primera escritura. Delegan al TS: un JSON o un workplan que `JSON.parse` o zod rechazan (mensajes de V8 y de zod), un `matches:` que solo un `RegExp` de JS valida, un `source` de entrega del plan maestro, un workplan hermano que Rust no puede juzgar en `render`, un lock ya tomado, una config que Rust no modela, una raíz de estado que el TS lanza sin capturar, `--no-*` y valores repetidos o vacíos, `classify --diff` (git, D42), y `update`, `escalation-reset`, `acknowledge` y `resume`, que no están en el manifiesto (evidencia de ejecución, eventos de auditoría de T18 y concesiones de escalamiento). Depende del núcleo de T10 (`state_files`, cherry-pick de 9fc9a1cf0). Oráculo `--only plan`: 153 casos (78 de `plan-cmd`, 56 nativos), 0 diferencias. Faltan `update`, `escalation-reset`, `acknowledge`, `resume` y `classify --diff`.
  - Avance (2026-10-31): `plan update` y `plan escalation-reset` también son nativos. `update`: `--progress` (repetible), `--decision` con `--date` (validada como `z.iso.date`), sus errores de uso, el id desconocido, el rechazo de un `cumplido` estructurado y el `cumplido` libre sin evidencia con su aviso; la mutación cruda (`applyMutationsToRaw`) conserva los campos no declarados y su orden, y escribe JSON, Markdown e índice de aceptación bajo `.plan-update.lock`. `escalation-reset`: los flags antes de la raíz, el nivel, el historial `gate.jsonl` (rechazos distintos tras el último reset), el registro del rechazo vigente de `review_<feature>.md` y la línea de reset, por `Fs::append`. Delegan: una sesión identificada de Claude, Pi o Codex (`validateEvidence`, git, D42), una sesión de auditoría (eventos de T18), una línea del historial fuera de las formas que escribe el CLI, un registro `escalation_*` en el directorio neutral (`reconcileHistory`), un workplan o una mutación que zod rechaza y un lock tomado. Siguen en el TS `acknowledge`, `resume` y `classify --diff`. Oráculo `--only plan`: 199 casos (124 de `plan-cmd`), 0 diferencias.
  - Cerrado (2026-11-02): `plan resume`, `plan classify --diff` (git por el `ProcessRunner`) y `plan acknowledge` (acknowledgement, inspección y continuación, con `plan::escalation` sobre una vista de las escrituras planeadas) son nativos; delegan los errores de zod, de `JSON.parse` y de citty. Ningún subcomando ni flag de `plan` queda fuera del manifiesto. Oráculo `--only handoff,plan`: 384 casos, 0 diferencias; prueba de propiedades `plan_acknowledge_parity` contra `acknowledgePlanEscalation`.
- [x] **T12** (R70) — `implementer-no-markdown` en `shadow` · effect: behavior · test: `crates/navori-hooks/tests/implementer_no_markdown.rs`::"veredictos del corpus en shadow"
  - Cerrado (2026-10-30): en `shadow` en Claude, Codex y Pi. Reglas, rutas de doctrina (incluida la de worktrees registrados) y flujo en Rust; los tres analizadores de intérprete son los programas fijos del script, que el host corre con `node -e` y `python3 -I -S -c` (solo leen, así que la sombra evalúa el hook completo). Difiere un comando mayor que el búfer del pipe, texto no UTF-8 y una regla de escritura que decida `[[:alnum:]]` no ASCII. Replay `--impl rust`: 723 casos idénticos con auditoría `off` y `active`; fuzz semilla 1: 100 000 casos idénticos.

### M5 — Gobierno de agentes y publicación
Entregable: `role-guard`, `engram-write-guard`, `comment-draft-confirm` y `pr-publisher-confirm`
deciden en Rust en `shadow`, `dominio` es nativo completo y el área E1 no tiene pendientes.
- **A5** [observable] — el área E1 está completa · `bun run oracle:rust --only dominio && node scripts/js/hook-verdict-replay.mjs --impl rust --only role-guard.sh,engram-write-guard.sh,comment-draft-confirm.sh,pr-publisher-confirm.sh && for h in role-guard comment-draft-confirm pr-publisher-confirm; do bun run fuzz:hooks --hook "$h.sh" --seed 1 --cases 10000 || exit 1; done && cd packages/cli && bun run vitest run src/__tests__/rust-areas.test.ts -t E1` → exit 0; 0 diferencias
- [x] **T13** (R70) — `role-guard` y `engram-write-guard` en `shadow` en los engines donde están registrados · effect: behavior · test: `crates/navori-hooks/tests/agent_governance.rs`::"veredictos del corpus en shadow"
- [x] **T14** (R70, R72) — `comment-draft-confirm` y `pr-publisher-confirm` en `shadow`, con los parciales `gate-trigger` y `draft-body` y el borrador citado en la razón igual que el shell; la rama Codex de `pr-publisher-confirm` ejecuta `navori codex approval request` por el ejecutor de 0059 y, en sombra, sin efectos · effect: behavior · test: `crates/navori-hooks/tests/publish_confirm.rs`::"veredictos del corpus en shadow"
  - Cerrado (2026-11-01): los cuatro hooks en `shadow` (`role-guard` y `engram-write-guard` solo en Codex, donde están registrados; `comment-draft-confirm` y `pr-publisher-confirm` en Claude, Codex y Pi). Replay `--impl rust`: 425 casos idénticos con auditoría `off` y `active` (7 diferidos por falta de Bash o de una herramienta de texto); fuzz semilla 1: 10 000 casos idénticos por hook (`role-guard` y `engram-write-guard` con `--engine codex`). Los dos casos Codex del corpus de `pr-publisher-confirm` que grabaron `navori codex approval request` quedan fuera del test de política: dependen de un `navori` en el PATH de quien grabó y los cubre el replay nativo.
- [x] **T15** (R73) — el resto de `dominio` nativo (0059 porta `dominio inject`) · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"dominio sin subcomandos pendientes"
  - Cerrado (2026-10-31): `dominio init`, `list`, `show`, `reindex` y `doctor` son nativos, con el grupo (uso, ayuda y subcomando desconocido de citty). El índice `DOMINIO.md` (`buildIndex`) y `validateDominio` viven en `navori_core::workspace::dominio_store`; las escrituras van por la capa `Fs`. La salida de `@clack/prompts` (intro, note, outro y cancel) se reproduce sin color, a 80 columnas y con sus símbolos Unicode. Delegan al TS: stdout en una TTY, `FORCE_COLOR`, `CI` sin `NO_COLOR` y `TERM=linux` (color y símbolos); una nota que clack podría partir a 74 columnas o con caracteres que Rust no mide como `fast-string-width`; un nombre de workspace que el registro rechaza y `init`/`reindex` sobre un workspace no registrado (el TS lanza sin capturar); y un registro o entrada que Rust no modela. Oráculo `--only dominio`: 67 casos (50 de los subcomandos, 42 nativos, y los de `inject`), 0 diferencias.
- [ ] **T16** (R77, R78) — test de inventario del área E1 en verde, con E2 y E3 fuera del manifiesto · effect: tests · test: `packages/cli/src/__tests__/rust-areas.test.ts`::"E1 completa sin E2 ni E3"
  - Pasa al PR 1e (Q31): el inventario de E1 queda en verde cuando `master init` y los `master delivery-*` entren al manifiesto.

### M6 — Infraestructura compartida
Entregable: un solo comando sincroniza los hooks portados y otro los verifica, los casos del
oráculo viven en un archivo por área, y los comandos tienen un transporte grabado para procesos
externos. E2 y E3 parten de aquí.
- **A6** [observable] — la sincronización y la verificación corren solas, el oráculo lee sus casos por área y el transporte grabado responde · `bun run rust:hooks-sync -- --check && bun run rust:verify -- --hook general-purpose-confirm.sh --cases 2000 && bun run oracle:rust --only spec && cargo test -p navori-cli --test facts_cache --test hook_facts --locked && cargo test -p navori-core --test process_runner --locked` → exit 0
- [x] **T17** (R70, R77) — `scripts/js/rust-hooks-sync.mjs` (`bun run rust:hooks-sync`: recalcula `impl` y `blocks` de `crates/ported.json` sin reformatear, corre `render --apply` y recompila `navori-rust`; `--check` falla si algo quedó desfasado) y `scripts/js/rust-verify.mjs` (`bun run rust:verify`: replay nativo y fuzz con el binario recién compilado, reintentando una vez una llamada diferida por "probe deadline expired"); los tests de `hook_facts` y `facts_cache` usan el plazo máximo de `Limits`; `scripts/js/rust-oracle/cases.json` se parte en `scripts/js/rust-oracle/cases/<área>.json` y `loadCases` los lee todos (D47) · effect: behavior · test: `packages/cli/src/__tests__/rust-hooks-sync.test.ts`::"un impl desfasado deja --check en rojo y la sincronización lo corrige"
  - Cerrado (2026-11-01): `rust:hooks-sync` reescribe solo las cadenas de hash desfasadas dentro del objeto de su hook (`staleHashes` en `rust-manifest-check.mjs`), corre `render:apply` y `cargo install` (`--no-install`: `cargo build`); `--check` falla con un hash desfasado y, si no, corre `check:render`, porque los wrappers firmados llevan los hashes. `rust:verify` compila y corre el replay `--impl rust` y, con `--cases`, el fuzz de cada hook con `NAVORI_RUST_BIN` del binario recién compilado; el reintento ante "probe deadline expired" vive en `runRustHook`, que comparten replay y fuzz, y solo repite ese diferimiento. **Enmienda:** el plazo máximo de `Limits` es el que acepta `prepare::plan` (500 ms); los tests lo declaran como `PROBE_LIMITS` sin tocar `navori-hooks`, cuyo cambio movería el `impl` de todos los hooks. Los casos quedan en `cases/<área>.json` por el primer argumento del comando (`cli` para `--version`); `readAreaCases` falla con un id repetido entre archivos y la ayuda de superficie corre en `SURFACE_FIXTURE`. A6 en verde salvo T18 al cerrarla: `rust:hooks-sync -- --check`, `rust:verify` de `general-purpose-confirm` (15 casos y 2000 de fuzz), oráculo `spec` 119/119 y `facts_cache` y `hook_facts`.
- [x] **T18** (R76) — `navori_core::process::ProcessRunner` (real y grabado) y stubs de oráculo para `git`, `gh`, `acli`, `codex`, `npm`, `tgrep`, `codegraph` y `pi` que responden por argv desde `scripts/js/rust-oracle/recordings/` con la versión de la herramienta que produjo cada grabación (D42; antes en E2, se adelanta porque la usan E2 y E3) · effect: behavior · test: `crates/navori-core/tests/process_runner.rs`::"la respuesta grabada se sirve por argv y registra la llamada"
  - Cerrado (2026-11-01): `process::{Request, ProcessRunner, RealRunner, RecordedRunner}`; la grabada lee `recordings/<herramienta>.json` (`schema` 1, `tool`, `version` y `responses` con `args`, `status`, `stdout` y `stderr`), responde por nombre de archivo del programa y argv exacto, y guarda cada llamada con la versión que la contestó (`None` si ninguna). Un caso del oráculo con `tools` pone stubs de esas herramientas primero en `PATH` (`stub-tool.mjs`); sin grabación salen con 127 en los dos lados, nunca llaman a la herramienta real, y el oráculo compara las llamadas de TS y Rust. Grabaciones iniciales: `git --version` y `gh --version`; cada comando que llegue con E2 o E3 agrega las suyas. `Output` sigue sin `stderr`, porque ningún llamador lo lee todavía. A6 completo en verde.

## E2 — Auditoría, gate y telemetría de sesión
Estimated LOC: 22000

### M7 — Auditoría, gate, recibos y telemetría
Entregable: `audit`, `gate`, `receipt`, `bench` y el resto de `tools` son nativos, y
`audit-mode-trigger`, `audit-mode-close`, `bash-outcome-watch`, `routing-watch` y
`stop-verify-reminder` deciden en Rust en `shadow`.
- **A7** [observable] — el área E2 está completa · `bun run oracle:rust --only audit,gate,receipt,bench,tools && node scripts/js/hook-verdict-replay.mjs --impl rust --only audit-mode-trigger.sh,audit-mode-close.sh,bash-outcome-watch.sh,routing-watch.sh,stop-verify-reminder.sh && cd packages/cli && bun run vitest run src/__tests__/rust-areas.test.ts -t E2` → exit 0; 0 diferencias
- [ ] **T19** (R73, R74, R76) — `audit` nativo por las capas de D44: sesión (`--arm`, `--start`, `--close`, log por sesión y escritor de eventos), recolección y reporte con sus formatos, y el resto de subcomandos y flags; lo raro se delega (D48) · effect: behavior · test: `scripts/js/rust-oracle/cases/`::"audit en todos sus subcomandos"
- [ ] **T20** (R73, R74, R76) — `gate fast`, `gate full` y `gate foreign` por el `ProcessRunner`, `receipt` (todos sus subcomandos), `bench` y el resto de `tools` nativos · effect: behavior · test: `scripts/js/rust-oracle/cases/`::"gate, receipt, bench y tools"
- [ ] **T21** (R70, R71, R72) — los cinco hooks de E2 en `shadow`: `audit` en proceso bajo la condición de versión de R53 de 0059, estado compartido de `bash-outcome` igual que el shell; corpus sembrado solo donde falte una clase · effect: behavior · test: `packages/cli/src/__tests__/hook-verdict-replay.test.ts`::"los hooks de E2 cubren cada clase de veredicto y modo por engine"
- [ ] **T22** (R77, R78) — inventario del área E2 en verde con E3 fuera del manifiesto, contando la lista de delegación permanente (D48) · effect: tests · test: `packages/cli/src/__tests__/rust-areas.test.ts`::"E2 completa sin E3"

## E3 — Instalación, mantenimiento y salud del repo
Estimated LOC: 25000

### M8 — Salud y mantenimiento
Entregable: `doctor`, `status`, `scan`, `migrations` y `backup` son nativos, y `managed-drift-watch`
y `worktree-reclaim` deciden en Rust en `shadow`. Empieza ya: no escribe por el render
multi-engine.
- **A8** [observable] — salud y mantenimiento son nativos y sus hooks reproducen el corpus · `bun run oracle:rust --only doctor,status,scan,migrations,backup && node scripts/js/hook-verdict-replay.mjs --impl rust --only managed-drift-watch.sh,worktree-reclaim.sh` → exit 0; 0 diferencias
  - La mitad de replay de hooks de A8 (`hook-verdict-replay.mjs ... managed-drift-watch.sh,worktree-reclaim.sh`) cierra con T25 en el PR 2 (Q32); la mitad de oráculo cierra el PR 4.
- [ ] **T23** (R73, R76) — `doctor` (`lib/diagnose` completo), `status` y `scan` nativos, con las herramientas externas por el `ProcessRunner` · effect: behavior · test: `scripts/js/rust-oracle/cases/`::"doctor, status y scan en cada fixture"
  - Avance (2026-11-02): `scan` es nativo (sin config, fuera de un monorepo, sin patrones, el resumen con las listas de nuevos y huérfanos, la config al día y `--yes`, que escribe por `writeConfig`); delega al TS `scan` sin `--yes` cuando hay workspaces que agregar (interactivo), los workspaces de Python (`pyproject` o `requirements`) y las rutas o entradas fuera de la collation o el formato modelados. Faltan `status` y `doctor`.
- [ ] **T24** (R73, R74) — `migrations` y `backup` (incluido `backup restore`) nativos · effect: behavior · test: `scripts/js/rust-oracle/cases/`::"migrations y backup"
  - Avance (2026-10-31): `backup` (`list`, `restore --yes`, `prune`) y `migrations` (`list`, `restore --yes` y el `list` por defecto) son nativos, con la salida de clack sin color; `restore` sin `--yes` (confirmación interactiva) sigue en el TS. `refresh` es de T27.
- [ ] **T25** (R70, R71, R74) — `managed-drift-watch` y `worktree-reclaim` en `shadow`; las eliminaciones de `worktree-reclaim` pasan por la capa `Fs` en modo registro durante la sombra · effect: behavior · test: `packages/cli/src/__tests__/hook-verdict-replay.test.ts`::"los hooks de E3 cubren cada clase de veredicto y modo por engine"

### M9 — Instalación, actualización, workspaces y Codex
Entregable: `init`, `add`, `configure`, `preset`, `update`, `refresh`, `workspace`, `registry`,
`ticket` y `codex` son nativos con los mismos prompts que el TS, y ningún subcomando de `cli.ts`
queda fuera del manifiesto ni de la lista de delegación permanente. Espera a 0059 E2: estos
comandos escriben por el render multi-engine.
- **A9** [observable] — el área E3 está completa · `bun run oracle:rust --only init,add,configure,preset,update,refresh,workspace,registry,ticket,codex && cargo test -p navori-oracle-tests --test prompts --locked && cd packages/cli && bun run vitest run src/__tests__/rust-areas.test.ts -t E3` → exit 0; 0 diferencias
- [ ] **T26** (R73, R74, R75) — `init`, `add`, `configure` y `preset` nativos, con escrituras por la capa `Fs` y guiones de prompts bajo pseudo-TTY con `expectrl` (D43) · effect: behavior · test: `crates/navori-oracle-tests/tests/prompts.rs`::"init, add, configure y preset preguntan lo mismo que el TS"
  - Avance (2026-10-31): `preset init` es nativo (manifiesto, bloque y skill de ejemplo en español o inglés, y `preset` fijado por `writeConfig`), con la salida de clack; faltan `init`, `add` y `configure`, y los guiones de prompts.
- [ ] **T27** (R73, R74, R76) — `update` (con `npm` grabado) y `refresh` nativos, por el render multi-engine de 0059 E2 · effect: behavior · test: `scripts/js/rust-oracle/cases/`::"update y refresh"
- [ ] **T28** (R73, R74, R75, R76) — `workspace` (con su guion de prompts), `registry`, `ticket` y `codex` (perfil, aprobación, integración y evaluación, sin escribir `~/.codex/config.toml` más allá de lo que escribe el TS) nativos · effect: behavior · test: `scripts/js/rust-oracle/cases/`::"workspace, registry, ticket y codex"
  - Avance (2026-10-31): `registry` (`ls`, `scan`, `add`, `remove`, `prune`) es nativo, con su lock, el orden por `localeCompare` modelado y la detección de worktrees; faltan `workspace`, `ticket` y `codex`.
- [ ] **T29** (R77) — inventario del área E3 en verde; con E1–E3 integradas, todo subcomando y flag de `cli.ts` está en el manifiesto o en la lista de delegación permanente (D48) · effect: tests · test: `packages/cli/src/__tests__/rust-areas.test.ts`::"E3 completa y ningún subcomando sin dueño"
