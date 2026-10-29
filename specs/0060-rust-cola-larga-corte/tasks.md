# Migración a Rust, fase 4: cola larga, activaciones, distribución y corte — Tasks

**Estado:** aceptada para desarrollo (Q20, Q21 y Q25 resueltas; Q22–Q24 abiertas en `design.md`,
ninguna bloquea E1) · **Base:** `migration/rust`. Fase 4 del programa (ver
`specs/0057-migracion-rust/requirements.md` § "Fases del programa"): seis entregas, cada una con su
propio PR. E1–E5 van contra `migration/rust`; E6 es el único PR contra `dev`. El LOC es una
referencia gruesa, no una medición.

Correspondencia con el "Plan de entregas" de 0057: E1–E3 equivalen a E8 (cola larga), repartida en
vertical slices (Q21); E4 reúne T27 de 0057, E1 de 0058 y E3 de 0059; E5 equivale a E9 y E6 a E10.

**Cómo leer este archivo.** Cada milestone de E1–E3 es un slice vertical: abre con su
**entregable** (lo que corre en Rust al cerrarlo) y se cierra con su `A<n>`. M1 y M2 son los slices
de referencia (Q25): fijan el patrón de hooks y de comandos que repiten los demás.

**PRs**

| PR | Entrega | Entregable | Se mergea cuando |
|---|---|---|---|
| 1 | E1 | Orquestación y gobierno de agentes en Rust: `spec`, `master`, `handoff`, `plan`, `dominio` nativos y sus 8 hooks en `shadow` | A1–A5 verdes, 0059 E1 integrada, `bun check` completo, `cargo test`, `rust.yml` verde y revisión independiente |
| 2 | E2 | Auditoría, gate y telemetría en Rust: `audit`, `gate`, `receipt`, `bench`, `tools` nativos y sus 5 hooks en `shadow` | A6–A8 verdes y lo mismo que PR 1 |
| 3 | E3 | Instalación y salud del repo en Rust: `doctor`, `init`, `add`, `configure`, `update`, `workspace`, `codex` y el resto, con sus 2 hooks en `shadow` | A9–A12 verdes y lo mismo que PR 1 |
| 4 | E4 | Los 22 hooks deciden en Rust (`active`) | A13–A14 verdes, resumen de sombra adjunto y aprobación del usuario en el PR |
| 5 | E5 | El paquete instala y responde en macOS y Linux, sin publicar | A15–A17 verdes |
| 6 | E6 | `navori` es el binario Rust en `dev` | A18 verde y aprobación explícita del usuario (R20) |

**Precondiciones de entrada:**
- **E1:** M1 y M2 empiezan ya. M3–M5 usan la base de hooks de 0059 E1 (T3 y T4 de 0059: versión del
  `navori` de `PATH` y ejecutor de subcomandos); el PR de E1 se integra después de 0059 E1.
- **E2:** E1 integrada.
- **E3:** E2, 0058 E3 y 0059 E2 integradas (`render`, `sync`, `remove` y `adopt` nativos para todos
  los engines).
- **E4:** E1–E3 integradas; para cada hook, su ventana de sombra cumplida (R81) o la excepción de
  R82 aprobada.
- **E5:** E4 integrada. **E6:** E5 integrada y aprobación explícita del usuario.

Reglas de ejecución:
- Workplan por entrega: `0060-rust-cola-larga-corte-e<n>`, con fases = milestones; `tasks.md` es el
  tracking canónico.
- Cada prueba nueva lleva `// Covers: R<n>` (Rust y TS). Los casos nombrados son planeados; los
  archivos nuevos se crean en el milestone que los nombra.
- Los milestones que tocan Rust corren `cargo fmt --check && cargo clippy --workspace --all-targets
  --locked -- -D warnings && cargo test --workspace --locked`, además de `bun run check:fast` y sus
  `A<n>`. `navori gate full` no corre `cargo test`: el cierre de cada entrega corre los dos, más
  `rust.yml` en verde y revisión independiente.
- Sin subagentes por instrucción del usuario mientras no se resuelva Q23: cada PR queda con revisión
  independiente pendiente antes del merge. Antes de abrir cada entrega, la rama se actualiza con
  `origin/migration/rust`, que a su vez sincroniza `dev` (D10 de 0057).
- Hooks, render, markers, escrituras y distribución son área crítica: un commit por mecanismo.
  Ningún hook pasa a `active` fuera de E4.

## E1 — Orquestación y gobierno de agentes
Estimated LOC: 16000

### M1 — Slice de referencia de hooks: confirmaciones de publicación
Entregable: `comment-draft-confirm` y `pr-publisher-confirm` deciden en Rust en `shadow` en cada
engine donde están registrados, y existe el inventario por área.
- **A1** [observable] — los dos hooks reproducen el corpus y el fuzz, y todo subcomando y hook tiene área · `node scripts/js/hook-verdict-replay.mjs --impl rust --only comment-draft-confirm.sh,pr-publisher-confirm.sh && for h in comment-draft-confirm pr-publisher-confirm; do bun run fuzz:hooks --hook "$h.sh" --seed 1 --cases 20000 || exit 1; done && cd packages/cli && bun run vitest run src/__tests__/rust-areas.test.ts` → exit 0; 0 divergencias
- [ ] **T1** (R77, R78) — `scripts/js/rust-areas.mjs` con `inventory()` (subcomandos y flags de `cli.ts` desde `dist/`, hooks de `core-assets` y plugins), `areaOf()` con la tabla de D40 y `areaInventoryCheck(area, manifest)`, que también corre con las otras áreas de la fase retiradas del manifiesto (D41, F39) · effect: behavior · test: `packages/cli/src/__tests__/rust-areas.test.ts`::"todo subcomando, flag y hook tiene un área"
- [ ] **T2** (R71) — corpus de `comment-draft-confirm` y `pr-publisher-confirm` con al menos un caso por clase de veredicto en cada engine registrado; `coverage.json` regenerado · effect: tests · test: `packages/cli/src/__tests__/hook-verdict-replay.test.ts`::"las confirmaciones de publicación cubren cada clase de veredicto por engine"
- [ ] **T3** (R70) — `navori-hooks` (`hooks/publish_confirm`): parciales `gate-trigger` y `draft-body` y los dos hooks, con el borrador citado en la razón y el evento de auditoría igual que el shell; entrada `mode: "shadow"` en `ported.json` con sus `blocks` y `deps` · effect: behavior · test: `crates/navori-hooks/tests/publish_confirm.rs`::"veredictos del corpus en shadow"
- [ ] **T4** (R70) — fuzz de las dos confirmaciones: gramática de `gh pr create`, `gh pr/issue comment`, `gh pr review` e `gh issue create` con sus formas inertes, en `hook-fuzz.mjs` · effect: tests · test: `packages/cli/src/__tests__/hook-fuzz.test.ts`::"la gramática de publicación cubre cada forma que publica y sus formas inertes"

### M2 — Slice de referencia de comandos: `spec`
Entregable: `navori-rust spec` (todos sus subcomandos y flags) es nativo con diferencial cero.
- **A2** [observable] — `spec` es nativo y su área no tiene pendientes de `spec` · `bun run oracle:rust --only spec && cd packages/cli && bun run vitest run src/__tests__/rust-areas.test.ts -t spec` → exit 0; 0 diferencias
- [ ] **T5** (R73) — `spec` nativo (check, classify y el resto), con la gramática E/M/A/T y la clasificación de `lib/spec` · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"spec check y classify sobre las specs reales y fixtures con errores"
- [ ] **T6** (R77) — `spec` sin subcomandos ni flags fuera del manifiesto · effect: tests · test: `packages/cli/src/__tests__/rust-areas.test.ts`::"spec no tiene subcomandos ni flags pendientes"

### M3 — Master plan
Entregable: `navori-rust master` es nativo y `master-plan-context` y `master-accept-confirm` deciden
en Rust en `shadow`.
- **A3** [observable] — `master` es nativo y sus dos hooks reproducen el corpus · `bun run oracle:rust --only master && node scripts/js/hook-verdict-replay.mjs --impl rust --only master-plan-context.sh,master-accept-confirm.sh && bun run fuzz:hooks --hook master-accept-confirm.sh --seed 1 --cases 100000` → exit 0; 0 diferencias
- [ ] **T7** (R71) — corpus de `master-plan-context`, `master-accept-confirm`, `implementer-no-markdown`, `role-guard`, `general-purpose-confirm` y `engram-write-guard` por clase de veredicto y modo en cada engine registrado · effect: tests · test: `packages/cli/src/__tests__/hook-verdict-replay.test.ts`::"los hooks de E1 cubren cada clase de veredicto y modo por engine"
- [ ] **T8** (R73, R74) — `master` nativo (todos sus subcomandos), con sus escrituras de estado por la capa `Fs` · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"master status, part, close y el resto"
- [ ] **T9** (R70, R72) — `master-plan-context` y `master-accept-confirm` en `shadow`, con `master` en proceso bajo la condición de versión de R53 de 0059 y por el `navori` de `PATH` en otro caso · effect: behavior · test: `crates/navori-hooks/tests/master_hooks.rs`::"veredictos del corpus en shadow"

### M4 — Handoff y plan
Entregable: `navori-rust handoff` y `plan` son nativos e `implementer-no-markdown` decide en Rust en
`shadow`.
- **A4** [observable] — `handoff` y `plan` son nativos y el hook reproduce el corpus · `bun run oracle:rust --only handoff,plan && node scripts/js/hook-verdict-replay.mjs --impl rust --only implementer-no-markdown.sh && bun run fuzz:hooks --hook implementer-no-markdown.sh --seed 1 --cases 100000` → exit 0; 0 diferencias
- [ ] **T10** (R73, R74) — `handoff` nativo (check, render, prepare-parallel, finalize-parallel y el resto) · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"handoff en todos sus subcomandos"
- [ ] **T11** (R73, R74) — `plan` nativo en lo que 0059 no porta (classify, render, check, update, escalation-reset, resume y el resto) · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"plan sin subcomandos pendientes"
- [ ] **T12** (R70) — `implementer-no-markdown` en `shadow` · effect: behavior · test: `crates/navori-hooks/tests/implementer_no_markdown.rs`::"veredictos del corpus en shadow"

### M5 — Gobierno de agentes
Entregable: `role-guard`, `general-purpose-confirm` y `engram-write-guard` deciden en Rust en
`shadow`, `dominio` es nativo completo y el área E1 no tiene pendientes.
- **A5** [observable] — el área E1 está completa · `bun run oracle:rust --only dominio && node scripts/js/hook-verdict-replay.mjs --impl rust --only role-guard.sh,general-purpose-confirm.sh,engram-write-guard.sh && for h in role-guard general-purpose-confirm; do bun run fuzz:hooks --hook "$h.sh" --seed 1 --cases 100000 || exit 1; done && cd packages/cli && bun run vitest run src/__tests__/rust-areas.test.ts -t E1` → exit 0; 0 diferencias
- [ ] **T13** (R70) — `role-guard`, `general-purpose-confirm` y `engram-write-guard` en `shadow` en los engines donde están registrados · effect: behavior · test: `crates/navori-hooks/tests/agent_governance.rs`::"veredictos del corpus en shadow"
- [ ] **T14** (R73) — el resto de `dominio` nativo (0059 porta `dominio inject`) · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"dominio sin subcomandos pendientes"
- [ ] **T15** (R77, R78) — test de inventario del área E1 en verde, con E2 y E3 fuera del manifiesto · effect: tests · test: `packages/cli/src/__tests__/rust-areas.test.ts`::"E1 completa sin E2 ni E3"

## E2 — Auditoría, gate y telemetría de sesión
Estimated LOC: 22000

### M6 — Sesión de auditoría
Entregable: `navori-rust audit --arm|--start|--close` es nativo y `audit-mode-trigger` y
`audit-mode-close` deciden en Rust en `shadow`.
- **Consumes:** `bun run oracle:rust --only audit` → ejecuta `navori-rust audit --arm|--start|--close` contra el TS sobre los fixtures
- **A6** [observable] — la sesión de auditoría es nativa y sus dos hooks reproducen el corpus · `bun run oracle:rust --only audit && node scripts/js/hook-verdict-replay.mjs --impl rust --only audit-mode-trigger.sh,audit-mode-close.sh && bun run fuzz:hooks --hook audit-mode-trigger.sh --seed 1 --cases 20000` → exit 0; 0 diferencias
- [ ] **T16** (R71) — corpus de los cinco hooks de E2 por clase de veredicto y modo en cada engine registrado · effect: tests · test: `packages/cli/src/__tests__/hook-verdict-replay.test.ts`::"los hooks de E2 cubren cada clase de veredicto y modo por engine"
- [ ] **T17** (R73, R74) — `audit --arm`, `--start` y `--close` nativos: log por sesión, spool y cierre por el escritor de eventos de D12 de 0057, con sus escrituras por la capa `Fs` (D44) · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"audit arm, start y close nativos"
- [ ] **T18** (R70, R72) — `audit-mode-trigger` y `audit-mode-close` en `shadow`, con `audit` en proceso bajo la condición de versión de R53 de 0059 · effect: behavior · test: `crates/navori-hooks/tests/audit_mode.rs`::"veredictos del corpus en shadow"

### M7 — Recolección y reporte de auditoría
Entregable: `navori-rust audit` completo es nativo.
- **A7** [observable] — `audit` no tiene subcomandos ni flags pendientes · `bun run oracle:rust --only audit && cd packages/cli && bun run vitest run src/__tests__/rust-areas.test.ts -t audit` → exit 0, 0 diferencias
- [ ] **T19** (R73, R76) — `audit` collect y report nativos, con sus formatos y la consulta de salud del puente local por el transporte de D42 (D44) · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"audit collect y report en sus formatos"
- [ ] **T20** (R73) — el resto de subcomandos y flags de `audit` que marque `areaInventoryCheck` (D44) · effect: behavior · test: `packages/cli/src/__tests__/rust-areas.test.ts`::"audit no tiene subcomandos ni flags pendientes"

### M8 — Gate, recibos y telemetría
Entregable: `gate`, `receipt`, `bench` y `tools` son nativos, `bash-outcome-watch`, `routing-watch` y
`stop-verify-reminder` deciden en Rust en `shadow` y el área E2 no tiene pendientes.
- **A8** [observable] — el área E2 está completa · `cargo test -p navori-core --test process_runner --locked && bun run oracle:rust --only gate,receipt,bench,tools && node scripts/js/hook-verdict-replay.mjs --impl rust --only bash-outcome-watch.sh,routing-watch.sh,stop-verify-reminder.sh && for h in bash-outcome-watch routing-watch; do bun run fuzz:hooks --hook "$h.sh" --seed 1 --cases 20000 || exit 1; done && cd packages/cli && bun run vitest run src/__tests__/rust-areas.test.ts -t E2` → exit 0; 0 diferencias
- [ ] **T21** (R76) — `navori_core::process::ProcessRunner` (real y grabado) y stubs de oráculo para `git`, `gh`, `acli`, `codex`, `npm`, `tgrep`, `codegraph` y `pi` que responden por argv desde `scripts/js/rust-oracle/recordings/`, con la versión de la herramienta que produjo cada grabación (D42, F41) · effect: behavior · test: `crates/navori-core/tests/process_runner.rs`::"la respuesta grabada se sirve por argv y registra la llamada"
- [ ] **T22** (R73, R76) — `gate fast`, `gate full` y `gate foreign` nativos, con la ejecución del gate configurado por el `ProcessRunner` y el mismo registro de resultado que el TS · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"gate fast, full y foreign"
- [ ] **T23** (R73, R74) — `receipt` (todos sus subcomandos), `bench` y el resto de `tools` nativos · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"receipt, bench y tools"
- [ ] **T24** (R70) — `bash-outcome-watch`, `routing-watch` y `stop-verify-reminder` en `shadow`, con el estado compartido de `bash-outcome` igual que el shell · effect: behavior · test: `crates/navori-hooks/tests/session_telemetry.rs`::"veredictos del corpus en shadow"
- [ ] **T25** (R77, R78) — test de inventario del área E2 en verde, con E3 fuera del manifiesto · effect: tests · test: `packages/cli/src/__tests__/rust-areas.test.ts`::"E2 completa sin E3"

## E3 — Instalación, mantenimiento y salud del repo
Estimated LOC: 25000

### M9 — Salud del repo
Entregable: `doctor`, `status` y `scan` son nativos y `managed-drift-watch` y `worktree-reclaim`
deciden en Rust en `shadow`.
- **A9** [observable] — `doctor`, `status` y `scan` son nativos y sus dos hooks reproducen el corpus · `bun run oracle:rust --only doctor,status,scan && node scripts/js/hook-verdict-replay.mjs --impl rust --only managed-drift-watch.sh,worktree-reclaim.sh && bun run fuzz:hooks --hook managed-drift-watch.sh --seed 1 --cases 20000` → exit 0; 0 diferencias
- [ ] **T26** (R71) — corpus de `managed-drift-watch` y `worktree-reclaim` por clase de veredicto y modo en cada engine registrado · effect: tests · test: `packages/cli/src/__tests__/hook-verdict-replay.test.ts`::"los hooks de E3 cubren cada clase de veredicto y modo por engine"
- [ ] **T27** (R73, R76) — `doctor` nativo (`lib/diagnose` completo: chequeos, contratos del host y su salida), con las herramientas externas por el `ProcessRunner` · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"doctor en cada fixture"
- [ ] **T28** (R73) — `status` y `scan` nativos · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"status y scan"
- [ ] **T29** (R70, R74) — `managed-drift-watch` y `worktree-reclaim` en `shadow`; las eliminaciones de `worktree-reclaim` pasan por la capa `Fs` en modo registro durante la sombra · effect: behavior · test: `crates/navori-hooks/tests/repo_health.rs`::"veredictos del corpus en shadow sin borrar en sombra"

### M10 — Instalación
Entregable: `init`, `add`, `configure` y `preset` son nativos, con los mismos prompts que el TS.
- **A10** [observable] — los cuatro comandos son nativos con diferencial cero y los mismos prompts · `bun run oracle:rust --only init,add,configure,preset && cargo test -p navori-oracle-tests --test prompts --locked` → exit 0; 0 diferencias
- [ ] **T30** (R73, R74) — `init` y `add` nativos, con sus escrituras por la capa `Fs` y el oráculo de escrituras · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"init y add escriben lo mismo que el TS"
- [ ] **T31** (R73, R74) — `configure` y `preset` nativos · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"configure y preset"
- [ ] **T32** (R75) — guiones de prompts de `init`, `add`, `configure` y `preset` bajo pseudo-TTY con `expectrl`, y su salida no-TTY byte a byte (D43) · effect: tests · test: `crates/navori-oracle-tests/tests/prompts.rs`::"init, add, configure y preset preguntan lo mismo que el TS"

### M11 — Mantenimiento
Entregable: `update`, `refresh`, `migrations` y `backup` son nativos.
- **A11** [observable] — los cuatro comandos son nativos · `bun run oracle:rust --only update,refresh,migrations,backup && cargo test -p navori-oracle-tests --test prompts --locked` → exit 0; 0 diferencias
- [ ] **T33** (R73, R74, R76) — `update` nativo, con `npm` por el `ProcessRunner` y el guion de prompts · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"update con npm grabado"
- [ ] **T34** (R73, R74) — `refresh`, `migrations` y `backup` nativos (incluido `backup restore`) · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"refresh, migrations y backup"

### M12 — Workspaces, registro, tickets y Codex
Entregable: `workspace`, `registry`, `ticket` y `codex` son nativos y ningún subcomando de `cli.ts`
queda fuera del manifiesto.
- **A12** [observable] — el área E3 está completa · `bun run oracle:rust --only workspace,registry,ticket,codex && cd packages/cli && bun run vitest run src/__tests__/rust-areas.test.ts -t E3` → exit 0; 0 diferencias
- [ ] **T35** (R73, R74, R75) — `workspace`, `registry` y `ticket` nativos, con el guion de prompts de `workspace` · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"workspace, registry y ticket"
- [ ] **T36** (R73, R76) — `codex` nativo (perfil, aprobación, integración y evaluación), con `codex` por el `ProcessRunner` y sin escribir `~/.codex/config.toml` más allá de lo que escribe el TS · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"codex en todos sus subcomandos"
- [ ] **T37** (R77) — test de inventario del área E3 en verde; con E1–E3 integradas, `cli.ts` no tiene subcomandos ni flags fuera del manifiesto · effect: tests · test: `packages/cli/src/__tests__/rust-areas.test.ts`::"E3 completa y ningún subcomando pendiente"

## E4 — Activación de los hooks
Estimated LOC: 4000

### M13 — Evidencia previa a la activación
Entregable: un reporte de sombra por hook y engine dice qué hooks pueden activarse.
- **Consumes:** `node scripts/js/hook-shadow-report.mjs` → lee el ledger de sombra que deja `navori-rust hook --shadow` en sesiones reales
- **A13** [observable] — corpus, fuzz y sombra cumplen R81 o R82 para cada hook, y el manifiesto valida transiciones · `node scripts/js/hook-verdict-replay.mjs --impl rust && node scripts/js/hook-shadow-report.mjs --class-thresholds && cd packages/cli && bun run vitest run src/__tests__/rust-manifest-check.test.ts src/__tests__/hook-shadow-report.test.ts` → exit 0; 0 divergencias; cada hook con su umbral o su excepción aprobada
- [ ] **T38** (R81, R82) — `scripts/js/hook-shadow-report.mjs`: invocaciones y divergencias por hook y engine en la ventana, umbral por clase de D45 y la excepción a 30 días; falla si un engine registrado no llega y no hay excepción aprobada · effect: behavior · test: `packages/cli/src/__tests__/hook-shadow-report.test.ts`::"un hook bajo su umbral sin excepción deja el reporte en rojo"
- [ ] **T39** (R79, R80) — `scripts/js/rust-manifest-check.mjs`: `shadow` → `active` exige `shadow` en la merge-base y una línea `activate` nueva; `active` → `shadow` exige `deactivate`; una línea `activate` con `reason: "below-threshold"` exige el conteo real (D45) · effect: behavior · test: `packages/cli/src/__tests__/rust-manifest-check.test.ts`::"activar sin línea activate o sin sombra previa falla"
- [ ] **T40** (R81) — verificación del corpus por clase de los siete hooks de las fases 1–3 (R29 de 0058, R54 de 0059) y fuzz de los 22 hooks con el número de casos de R81, con el resumen listo para el PR · effect: tests · test: `packages/cli/src/__tests__/hook-verdict-replay.test.ts`::"cada hook portado cubre cada clase de veredicto y modo por engine"

### M14 — Activación
Entregable: los 22 hooks deciden en Rust en los tres engines.
- **A14** [observable] — Rust decide en los tres engines y ninguna salida anómala permite · `cargo test -p navori-hooks --locked && cd packages/cli && bun run vitest run src/__tests__/native-hook-failclosed.test.ts src/__tests__/rust-manifest-check.test.ts` → exit 0
- [ ] **T41** (R81, R82) — `ported.json` pasa a `active` los 22 hooks que cumplen R81 o R82, con una línea `activate` por hook, el resumen de M13 en el PR y la aprobación del usuario (incluye T27 de 0057, T4 de 0058 y T35 de 0059) · effect: behavior · test: `crates/navori-hooks/tests/activation.rs`::"modo active responde Rust en cada hook activado"
- [ ] **T42** (R83) — matriz fail-closed de T8 de 0057 sobre cada hook con compuerta en `active`, invocado por el comando registrado exacto de cada engine (incluye T5 de 0058 y T36 de 0059) · effect: tests · test: `packages/cli/src/__tests__/native-hook-failclosed.test.ts`::"ningún hook activo con compuerta permite ante SIGSEGV, 101 o stdout cerrado"
- [ ] **T43** (R83) — re-render de los scripts de los tres engines con el fragmento activo y actualización revisada a mano de `wiring.snap` (incluye T6 de 0058) · effect: behavior · test: `crates/navori-hooks/tests/golden/wiring.snap`::"todos los hooks active"

## E5 — Ensayo de distribución, sin publicar
Estimated LOC: 3500

### M15 — Binarios y paquetes
Entregable: un tarball local con lanzador, binarios y TS congelado.
- **A15** [observable] — el workflow construye los cuatro binarios y el tarball instala con lanzador, binario y TS congelado · `npm pack --dry-run --workspace navori && cd packages/cli && bun run vitest run src/__tests__/dist-launcher.test.ts` → exit 0
- [ ] **T44** (R21) — workflow de release que construye darwin arm64/x64 y linux arm64/x64 (musl estático) y los tarballs de plataforma, sin publicar (D46) · effect: behavior · test: `.github/workflows/rust-release.yml`::"cuatro binarios sin publicar"
- [ ] **T45** (R22) — paquete `navori` con lanzador JS, `optionalDependencies` por plataforma, `postinstall` que enlaza solo si `--version` coincide y `legacy/` con el `dist/` exacto del último TS publicado verificado por `integrity` (D46) · effect: behavior · test: `packages/cli/src/__tests__/dist-launcher.test.ts`::"sin binario corre legacy y sin postinstall corre el binario por Node"

### M16 — Sondas de instalación
Entregable: npm, pnpm y bun instalan y responden en cada plataforma con binario.
- **A16** [observable] — las sondas pasan en cada plataforma con binario · `node scripts/js/dist-probe.mjs` → exit 0 en darwin arm64/x64 y linux arm64/x64
- [ ] **T46** (R84) — `scripts/js/dist-probe.mjs`: instala el tarball local con npm, pnpm y bun, con y sin scripts, y verifica `navori --version` y un bloqueo de `guard-destructive`; usa el scope npm que resuelva Q24 · effect: behavior · test: `packages/cli/src/__tests__/dist-probe.test.ts`::"cada gestor responde con el binario o el binario por Node"

### M17 — Gate posterior al corte
Entregable: `check:post-cutover` cabe en 5 minutos y `cutover:check` está en verde.
- **A17** [observable] — el gate posterior al corte cabe en 5 minutos y `cutover:check` está en verde · `bun run check:post-cutover && bun run cutover:check` → exit 0; tiempo registrado ≤ 300 s
- [ ] **T47** (R18) — `check:post-cutover` en `package.json` (cargo, oráculo congelado de hooks, suites de artefacto y checks de docs y render, sin la suite TS), cronometrado en reposo con su registro (D46) · effect: behavior · test: `packages/cli/src/__tests__/post-cutover-gate.test.ts`::"el gate posterior al corte no incluye la suite TS y registra su tiempo"
- [ ] **T48** (R20) — `scripts/js/cutover-check.mjs` y `bun run cutover:check`: inventario completo por D41, ningún hook en `shadow`, ningún despoteo abierto, R17 y R18 cumplidos · effect: behavior · test: `packages/cli/src/__tests__/cutover-check.test.ts`::"falla con un hook en shadow o un subcomando fuera del manifiesto"
- [ ] **T49** (R85, R76) — avisos de actualización y de versión de herramientas en Rust por un `HttpClient` grabado, apagados durante la convivencia (D42) · effect: behavior · test: `crates/navori-cli/tests/notices.rs`::"el aviso coincide con el TS en versión nueva, igual, error y tiempo agotado"

## E6 — Corte
Estimated LOC: 2000

### M18 — PR de `migration/rust` a `dev`
Entregable: `navori` es el binario Rust en `dev`, con el TS congelado como respaldo.
- **A18** [observable] — el corte cumple R20 y R24 con el gate full verde · `bun run cutover:check && bun run check:post-cutover && cargo test --workspace --locked` → exit 0, con la aprobación del usuario registrada en el PR
- [ ] **T50** (R24, R20) — PR único a `dev`: re-apunta `rust.yml` a `dev`, añade el workflow de release, el empaquetado y `legacy/`, borra `packages/cli/src` con sus tests salvo las suites de artefacto, elimina la delegación y el oráculo TS, con la aprobación explícita del usuario (D46) · effect: behavior · test: `packages/cli/src/__tests__/cutover-check.test.ts`::"el árbol de corte no conserva la delegación ni la suite TS"
- [ ] **T51** (R85) — avisos de actualización y de versión de herramientas encendidos en el binario publicado · effect: behavior · test: `crates/navori-cli/tests/notices.rs`::"tras el corte el aviso se muestra con la versión del paquete"
- [ ] **T52** (R21, R22) — release con binarios macOS y Linux y TS congelado para las demás plataformas, documentado en README § Releases · effect: docs · test: `README.md`::"Releases"
