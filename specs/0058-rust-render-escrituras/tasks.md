# Migración a Rust, fase 2: config, markers, render y escrituras — Tasks

**Estado:** aceptada y replanificada el 2026-10-27 (Q13): E2 integrada; E3 absorbe a la antigua E4.
Replanificada el 2026-10-28 (Q14): E1 pasa a la fase 4 (0060). El 2026-10-28 el usuario mergeó la
primera parte de E3 (#1434) y el 2026-10-29 decidió partir el resto: la parte 2 (#1438) lleva lo
que no toca las entradas del manifiesto; la parte 3, el resto. Quedan **dos PRs** contra
`migration/rust`: E3 parte 2 y E3 parte 3 ·
**Base:** `migration/rust`. Fase 2 del programa (ver `specs/0057-migracion-rust/requirements.md`
§ "Fases del programa"). El LOC es una estimación, no una medición.

Correspondencia con `design.md` § "Plan de entregas": E1 = E5 M3 de 0057; E2 = E4 M1; E3 = E4 M2 y
E5 M1–M2.

**PRs que faltan**

| PR | Entrega | Contenido | Se mergea cuando |
|---|---|---|---|
| 1 | E3, parte 1 (#1434, integrado) | M5 hasta T14 y la primera mitad de T15 | Mergeado por el usuario el 2026-10-28 sin revisión independiente; sin efecto en runtime porque ningún comando usa aún el render Rust |
| 2 | E3, parte 2 (#1438) | El cierre de T15 y T16 (M5), M7, T28 (`schema: 2` sin entradas nuevas) y la preparación de M6 sin manifiesto: `NativeCommand` con la invocación, el gate de `render` y los archivos de ignore del comando | A5 y A7 verdes, `bun check` completo y `rust.yml` verde; sin efecto en runtime porque ningún comando del manifiesto usa el render Rust. Revisión inline por instrucción del usuario, declarada en el PR |
| 3 | E3, parte 3 | El resto de M6 (salida del comando, T18 con `RecordingFs`, T17, T19 y T20), M8 y M9 | A6, A8 y A9 verdes, `bun check` completo, `rust.yml` verde y revisión independiente que cubra también #1434 y #1438 |

Partir la parte 3 en más PRs requiere volver a preguntar al usuario.

**Precondición de entrada** (cierre de 0057, verificable antes de cerrar E3):
- `crates/ported.json` tiene `subagent-no-background` y `guard-destructive` en `shadow`, este con
  `blocks` (`guard-destructive-base`, `tgrep-search-lane`) y `deps`
  (`scripts/guard-search-routing.sh`).
- A11 de 0057 en verde sobre el `HEAD` de `migration/rust`. A10 se evalúa en 0060 (Q14).

Reglas de ejecución:
- Workplan por entrega: `0058-rust-render-escrituras-e<n>`, con fases = milestones; `tasks.md` es el
  tracking canónico.
- Un PR por entrega, contra `migration/rust`; ninguno contra `dev`. `rust.yml` y `ci.yml` solo corren
  en PRs (no en push de rama), así que el PR de la entrega se abre en draft desde su primer
  milestone y cada push corre CI; se marca listo al cerrar la entrega. Sin PRs intermedios.
- Cada prueba nueva lleva `// Covers: R<n>` (Rust y TS). Los casos nombrados son planeados; los
  archivos nuevos se crean en el milestone que los nombra.
- Los milestones que tocan Rust corren `cargo fmt --check && cargo clippy --workspace --all-targets
  --locked -- -D warnings && cargo test --workspace --locked`, además de `bun run check:fast` y sus
  `A<n>`. El cierre de cada entrega corre `bun check` completo, `rust.yml` en verde y un reviewer
  fresco.
- Hooks, render, sync, backup y markers son área crítica: un commit por mecanismo. Esta fase no
  pasa ningún hook a `active` (Q14).
- Las preguntas Q2–Q14 están resueltas (`design.md` § "Decisiones del usuario"); cambiar una
  resolución requiere volver a preguntar al usuario.

## E1 — Activación de `guard-destructive` (movida a 0060)
Estimated LOC: 1200

Decisión del usuario (Q14, 2026-10-28): la ventana de sombra no bloquea esta fase. E1 completa
(A1, A2, T1–T6, R27–R31) pasa a la fase 4 (0060), que la redeclara y la resuelve en un solo PR
junto con T27 de 0057 (`subagent-no-background`). El texto queda abajo como insumo para 0060; sus
tareas no cuentan para el cierre de esta spec. El cierre de T28 de 0057 ya llevó el corpus a
Claude 933, Codex 140 y Pi 129 casos, base de T1.

### M1 — Evidencia previa a la activación
- **Consumes:** `node scripts/js/hook-shadow-report.mjs guard-destructive` → lee el ledger de sombra que deja `navori-rust hook --shadow` en sesiones reales (0057 T24/A10)
- **A1** [observable] — corpus, fuzz y sombra cumplen D9 en los tres engines · `node scripts/js/hook-verdict-replay.mjs --impl rust --only guard-destructive && bun run fuzz:hooks --hook guard-destructive --seed 1 --cases 100000 && node scripts/js/hook-shadow-report.mjs guard-destructive` → exit 0; 0 divergencias; ≥ 500 invocaciones en ≥ 14 días por cada engine registrado (claude, codex, pi)
- **T1** (R29, → 0060) — corpus de `guard-destructive` ampliado: al menos un caso por clase de veredicto en Claude, Codex y Pi (hoy 770/6/110), con `coverage.json` actualizado · effect: tests · test: `packages/cli/src/__tests__/hook-verdict-replay.test.ts`::"guard-destructive cubre cada clase de veredicto en claude, codex y pi"
- **T2** (R27, R31, → 0060) — `scripts/js/rust-manifest-check.mjs`: `shadow` → `active` exige `shadow` en la merge-base y una línea `activate` nueva; `active` → `shadow` exige una línea `deactivate` (Q10); `active` sin `shadow` previo falla · effect: behavior · test: `packages/cli/src/__tests__/rust-manifest-check.test.ts`::"activar sin línea activate o sin sombra previa falla"
- **T3** (R28, → 0060) — el reporte de sombra cuenta invocaciones y divergencias por engine y falla si un engine donde el hook está registrado no llega al umbral. Si 0057 no entregó el ledger o el script, se completan aquí sin crear un segundo reporte (D18) · effect: behavior · test: `packages/cli/src/__tests__/hook-shadow-report.test.ts`::"un engine registrado bajo 500 invocaciones deja el reporte en rojo"

### M2 — Activación
- **A2** [observable] — Rust decide en los tres engines y ninguna salida anómala permite · `cargo test -p navori-hooks --test guard_destructive --locked && bun run vitest run src/__tests__/native-hook-failclosed.test.ts -t guard-destructive` → exit 0
- **T4** (R28, → 0060) — `ported.json` pasa `guard-destructive` a `active`, con línea `activate` en `ported-history.jsonl`, el resumen de A1 adjunto al PR y la aprobación del usuario · effect: behavior · test: `crates/navori-hooks/tests/guard_destructive.rs`::"modo active responde Rust"
- **T5** (R30, → 0060) — matriz fail-closed de T8 de 0057 sobre `guard-destructive` en `active`, invocado por el comando registrado exacto de cada engine · effect: tests · test: `packages/cli/src/__tests__/native-hook-failclosed.test.ts`::"guard-destructive activo nunca permite ante SIGSEGV, 101 o stdout cerrado"
- **T6** (R42, R30, → 0060) — re-render de los tres scripts con el fragmento activo y actualización revisada a mano de `wiring.snap` · effect: behavior · test: `crates/navori-hooks/tests/golden/wiring.snap`::"guard-destructive active"

## E2 — Config, markers y anti-rollback (integrada)

Integrada en #1410. Sin subagentes por instrucción del usuario; A3 y A4 verdes, `bun check` completo
y `oracle:rust` con 0 diferencias al cierre. El detalle de propiedades y mutaciones está en el
historial de git de este archivo.

### M3 — Semver, versión de sello y config
- **A3** [observable] — config y semver coinciden con Node en documentos generados · `cargo test -p navori-core --test semver --test config --test markers --locked && cargo test -p navori-oracle-tests --test semver_parity --test config_parity --locked` → exit 0
- [x] **T7** (R38) — `navori-core` (`semver`) con la semántica de `semver.ts` (prerelease ignorada, inparseable nunca es retroceso) y `build.rs` que emite `TS_CLI_VERSION` desde `packages/cli/package.json` (D20) · effect: behavior · test: `crates/navori-core/tests/semver.rs`::"0.13.0-rust.1 se ordena como 0.13.0 y el sello usa la versión del TS"
- [x] **T8** (R32) — `navori-core` (`config`): `NavoriConfig` en serde con defaults, migración de claves retiradas y advertencias de claves desconocidas, con propiedades contra `NavoriConfigSchema.safeParse` (D22) · effect: behavior · test: `crates/navori-oracle-tests/tests/config_parity.rs`::"acepta, rechaza y completa defaults igual que NavoriConfigSchema"
- [x] **T9** (R33) — config ausente o inválida: `config::read` devuelve la causa de re-delegación (no UTF-8, JSON, claves retiradas, esquema) y nunca adivina; el CLI re-delega antes de cualquier salida con T17 (Q4) · effect: behavior · test: `crates/navori-core/tests/config.rs`::`every_config_the_ts_must_report_is_delegated`
- [x] **T10** (R34) — `render::context::RenderContext` con `cli_version`, `floor`, `lang`, `mode`, `now` y `pid` (D19); ninguna función de markers lee estado global · effect: behavior · test: `crates/navori-core/tests/markers.rs`::"el floor solo llega por el contexto o por meta"

### M4 — Markers y anti-rollback
- **A4** [observable] — inject, remove y la matriz unitaria coinciden con Node · `cargo test -p navori-core --test markers --test anti_rollback --locked && cargo test -p navori-oracle-tests --test marker_parity --locked` → exit 0
- [x] **T11** (R35) — `navori-core` (`markers`): `proseLines`, `findMarker`, `stripOrphanMarkers`, `buildBlock`, `inject_managed_section`, `locate`/`reorder` y secciones de usuario, con propiedades contra Node que incluyen fences, huérfanos, CRLF, bloques vacíos y Unicode no BMP (D21) · effect: behavior · test: `crates/navori-oracle-tests/tests/marker_parity.rs`::"inject coincide con injectManagedSection en bytes, status y details"
- [x] **T12** (R36) — `remove_managed_section_guarded` con la versión de sello y sin floor, como `marker.ts:562` · effect: behavior · test: `crates/navori-oracle-tests/tests/marker_parity.rs`::"remove guardado conserva newer, sin versión y editado igual que el TS"
- [x] **T13** (R37, R34) — matriz unitaria: floor {ausente, menor, igual, mayor} × `version=` {ausente, menor, igual, mayor} × CLI × {inject, remove}, incluida la asimetría de floor en remove (F25) · effect: tests · test: `crates/navori-core/tests/anti_rollback.rs`::"matriz floor × marker × CLI coincide con el TS"

## E3 — `render` Claude con escrituras (PR 1)
Estimated LOC: 10000 restantes (M5 ~3000, M6 ~1500, M7–M9 ~5500)

### M5 — Plan de render Claude

Adelantado antes de E1 por decisión del usuario (Q2), en tramos ya integrados en `migration/rust`
(#1411, #1417, #1422, #1425, #1428, #1431 y #1433, antes de Q13). Cada módulo tiene paridad contra el
TS real y mutaciones verificadas:
- **Base del render:** `interpolate`, `frontmatter`, `hook-includes`, assets embebidos, núcleo de
  `render-plan`, presets, skills de librerías, plugins, `effectiveConfig` y el plan de bloques de
  `CLAUDE.md` (`render::block_plan`).
- **Motor Claude (`prepareClaudeEngine` en dry-run):** `renderManagedFile`; paso 1, `CLAUDE.md` y
  `.claude/context/` (`render::claude_md`); `resolveHarnessPlan`, `filterInventory` y la colocación
  de agentes, skills y hooks (`render::harness_files`); pasos 5–7, `progress/`, hooks del preset y
  scripts de plugins con la migración de #637 (`render::claude_files`, `render::plugin_scripts`);
  pasos 8–8.5-ter, sub-bloques con su grant de `tools:` (`render::sub_blocks`,
  `render::agent_mcp_tools`); retiros 8.5 y 8.6–8.8 con el criterio de `removable.ts`
  (`render::retirements`, `render::removable`); inventario de paths propios, el
  `navoriOwnedPaths` de `guard-destructive` (`render::owned_paths`, en la rama de E3); `.gitignore`
  anidados de `.claude`, `.codex` y `.navori` (`render::nested_gitignore`, en la rama de E3).
- **Se delega al TS:** workspaces de monorepo, destinos no normalizados o ilegibles, assets de
  plugins retirados en disco (8.5-bis) y todo lo que el TS lanza.

T14 cerrada en la rama de E3: `render::claude::plan_claude_engine` ensambla los pasos en el orden
del TS; `render_claude.rs` compara el árbol con el snap `claude` (53 archivos) y el plan con el
`finalize` real. El `.gitignore` raíz y `.prettierignore` los reconcilia el comando y llegan con M6.

T15 cerrada en la rama del resto de E3: `buildClaudeSettings` (`render::claude_settings`),
`planSettings` con coexist y `planStampedJson` (`render::settings_file`) y `planMcpRegistration`
(`render::mcp_file`) como pasos 2 y 2.5, y el wiring nativo al final del plan: el shell del
runtime y el brazo nativo de `claudeHookCommand` (`render::native_hook`), `finalizeNativeHooks` y
`applyNativeClaudeSettings` (`render::native_hooks`, con `referenceFor`/`depsFor` de `121568e7`).
`render_claude.rs` ya no excluye nada contra el motor; el golden corre sin hooks portados, como su
test TS.

T16 cerrada en la misma rama: el plan expone el `ClaudeEngineResult` que lee el reporte
(`inspected`, avisos completos en el orden del TS, entradas de `CLAUDE.md`, fallbacks), comparado
con el `runRender` real; `render::report` porta la salida no-TTY de clack y las secciones Claude
del reporte, comparadas con el stdout del comando TS. M5 cerrado (A5 verde). La procedencia del
core, los `.gitignore`, `.prettierignore` y el outro son del comando y llegan con M6. El wiring en
`active` se verifica con el verificador de integridad del binario (el `ported.json` real está en
`shadow`, así que el TS no lo puede renderizar en `active` por `prepareClaudeEngine`).

Pendiente ajeno a 0058: `navori-cli/tests/facts_cache.rs` (0057, `bccfedd0`) falla de forma
intermitente (3/5 aislado) por un presupuesto de 1 ms.
- **A5** [observable] — el plan Claude reproduce el golden y el wiring · `cargo test -p navori-oracle-tests --test render_claude --locked` → exit 0
- [x] **T14** (R41) — `navori-core` (`render::claude`): resolución de assets, plugins y presets, interpolación, frontmatter, includes de hooks y `.gitignore` anidados (`.codex` incluido en solo-Claude) como plan puro de `PendingWrite`/`PendingRemoval` (D23) · effect: behavior · test: `crates/navori-oracle-tests/tests/render_claude.rs`::"el árbol Claude coincide con el snap claude de golden-render-tree"
- [x] **T15** (R42, R37) — `settings.json` (`build-settings`, coexist, `$navori.version` con anti-rollback) y wiring nativo con conformidad D8, en `shadow` y `active` (el caso `active` sobre un manifiesto de prueba: Q14) · effect: behavior · test: `crates/navori-oracle-tests/tests/render_claude.rs`::"wiring nativo igual a wiring.snap en shadow y active"
- [x] **T16** (R41) — `navori-core` (`i18n`): cadenas de `render` y `engine` en `es` y `en`, y salida no-TTY de clack (`intro`, `log.*`, `outro`) · effect: behavior · test: `crates/navori-oracle-tests/tests/render_claude.rs`::"la salida no-TTY de render en es y en coincide con el TS"

### M6 — Comando `render` en preview (sin esperar a E1: Q14)
- **Consumes:** `bun run oracle:rust --only render` → ejecuta `navori-rust render` nativo (plan de M5) contra el TS sobre los fixtures
- **A6** [observable] — `render` en preview es nativo con diferencial cero y re-delega fuera del subconjunto · `bun run oracle:rust --only render` → exit 0, 0 diferencias
- [x] **T17** (R39) — entrada `render` en `ported.json` con `when.engines = ["claude"]` y las flags `cwd`, `dry-run` y `json` (Q8); `NativeCommand.run` recibe la invocación; re-delegación antes de cualquier salida con config ausente o inválida (T9), monorepo, otro engine, `--all`, `--prune`, `--workspace` o `--verbose` · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"render re-delega con monorepo, codex y pi sin salida previa"
- [x] **T18** (R40) — `navori-core` (`fs::RecordingFs`): sin `--apply` no hay operaciones reales en el repo, en `~/.navori` ni en `NAVORI_BACKUP_ROOT` · effect: behavior · test: `crates/navori-cli/tests/render.rs`::"render sin --apply no ejecuta operaciones reales"

Preparación de M6 integrada en la parte 2 (#1438), sin entrada en el manifiesto: `NativeCommand.run`
recibe el argv y la entrada que lo seleccionó y devuelve `Exit` o `Delegate`; `navori-cli::render`
parsea en estricto (`cwd`, `dry-run`, `json`; cualquier otra forma delega) y re-delega antes de
cualquier salida con config ausente o inválida, engines fuera de `when.engines`, workspaces o un
directorio inexistente; por ahora `run` siempre delega. `render::ignore_files` porta
`renderGitignore`, `ensurePrettierIgnore` y `scanOrphanedEngineOutputs` con paridad contra el TS.
M6 cerrado en la parte 3 (A6 verde: 18 casos de `render`, 0 diferencias). `render::command`
ensambla el plan de `runRenderCore` (Claude, `.gitignore` raíz y anidados, `.prettierignore`,
huérfanos), el reporte humano y el `--json` (`coreRoot: "(embedded)"`, `bundled: true`,
`staleCore: null`); `collect::DiskView` es la vista de producción. Los avisos de `readConfig` salen
dos veces a stderr, como las dos lecturas del TS. El reporte humano solo es nativo sin color (stdout
no TTY, sin `FORCE_COLOR` y `CI` solo con `NO_COLOR`); una terminal delega. La máscara `provenance`
del oráculo reescribe solo el lado TS. T18 se verifica corriendo el binario sin TS disponible y
comparando los árboles del repo, el home y `NAVORI_BACKUP_ROOT` antes y después: el preview no
pasa por la capa `Fs`, así que `RecordingFs` llega con el commit de M8. Fixture nuevo `claude-en`
(inglés, `.gitignore` en modo `full`, prettier, huérfano `AGENTS.md`, clave desconocida).
- [x] **T19** (R41, R49) — casos del oráculo de `render` y `render --json` en cada fixture aplicable y en ambos idiomas, más el test que falla si a un comando portado le falta un fixture · effect: tests · test: `packages/cli/src/__tests__/rust-oracle.test.ts`::"cada comando portado tiene caso en cada fixture aplicable"
- [x] **T20** (R41) — máscara literal de lado para la línea de procedencia del core, `core: (embedded)` en Rust (Q11), y aviso de actualización omitido en nativo y documentado en CONTRIBUTING de la rama (Q6), con su prueba de mutación · effect: behavior · test: `packages/cli/src/__tests__/rust-oracle.test.ts`::"la máscara de procedencia solo toca su línea literal"

### M7 — Capa `Fs`, backup y poda
- **A7** [observable] — los tests de D15 pasan sobre registro y disco real · `cargo test -p navori-core --features fault-injection --test fs --locked` → exit 0
- [x] **T21** (R43, R14) — `navori-core` (`fs`): `RealFs`, escritura atómica con el nombre y el modo de `atomic.ts`, apertura `O_CREAT|O_TRUNC` sin `O_EXCL` como el TS (Q7) y mensajes de `friendlyFsError` · effect: behavior · test: `crates/navori-core/tests/fs.rs`::"todo rename va precedido por fsync y los modos con umask 022 y 077 coinciden con Node"
- [x] **T22** (R44) — `navori-core` (`backup`, `commit`): backup proporcional, excludes efímeros, nombre `<label>-<ts>-p<pid>-<seq>`, `writeLast` y `chmod 0o755` best-effort · effect: behavior · test: `crates/navori-core/tests/fs.rs`::"el backup de un archivo precede a su primer rename o remove y no hay backup sin destrucción"
- [x] **T23** (R45) — poda por 30 días y luego por 2 GiB, del más viejo al más nuevo, ignorando carreras, con `now` del contexto · effect: behavior · test: `crates/navori-core/tests/fs.rs`::"poda 30 días y 2 GiB con mtimes sintéticos"
- [x] **T24** (R46) — inyección de fallos después del backup, después del write y antes del rename; mensaje de `RenderWriteError` · effect: tests · test: `crates/navori-core/tests/fs.rs`::"un fallo deja el original intacto, ningún temporal y el mensaje del TS"

M7 cerrado en `feat/0058-rust-e3-native-wiring` (A7 verde, 11 pruebas contra `atomic.ts`,
`backup.ts` y `commitWrites` reales; `rust.yml` corre A7). `navori-core::fs` (trait `Fs`, `RealFs`,
`RecordingFs`, `FaultFs` tras la feature `fault-injection`), `backup` (crear y podar, hora local con
`jiff`) y `commit` (`commitWrites`). Los mensajes siguen a Node, incluido el formato C++ de `rmSync`.
Ninguna escritura nativa está cableada todavía: llega con M8. Un `rm` que falla dentro del bucle
solo lo ve Codex (Claude borra best-effort).

### M8 — `render --apply` y `adopt`
- **Consumes:** `bun run oracle:rust --only apply` → ejecuta `render --apply` y `adopt --apply` nativos (capa `Fs` de M7) contra el TS
- **A8** [observable] — escrituras nativas con diferencial cero, matriz incluida · `bun run oracle:rust --only apply && bun run oracle:rust --only anti-rollback` → exit 0, 0 diferencias
- [x] **T25** (R14, R47) — `render` con `apply` y `force`: commit con `RealFs`, `harnessVersion` solo tras escritura real y `refreshRepoName` en `~/.navori/registry.json` (D27) · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"render-apply en self-hosted, user-content y drifted-block"
- [x] **T26** (R14) — `adopt` con `path`, `apply` y `cwd`; preview por defecto y backup antes de tomar el archivo · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"adopt-apply toma un archivo hecho a mano con backup"
- [x] **T27** (R37, R49) — generador de la matriz anti-rollback en el oráculo: floor × marker × CLI × {inject, remove, hook, `settings.json`} (D26) · effect: tests · test: `scripts/js/rust-oracle/cases.json`::"anti-rollback:*"

T27 cerrada: `antiRollbackCases` en `rust-oracle.mjs` genera 48 celdas, floor (`harnessVersion`)
× sello {ausente, menor, igual, mayor} × {inject en `CLAUDE.md`, bloque base de un hook,
`$navori.version` de `settings.json`}, cada una un `render --apply` sobre `fresh-init` con un
archivo superpuesto de hash válido; los casos admiten `files`. La operación `remove` entra con
`remove --yes` en M9 (T30), en la misma matriz. `rust-oracle.test.ts` comprueba cada celda.

T26 cerrada: `adopt` es nativo con `apply` y `cwd` (`navori_core::adopt`: `planAdoption` con las
rutas de `path.resolve`/`path.relative` de Node y `listMarkers`; el apply hace el backup y luego
`writeFileSync`, no atómico como el TS, y registra `harnessVersion`). Delega sin ruta posicional,
con config inválida, con color o sin raíz de backups. Pruebas: fixture `adopt` (preview, apply,
ya adoptado y cada rechazo), `adopt_parity.rs` contra `planAdoption` y el parseo en
`navori-cli/tests/adopt.rs`.

T25 cerrada: `render --apply` y `--force` son nativos (flags `apply` y `force` en `ported.json`);
`force` llega a `settings.json`, `.mcp.json`, el wiring nativo de settings y los ignore files,
que son los pasos que lo honran en el TS.
`render::command::run_render` hace un `commitWrites` por paso (motor Claude con `CLAUDE.md` al
final y remociones best-effort; cada ignore file con el suyo) antes de que el siguiente lea el
disco, reescribe los avisos de colisión con la ruta del backup, registra `harnessVersion`
(`config::record_harness_version`, forma canónica) solo con escrituras reales y avisa del cruce
del presupuesto de `CLAUDE.md` (`render::doc_budget`, tablas comparadas con el TS). El apply se
planea antes en preview, así que una re-delegación nunca llega después de escribir.
`refreshRepoName` no se porta: cuando reescribiría el registro (el TS lo ordena con
`localeCompare`) o `HOME` no sirve, el apply se delega antes de cualquier efecto. Un error de
escritura imprime el mensaje de `RenderWriteError` y sale con 1; el formato de citty/consola del TS
no se reproduce (solo alcanzable con fallos de E/S). Pruebas: casos de apply y force en `fresh-init`,
`drifted-block` y `claude-en`; proptest `render_apply_matches_the_ts_command` (stdout, stderr,
árbol del repo y de backups); paridad de `measureDocBudget` y `recordHarnessVersion`.

### M9 — `sync` y `remove` no interactivos
- **Consumes:** `bun run oracle:rust` → corrida completa del oráculo sobre todos los comandos del manifiesto y los fixtures de escritura
- **A9** [observable] — todos los comandos portados con diferencial cero y cobertura completa · `bun run oracle:rust && bun run vitest run src/__tests__/rust-oracle.test.ts src/__tests__/rust-manifest-check.test.ts` → exit 0, 0 diferencias
- [x] **T28** (R48) — flags requeridas en el manifiesto: `requires: string[][]`, `schema: 2` y varias entradas por ruta (Q5), con validador en Rust y en TS · effect: schema · test: `crates/navori-core/tests/manifest.rs`::"una invocación sin las flags requeridas se delega"
  T28 cerrada en `feat/0058-rust-e3-native-wiring` sin entradas nuevas: `ported.json` pasa a
  `schema: 2`; `manifest.rs` y `checkCommands` de `rust-manifest-check.mjs` validan `requires`
  (alternativas no vacías, sin repetir, contenidas en `flags`) y distinguen las entradas de una
  ruta por `requires` como conjunto de conjuntos. `loadNativeHooks` y `rust-hook-adapter.mjs`
  exigen el schema 2.
- [ ] **T29** (R14, R36) — `sync` con `apply`/`yes`, `accept-new`, `keep-mine`, `accept-new-files`, `dry-run`, `json` y `cwd`; ramas de borrado `removed`, `modified`, `foreign` y `newer` · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"sync-conflicts con cada modo bulk"
- [ ] **T30** (R14, R48) — `remove --plugin <id> --yes`: `writeConfig` con preservación de enums y render posterior; sin `--yes` se delega · effect: behavior · test: `scripts/js/rust-oracle/cases.json`::"remove-yes limpia bloques del plugin y sin --yes delega"
- [ ] **T31** (R49, R45) — fixtures `aged-backups`, `foreign-blocks`, `sync-conflicts` y `codex-trusted`; el formato de fixture admite `mtime` relativo aplicado en cada copia (D26) · effect: tests · test: `packages/cli/src/__tests__/rust-oracle.test.ts`::"los fixtures de escritura se copian con sus mtimes relativos"
