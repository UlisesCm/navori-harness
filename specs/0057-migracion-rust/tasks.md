# Migración de navori a Rust — Tasks

**Estado:** E2 en progreso; documentación de E1 pendiente · **Base:** `migration/rust`. Fase 1 del programa (ver `requirements.md` §
"Fases del programa"): tres entregas, cada una un PR contra `migration/rust`. El LOC es una
estimación, no una medición.

Correspondencia con `design.md` § "Plan de entregas": E1–E3 son las mismas entregas del diseño. E4 en
adelante, y E-Pi, pertenecen a las specs de fase 0058–0060.

Reglas de ejecución:
- Workplan por entrega: `0057-migracion-rust-e<n>`, con fases = milestones; `tasks.md` es el
  tracking canónico.
- Cada prueba nueva lleva `// Covers: R<n>` (Rust y TS). Los casos nombrados son planeados; los
  archivos nuevos se crean en el milestone que los nombra.
- Los milestones que tocan Rust corren `cargo fmt --check && cargo clippy --all-targets -- -D warnings
  && cargo test --workspace` además de `bun run check:fast` y sus `A<n>`. El cierre de cada entrega
  corre `bun check` completo, `rust.yml` en verde y un reviewer fresco.
- Hooks, render, sync y backup son área crítica: un commit por mecanismo; un hook nunca pasa de
  `shadow` a `active` sin los criterios de D9 y sin aprobación del usuario en el PR de activación.
- `dev` se incorpora a `migration/rust` por merge (D1, R23); los conflictos siguen las cuatro clases
  de D1.

## E1 — Cimientos (foundation)
Estimated LOC: 3500

### M1 — Dirección y esqueleto
- **A1** [observable] — DIRECTION enmendada, workspace compila y `--version` nativo · `cargo build --locked -p navori-cli && ./target/debug/navori-rust --version` → imprime `0.13.0-rust.1` (versión del workspace cargo), exit 0
- [x] **T1** (R1) — `docs/DIRECTION.md` § "Non-goals" y una sección nueva de convivencia: retira "Rust control plane", registra la migración, la rama `migration/rust`, el sentido único de sincronización y su porqué · effect: docs · test: `docs/DIRECTION.md`::"Rust migration"
- [x] **T2** (R2, R16) — `Cargo.toml` del workspace (`resolver = "3"`, `[workspace.lints]` con `unsafe_code`, `clippy::unwrap_used` y `clippy::expect_used` en deny), `rust-toolchain.toml` con `channel = "1.99.1"` y los cuatro targets, `Cargo.lock` versionado; crates `navori-core`, `navori-hooks`, `navori-cli` y `navori-oracle-tests` vacíos · effect: behavior · test: `crates/navori-cli/tests/lints.rs`::"un unwrap en código de producción no pasa clippy"
- [x] **T3** (R17) — `crates/navori-core/build.rs`: tabla `include_bytes!` de `packages/core/core-assets/` y `packages/plugins/*/`, `rerun-if-changed` por directorio; `--version` nativo en `navori-cli` con el formato de salida de citty · effect: behavior · test: `crates/navori-cli/tests/version.rs`::"--version reporta la versión del workspace"
- [x] **T52** (R25, R26) — `[workspace.package] version = "0.13.0-rust.1"` heredada por los cuatro crates; `packages/cli/package.json` conserva la versión de `dev`; la sección de migración de `docs/DIRECTION.md` explica dónde vive la prerelease (la guía de instalación y sincronización de CONTRIBUTING llega con T17, en los tres idiomas). La regla del oráculo para `--version` llega con T9 · effect: behavior · test: `crates/navori-cli/tests/version.rs`::"la versión tiene la forma 0.13.0-rust.<n>"

### M2 — Delegación
- **A2** [observable] — un subcomando no portado se ejecuta vía TS con el mismo exit code · `cargo test -p navori-cli --test delegation` → exit 0, todos los casos verdes
- [x] **T4** (R5) — `navori-cli` (`parser`, `help`): parser citty mínimo sobre `lexopt` 0.3.2 para la raíz y `--help` (D2) · effect: behavior · test: `crates/navori-cli/tests/parser.rs`::"--help de la raíz coincide con cli-surface.golden.json"
- [x] **T5** (R5, R7) — `navori-cli` (`delegate`): selección por manifiesto (ruta + flags), `exec` al TS resuelto por `NAVORI_TS_CLI` → `dist/` del checkout → `PATH` sin el propio binario, aviso de versión en una línea (D3) · effect: behavior · test: `crates/navori-cli/tests/delegation.rs`::"argv, stdin, cwd, entorno y exit code pasan tal cual"
- [x] **T6** (R6) — sin TS o sin `node`: exit 69 con subcomando, rutas probadas y causa · effect: behavior · test: `crates/navori-cli/tests/delegation.rs`::"sin TS sale 69 y no lanza procesos"
- [x] **T7** (R7) — anti-bucle con `NAVORI_DELEGATED=<pid>` (70 solo con el propio pid) y test que recorre la tabla nativa contra el manifiesto · effect: behavior · test: `crates/navori-cli/tests/delegation.rs`::"toda implementación sin entrada en el manifiesto se delega"
- [x] **T8** (R7, R10) — esquema de `crates/ported.json` y `crates/ported-history.jsonl` (D4, D1) con su validador en `navori-core` · effect: schema · test: `crates/navori-core/tests/manifest.rs`::"rechaza entradas sin flags normalizados o hashes incompletos"

### M3 — Oráculo diferencial

Verificación local (2026-10-23): A3 `bun run oracle:rust` → 52 casos, 0 diferencias; fmt,
clippy y pruebas del workspace verdes. Ejecución directa por instrucción del usuario.
- **Consumes:** `bun run oracle:rust` → ejecuta `navori-rust` (versión nativa de M1 y delegación de M2) contra el CLI TS sobre los fixtures
- **A3** [observable] — el oráculo compara ambos binarios sobre los fixtures con diferencial cero en lo delegado · `bun run oracle:rust` → exit 0, reporte con 0 diferencias
- [x] **T9** (R8) — `scripts/js/rust-oracle.mjs` y `bun run oracle:rust`: corrida secuencial en la misma ruta, entorno hermético, comparación de stdout, stderr, exit code y árbol de archivos (D5) · effect: behavior · test: `packages/cli/src/__tests__/rust-oracle.test.ts`::"una diferencia de un byte en el árbol se reporta"
- [x] **T10** (R8, R9) — normalización por tokens estrictos (PID, rutas, hashes derivados de rutas, fechas) con un test de mutación por regla · effect: tests · test: `packages/cli/src/__tests__/rust-oracle.test.ts`::"cada regla de normalización tiene una mutación que la rompe"
- [x] **T11** (R9) — fixtures en `scripts/js/rust-oracle/fixtures/`, incluido un repo con contenido de usuario fuera de los markers, y casos de superficie desde `cli-surface.golden.json` · effect: tests · test: `scripts/js/rust-oracle/cases.json`::"user-content-outside-markers"
- [x] **T12** (R9) — `navori-core` (`js_json`): serialización con semántica JS (claves enteras, `1.0`) con propiedades contra Node (D14) · effect: behavior · test: `crates/navori-oracle-tests/tests/js_json.rs`::"js_json coincide con JSON.stringify en valores generados"

### M4 — CI e instalación

Implementados localmente T13–T16 y la parte CI de T17 en `.github/workflows/rust.yml`,
los tres scripts `rust-*-check.mjs` / `rust-sync-age.mjs`, sus pruebas y `ci.yml`.
Instalación local comprobada: `navori-rust` tiene ruta propia y `navori` conserva ruta y hash.
Los seis jobs remotos de Rust pasaron en PR1389; M4 sigue abierto por documentación. Las guías CONTRIBUTING de T17 no
se editaron: `guard-destructive` bloqueó la escritura shell como archivo gestionado.
- **A4** [observable] — `rust.yml` corre todos sus jobs y la instalación local no toca `navori` · `cargo install --path crates/navori-cli --locked && command -v navori-rust && command -v navori` → dos rutas distintas; la de `navori` igual que antes de instalar
- [ ] **T13** (R15) — `.github/workflows/rust.yml` job `quality` (fmt, clippy `-D warnings`, test) para PRs y pushes a `migration/rust`, sin `schedule` · effect: behavior · test: `.github/workflows/rust.yml`::"quality"
- [ ] **T14** (R10) — jobs `oracle` y `manifest` (recalcula hashes, exige línea `unport` al quitar una entrada) · effect: behavior · test: `packages/cli/src/__tests__/rust-manifest-check.test.ts`::"quitar una entrada sin unport falla"
- [ ] **T15** (R23) — `scripts/js/rust-sync-age.mjs` y job `freshness` por commits de primer padre de `dev`; el PR de sincronización siempre pasa (D10) · effect: behavior · test: `packages/cli/src/__tests__/rust-sync-age.test.ts`::"commit de dev sin incorporar con más de 7 días falla y el PR de sync pasa"
- [ ] **T16** (R4) — job `tarball`: `npm pack --dry-run --json` en `packages/cli` sin binarios, sin `crates/` y sin `postinstall` · effect: behavior · test: `packages/cli/src/__tests__/rust-tarball.test.ts`::"el tarball no contiene artefactos Rust"
- [ ] **T17** (R3) — job `install` y CONTRIBUTING de la rama con instalación y sincronización; `ci.yml` acepta `migration/rust` en `plan` y `affected` · effect: docs · test: `CONTRIBUTING.md`::"navori-rust local"

## E2 — Runtime de hooks
Estimated LOC: 4000

### M5 — Runner

Verificación local (2026-10-23): runner (5 casos), integridad exacta, propiedades contra Node,
workspace completo, clippy y fmt verdes. A5 pasa. Son bibliotecas sin wiring nativo todavía:
la integración del CLI, la escritura final y el fallback del renderer llegan en M6.
Las propiedades escapan U+2028/U+2029 solo en el transporte JSONL hacia Node; no en los datos.
- **A5** [observable] — el runner solo sale con 0/1/2/3 y un panic produce el veredicto seguro · `cargo test -p navori-hooks --test runner` → exit 0
- [x] **T18** (R12) — `navori-hooks` (`runner`): salida en búfer, `catch_unwind`, contrato 0/1/2/3 y veredicto seguro por engine para hooks con `gating` (D6) · effect: behavior · test: `crates/navori-hooks/tests/runner.rs`::"panic en hook con compuerta emite el veredicto seguro del engine"
- [x] **T19** (R11, R13) — integridad `file`/`impl`/`deps` con sha256 de bytes exactos y hash de marker sha1/8 con `normalize` de JS (D8) · effect: behavior · test: `crates/navori-core/tests/integrity.rs`::"CRLF, espacio final o script hermano editado difieren al shell"

### M6 — Wiring de convivencia

Implementado en `feat/0057-rust-e2-m6`, con Rust y TS divididos entre principal/clon y revisión
independiente. Entrada interna de hooks, validación antes de stdin, wrappers compartidos y
golden manual. 62 pruebas focalizadas verdes; Rust 54 casos, fmt y clippy verdes. Oráculo final
52 casos sin diferencias. El full preliminar reprodujo el stamp legacy sin wrapper (corregido)
y un timeout de doctor (caso aislado verde). Full final verde: 10240 aprobadas, dos omitidas,
483 archivos en1369.1s; cobertura87.87/86.17/90.51/80.95%, piso162/0 y bundle1637.7/1650KiB.
No hay hooks portados/activos todavía.
- **A6** [observable] — ninguna salida anómala del binario termina en permitir · `bun run vitest run src/__tests__/native-hook-failclosed.test.ts` → exit 0 en Claude, Codex y Pi
- [x] **T20** (R13) — `packages/cli/src/lib/render/native-hook.ts` (`nativeRunnerShell`), puntos de llamada en `claudeHookCommand` y `expandHookIncludes`; sin hooks en el manifiesto la salida es idéntica a `dev` (D7) · effect: behavior · test: `packages/cli/src/__tests__/native-hook.test.ts`::"manifiesto sin hooks renderiza igual que dev"
- [x] **T21** (R12, R13) — mapeo de salidas por engine: 3/126/127 al shell; otra salida, señal o stdout cerrado al veredicto seguro (T8 del diseño) · effect: behavior · test: `packages/cli/src/__tests__/native-hook-failclosed.test.ts`::"SIGSEGV, SIGABRT y exit 101 nunca permiten"

### M7 — Auditoría
- **A7** [observable] — metadata byte exacta frente al partial shell y bridge al escritor TS real · `cargo test -p navori-core --test audit --locked` → exit 0, seis pruebas
- [x] **T22** (R11) — `navori-core` (`audit`): actividad, metadata cerrada y bridge best-effort al escritor CLI único (D12); conserva campos y `tsMs` del shell sin append directo · effect: behavior · test: `crates/navori-core/tests/audit.rs`::`metadata_matches_the_real_shell_partial_without_human_content`, `real_ts_writer_remains_authoritative_for_identity_modes_and_wire_ids`

Validado desde el hilo principal: seis pruebas A7 verdes; workspace, fmt, clippy y check:fast
verdes en el worktree de M7. La aceptación anterior de replay ignoraba flags y no probaba
audit-writer; replay/fuzz reales permanecen en M8. No activa hooks ni cambia el writer productivo.
El primer full local tuvo un timeout zsh de 300 s; el focal pasó dos pruebas en166.7s.
Full final verde:10218 aprobadas, dos omitidas,481 archivos en1915.7s. Integrado en #1390.
El test del writer real usa Node24 transform-types; el job Rust quality no dispone de Bun.

### M8 — Herramientas

Incremento de tooling en `feat/0057-rust-e2-m8-tools`: adapter Rust directo con binario/rutas
fijados antes del sandbox, parser estricto, replay, fuzz determinista y benchmark wall-time/p95
separado del CPU de shell. 59 pruebas focales iniciales y63 al integrar #1393, check:fast verde.
Fuzz acepta hasta100000 casos
(D9), pero con el registro real vacío termina con error y cero casos ejecutados.
Auditoría active Rust falla explícitamente hasta disponer de fixtures CLI válidos.
El benchmark conserva el evento registrado y rechaza wrappers/argumentos de shell que no
pueda representar mediante argv exacto; no mide silenciosamente otra rama del hook.
T23–T25 y A8 siguen pendientes: portes reales, clasificación del corpus, gramática ampliada,
log shadow y medición de rendimiento nativo. Full M8 final verde:10238 aprobadas, dos omitidas,
482 archivos en2281.8s; piso160 módulos sin excepciones. Ancestry integrada mediante #1393.

- **A8** [observable] — replay, fuzz y bench funcionan con `--impl rust` · `bun run fuzz:hooks --seed 1 --cases 1000 && bun run bench:hooks --impl rust --report-only` → exit 0
- [ ] **T23** (R11) — `hook-verdict-replay.mjs --impl rust`, `divergences` con los 163 casos `shell-runtime` clasificados, corpus ampliado (al menos un caso por clase de veredicto y engine) · effect: tests · test: `packages/cli/src/__tests__/hook-verdict-replay.test.ts`::"rust reproduce el corpus o la categoría de su divergencia"
- [ ] **T24** (R11, R12) — `scripts/js/hook-fuzz.mjs` (`fuzz:hooks`) y modo `shadow` con log local de divergencias (D9) · effect: behavior · test: `packages/cli/src/__tests__/hook-fuzz.test.ts`::"reports a seeded divergence with the exact reproducible payload"
- [ ] **T25** (R17) — `bench-hooks.mjs --impl rust`: p95 de la invocación directa del binario con comparabilidad de 0055 · effect: behavior · test: `packages/cli/src/__tests__/bench-scripts.test.ts`::"bench --impl rust mide el binario sin wrapper"

### M9 — Primer hook en sombra

Infraestructura integrada en #1393: handler puro, hashes compilados D8 y dispatch shadow
con shell autoritativo. Rust forzado devuelve sólo el resultado nativo y conserva defer como
unavailable. Perfiles explícitos BSD/GNU/C y diagnósticos NUL de Bash3/5, sin normalizar stderr.
CI final verde:98 pruebas Rust y10265 JS, una omitida; cobertura162 módulos sin excepciones.
Los232 casos del handler prueban política pura; no sustituyen A9 ni acreditan auditoría activa.
Registro/manifiesto productivos vacíos: faltan preparación de elegibilidad antes de stdin,
registro, fixtures de auditoría activa y journal D9. T26 permanece abierto.

Journal D9 preparado como biblioteca privada del CLI: pares begin/complete, append con
creación exclusiva vacía, payload sólo en divergencias y reporte por hash/engine registrado.
Exige500 matches/14d por engine, cero divergencias/pendientes y al menos un host no-Claude.
Quince pruebas focales verdes incluyen concurrencia real, privacidad y payload binario de4MiB;
la validación base64 canónica evita el desbordamiento de pila de la regex anterior.
Pendientes el bridge Rust, la resolución de registros reales y el comando público de reporte;
estas pruebas sintéticas no acreditan uso vivo ni completan T26/A9.

- **A9** [observable] — `subagent-no-background` reproduce el corpus en Claude y Pi · `node scripts/js/hook-verdict-replay.mjs --impl rust --only subagent-no-background` → exit 0, 232 casos
- [ ] **T26** (R11) — `navori-hooks` (`hooks/subagent_no_background`) en `mode: "shadow"` en `ported.json` · effect: behavior · test: `crates/navori-hooks/tests/subagent_no_background.rs`::"veredictos del corpus"

## E3 — `guard-destructive`
Estimated LOC: 2500

### M10 — Activar `subagent-no-background`
- **A10** [observable] — criterios de D9 cumplidos · `node scripts/js/hook-shadow-report.mjs subagent-no-background` → ≥ 500 invocaciones por engine en ≥ 14 días y 0 divergencias
- [ ] **T27** (R11) — `ported.json` pasa el hook a `active`, con el resumen de sombra adjunto al PR y aprobación del usuario · effect: behavior · test: `crates/navori-hooks/tests/subagent_no_background.rs`::"modo active responde Rust"

### M11 — `guard-destructive` en sombra
- **A11** [observable] — corpus y fuzz de gramática completa verdes · `node scripts/js/hook-verdict-replay.mjs --impl rust --only guard-destructive && bun run fuzz:hooks --hook guard-destructive --seed 1 --cases 100000` → exit 0, 0 divergencias
- [ ] **T28** (R11, R12) — `guard-destructive-base` y `tgrep-search-lane` (con `deps` del script de búsqueda) en `shadow` · effect: behavior · test: `crates/navori-hooks/tests/guard_destructive.rs`::"cada regla bloquea, pregunta o permite igual que el shell"

