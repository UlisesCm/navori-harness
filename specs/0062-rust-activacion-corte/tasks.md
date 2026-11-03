# Migración a Rust, fase 5: activación, distribución y corte — Tasks

**Estado:** aceptada para desarrollo (Q26–Q29 resueltas; R18 resuelta el 2026-11-02, D52; Q24 aplazada, no bloquea E2) · **Base:**
`migration/rust`. Tres entregas y cinco PRs: E1 (herramientas y dos lotes de activación, Q30) y E2 contra
`migration/rust`, E3 contra `dev`. Sale de E4–E6 de la versión anterior de 0060 (correspondencia en
cada tarea). El LOC es una referencia gruesa.

**Enmienda de alcance (2026-11-02):** lo congelado en `dev` (#1484, #1502) no se porta ni se
activa; se resuelve por delegación permanente al TS. Ver `requirements.md`. Lo marcado "Fuera de
alcance (2026-11-02)" se conserva como registro y no se ejecuta.

**PRs**

| PR | Entrega | Entregable | Se mergea cuando |
|---|---|---|---|
| 1a | E1, M1 | Herramientas de activación (T1, T2, T4), sin activar ningún hook (Q30) | Los tests de A1, el replay `--registered` de A1 y la CI en verde |
| 1a′ | E1, M1 | El primer lote de hooks en `active` (T3: los que llevan 7 días o más en `shadow` al abrir el PR) | A1 verde, evidencia de R81 adjunta y aprobación del usuario |
| 1b | E1, M2 | El resto de los hooks en `active` | A2 verde, evidencia de R81 adjunta y aprobación del usuario |
| 2 | E2 | El paquete instala y responde en macOS y Linux, sin publicar | A3 verde |
| 3 | E3 | `navori` es el binario Rust en `dev` | A4 verde y aprobación explícita del usuario (R20) |

Estado (2026-11-02): 1a (`feat/0062-rust-e1-m1`, #1479) trae T1, T2 y T4 y `--registered` en el
replay (el corpus trae los 7 hooks de 0060 E2 y E3 aún sin portar); T3 pasó a 1a′ (Q30) y espera
los 7 días de sombra. Cada checkout escribe su propio journal y los hooks de `main` no llevan `--shadow`, así que
el tráfico sale de los worktrees de la migración: la ventana corre desde el 2026-11-02 y el reporte
los suma con `--journals <dir>` (repetible). 2 puede empezar ya, desde
`migration/rust`. Los PRs se abren terminados, nunca en draft.

E1 lleva dos PRs a propósito: la ventana de 7 días de R81 es calendario, y esperar a que el último
hook de la cola larga la cumpla dejaría parados los que ya la cumplen.

**Precondiciones de entrada (trabajo en paralelo):**
- **M1 (PRs 1a y 1a′):** empieza ya. T1, T2 y T4 no dependen de ningún hook (1a); el lote 1 (1a′)
  son los hooks que ya están en `shadow` con 7 días o más al abrir el PR.
- **M2 (PR 1b):** cada hook de 0060 E2 y E3 (y T13, T14 de 0060 E1) entra cuando cumple 7 días en
  `shadow`; el PR se abre cuando estén todos.
- **E2 (PR 2):** empieza ya, en paralelo con E1 y con 0060. `cutover-check` puede salir en rojo
  mientras la cola larga no termine; su verde solo se exige en E3.
- **E3 (PR 3):** 0059 y 0060 cerradas, E1 y E2 integradas, `cutover:check` en verde y aprobación
  del usuario.

**Flujos y zonas (D47 de 0060):** E1 es del flujo de hooks (`crates/navori-hooks/**`, la sección
`hooks` de `crates/ported.json`, los scripts renderizados); E2 del flujo de render y distribución
(workflows de release, empaquetado, `scripts/js/dist-probe.mjs`, `scripts/js/cutover-check.mjs`);
E3 lo hace quien cierre el último de los dos.

Reglas de ejecución (política de velocidad, D47 de 0060):
- Un PR por entrega (dos en E1, por el calendario) con commits atómicos y una revisión cruzada por
  PR.
- En cada commit, `bun run check:fast` y los tests del área tocada. El gate completo (`bun run
  check` y `cargo test --workspace`) corre en la CI del PR.
- Cada prueba nueva lleva `// Covers: R<n>`. No se añade un test que repita lo que ya cubre el
  replay o el oráculo.
- Hooks, distribución y corte son área crítica: un commit por mecanismo.

## E1 — Activación de los hooks
Estimated LOC: 3000

### M1 — Herramientas y primer lote
Entregable: el reporte de sombra, las reglas de transición y la matriz fail-closed existen, y los
hooks que llevan 7 días o más en `shadow` deciden en Rust.
- **A1** [observable] — el primer lote tiene su evidencia y ninguna salida anómala permite · `node scripts/js/hook-verdict-replay.mjs --impl rust --registered && node scripts/js/hook-shadow-report.mjs --window 7 && cargo test -p navori-hooks --locked && cd packages/cli && bun run vitest run src/__tests__/rust-manifest-check.test.ts src/__tests__/hook-shadow-report.test.ts src/__tests__/native-hook-failclosed.test.ts` → exit 0; 0 divergencias
- [x] **T1** (R81, R82) — `scripts/js/hook-shadow-report.mjs`: invocaciones y divergencias por hook y engine en la ventana, en rojo ante cualquier divergencia o ante un hook con compuerta sin tráfico ni aprobación de R82 (antes T39 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/hook-shadow-report.test.ts`::"una divergencia o un hook con compuerta sin tráfico deja el reporte en rojo"
- [x] **T2** (R79, R80) — `scripts/js/rust-manifest-check.mjs`: `shadow` → `active` exige `shadow` en la merge-base y una línea `activate` nueva; `active` → `shadow` exige `deactivate` (antes T40 de 0060 y T2 de 0058) · effect: behavior · test: `packages/cli/src/__tests__/rust-manifest-check.test.ts`::"activar sin línea activate o sin sombra previa falla"
- [ ] **T3** (R81, R83) — lote 1: replay nativo y fuzz de 100 000 entradas (los de compuerta) de los hooks con 7 días o más en `shadow`; `ported.json` los pasa a `active` con su línea `activate` y el render deja el fragmento activo en los tres engines (antes T41, T42 y T44 de 0060; incluye T27 de 0057, T4 de 0058 y T35 de 0059) · effect: behavior · test: `crates/navori-hooks/tests/golden/wiring.snap`::"hooks del lote 1 active"
  - Fuera de alcance (2026-11-02, enmienda de `requirements.md`): `master-plan-context` y `master-accept-confirm` (congelados) y `role-guard` y `engram-write-guard` (solo Codex) no entran al lote; la evidencia de R81 se exige solo en Claude y Pi.
- [x] **T4** (R83) — matriz fail-closed sobre cada hook con compuerta en `active`, invocado por el comando registrado exacto de cada engine; crece con cada lote (antes T43 de 0060; incluye T5 de 0058 y T36 de 0059) · effect: tests · test: `packages/cli/src/__tests__/native-hook-failclosed.test.ts`::"ningún hook activo con compuerta permite ante SIGSEGV, 101 o stdout cerrado"

### M2 — Segundo lote
Entregable: los 22 hooks deciden en Rust en los tres engines.
- **A2** [observable] — ningún hook queda en `shadow` y el segundo lote tiene su evidencia · `node scripts/js/hook-verdict-replay.mjs --impl rust && node scripts/js/hook-shadow-report.mjs --window 7 && cd packages/cli && bun run vitest run src/__tests__/native-hook-failclosed.test.ts src/__tests__/rust-manifest-check.test.ts` → exit 0; 0 divergencias; 0 hooks en `shadow`
- [ ] **T5** (R81, R82, R83) — lote 2: la misma evidencia de T3 para los hooks que entraron en `shadow` con 0060 E1 (T13, T14), E2 y E3, su paso a `active` y la matriz de T4 extendida a ellos · effect: behavior · test: `crates/navori-hooks/tests/golden/wiring.snap`::"los 22 hooks active"
  - Fuera de alcance (2026-11-02, enmienda de `requirements.md`): `audit-mode-trigger`, `audit-mode-close` y `stop-verify-reminder` (replay, fuzz y sombra): no tienen puerto. Al cerrar el lote 2 quedan 15 hooks en `active` en Claude y Pi, no 22; los congelados y los de solo Codex quedan en la lista de hooks shell permanentes.

## E2 — Ensayo de distribución, sin publicar
Estimated LOC: 3500

### M3 — Paquete, sondas y compuertas de corte
Entregable: un tarball local que instala y responde en cada plataforma con binario, y las
compuertas del corte (`check:post-cutover`, `cutover:check`) existen.
- **A3** [observable] — el paquete instala y responde, y las compuertas del corte corren · `npm pack --dry-run --workspace navori && node scripts/js/dist-probe.mjs && bun run check:post-cutover && cd packages/cli && bun run vitest run src/__tests__/dist-launcher.test.ts src/__tests__/cutover-check.test.ts` → exit 0; tiempo de `check:post-cutover` dentro del presupuesto de su host (300 s en la máquina de referencia, 600 s en CI; D52)
- [x] **T6** (R21, R22) — workflow de release con los cuatro binarios (musl estático en Linux) sin publicar, y paquete `navori` con lanzador JS, `optionalDependencies` por plataforma, `postinstall` que enlaza solo si `--version` coincide y `legacy/` con el `dist/` del último TS publicado verificado por `integrity` (antes T45 y T46 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/dist-launcher.test.ts`::"sin binario corre legacy y sin postinstall corre el binario por Node"
  - Hecho: `packaging/npm/` (bins JS `navori` y `navori-native-hook`, `lib/launcher.js`, `lib/install.js` y `postinstall.js`), `packaging/legacy.json` (navori 0.12.3 con su `integrity`), `scripts/js/dist-assemble.mjs` y `.github/workflows/rust-release.yml` (cuatro binarios, musl estático comprobado con `ldd`, paquetes armados sin publicar y sonda por plataforma). En Rust, la delegación encuentra el TS congelado del paquete (`crates/navori-cli/tests/delegation.rs`). **Enmiendas (D53):** el paquete se arma aparte de `packages/cli` mientras rija R4; `legacy/` es el tarball entero, así que el TS congelado es `legacy/dist/index.js`; bajo pnpm el `postinstall` deja los bins JS y el lanzador quita del `NODE_PATH` las rutas del shim.
- [x] **T7** (R84) — `scripts/js/dist-probe.mjs`: npm, pnpm y bun, con y sin scripts, verifican `navori --version`, un bloqueo de `guard-destructive` y un subcomando de delegación permanente (antes T47 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/dist-probe.test.ts`::"cada gestor responde con el binario, el binario por Node o legacy"
  - Hecho: `scripts/js/dist-probe.mjs` arma los paquetes con el binario del host, los instala con npm, pnpm y bun, con y sin scripts, y además sin el paquete de plataforma, y exige `navori --version`, el bloqueo de un caso de `guard-destructive` del corpus por `navori-native-hook` y la delegación al TS congelado. En local (darwin-arm64), 7 de 7 instalaciones en verde.
- [x] **T8** (R18, R20) — `check:post-cutover` cronometrado y `scripts/js/cutover-check.mjs` con el inventario de D41, la lista de delegación permanente de D48 de 0060, ningún hook en `shadow` y R17/R18 cumplidos; mientras la cola larga no termine reporta lo que falta en vez de bloquear el PR (antes T48 y T49 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/cutover-check.test.ts`::"falla con un hook en shadow o un subcomando fuera del manifiesto y de la lista de delegación"
  - Hecho (`59b8f5168`, `68e8aaaaa`, `2b2057116`, `698f7140d`): `bun run cutover:check` (falla mientras falte algo; `--report` solo lista) sobre `commandInventory` y `hookInventory` de `rust-areas.mjs`, con `PERMANENT_DELEGATION` (vacía, cada entrada con motivo; una entrada sin `flags` delega el subcomando entero), hooks en `shadow`, despoteos abiertos, R17 (`.navori/state/bench/hooks-rust-latest.json` comparable y bajo 5 ms de p95, y la mediana de `navori-rust --version` ≤ 10 ms) y R18 (`post-cutover-latest.json` en verde y ≤ 300 s). Hoy reporta 133 hallazgos. `bun run check:post-cutover` corre `cargo fmt`, `clippy`, `test` y `build`, el replay nativo de los hooks del manifiesto, las suites de artefacto (`first-class-*` de Pi, `render-syntax`, `rust-tree` obligatoria y `native-hook-failclosed`) y `check:links`, `check:render`, `check:assets` y `check:doc-budgets`; lo cronometra y deja el registro que lee `cutover:check`. El job `post-cutover` de `rust.yml` lo mide en Linux. **Enmiendas:** el árbol de comandos se lee de `packages/cli/src/cli.ts` con bun, como el test de inventario por área, porque `dist/index.js` ejecuta el CLI al importarse (D41 decía `dist/`); el replay se limita a los hooks del manifiesto, porque los que faltan no tienen implementación nativa que replicar. En macOS no se puede medir R18: fallan en la base `facts_cache`, `guard_registry`, el audit de `hooks`, `plan_gate` y el replay nativo de dos hooks ("native runtime deferred"), que pasan en Linux. R18 puede quedar justo: en macOS las suites de artefacto tardan unos 150 s y el replay de 13 hooks unos 270 s, sin contar `cargo test`. Primera medición en CI (`4c5269eb9`): todo verde en 1589.5 s, de ellos unos 740 s en `navori-oracle-tests` y 454 s en el replay. Esa crate compara contra el TS y el corte la elimina (R24, D17 de 0057), así que `clippy` y `test` la excluyen (`TS_ORACLE_CRATE`). El job restaura además una caché de cargo y la guarda también en rojo. Con ella, todo verde en 621 s: `cargo test` 168 s (casi todo ejecución; `navori-hooks` unos 140 s), replay 383 s (serial, un proceso por caso) y suites de artefacto 60 s. R18 sigue sin cumplirse: el replay solo ya excede el presupuesto. Con el oráculo en shards paralelos y R18 por host (D52), el job queda en verde en 376 s contra 600 s, con el oráculo en 142 s; el `--budget-advisory` que lo dejaba pasar en exceso se retiró.
- [x] **T9** (R85) — avisos de actualización y de versión de herramientas en Rust por un `HttpClient` grabado, apagados durante la convivencia (antes T50 de 0060) · effect: behavior · test: `crates/navori-oracle-tests/tests/notices_parity.rs`::"el aviso coincide con el TS en versión nueva, igual, error y tiempo agotado"
  - Hecho (`f764a414d`, `f24bf7ebd`, `9758ab5a8`): `navori_core::http` (`HttpClient`, `get_json` con la semántica de `readBoundedJson`, `CurlClient` que envía por `curl` en el `ProcessRunner` de R76 con el mismo límite de 2 s y `RecordedHttp` para pruebas), `tools::update_notice` (`runUpdateNotice` y su worker: elegibilidad, idioma, reserva diaria bajo el lock, texto y la caché `~/.navori/update-notice` que comparte con el TS) y el worker de `tool-version-notice` en `tools::notice`. Paridad contra el TS real con `fetch` sustituido y el reloj fijo: el aviso, en `es` y `en`, con versión nueva, igual, error, tiempo agotado, cuerpo no JSON y 503, el día siguiente incluido; el worker de herramientas con release nueva, tag ilegible, prerelease, error, tiempo agotado y una lista; mismos archivos, mismo texto, mismas URL y cabeceras. Mutación detectada. En el CLI, `notices::ENABLED = false` (R85, Q6 de 0058): con él apagado no hay aviso nativo y los workers siguen en el TS; encendido, `run()` corre los workers y el aviso antes del comando, salvo `gate`, y la caché compartida evita que un TS delegado lo repita. **Enmiendas:** sin crate HTTP (D13 de 0057 no lo admite), el transporte real es `curl` por el `ProcessRunner`; sin `curl` el aviso calla, como sin red. La paridad vive en `navori-oracle-tests` (como el resto de las paridades contra el TS), y `crates/navori-cli/tests/notices.rs` prueba que los avisos siguen apagados.

## E3 — Corte
Estimated LOC: 2000

### M4 — PR de `migration/rust` a `dev`
Entregable: `navori` es el binario Rust en `dev`, con el TS congelado como respaldo y para las
delegaciones permanentes.
- **A4** [observable] — el corte cumple R20 y R24 con el gate full verde · `bun run cutover:check && bun run check:post-cutover && cargo test --workspace --locked` → exit 0, con la aprobación del usuario registrada en el PR
- [ ] **T10** (R24, R20) — PR único a `dev`: re-apunta `rust.yml`, añade release, empaquetado y `legacy/`, dirige la delegación al TS congelado solo para la lista permanente, borra `packages/cli/src` salvo las suites de artefacto y elimina el oráculo TS (antes T51 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/cutover-check.test.ts`::"el árbol de corte delega solo la lista permanente y no conserva la suite TS"
  - Enmienda (2026-11-02): `PERMANENT_DELEGATION` y `cutover:check` aceptan hooks shell permanentes y miden solo los motores del corte, Claude y Pi (R20 enmendado en `requirements.md`). La lista suma `master`, `audit`, `codex`, `workspace`, `ticket` y `registry`.
- [ ] **T11** (R85, R21, R22) — avisos encendidos en el binario publicado y release documentado en README § Releases (antes T52 y T53 de 0060) · effect: docs · test: `README.md`::"Releases"
