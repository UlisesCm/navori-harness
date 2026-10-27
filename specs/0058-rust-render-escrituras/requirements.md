# Migración a Rust, fase 2: config, markers, render y escrituras — Requirements

**Estado:** borrador · **Fecha:** 2026-10-23 · **Base:** `migration/rust` en `73fa052f`. Cada
entrega abre su propio PR contra `migration/rust`; nada de esta fase llega a `dev` ni a npm.

## Contexto

Esta spec es la fase 2 del programa de migración descrito en
`specs/0057-migracion-rust/` (§ "Fases del programa" de `requirements.md`). Hereda sin cambios las
decisiones D1–D17 de `specs/0057-migracion-rust/design.md` y los requisitos R1–R13, R15–R17, R23,
R25 y R26, que siguen vigentes en `migration/rust`.

Alcance de la fase, según la tabla del programa: config, markers, render en preview y escrituras,
más la activación de `guard-destructive`. La fase entrega por primera vez comandos nativos que
**escriben en el repo del usuario**, así que lo central son las garantías de escritura: preview,
backup, fsync, markers y anti-rollback, verificados con tests propios y con el diferencial.

**Puerta de entrada.** 0058 empieza cuando 0057 E3 esté cerrada: `subagent-no-background` en
`active`, y `guard-destructive-base` y `tgrep-search-lane` en `shadow`, con replay y fuzz a cero. La
primera entrega de esta fase activa `guard-destructive` (T28 de 0057 → `active`). Las demás
entregas dependen de eso según el orden de `tasks.md`.

**Numeración.** Los `R<n>` siguen la numeración del programa. R14 es un requisito del programa que
0057 no declaró. Esta spec lo redeclara con el texto reconstruido a partir de la tabla de fases y
de las observaciones de `design.md` de 0057; el texto original no está en el historial de git (ver
`design.md` § "Decisiones del usuario", Q9: redacción aceptada). Los requisitos nuevos empiezan en R27. R18–R22 y R24 se
quedan en el programa: los redeclara la fase 4 (0060). R19 lo redeclara la fase 3 (0059).

## Requirements (EARS)

### Activación de `guard-destructive` (puerta de entrada)

- **R27** — WHEN un PR cambia un hook de `shadow` a `active` en `crates/ported.json`, el job
  `manifest` SHALL fallar, salvo que la merge-base ya tuviera ese hook en `shadow` y el PR añada
  una línea `activate` para ese id a `crates/ported-history.jsonl`.
- **R28** — El PR que activa `guard-destructive` SHALL adjuntar replay a cero, fuzz local de
  100 000 entradas a cero y un resumen de sombra con ≥ 500 invocaciones reales en ≥ 14 días y cero
  divergencias en cada engine donde el hook está registrado (Claude, Codex y Pi). Además SHALL
  tener la aprobación explícita del usuario en el PR.
- **R29** — Antes de activar `guard-destructive`, su corpus de veredictos SHALL tener al menos un
  caso de cada clase de veredicto (permitir, preguntar o bloquear según el engine) en cada engine
  donde el hook está registrado.
- **R30** — WHILE `guard-destructive` esté en `active`, el hook invocado por su comando registrado
  exacto SHALL dar en cada engine el mismo veredicto que el shell. Ante una salida anómala del
  binario SHALL caer al shell o emitir el veredicto seguro, y nunca SHALL resolver en permitir.
- **R31** — IF un hook activo produce una divergencia confirmada THEN SHALL volver a `shadow`
  con un evento registrado en `crates/ported-history.jsonl` antes de cualquier otro cambio en su
  implementación.

### Config

- **R32** — `navori-core` SHALL aceptar exactamente las configs que acepta `NavoriConfigSchema`,
  con los mismos valores por defecto y la misma migración de claves retiradas, y SHALL emitir las
  mismas advertencias de claves desconocidas o retiradas, byte a byte, en el mismo stream.
- **R33** — IF `navori.config.json` falta o es inválida THEN un comando nativo SHALL producir el
  mismo stdout, stderr y código de salida que el TS, y no SHALL realizar ningún efecto.
- **R34** — El floor anti-rollback (`harnessVersion`) SHALL viajar como campo explícito del
  contexto de render, inicializado por el comando que lee la config. Ninguna función de markers
  SHALL leerlo de estado global.

### Markers y anti-rollback

- **R35** — `inject_managed_section` SHALL producir los mismos bytes, el mismo `status` y los
  mismos `details` que `injectManagedSection` para toda combinación de contenido existente, id,
  contenido nuevo, meta, estilo de comentario, `forceOverwrite` y `restamp`, incluidos los bloques
  citados dentro de fences, los markers huérfanos, CRLF y los bloques vacíos.
- **R36** — `remove_managed_section_guarded` SHALL conservar un bloque y reportar el mismo motivo
  (`newer` o `modified`) en los mismos casos que `removeManagedSectionGuarded`, y SHALL borrarlo
  con los mismos bytes en los demás.
- **R37** — WHEN la versión de un marker, el floor del registro o el `$navori.version` de
  `settings.json` es estrictamente mayor que la versión del CLI, Rust SHALL preservar el contenido
  y reportar el retroceso igual que el TS en las operaciones inject, remove, hook y `settings.json`.
- **R38** — WHILE la migración esté abierta, los markers, `$navori.version` y `harnessVersion` que
  escriba `navori-rust` SHALL llevar la versión de `packages/cli/package.json` del checkout con
  que se compiló, nunca la prerelease `0.13.0-rust.<n>`.

### Render en preview

- **R39** — `navori-rust render` SHALL ejecutarse en nativo solo cuando la config y las flags
  estén dentro del subconjunto portado que declara el manifiesto. En otro caso SHALL re-delegar al
  TS antes de cualquier salida o efecto.
- **R40** — WHEN un comando nativo que escribe se invoca sin `--apply` (o con `--dry-run`), SHALL
  no ejecutar ninguna operación real de escritura, borrado, backup ni poda, ni en el repo ni en
  `~/.navori`, ni en `NAVORI_BACKUP_ROOT`.
- **R41** — `navori-rust render` en preview, con y sin `--json`, SHALL producir el mismo stdout,
  stderr, código de salida y árbol que el TS en cada fixture aplicable y en cada idioma soportado
  (`es`, `en`).
- **R42** — El wiring de hooks nativos que emite el render Rust (prólogo, brazo de Claude y línea
  de integridad) SHALL coincidir byte a byte con el del TS y con
  `crates/navori-hooks/tests/golden/wiring.snap`, tanto para hooks en `shadow` como en `active`.

### Escrituras

- **R14** — WHEN un comando portado escribe en el repo del usuario o en el estado de navori, SHALL
  hacerlo con preview por defecto, backup previo, escritura atómica con fsync, markers con hash y
  versión y guard anti-rollback, con el mismo resultado que el TS. SHALL verificarse con tests
  dedicados y con el diferencial de R8.
- **R43** — Toda escritura de un archivo SHALL pasar por un temporal `.<base>.navori.tmp.<12 hex>`
  en el mismo directorio, creado con modo `0o644` sujeto a umask, seguido de write, fsync, close y
  rename. Si algo falla, SHALL borrar el temporal y reportar el mismo mensaje que `writeFileAtomic`.
- **R44** — WHEN un comando con `--apply` va a sobrescribir o borrar archivos existentes, SHALL
  copiar antes exactamente esos archivos, salvo las rutas efímeras del harness, a un backup con la
  gramática de nombre de `backup.ts`. Si no destruye nada, SHALL no crear ningún backup.
- **R45** — WHEN un backup copia al menos un archivo, SHALL podar los backups con más de 30 días y,
  después, borrar del más viejo al más nuevo hasta que el total sea ≤ 2 GiB. Una entrada que
  desaparezca a mitad de la poda SHALL ignorarse.
- **R46** — IF una escritura falla después del backup THEN el archivo original SHALL quedar intacto,
  no SHALL quedar ningún temporal, y el mensaje y el código de salida SHALL ser los del TS (rutas
  completadas, pendientes y ruta del backup).
- **R47** — `harnessVersion` SHALL registrarse solo tras una escritura real, nunca SHALL bajar, y un
  `navori.config.json` que no esté en forma canónica SHALL quedar byte a byte igual.
- **R48** — WHEN una invocación de `sync`, `remove` o `adopt` requiere un prompt interactivo,
  `navori-rust` SHALL delegarla al TS.
- **R49** — CI SHALL fallar si un comando del manifiesto que escribe no tiene caso del oráculo en
  algún fixture aplicable. Eso incluye `user-content`, `aged-backups`, `foreign-blocks`,
  `sync-conflicts` y cada celda de la matriz anti-rollback.

## Requisitos heredados que esta fase vuelve a ejercer

- **R5, R7 y R9:** cada comando portado entra al manifiesto por ruta y flags, con diferencial cero
  en todos sus fixtures.
- **R10:** un cambio TS que llegue por merge de `dev` y altere un comando portado pone CI en rojo.
- **R11–R13:** la activación de `guard-destructive` conserva el contrato de salidas, el
  fail-closed y el fallback al shell.
- **R15 y R16:** misma barra de calidad Rust.
