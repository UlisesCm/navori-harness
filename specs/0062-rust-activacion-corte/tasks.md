# Migración a Rust, fase 5: activación, distribución y corte — Tasks

**Estado:** aceptada para desarrollo (Q26–Q29 resueltas; Q24 abierta, bloquea solo E2) · **Base:**
`migration/rust`. Tres entregas y cinco PRs: E1 (herramientas y dos lotes de activación, Q30) y E2 contra
`migration/rust`, E3 contra `dev`. Sale de E4–E6 de la versión anterior de 0060 (correspondencia en
cada tarea). El LOC es una referencia gruesa.

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
- [x] **T4** (R83) — matriz fail-closed sobre cada hook con compuerta en `active`, invocado por el comando registrado exacto de cada engine; crece con cada lote (antes T43 de 0060; incluye T5 de 0058 y T36 de 0059) · effect: tests · test: `packages/cli/src/__tests__/native-hook-failclosed.test.ts`::"ningún hook activo con compuerta permite ante SIGSEGV, 101 o stdout cerrado"

### M2 — Segundo lote
Entregable: los 22 hooks deciden en Rust en los tres engines.
- **A2** [observable] — ningún hook queda en `shadow` y el segundo lote tiene su evidencia · `node scripts/js/hook-verdict-replay.mjs --impl rust && node scripts/js/hook-shadow-report.mjs --window 7 && cd packages/cli && bun run vitest run src/__tests__/native-hook-failclosed.test.ts src/__tests__/rust-manifest-check.test.ts` → exit 0; 0 divergencias; 0 hooks en `shadow`
- [ ] **T5** (R81, R82, R83) — lote 2: la misma evidencia de T3 para los hooks que entraron en `shadow` con 0060 E1 (T13, T14), E2 y E3, su paso a `active` y la matriz de T4 extendida a ellos · effect: behavior · test: `crates/navori-hooks/tests/golden/wiring.snap`::"los 22 hooks active"

## E2 — Ensayo de distribución, sin publicar
Estimated LOC: 3500

### M3 — Paquete, sondas y compuertas de corte
Entregable: un tarball local que instala y responde en cada plataforma con binario, y las
compuertas del corte (`check:post-cutover`, `cutover:check`) existen.
- **A3** [observable] — el paquete instala y responde, y las compuertas del corte corren · `npm pack --dry-run --workspace navori && node scripts/js/dist-probe.mjs && bun run check:post-cutover && cd packages/cli && bun run vitest run src/__tests__/dist-launcher.test.ts src/__tests__/cutover-check.test.ts` → exit 0; tiempo de `check:post-cutover` ≤ 300 s
- [ ] **T6** (R21, R22) — workflow de release con los cuatro binarios (musl estático en Linux) sin publicar, y paquete `navori` con lanzador JS, `optionalDependencies` por plataforma, `postinstall` que enlaza solo si `--version` coincide y `legacy/` con el `dist/` del último TS publicado verificado por `integrity` (antes T45 y T46 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/dist-launcher.test.ts`::"sin binario corre legacy y sin postinstall corre el binario por Node"
- [ ] **T7** (R84) — `scripts/js/dist-probe.mjs`: npm, pnpm y bun, con y sin scripts, verifican `navori --version`, un bloqueo de `guard-destructive` y un subcomando de delegación permanente (antes T47 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/dist-probe.test.ts`::"cada gestor responde con el binario, el binario por Node o legacy"
- [ ] **T8** (R18, R20) — `check:post-cutover` cronometrado y `scripts/js/cutover-check.mjs` con el inventario de D41, la lista de delegación permanente de D48 de 0060, ningún hook en `shadow` y R17/R18 cumplidos; mientras la cola larga no termine reporta lo que falta en vez de bloquear el PR (antes T48 y T49 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/cutover-check.test.ts`::"falla con un hook en shadow o un subcomando fuera del manifiesto y de la lista de delegación"
- [ ] **T9** (R85) — avisos de actualización y de versión de herramientas en Rust por un `HttpClient` grabado, apagados durante la convivencia (antes T50 de 0060) · effect: behavior · test: `crates/navori-cli/tests/notices.rs`::"el aviso coincide con el TS en versión nueva, igual, error y tiempo agotado"

## E3 — Corte
Estimated LOC: 2000

### M4 — PR de `migration/rust` a `dev`
Entregable: `navori` es el binario Rust en `dev`, con el TS congelado como respaldo y para las
delegaciones permanentes.
- **A4** [observable] — el corte cumple R20 y R24 con el gate full verde · `bun run cutover:check && bun run check:post-cutover && cargo test --workspace --locked` → exit 0, con la aprobación del usuario registrada en el PR
- [ ] **T10** (R24, R20) — PR único a `dev`: re-apunta `rust.yml`, añade release, empaquetado y `legacy/`, dirige la delegación al TS congelado solo para la lista permanente, borra `packages/cli/src` salvo las suites de artefacto y elimina el oráculo TS (antes T51 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/cutover-check.test.ts`::"el árbol de corte delega solo la lista permanente y no conserva la suite TS"
- [ ] **T11** (R85, R21, R22) — avisos encendidos en el binario publicado y release documentado en README § Releases (antes T52 y T53 de 0060) · effect: docs · test: `README.md`::"Releases"
