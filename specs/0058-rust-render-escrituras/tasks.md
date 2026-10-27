# Migración a Rust, fase 2: config, markers, render y escrituras — Tasks

**Estado:** aceptada; E2 en curso, E1 bloqueada por el cierre de 0057 E3 · **Base:** `migration/rust`. Fase 2 del programa (ver
`specs/0057-migracion-rust/requirements.md` § "Fases del programa"): cuatro entregas, **cada una con
su propio PR contra `migration/rust`**. El LOC es una estimación, no una medición.

Correspondencia con `design.md` § "Plan de entregas": E1–E4 son las mismas entregas del diseño.
Equivalen a E5 M3, E4 M1, E4 M2 y E5 M1–M2 del plan de 0057.

**Precondición de entrada** (cierre de 0057 E3, verificable antes de abrir E1):
- `crates/ported.json` tiene `subagent-no-background` en `active` y `guard-destructive` en `shadow`
  con `blocks` (`guard-destructive-base`, `tgrep-search-lane`) y `deps`
  (`scripts/guard-search-routing.sh`).
- A10 y A11 de 0057 en verde sobre el `HEAD` de `migration/rust`.

Reglas de ejecución:
- Workplan por entrega: `0058-rust-render-escrituras-e<n>`, con fases = milestones; `tasks.md` es el
  tracking canónico.
- Cada PR de entrega va contra `migration/rust`; ninguno contra `dev`. Las entregas paralelas
  necesitan archivos disjuntos y PR propio (Q2 de `design.md`).
- Cada prueba nueva lleva `// Covers: R<n>` (Rust y TS). Los casos nombrados son planeados; los
  archivos nuevos se crean en el milestone que los nombra.
- Los milestones que tocan Rust corren `cargo fmt --check && cargo clippy --workspace --all-targets
  --locked -- -D warnings && cargo test --workspace --locked`, además de `bun run check:fast` y sus
  `A<n>`. El cierre de cada entrega corre `bun check` completo, `rust.yml` en verde y un reviewer
  fresco.
- Hooks, render, sync, backup y markers son área crítica: un commit por mecanismo. El paso de
  `guard-destructive` a `active` exige los criterios de D9 de 0057 y la aprobación del usuario en
  el PR de activación.
- Las preguntas Q2–Q12 están resueltas (`design.md` § "Decisiones del usuario"); cambiar una
  resolución requiere volver a preguntar al usuario.

## E1 — Activación de `guard-destructive`
Estimated LOC: 1200

### M1 — Evidencia previa a la activación
- **Consumes:** `node scripts/js/hook-shadow-report.mjs guard-destructive` → lee el ledger de sombra que deja `navori-rust hook --shadow` en sesiones reales (0057 T24/A10)
- **A1** [observable] — corpus, fuzz y sombra cumplen D9 en los tres engines · `node scripts/js/hook-verdict-replay.mjs --impl rust --only guard-destructive && bun run fuzz:hooks --hook guard-destructive --seed 1 --cases 100000 && node scripts/js/hook-shadow-report.mjs guard-destructive` → exit 0; 0 divergencias; ≥ 500 invocaciones en ≥ 14 días por cada engine registrado (claude, codex, pi)
- [ ] **T1** (R29) — corpus de `guard-destructive` ampliado: al menos un caso por clase de veredicto en Claude, Codex y Pi (hoy 770/6/110), con `coverage.json` actualizado · effect: tests · test: `packages/cli/src/__tests__/hook-verdict-replay.test.ts`::"guard-destructive cubre cada clase de veredicto en claude, codex y pi"
- [ ] **T2** (R27, R31) — `scripts/js/rust-manifest-check.mjs`: `shadow` → `active` exige `shadow` en la merge-base y una línea `activate` nueva; `active` → `shadow` exige una línea `deactivate` (Q10); `active` sin `shadow` previo falla · effect: behavior · test: `packages/cli/src/__tests__/rust-manifest-check.test.ts`::"activar sin línea activate o sin sombra previa falla"
- [ ] **T3** (R28) — el reporte de sombra cuenta invocaciones y divergencias por engine y falla si un engine donde el hook está registrado no llega al umbral. Si 0057 no entregó el ledger o el script, se completan aquí sin crear un segundo reporte (D18) · effect: behavior · test: `packages/cli/src/__tests__/hook-shadow-report.test.ts`::"un engine registrado bajo 500 invocaciones deja el reporte en rojo"

### M2 — Activación
- **A2** [observable] — Rust decide en los tres engines y ninguna salida anómala permite · `cargo test -p navori-hooks --test guard_destructive --locked && bun run vitest run src/__tests__/native-hook-failclosed.test.ts -t guard-destructive` → exit 0
- [ ] **T4** (R28) — `ported.json` pasa `guard-destructive` a `active`, con línea `activate` en `ported-history.jsonl`, el resumen de A1 adjunto al PR y la aprobación del usuario · effect: behavior · test: `crates/navori-hooks/tests/guard_destructive.rs`::"modo active responde Rust"
- [ ] **T5** (R30) — matriz fail-closed de T8 de 0057 sobre `guard-destructive` en `active`, invocado por el comando registrado exacto de cada engine · effect: tests · test: `packages/cli/src/__tests__/native-hook-failclosed.test.ts`::"guard-destructive activo nunca permite ante SIGSEGV, 101 o stdout cerrado"
- [ ] **T6** (R42, R30) — re-render de los tres scripts con el fragmento activo y actualización revisada a mano de `wiring.snap` · effect: behavior · test: `crates/navori-hooks/tests/golden/wiring.snap`::"guard-destructive active"

## E2 — Config, markers y anti-rollback
Estimated LOC: 4500

### M3 — Semver, versión de sello y config
- **A3** [observable] — config y semver coinciden con Node en documentos generados · `cargo test -p navori-core --test semver --test config --locked && cargo test -p navori-oracle-tests --test config_parity --locked` → exit 0
- [ ] **T7** (R38) — `navori-core` (`semver`) con la semántica de `semver.ts` (prerelease ignorada, inparseable nunca es retroceso) y `build.rs` que emite `TS_CLI_VERSION` desde `packages/cli/package.json` (D20) · effect: behavior · test: `crates/navori-core/tests/semver.rs`::"0.13.0-rust.1 se ordena como 0.13.0 y el sello usa la versión del TS"
- [ ] **T8** (R32) — `navori-core` (`config`): `NavoriConfig` en serde con defaults, migración de claves retiradas y advertencias de claves desconocidas, con propiedades contra `NavoriConfigSchema.safeParse` (D22) · effect: behavior · test: `crates/navori-oracle-tests/tests/config_parity.rs`::"acepta, rechaza y completa defaults igual que NavoriConfigSchema"
- [ ] **T9** (R33) — config ausente o inválida: re-delegación al TS antes de cualquier salida (Q4) · effect: behavior · test: `crates/navori-cli/tests/delegation.rs`::"config inválida produce la salida del TS sin efectos"
- [ ] **T10** (R34) — `render::context::RenderContext` con `cli_version`, `floor`, `lang`, `mode`, `now` y `pid` (D19); ninguna función de markers lee estado global · effect: behavior · test: `crates/navori-core/tests/markers.rs`::"el floor solo llega por el contexto o por meta"

### M4 — Markers y anti-rollback
- **A4** [observable] — inject, remove y la matriz unitaria coinciden con Node · `cargo test -p navori-core --test markers --test anti_rollback --locked && cargo test -p navori-oracle-tests --test marker_parity --locked` → exit 0
- [ ] **T11** (R35) — `navori-core` (`markers`): `proseLines`, `findMarker`, `stripOrphanMarkers`, `buildBlock`, `inject_managed_section`, `locate`/`reorder` y secciones de usuario, con propiedades contra Node que incluyen fences, huérfanos, CRLF, bloques vacíos y Unicode no BMP (D21) · effect: behavior · test: `crates/navori-oracle-tests/tests/marker_parity.rs`::"inject coincide con injectManagedSection en bytes, status y details"
- [ ] **T12** (R36) — `remove_managed_section_guarded` con la versión de sello y sin floor, como `marker.ts:562` · effect: behavior · test: `crates/navori-oracle-tests/tests/marker_parity.rs`::"remove guardado conserva newer, sin versión y editado igual que el TS"
- [ ] **T13** (R37, R34) — matriz unitaria: floor {ausente, menor, igual, mayor} × `version=` {ausente, menor, igual, mayor} × CLI × {inject, remove}, incluida la asimetría de floor en remove (F25) · effect: tests · test: `crates/navori-core/tests/anti_rollback.rs`::"matriz floor × marker × CLI coincide con el TS"

## E3 — `render` Claude en preview
Estimated LOC: 9000

### M5 — Plan de render Claude
- **A5** [observable] — el plan Claude reproduce el golden y el wiring · `cargo test -p navori-oracle-tests --test render_claude --locked` → exit 0
- [ ] **T14** (R41) — `navori-core` (`render::claude`): resolución de assets, plugins y presets, interpolación, frontmatter, includes de hooks y `.gitignore` anidados (`.codex` incluido en solo-Claude) como plan puro de `PendingWrite`/`PendingRemoval` (D23) · effect: behavior · test: `crates/navori-oracle-tests/tests/render_claude.rs`::"el árbol Claude coincide con el snap claude de golden-render-tree"
- [ ] **T15** (R42, R37) — `settings.json` (`build-settings`, coexist, `$navori.version` con anti-rollback) y wiring nativo con conformidad D8, en `shadow` y `active` · effect: behavior · test: `crates/navori-oracle-tests/tests/render_claude.rs`::"wiring nativo igual a wiring.snap en shadow y active"
- [ ] **T16** (R41) — `navori-core` (`i18n`): cadenas de `render` y `engine` en `es` y `en`, y salida no-TTY de clack (`intro`, `log.*`, `outro`) · effect: behavior · test: `crates/navori-oracle-tests/tests/render_claude.rs`::"la salida no-TTY de render en es y en coincide con el TS"

### M6 — Comando `render` en preview
- **Consumes:** `bun run oracle:rust --only render` → ejecuta `navori-rust render` nativo (plan de M5) contra el TS sobre los fixtures
- **A6** [observable] — `render` en preview es nativo con diferencial cero y re-delega fuera del subconjunto · `bun run oracle:rust --only render` → exit 0, 0 diferencias
- [ ] **T17** (R39) — entrada `render` en `ported.json` con `when.engines = ["claude"]` y las flags `cwd`, `dry-run` y `json` (Q8); `NativeCommand.run` recibe la invocación; re-delegación antes de cualquier salida con monorepo, otro engine, `--all`, `--prune`, `--workspace` o `--verbose` · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"render re-delega con monorepo, codex y pi sin salida previa"
- [ ] **T18** (R40) — `navori-core` (`fs::RecordingFs`): sin `--apply` no hay operaciones reales en el repo, en `~/.navori` ni en `NAVORI_BACKUP_ROOT` · effect: behavior · test: `crates/navori-cli/tests/render.rs`::"render sin --apply no ejecuta operaciones reales"
- [ ] **T19** (R41, R49) — casos del oráculo de `render` y `render --json` en cada fixture aplicable y en ambos idiomas, más el test que falla si a un comando portado le falta un fixture · effect: tests · test: `packages/cli/src/__tests__/rust-oracle.test.ts`::"cada comando portado tiene caso en cada fixture aplicable"
- [ ] **T20** (R41) — máscara literal de lado para la línea de procedencia del core, `core: (embedded)` en Rust (Q11), y aviso de actualización omitido en nativo y documentado en CONTRIBUTING de la rama (Q6), con su prueba de mutación · effect: behavior · test: `packages/cli/src/__tests__/rust-oracle.test.ts`::"la máscara de procedencia solo toca su línea literal"

## E4 — Escrituras
Estimated LOC: 5500

### M7 — Capa `Fs`, backup y poda
- **A7** [observable] — los tests de D15 pasan sobre registro y disco real · `cargo test -p navori-core --features fault-injection --test fs --locked` → exit 0
- [ ] **T21** (R43, R14) — `navori-core` (`fs`): `RealFs`, escritura atómica con el nombre y el modo de `atomic.ts`, apertura `O_CREAT|O_TRUNC` sin `O_EXCL` como el TS (Q7) y mensajes de `friendlyFsError` · effect: behavior · test: `crates/navori-core/tests/fs.rs`::"todo rename va precedido por fsync y los modos con umask 022 y 077 coinciden con Node"
- [ ] **T22** (R44) — `navori-core` (`backup`, `commit`): backup proporcional, excludes efímeros, nombre `<label>-<ts>-p<pid>-<seq>`, `writeLast` y `chmod 0o755` best-effort · effect: behavior · test: `crates/navori-core/tests/fs.rs`::"el backup de un archivo precede a su primer rename o remove y no hay backup sin destrucción"
- [ ] **T23** (R45) — poda por 30 días y luego por 2 GiB, del más viejo al más nuevo, ignorando carreras, con `now` del contexto · effect: behavior · test: `crates/navori-core/tests/fs.rs`::"poda 30 días y 2 GiB con mtimes sintéticos"
- [ ] **T24** (R46) — inyección de fallos después del backup, después del write y antes del rename; mensaje de `RenderWriteError` · effect: tests · test: `crates/navori-core/tests/fs.rs`::"un fallo deja el original intacto, ningún temporal y el mensaje del TS"

### M8 — `render --apply` y `adopt`
- **Consumes:** `bun run oracle:rust --only apply` → ejecuta `render --apply` y `adopt --apply` nativos (capa `Fs` de M7) contra el TS
- **A8** [observable] — escrituras nativas con diferencial cero, matriz incluida · `bun run oracle:rust --only apply && bun run oracle:rust --only anti-rollback` → exit 0, 0 diferencias
- [ ] **T25** (R14, R47) — `render` con `apply` y `force`: commit con `RealFs`, `harnessVersion` solo tras escritura real y `refreshRepoName` en `~/.navori/registry.json` (D27) · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"render-apply en self-hosted, user-content y drifted-block"
- [ ] **T26** (R14) — `adopt` con `path`, `apply` y `cwd`; preview por defecto y backup antes de tomar el archivo · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"adopt-apply toma un archivo hecho a mano con backup"
- [ ] **T27** (R37, R49) — generador de la matriz anti-rollback en el oráculo: floor × marker × CLI × {inject, remove, hook, `settings.json`} (D26) · effect: tests · test: `scripts/js/rust-oracle/cases.json`::"anti-rollback:*"

### M9 — `sync` y `remove` no interactivos
- **Consumes:** `bun run oracle:rust` → corrida completa del oráculo sobre todos los comandos del manifiesto y los fixtures de escritura
- **A9** [observable] — todos los comandos portados con diferencial cero y cobertura completa · `bun run oracle:rust && bun run vitest run src/__tests__/rust-oracle.test.ts src/__tests__/rust-manifest-check.test.ts` → exit 0, 0 diferencias
- [ ] **T28** (R48) — flags requeridas en el manifiesto: `requires: string[][]`, `schema: 2` y varias entradas por ruta (Q5), con validador en Rust y en TS · effect: schema · test: `crates/navori-core/tests/manifest.rs`::"una invocación sin las flags requeridas se delega"
- [ ] **T29** (R14, R36) — `sync` con `apply`/`yes`, `accept-new`, `keep-mine`, `accept-new-files`, `dry-run`, `json` y `cwd`; ramas de borrado `removed`, `modified`, `foreign` y `newer` · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"sync-conflicts con cada modo bulk"
- [ ] **T30** (R14, R48) — `remove --plugin <id> --yes`: `writeConfig` con preservación de enums y render posterior; sin `--yes` se delega · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"remove-yes limpia bloques del plugin y sin --yes delega"
- [ ] **T31** (R49, R45) — fixtures `aged-backups`, `foreign-blocks`, `sync-conflicts` y `codex-trusted`; el formato de fixture admite `mtime` relativo aplicado en cada copia (D26) · effect: tests · test: `packages/cli/src/__tests__/rust-oracle.test.ts`::"los fixtures de escritura se copian con sus mtimes relativos"
