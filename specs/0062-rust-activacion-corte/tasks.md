# Migración a Rust, fase 5: activación, distribución y corte — Tasks

**Estado:** aceptada para desarrollo (Q26–Q29 resueltas; Q24 abierta, bloquea solo E2) · **Base:**
`migration/rust`. Tres entregas, tres PRs: E1 y E2 contra `migration/rust`, E3 contra `dev`. Sale de
E4–E6 de la versión anterior de 0060 (correspondencia en cada tarea). El LOC es una referencia
gruesa.

**PRs**

| PR | Entrega | Entregable | Se mergea cuando |
|---|---|---|---|
| 1 | E1 | Los 22 hooks deciden en Rust (`active`) | A1 verde, evidencia de R81 adjunta y aprobación del usuario |
| 2 | E2 | El paquete instala y responde en macOS y Linux, sin publicar | A2 verde |
| 3 | E3 | `navori` es el binario Rust en `dev` | A3 verde y aprobación explícita del usuario (R20) |

Reglas de ejecución (política de velocidad, D47 de 0060):
- Un PR por entrega con commits atómicos; una revisión cruzada por PR.
- En cada commit, `bun run check:fast` y los tests del área tocada. El gate completo (`bun run
  check` y `cargo test --workspace`) corre en la CI del PR.
- Cada prueba nueva lleva `// Covers: R<n>`. No se añade un test que repita lo que ya cubre el
  replay o el oráculo.
- Hooks, distribución y corte son área crítica: un commit por mecanismo.

## E1 — Activación de los hooks
Estimated LOC: 3000

### M1 — Evidencia y activación
Entregable: los hooks que cumplen R81 deciden en Rust en los tres engines.
- **A1** [observable] — cada hook activado tiene su evidencia y ninguna salida anómala permite · `node scripts/js/hook-verdict-replay.mjs --impl rust && node scripts/js/hook-shadow-report.mjs --window 7 && cargo test -p navori-hooks --locked && cd packages/cli && bun run vitest run src/__tests__/rust-manifest-check.test.ts src/__tests__/hook-shadow-report.test.ts src/__tests__/native-hook-failclosed.test.ts` → exit 0; 0 divergencias
- [ ] **T1** (R81, R82) — `scripts/js/hook-shadow-report.mjs`: invocaciones y divergencias por hook y engine en la ventana, en rojo ante cualquier divergencia o ante un hook con compuerta sin tráfico ni aprobación de R82 (antes T39 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/hook-shadow-report.test.ts`::"una divergencia o un hook con compuerta sin tráfico deja el reporte en rojo"
- [ ] **T2** (R79, R80) — `scripts/js/rust-manifest-check.mjs`: `shadow` → `active` exige `shadow` en la merge-base y una línea `activate` nueva; `active` → `shadow` exige `deactivate` (antes T40 de 0060 y T2 de 0058) · effect: behavior · test: `packages/cli/src/__tests__/rust-manifest-check.test.ts`::"activar sin línea activate o sin sombra previa falla"
- [ ] **T3** (R81, R83) — una corrida de evidencia: replay nativo de los 22 hooks y fuzz de 100 000 entradas de los hooks con compuerta; `ported.json` pasa a `active` los que cumplen, con su línea `activate`, y el render deja el fragmento activo en los tres engines (antes T41, T42 y T44 de 0060; incluye T27 de 0057, T4 de 0058 y T35 de 0059) · effect: behavior · test: `crates/navori-hooks/tests/golden/wiring.snap`::"hooks active"
- [ ] **T4** (R83) — matriz fail-closed sobre cada hook con compuerta en `active`, invocado por el comando registrado exacto de cada engine (antes T43 de 0060; incluye T5 de 0058 y T36 de 0059) · effect: tests · test: `packages/cli/src/__tests__/native-hook-failclosed.test.ts`::"ningún hook activo con compuerta permite ante SIGSEGV, 101 o stdout cerrado"

## E2 — Ensayo de distribución, sin publicar
Estimated LOC: 3500

### M2 — Paquete, sondas y compuertas de corte
Entregable: un tarball local que instala y responde en cada plataforma con binario, y
`cutover:check` en verde.
- **A2** [observable] — el paquete instala y responde, y las compuertas de corte están en verde · `npm pack --dry-run --workspace navori && node scripts/js/dist-probe.mjs && bun run check:post-cutover && bun run cutover:check && cd packages/cli && bun run vitest run src/__tests__/dist-launcher.test.ts src/__tests__/cutover-check.test.ts` → exit 0; tiempo de `check:post-cutover` ≤ 300 s
- [ ] **T5** (R21, R22) — workflow de release con los cuatro binarios (musl estático en Linux) sin publicar, y paquete `navori` con lanzador JS, `optionalDependencies` por plataforma, `postinstall` que enlaza solo si `--version` coincide y `legacy/` con el `dist/` del último TS publicado verificado por `integrity` (antes T45 y T46 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/dist-launcher.test.ts`::"sin binario corre legacy y sin postinstall corre el binario por Node"
- [ ] **T6** (R84) — `scripts/js/dist-probe.mjs`: npm, pnpm y bun, con y sin scripts, verifican `navori --version`, un bloqueo de `guard-destructive` y un subcomando de delegación permanente (antes T47 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/dist-probe.test.ts`::"cada gestor responde con el binario, el binario por Node o legacy"
- [ ] **T7** (R18, R20) — `check:post-cutover` cronometrado y `scripts/js/cutover-check.mjs` con el inventario de D41, la lista de delegación permanente de D48 de 0060, ningún hook en `shadow` y R17/R18 cumplidos (antes T48 y T49 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/cutover-check.test.ts`::"falla con un hook en shadow o un subcomando fuera del manifiesto y de la lista de delegación"
- [ ] **T8** (R85) — avisos de actualización y de versión de herramientas en Rust por un `HttpClient` grabado, apagados durante la convivencia (antes T50 de 0060) · effect: behavior · test: `crates/navori-cli/tests/notices.rs`::"el aviso coincide con el TS en versión nueva, igual, error y tiempo agotado"

## E3 — Corte
Estimated LOC: 2000

### M3 — PR de `migration/rust` a `dev`
Entregable: `navori` es el binario Rust en `dev`, con el TS congelado como respaldo y para las
delegaciones permanentes.
- **A3** [observable] — el corte cumple R20 y R24 con el gate full verde · `bun run cutover:check && bun run check:post-cutover && cargo test --workspace --locked` → exit 0, con la aprobación del usuario registrada en el PR
- [ ] **T9** (R24, R20) — PR único a `dev`: re-apunta `rust.yml`, añade release, empaquetado y `legacy/`, dirige la delegación al TS congelado solo para la lista permanente, borra `packages/cli/src` salvo las suites de artefacto y elimina el oráculo TS (antes T51 de 0060) · effect: behavior · test: `packages/cli/src/__tests__/cutover-check.test.ts`::"el árbol de corte delega solo la lista permanente y no conserva la suite TS"
- [ ] **T10** (R85, R21, R22) — avisos encendidos en el binario publicado y release documentado en README § Releases (antes T52 y T53 de 0060) · effect: docs · test: `README.md`::"Releases"
