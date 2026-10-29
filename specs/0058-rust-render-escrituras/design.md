# Migración a Rust, fase 2: config, markers, render y escrituras — Design

**Estado:** aceptado; decisiones Q2–Q14 resueltas por el usuario (§ "Decisiones del usuario"); Q14
(2026-10-28) mueve E1 a la fase 4 (0060) ·
**Fecha:** 2026-10-23 · **Base verificada:**
`origin/migration/rust` = `73fa052f` (merge de #1393). Toda afirmación "ya existe" o "falta" se
leyó en ese commit; las referencias `archivo:línea` apuntan a él. Cada entrega abre su propio PR
contra `migration/rust`.

**Alcance del documento:** fase 2 del programa (`specs/0057-migracion-rust/requirements.md` §
"Fases del programa"). Se reutilizan sin cambios las decisiones D1–D17 de
`specs/0057-migracion-rust/design.md`; las decisiones nuevas siguen la numeración (D18 en
adelante), igual que los modos de falla (F18 en adelante) y las preguntas (Q2 en adelante; Q1 es
de 0057). Corresponde a las entregas E4, E5 y E5 M3 del "Plan de entregas" de 0057,
reordenadas como se explica en § "Plan de entregas".

**Señal arquitectónica:** primer código Rust que escribe y borra en el repo del usuario; markers
gestionados y guard anti-rollback; activación de un hook con compuerta (`guard-destructive`)
en los tres engines; contrato compartido (`crates/ported.json` y su historial).

## Decision drivers

Los mismos de 0057 (TS como oráculo, fallar hacia lo seguro, velocidad sin bajar calidad, `dev`
libre de Rust, mínima superficie de conflicto, invariantes 1–10), más tres propios de esta fase:

1. **Una escritura equivocada no se revierte con un despoteo.** Un hook mal portado se corrige
   volviendo al shell; un archivo del usuario sobrescrito solo se recupera si existía su backup. Por
   eso cada mecanismo de escritura tiene un test dedicado además del oráculo (D15 de 0057).
2. **El anti-rollback compara versiones entre binarios.** Durante la convivencia escriben el TS y
   Rust sobre los mismos markers; cualquier diferencia en la versión que sellan se convierte en un
   bloqueo (D20).
3. **Nada interactivo en esta fase.** Los prompts (D16 de 0057) se quedan en el TS; los comandos
   nativos solo cubren las invocaciones que no preguntan (R48).

## Qué ya existe (evidencia en `73fa052f`)

### En `crates/`

- **Manifiesto.** `crates/ported.json` solo lista `--version` y `--help`, y `hooks` está vacío. El
  historial `crates/ported-history.jsonl` está vacío.
  - `Manifest::select` (`crates/navori-core/src/manifest.rs:139-143`) admite una invocación si su
    ruta empieza con la de la entrada y **sus** flags están contenidas en la lista. Una invocación
    sin flags siempre cabe: no hay forma de declarar "solo con `--apply`" (ver D25).
  - `validate` rechaza rutas duplicadas (`manifest.rs:155-156`), así que tampoco caben dos entradas
    `render` con flags distintas.
  - `When` solo tiene `engines` (`manifest.rs:37-41`).
- **Despacho nativo.** `NATIVE` en `crates/navori-cli/src/lib.rs:37-46` tiene dos comandos, y
  `NativeCommand.run` es `fn() -> ExitCode`, sin argv ni contexto (`lib.rs:19-24`).
- **Hooks.** `NATIVE_HOOKS` está vacío (`crates/navori-cli/src/hook.rs:28`). Existen
  `hooks/subagent_no_background/` y el modo sombra (`crates/navori-cli/src/shadow.rs`). No hay
  código de `guard-destructive` en `crates/`.
  - La sombra **no** escribe todavía el ledger de divergencias ni de invocaciones
    (`shadow.rs:4`, `shadow.rs:57`). No existe `scripts/js/hook-shadow-report.mjs`, que el A10 de
    0057 ya invoca.
- **Integridad y hash de marker.** `crates/navori-core/src/integrity.rs`: `js_trim_end` (114),
  `normalize_marker` (120) y `marker_hash` (127) ya reproducen `normalize` y `hashContent` de
  `marker.ts:64-70`. El parser de markers (inject/remove/locate) no existe.
- **JSON con semántica JS.** `crates/navori-core/src/js_json.rs` (`JsValue`, `stringify`, 136).
- **Assets embebidos.** `crates/navori-core/build.rs` genera la tabla `ASSETS`, pero **no** lee la
  versión de `packages/cli/package.json` (`build.rs:25-58`), aunque el § "Assets embebidos" de 0057
  lo prevé. `navori_core::VERSION` es la del workspace, `0.13.0-rust.1` (`lib.rs:4`).
- **Auditoría** (`audit.rs`) y **delegación** (`delegate.rs`): sin cambios en esta fase.

### En el oráculo y CI

- `scripts/js/rust-oracle/fixtures/` tiene `drifted-block`, `empty`, `fresh-init`, `monorepo`,
  `pi`, `self-hosted` y `user-content`. **Faltan** `codex-trusted`, `aged-backups`,
  `foreign-blocks`, `sync-conflicts` y la matriz anti-rollback, que D5 de 0057 difiere "hasta que
  se porte un comando que escriba".
- `cases.json` ya trae casos delegados de `render`, `render --apply` y `sync` sobre varios
  fixtures, útiles como base.
- El test "los casos cubren el repo con contenido de usuario y la superficie del golden"
  (`packages/cli/src/__tests__/rust-oracle.test.ts:242`) no comprueba la regla de R9 "cada comando
  portado tiene caso en cada fixture aplicable".
- `scripts/js/rust-manifest-check.mjs:21-61` valida `port`/`unport` y el aviso de 14 días. **No**
  valida las transiciones `shadow` → `active` ni la línea `activate`.
- El entorno del oráculo fija `NAVORI_NO_UPDATE_NOTIFIER=1` (D5 de 0057), así que el aviso de
  actualización no se compara nunca (ver D27).

### TS a portar

- **Markers** — `packages/cli/src/lib/render/marker.ts`:
  - `findMarker` y `stripOrphanMarkers` son conscientes de fences vía `proseLines`.
  - `injectManagedSection` (383-526) devuelve cinco estados: `created`, `updated`, `unchanged`,
    `user-modified-skipped` y `downgrade-skipped`.
  - El floor es estado de módulo: `ambientFloorVersion` (113) y `setMarkerFloorVersion` (116). Lo
    fijan `commands/render.ts:756` y `commands/sync.ts:836`, y lo limpia `render.ts:618`.
  - `removeManagedSectionGuarded` (552-569) compara contra `readCliVersion()` (562) **sin** el
    floor. Esa asimetría con inject es comportamiento vigente y la matriz debe fijarla (F25).
- **Semver** — `lib/primitives/semver.ts`. `parseSemver` ignora el sufijo `-prerelease` (22-27) e
  `isDowngrade` (54-59) trata lo que no se puede parsear como "no es retroceso".
- **Escritura atómica** — `lib/primitives/atomic.ts:22-46`. Abre el temporal con `openSync(tmp,
  "w", 0o644)` (29), es decir `O_CREAT|O_TRUNC` **sin** `O_EXCL`; D15 de 0057 dice `create_new`
  (resuelto por Q7: manda el TS). Los mensajes de `friendlyFsError` (48-71) son contrato de salida.
- **Backup** — `lib/render/backup.ts`:
  - el nombre usa hora local (`timestamp`, 39-47), más `-p<pid>` y una secuencia por proceso (61,
    97);
  - la raíz es `NAVORI_BACKUP_ROOT` (19-25);
  - la poda (160-204) borra primero por antigüedad y después por tamaño, e ignora carreras.
- **Commit de escrituras** — `engines/shared/execute-plan.ts:977-1080` (`commitWrites`):
  - el backup es proporcional: solo los pendientes que ya existen y las remociones;
  - excluye `EPHEMERAL_HARNESS_PATHS`;
  - poda solo si el backup copió algo;
  - aplica `writeLast`;
  - hace `chmod 0o755` best-effort (1053);
  - `removalsBestEffort`;
  - `RenderWriteError` con las rutas completadas y pendientes.
- **Config** — `lib/config/config.ts`:
  - `readConfig` (610) valida con zod y lanza `ConfigError` con `issues` (629-640);
  - `writeConfig` (505-509) re-valida y preserva enums;
  - `recordHarnessVersion` (523) solo sube la versión y deja intacto un archivo no canónico;
  - el esquema está en `lib/config/schema.ts` (639 líneas).
- **Render** — `commands/render.ts`:
  - `runRender` (605-620) y `runRenderCore` (634-1148);
  - `refreshRepoName` escribe `~/.navori/registry.json` en cada apply (764);
  - el `.gitignore` anidado de `.codex` se renderiza **también** en repos solo-Claude (1014);
  - la línea de procedencia `core: <root> (build copy)` sale en toda corrida no-JSON (1310;
    `lib/i18n.ts:3267`).
  - El motor Claude son ~5 000 líneas: `engines/claude/index.ts` (2 875) y `build-settings.ts`
    (1 064), más los compartidos de `engines/shared/` (8 367).
- **Idiomas** — `Lang = "es" | "en"` (`lib/i18n.ts:15`, 566); el archivo tiene 4 539 líneas.
- **Aviso de actualización** — `packages/cli/src/index.ts:24` lo lanza en todo comando salvo
  `gate`.
- **Comandos con prompt:**
  - `sync` sin `--apply`/`--yes` ni modo bulk pregunta con `p.select`/`p.confirm`
    (`commands/sync.ts:372-415`);
  - `remove` sin `--yes` pregunta con `p.confirm` (`commands/remove.ts:63`);
  - `adopt` no pregunta: es preview salvo `--apply`.

### `guard-destructive` hoy

- Está registrado en los tres engines: `.claude/hooks/guard-destructive.sh`,
  `.codex/config.toml:19` y `.pi/navori/hooks/guard-destructive.sh`.
- Su corpus (`packages/cli/src/__tests__/fixtures/hook-verdict-corpus/guard-destructive.sh.jsonl`)
  tiene 886 casos: 770 Claude, 110 Pi y **6 Codex**.

## Approach

Cuatro entregas, en este orden:

1. **Activar `guard-destructive`.** Es la puerta de entrada.
2. **Bibliotecas puras.** Config, semver, markers y anti-rollback.
3. **`render` Claude en preview.** Toda escritura pasa por la capa `Fs` en modo registro.
4. **Escrituras reales.** Capa `Fs` real, backup y poda, y los comandos `render --apply`, `adopt`,
   `sync` y `remove` en sus invocaciones no interactivas.

El render se modela como en el TS: un **plan puro** (lista de `PendingWrite`/`PendingRemoval`)
seguido de un **commit**. Preview = plan sin commit, y eso hace R40 verificable por construcción.

### Escalera de opciones para la decisión de mayor riesgo: dónde vive el primer comando que escribe

- **Patrón existente: seguir delegando toda escritura hasta el corte.** Descartado: la fase 4 tendría
  que probar de una sola vez todas las escrituras, justo lo que el strangler evita.
- **Extensión: plan puro + capa `Fs` con modo registro, comando por comando (elegida).** Reutiliza la
  separación plan/commit que ya existe en `execute-plan.ts`, y cada comando entra al manifiesto
  solo con sus flags no interactivas.
- **Nueva arquitectura: transacción con journal y rollback automático.** Descartado: mejora el TS en
  lugar de reproducirlo (§ "NOT in scope" de 0057). Si se quiere, va primero a `dev`.

## Components

- **`crates/navori-core`**, módulos nuevos:
  - `semver` (D20);
  - `config` (D22);
  - `markers` (D21);
  - `render::context` (D19);
  - `render::claude` (D23);
  - `fs` con `RealFs` y `RecordingFs` (D24);
  - `backup` (D24);
  - `i18n` (solo las cadenas que emiten los comandos portados; D23).
- **`crates/navori-core/build.rs`:** además de `ASSETS`, emite `TS_CLI_VERSION` leída de
  `packages/cli/package.json` (D20).
- **`crates/navori-cli`:** `NativeCommand.run` recibe la invocación parseada; se añaden `render`,
  `adopt`, `sync` y `remove`, cada uno con su fila en la tabla del parser (D2 de 0057).
- **`crates/navori-hooks/src/hooks/guard_destructive/`:** viene de 0057 E3; esta fase solo cambia
  su `mode` (D18).
- **`crates/ported.json`:** entradas nuevas, `schema: 2` y el campo de flags requeridas `requires`
  (D25).
- **`scripts/js/rust-manifest-check.mjs`:** transiciones de modo (D18).
- **`scripts/js/rust-oracle.mjs`, `rust-oracle/fixtures/` y `cases.json`:** fixtures de escritura
  con mtimes, generador de la matriz anti-rollback y test de cobertura por fixture (D26).
- **`crates/navori-oracle-tests`:** propiedades JS-vs-Rust de config, semver y markers, con el
  mismo proceso Node persistente que `js_json` (D14 de 0057).

## Decisions

### D18 — Activar `guard-destructive` primero, como puerta de entrada (R27–R31)

> Superada en el orden por Q14 (2026-10-28): la activación pasa a 0060 y se resuelve junto con la
> de `subagent-no-background` (T27 de 0057). El resto de D18 (herramientas, corpus Codex, umbral
> Q3) sigue vigente como insumo de 0060. El caso `active` de R42 se prueba en E3 con un manifiesto
> de prueba, el costo que este mismo D18 anticipaba.

- **Orden.** E1 de 0058 es la activación (E5 M3 en el plan de 0057). Así lo pidió el usuario: la
  activación es la puerta de entrada de la fase. Además, el render Rust de E3 tiene que reproducir
  el wiring de un hook **activo** (R42); si la activación llegara al final, ese caso solo se
  probaría con un hook sintético.
- **Precondiciones verificables** (cierre de 0057 E3):
  - A10 y A11 de 0057 en verde;
  - `subagent-no-background` en `active` en `ported.json`;
  - `guard-destructive` en `shadow` con `blocks` (`guard-destructive-base`, `tgrep-search-lane`) y
    `deps` (`scripts/guard-search-routing.sh`).
- **Dependencia de herramientas.** R28 necesita un reporte de sombra que cuente **invocaciones**
  por engine, no solo divergencias. Hoy no existen ni el ledger (`shadow.rs:4`) ni el script del
  reporte. Si 0057 cierra E3 sin ellos, el T3 de esta fase los completa. No se escribe un segundo
  reporte paralelo.
- **Corpus Codex.** Seis casos no cubren las clases de veredicto (R29, T6 de 0057). E1 amplía el
  corpus Codex antes de medir. Si Codex tarda en llegar a 500 invocaciones, se espera (Q3): no hay
  modo por engine ni umbral distinto.
- **Transiciones en el job `manifest` (R27, R31):**
  - `shadow` → `active` exige el hook en `shadow` en la merge-base y una línea nueva
    `{"op":"activate","id":…}`;
  - `active` → `shadow` exige una línea nueva `{"op":"deactivate",…}` (Q10). `deactivate` no
    cuenta como despoteo: no dispara el aviso de 14 días ni bloquea `cutover:check` por sí solo;
  - `active` sin pasar por `shadow` falla.
- **Reversión.** `NAVORI_HOOK_IMPL=shell` sigue siendo la salida de emergencia inmediata (D7 de
  0057). La reversión durable es un PR que vuelve a `shadow` y re-renderiza (el fragmento cambia por
  `--shadow`, `native-hook.ts:96`).

### D19 — Contexto de render explícito (R34)

`RenderContext { cli_version, floor: Option<String>, lang, mode: Preview | Apply, now, pid }` se
construye una vez por comando, después de leer la config. Reemplaza a `ambientFloorVersion` y
`setMarkerFloorVersion` (`marker.ts:113-118`). `inject_managed_section` recibe el floor por
parámetro, igual que `meta.floorVersion`; la precedencia es `meta.floor_version` sobre el floor del
contexto, como en `marker.ts:462-465`. `now` y `pid` son entradas del contexto para que los tests de
backup y poda no dependan del reloj.

### D20 — Versión de sello = versión del TS del checkout (R38)

- `parseSemver` descarta el sufijo de prerelease (`semver.ts:24`), así que `0.13.0-rust.1` se ordena
  como `0.13.0` y queda por encima de `0.12.2`, la versión de `dev` (`packages/cli/package.json:3`).
- Si Rust sellara su propia versión, el TS de ese mismo checkout vería cada bloque escrito por Rust
  como "de un navori más nuevo" y respondería `downgrade-skipped` en todo render y sync posterior.
  `harnessVersion` subiría a `0.13.0`, y desde ahí el floor bloquearía también los bloques que nunca
  tocó Rust. Además, el oráculo daría diferencias en cada marker.
- **Decisión:** `build.rs` emite `TS_CLI_VERSION` desde `packages/cli/package.json`, y todo sello de
  versión (`version=` del marker, `$navori.version`, `harnessVersion`, `readCliVersion()` en
  `remove_managed_section_guarded`) usa ese valor. `navori_core::VERSION` queda solo para
  `--version` (R25). La regla vale hasta el corte; D17 de 0057 redefine las dos versiones en 0060.
- Lo fuerza R9 (diferencial cero), así que no se deja como pregunta abierta.

### D21 — Puerto literal de los markers (R35–R37)

- Se portan `proseLines`, `findMarker`, `closeStartAfter`, `stripOrphanMarkers`, `buildBlock`,
  `openMarker`, `injectManagedSection`, `removeManagedSection`, `removeManagedSectionGuarded`,
  `extractManagedContent`, `readMarkerAttrs`, `locateManagedBlocks`, `reorderManagedBlocks` y las
  secciones de usuario (`splitUserSection`, `emitUserSection`). La estructura es la del TS, no un
  rediseño.
- **Índices.** El TS corta por unidades UTF-16 y Rust por bytes UTF-8. Como todos los cortes del
  TS caen en límites que vienen de un match de regex o de `\n`, el puerto trabaja sobre `&str` con
  offsets en bytes. Los tests de propiedad incluyen caracteres fuera del BMP, U+2028/U+2029 y
  U+FEFF dentro y fuera de los bloques (F26).
- **Regex.** Los patrones del TS (`\s`, `[^"]+`, `\n{3,}`) se traducen a `regex` 1.13.1 con clases
  explícitas cuando `\s` de JS difiere del de Rust: el mismo criterio de `js_trim_end`.
- **Asimetría vigente.** `remove_managed_section_guarded` compara contra la versión de sello (D20)
  sin floor, como `marker.ts:562`. La matriz la fija con un caso propio para que el puerto no la
  "corrija" en silencio (F25).

### D22 — Config: serde con validación propia y diferencial contra zod (R32, R33)

- `NavoriConfig` en serde con `#[serde(default)]` donde zod tiene `.default()`. La migración de
  claves retiradas (`RETIRED_CONFIG_KEYS`, `config.ts:69`) y la detección de desconocidas
  (`findUnknownConfigKeys`, 437) se portan como funciones aparte, porque emiten las advertencias que
  hoy salen en cada comando (por ejemplo, "claves de config desconocidas…").
- **Aceptación (R32):** propiedades con documentos generados. El proceso Node persistente devuelve
  `NavoriConfigSchema.safeParse` normalizado y Rust debe coincidir en aceptar o rechazar y en el
  valor efectivo serializado con `js_json`.
- **Config inválida o ausente (R33):** se **re-delega** al TS antes de cualquier salida (Q4), lo
  que cumple R33 sin reproducir los mensajes de zod. Reproducirlos exigiría portar el formato de
  cada tipo de issue de zod 4 y mantenerlo en cada merge de `dev`. Rust solo decide "válida o no";
  la propiedad de R32 garantiza que esa decisión coincide con zod.
- **Lectura del JSON (hallazgos de M3).** `js_json::parse` conserva el orden de inserción de
  `JSON.parse`. Debe funcionar con y sin el feature `arbitrary_precision` de `serde_json`, que
  `navori-hooks` activa y que, por unificación de features, rige en el binario `navori-rust`.
  Además necesita `float_roundtrip` para redondear como JS. Lo que no modela (sustitutos solitarios,
  `Infinity`, anidamiento > 128, `__proto__`) se re-delega.
- **Advertencias duplicadas.** `render` llama a `readConfig` dos veces (instantánea del presupuesto en
  `render.ts:1260` y `runRender`), así que el TS imprime cada advertencia de config dos veces. E3 lo
  reproduce tal cual.
- `writeConfig` (para `remove`) re-valida y preserva enums de compatibilidad futura
  (`preserveForwardCompatEnums`); se porta en E3 M9 junto con su único consumidor.

### D23 — `render` Claude en preview (R39–R42)

- **Subconjunto nativo** (Q8: el mínimo):
  - config: `engines` = `["claude"]` (o ausente), sin `monorepo.workspaces` habilitados;
  - flags: `cwd`, `dry-run` y `json` en E3 M6; `apply` y `force` en E3 M8.
  - Se re-delega con `--all`, `--prune`, `--workspace` o `--verbose`, con otro engine, con
    workspaces o con un plugin cuyo asset no esté embebido.
  - La re-delegación ocurre después de leer la config y **antes de cualquier salida** (D3 de 0057):
    hay un fixture por cada condición (F21).
- **Pipeline.** Rust sigue el orden de `runRenderCore`:
  1. leer la config;
  2. contexto (D19);
  3. plan Claude;
  4. `.gitignore` raíz y anidados (`.claude`, `.codex` incondicional, `.navori`);
  5. `.prettierignore`;
  6. escaneo de salidas huérfanas (solo reporte; `--prune` queda delegado).
- **Wiring de hooks (R42).** El render Rust reproduce `nativeRunnerShell`, la conformidad de D8 y
  la finalización tras plugins de `native-hook-render.ts`. Se compara con el TS (oráculo) y con
  `wiring.snap` (golden manual), con `guard-destructive` en `active` y `subagent-no-background`
  también en `active` sobre un manifiesto de prueba (Q14: la activación real es de 0060).
- **Salida.** Las cadenas de `render` y de `engine` de `lib/i18n.ts` en `es` y `en`. La salida
  no-TTY de clack (`p.intro`, `p.log.*`, `p.outro`) se reproduce byte a byte (D16 de 0057);
  `NO_COLOR` y la ausencia de TTY son las del oráculo.
- **Línea de procedencia.** El TS imprime la raíz de `core-assets` que leyó. Rust lee assets
  embebidos y no tiene esa ruta. El oráculo aplica una máscara literal de lado, igual que la de
  versión (D5 de 0057), solo para esa línea (Q11). Rust imprime `core: (embedded)` con el mismo
  formato de `p.log.message`; nunca una ruta que no leyó.
- **Tamaño (Q12).** Se acepta el tamaño de E3 sin recortar el subconjunto: presets locales y
  plugins con `hookExtensions` entran, para que `self-hosted` sea nativo. M5 se parte en un commit
  por mecanismo (assets/plugins, interpolación/frontmatter, includes/wiring, settings, i18n).

### D24 — Capa `Fs`, backup y poda (R14, R40, R43–R46)

- Materializa D15 de 0057 con lo que mostró el código:
  - `trait Fs` con `create_temp`, `write`, `fsync`, `close`, `rename`, `remove`, `chmod`,
    `mkdir_all`, `copy`, `set_mtime` y `read_dir`;
  - `RealFs` y `RecordingFs`, que anota sin tocar disco;
  - la feature `fault-injection` solo en tests.
- **Escritura atómica (R43).** El nombre del temporal, el modo, el orden y el flag de apertura son
  los de `atomic.ts`: `O_CREAT|O_TRUNC|O_WRONLY`, sin `O_EXCL` (Q7). El texto de D15 de 0057 se
  enmienda en consecuencia; una mejora a `wx` iría primero a `dev`. Los mensajes de error se portan
  de `friendlyFsError`.
- **Commit (R44, R46).** Se porta `commitWrites`:
  - backup proporcional (solo los pendientes existentes y las remociones);
  - exclusión de `EPHEMERAL_HARNESS_PATHS`;
  - poda solo si se copió algo;
  - `writeLast` (`CLAUDE.md` al final);
  - `chmod 0o755` best-effort;
  - remociones best-effort o dentro del `try`, según el motor;
  - el mensaje de `RenderWriteError`.
- **Backup (R44).** Nombre `<label>-YYYY-MM-DDTHH-mm-ss-SSS-p<pid>-<seq>` en hora local, con `now`,
  `pid` y `seq` tomados del contexto. La hora local la da `jiff` (`TZ` y luego `/etc/localtime`,
  como Node), aprobado por el usuario el 2026-10-28; sin ella, `std` solo da UTC. Se copian
  archivos regulares y se omiten sockets y FIFOs. Los symlinks **se siguen**: `statSync` no es
  `lstatSync`, así que un enlace a un archivo se copia como archivo y uno a un directorio se
  recorre (el comentario de `backup.ts:129` dice lo contrario). Las entradas van en el orden de
  `scandir` de libuv, ordenadas por bytes.
- **Poda (R45).** Antigüedad > 30 días por `mtime`, luego tamaño > 2 GiB del más viejo al más
  nuevo. Los errores de `stat`/`rm` por carrera se ignoran.
- **Preview (R40).** El comando recibe `RecordingFs` salvo con `--apply` sin `--dry-run` (en el TS,
  `--dry-run` gana). Un test comprueba que la lista de operaciones reales queda vacía, incluidas
  `~/.navori/registry.json` y la raíz de backups.

### D25 — Selección por flags requeridas (R48)

- **Problema.** `select` acepta una invocación sin flags en cualquier entrada de la misma ruta
  (`manifest.rs:139-143`). Si `sync` entra con `["apply", …]`, `navori sync` a secas también sería
  nativo y llegaría al `p.select` de `sync.ts:384`.
- **Decisión** (Q5): un campo opcional `requires: string[][]` (alternativas de flags; al menos una
  debe estar presente) y permitir varias entradas por ruta cuando difieran en `requires`. Ejemplos:
  - `sync` requiere `[["apply"], ["yes"], ["accept-new", "apply"], …]`;
  - `remove` requiere `[["yes"]]`.

  Cambia el esquema, así que `schema` pasa a `2`, con validador en Rust (`manifest.rs`) y en TS
  (`rust-manifest-check.mjs`).
- **Descartado:** que el código nativo re-delegue al detectar que preguntaría. No cambia el
  esquema, pero saca del manifiesto la regla de qué es nativo (R7).

### D26 — Oráculo de escrituras (R14, R37, R49)

- **Fixtures nuevos:**
  - `aged-backups`: backups con mtimes declarados relativos al momento de la copia (`-40d`, `-5d`)
    y tamaños que cruzan 2 GiB con archivos dispersos, para no ocupar disco;
  - `foreign-blocks`: bloques sin `version`, con hash editado o de una versión mayor;
  - `sync-conflicts`;
  - `codex-trusted`: solo para comprobar la re-delegación.
- **Formato.** El fixture declarativo admite `mtime` relativo. El oráculo lo aplica en cada copia, de
  modo que TS y Rust ven la misma edad.
- **Matriz anti-rollback.** Un generador produce un fixture por celda: floor {ausente, menor, igual,
  mayor} × `version=` del marker {ausente, menor, igual, mayor} × operación {inject vía `render
  --apply`, remove vía `remove --yes`, hook, `settings.json` `$navori.version`}. La versión del CLI
  es la del checkout (D20).
- **Cobertura (R49).** Un test de `rust-oracle.test.ts` recorre los `commands` del manifiesto y
  falla si a uno que escribe le falta caso en algún fixture aplicable o en alguna celda de la
  matriz.
- **Máscaras.** Ninguna nueva salvo la de procedencia (D23, Q11). Los nombres de backup ya tienen
  `@BACKUP@`.

### D27 — Efectos fuera del repo (R40, R47)

- **`~/.navori/registry.json`.** `refreshRepoName` (`render.ts:764`) se porta con la capa `Fs`:
  solo con apply y solo si la entrada ya existe.
- **`harnessVersion` (R47).** Se registra después del commit, solo si hubo una escritura real
  (contador equivalente a `noteRealWrite`), con la regla de forma canónica de `config.ts:537`.
- **Aviso de actualización.** El TS lo lanza en cada comando (`index.ts:24`) y el oráculo lo apaga.
  Los comandos nativos lo **omiten** durante la convivencia (Q6): `navori-rust` no se publica y la
  versión que anunciaría sería la del TS. Queda documentado en CONTRIBUTING de la rama y lo retoma
  0060.

## Contracts

- **`crates/ported.json`.** Entradas nuevas `render`, `adopt`, `sync` y `remove`. `schema: 2` con
  `requires?: string[][]` y varias entradas por ruta (Q5). `hooks.guard-destructive.mode`
  = `active`.
- **`crates/ported-history.jsonl`.** Una línea `activate` para `guard-destructive` y el nuevo
  `op: "deactivate"` (Q10).
- **Sin cambios:** el formato y el hash de los markers, `$navori.version`, `harnessVersion`, el
  formato de `navori.config.json`, el nombre de los backups, el comando registrado de Codex y el
  puente de Pi.
- **Versión de sello (D20):** la del TS del checkout, no la de `--version`.

## Failure modes

| # | Falla | Contención |
|---|---|---|
| F18 | Rust sella `0.13.0-rust.<n>` y el TS ve cada bloque como "más nuevo" | Versión de sello del TS (D20); el oráculo compara markers byte a byte |
| F19 | Codex no llega a 500 invocaciones en 14 días | Corpus Codex ampliado; se espera hasta cumplirlo (Q3); no se activa antes |
| F20 | `sync` o `remove` nativos llegan a un prompt | Flags requeridas (D25) o re-delegación previa; casos sin flags en el oráculo |
| F21 | Render nativo emite salida y luego descubre una config no portada | Re-delegación antes de cualquier salida; un fixture por condición (D23) |
| F22 | Preview que toca `~/.navori`, la raíz de backups o el registro | `RecordingFs` con lista real vacía (D24); el oráculo compara esos árboles |
| F23 | Divergencia tras activar `guard-destructive` | `NAVORI_HOOK_IMPL=shell` inmediato; vuelta a `shadow` con evento (R31) |
| F24 | Puntos ciegos del oráculo (aviso de actualización, línea de procedencia, TTY) | Aviso omitido y documentado (D27); máscara literal de procedencia (D23); los prompts quedan delegados (R48) |
| F25 | El puerto "corrige" la asimetría de floor entre inject y remove | Celda propia en la matriz (D21, D26) |
| F26 | Offsets UTF-16 frente a UTF-8 en el parser de markers | Propiedades con caracteres no BMP y separadores Unicode (D21) |
| F27 | La poda depende del reloj y el oráculo no lo controla | mtimes relativos aplicados en cada copia (D26); `now` del contexto en unitarios (D19) |
| F28 | Un merge de `dev` cambia `marker.ts`, `atomic.ts` o el motor Claude | Diferencial y propiedades en CI (R10); despoteo con registro (D1 de 0057) |

## Migration

- Ningún contrato de usuario cambia. Los comandos nativos existen solo en `navori-rust`.
- **Activación (en 0060, Q14).** Al pasar `guard-destructive` a `active`, el siguiente `render --apply` en
  `migration/rust` reescribe el fragmento nativo de sus tres scripts (sin `--shadow`). Esos archivos
  renderizados cambian en la rama, con conflicto de clase 1 en la siguiente sincronización con
  `dev` (D1 de 0057).
- **Reversión:** despotear el comando (con registro) o volver el hook a `shadow`. Un archivo ya
  escrito por Rust se restaura con `navori backup restore`, que sigue siendo TS.

## Testing strategy

- **T18 — Transiciones del manifiesto (R27, R31).** Fixtures de merge-base sintéticos: activar sin
  línea, activar sin `shadow` previo y desactivar sin evento fallan; la transición correcta pasa.
- **T19 — Evidencia de activación (R28, R29).** Replay, fuzz de 100 000 entradas y reporte de
  sombra por engine registrado. El corpus por clase de veredicto se comprueba con `coverage.json`.
- **T20 — Activo y fail-closed (R30).** La matriz T8 de 0057 sobre `guard-destructive` en
  `active`, invocado por el comando registrado de cada engine.
- **T21 — Config (R32, R33).** Propiedades contra `NavoriConfigSchema` más los fixtures de config
  inválida y ausente.
- **T22 — Markers (R35, R36).** Propiedades contra Node para inject, remove guardado, locate y
  reorder, con fences, huérfanos, CRLF, bloques vacíos y Unicode.
- **T23 — Anti-rollback (R37, R34, R38).** Matriz unitaria en E2; matriz de oráculo en E3 M8 (D26).
- **T24 — Render en preview (R39–R42).** Oráculo sobre los fixtures aplicables en `es` y `en`, con
  y sin `--json`; un fixture por condición de re-delegación; `wiring.snap`.
- **T25 — Capa `Fs` (R14, R43–R46).** Los tests de D15 de 0057: orden, fsync, modos con umask
  `022` y `077`, inyección de fallos, poda y borrados.
- **T26 — Comandos que escriben (R14, R44, R47, R48, R49).** Oráculo de `render --apply`,
  `adopt --apply`, `sync` no interactivo y `remove --yes` con los fixtures de escritura y la matriz,
  más el test de cobertura por fixture.

## Plan de entregas

Cada entrega es un PR contra `migration/rust` y exige `rust.yml` y `ci.yml` en verde. Relación con
el plan de 0057: E1 = E5 M3; E2 = E4 M1; E3 = E4 M2 y E5 M1–M2.

**Replanificación (Q13, 2026-10-27).** Tras integrar E2 y la mayor parte de E3 M5 en tramos, el
usuario pidió la mínima cantidad de PRs para lo que falta. La antigua E4 se funde en E3: quedan dos
PRs, E1 y E3. E1 sigue aparte porque depende de la ventana de sombra y de la aprobación del usuario
en su propio PR; E3 se mergea después de E1 porque M6 toca `ported.json` (Q2). El costo es un PR
grande de área crítica (render y escrituras): cada mecanismo sigue en su propio commit y el cierre
exige revisión independiente.

**Replanificación (Q14, 2026-10-28).** El usuario no espera la ventana de sombra de 14 días para
cerrar fases: E1 pasa a la fase 4 (0060), junto con T27 de 0057, y queda un PR, E3. E3 ya no espera
a E1; M6 toca `ported.json` sin activar hooks.

### E1 — Activación de `guard-destructive` (puerta de entrada)

- **M1 —** Evidencia: corpus Codex por clase, transiciones del manifiesto y reporte de sombra por
  engine.
- **M2 —** Activación: `mode: "active"`, línea `activate`, matriz fail-closed en activo y wiring
  re-renderizado.

### E2 — Config, markers y anti-rollback (bibliotecas)

- **M3 —** Semver, versión de sello, config y contexto explícito.
- **M4 —** Markers y matriz anti-rollback unitaria.

### E3 — `render` Claude con escrituras

- **M5 —** Plan Claude puro, settings y wiring nativo, cadenas `es`/`en`.
- **M6 —** Comando `render` nativo en preview, re-delegación y cobertura del oráculo.
- **M7 —** Capa `Fs`, escritura atómica, backup y poda.
- **M8 —** `render --apply`, `adopt --apply`, `harnessVersion`, registro y matriz anti-rollback en el
  oráculo.
- **M9 —** `sync` no interactivo y `remove --yes`, flags requeridas y fixtures de escritura.

**Por qué este orden.**

- La activación es la puerta pedida y fija el wiring `active` que E3 reproduce.
- Las bibliotecas (E2) no tocan el manifiesto: pueden avanzar mientras corre la ventana de sombra de
  E1 (Q2).
- El preview (M5–M6) prueba todo el plan sin riesgo de escritura antes de que exista `RealFs` (M7).
- Dentro de las escrituras, `sync` y `remove` van al final porque son los únicos con prompts y con cambio de
  esquema.

## NOT in scope

- Codex, agents-md, cursor, copilot y Pi como engines nativos (fase 3, 0059). Una config con esos
  engines re-delega.
- Monorepos con workspaces, `render --all`, `--workspace`, `--prune` y `--verbose` (Q8).
- Prompts interactivos: `sync --interactive`, `sync` a secas y `remove` sin `--yes` (D16 de 0057;
  fase 4).
- `init`, `add`, `configure`, `update`, `refresh`, `backup restore` y el resto de comandos con
  escritura (fase 4).
- Activar otros hooks distintos de `guard-destructive`.
- Mejorar el protocolo de escritura (fsync de directorio, journal). Si se quiere, va a `dev` primero.
- Publicar o distribuir `navori-rust`.

## Observaciones sobre requirements

- **R14** es una reconstrucción: el texto original no está en git. El usuario aceptó la redacción
  (Q9).
- **R33** admite dos implementaciones (paridad de mensajes o re-delegación); el requisito exige el
  mismo resultado observable. Se implementa por re-delegación (Q4).
- **R28** exige ≥ 500 invocaciones por engine. Con 6 casos Codex en el corpus, el volumen real de
  Codex en 14 días es la mayor incertidumbre de calendario de la fase (Q3: se espera).

## Decisiones del usuario (2026-10-23)

El usuario aceptó las recomendaciones de esta spec para Q2–Q12. Para Q12 la spec no traía una
recomendación cerrada; se toma la de D23 (aceptar el tamaño sin recortar). El texto original de
cada pregunta se conserva abajo con su resolución.

| Q | Resolución |
|---|---|
| Q2 | E2 empieza ya y puede mergearse antes de que cierre E1. Ajuste del usuario tras mergear E2 (#1410): E3 M5 (plan Claude puro, sin tocar `ported.json`) empieza antes de E1; E3 M6 (comando nativo y manifiesto) sigue esperando a E1. El wiring `active` de M5 se prueba con un descriptor sintético hasta que E1 active `guard-destructive` |
| Q3 | Se espera a que Codex cumpla 500 invocaciones en 14 días; sin modo por engine ni otro umbral |
| Q4 | Config inválida o ausente: re-delegación antes de cualquier salida |
| Q5 | `requires: string[][]`, `schema: 2`, varias entradas por ruta |
| Q6 | Aviso de actualización omitido en comandos nativos hasta 0060, documentado |
| Q7 | Paridad estricta con `atomic.ts` (`O_TRUNC`, sin `O_EXCL`); D15 de 0057 enmendado |
| Q8 | Subconjunto mínimo de D23 |
| Q9 | R14 reconstruido aceptado; requisitos nuevos en R27+ |
| Q10 | `op: "deactivate"` |
| Q11 | Máscara literal de lado para la línea de procedencia; Rust imprime `core: (embedded)` |
| Q12 | Se acepta el tamaño de E3 sin recortar; M5 en un commit por mecanismo |
| Q13 | (2026-10-27) Mínima cantidad de PRs para lo que falta: la antigua E4 (M7–M9) se funde en E3 y quedan dos PRs, E1 y E3. Los tramos de M5 ya integrados (#1411–#1433) quedan como están |
| Q14 | (2026-10-28) La ventana de sombra no bloquea el cierre de fases: E1 (activación de `guard-destructive`, R27–R31) pasa a 0060 junto con T27 de 0057, en un solo PR con la sombra acumulada; queda un PR, E3, que ya no espera a E1 |

## Preguntas (resueltas)

- **Q2 [human] — Paralelismo con la ventana de sombra.** E1 no puede cerrar antes de 14 días de
  sombra. ¿E2 (bibliotecas, sin tocar `ported.json`) puede empezar y mergearse antes de que E1
  cierre? Recomendación: sí para E2; E3 espera a E1 porque reproduce el wiring activo.
- **Q3 [human] — Criterio de sombra en Codex.** Si Codex no llega a 500 invocaciones en 14 días:
  (a) esperar lo necesario, (b) permitir `mode` por engine en el manifiesto (cambio de esquema) o (c)
  enmendar D9 con otro umbral para Codex. Recomendación: (a); (b) solo si la espera bloquea la fase.
- **Q4 [human] — Config inválida.** Paridad de los mensajes de zod en Rust o re-delegación al TS
  antes de cualquier salida. Recomendación: re-delegar (D22).
- **Q5 [human] — Esquema del manifiesto.** `requires` con `schema: 2` y varias entradas por ruta, o
  re-delegación en código cuando el comando preguntaría (D25). Recomendación: `requires`.
- **Q6 [human] — Aviso de actualización** en comandos nativos: portarlo u omitirlo hasta 0060
  (D27). Recomendación: omitirlo y documentarlo.
- **Q7 [human] — Flag de apertura del temporal.** El TS usa `"w"` (`O_TRUNC`, sin `O_EXCL`,
  `atomic.ts:29`) y D15 de 0057 dice `create_new`. ¿Paridad estricta, o primero un PR a `dev` que
  cambie el TS a `wx` y luego portar? Recomendación: paridad estricta ahora y enmendar el texto de
  D15; la mejora, si se quiere, va a `dev`.
- **Q8 [human] — Subconjunto nativo de `render`.** ¿Basta con solo-Claude sin workspaces y con las
  flags `cwd`, `dry-run`, `json`, `apply` y `force`, o se quiere incluir monorepo o `--prune` en
  esta fase? Recomendación: el subconjunto mínimo de D23.
- **Q9 [human] — Texto de R14 y numeración.** Confirmar la redacción reconstruida de R14 y que los
  requisitos nuevos continúan la numeración del programa (R27+) en lugar de reiniciar por spec.
- **Q10 [human] — Evento de desactivación.** Añadir `op: "deactivate"` al historial (cambio de
  contrato en `manifest.rs` y `rust-manifest-check.mjs`) o expresar la vuelta a `shadow` como
  `unport` + `port`. Recomendación: `deactivate`, más legible y sin el aviso de 14 días de un
  despoteo.
- **Q11 [human] — Línea de procedencia del core.** Máscara literal de lado en el oráculo, o que
  Rust imprima una ruta equivalente (por ejemplo, la de `core-assets` del checkout). Recomendación:
  máscara literal, porque una ruta impresa por Rust que no leyó sería falsa.
- **Q12 [human] — Tamaño de E3.** El motor Claude y sus compartidos suman ~14 000 líneas TS; E3 se
  estima en ~9 000 LOC Rust, más del doble que cualquier entrega de 0057. ¿Se acepta, o se recorta
  el subconjunto (por ejemplo, sin presets locales ni plugins con `hookExtensions`) y lo demás
  re-delega?
- **[repo, E1]** — Confirmar que 0057 E3 entrega el ledger de sombra con conteo de invocaciones y
  `hook-shadow-report.mjs`. Si no, T3 los completa (D18).
- **[repo, E3]** — Comportamiento de `p.select`/`p.confirm` de clack sin TTY en `sync`. Ya no
  aplica: con `requires` (Q5) esas invocaciones nunca son nativas.

## Durable knowledge

- **CONTRIBUTING.md (`migration/rust`):** cómo portar un comando que escribe (plan puro + `Fs`,
  fixtures de escritura obligatorios, la regla de la versión de sello) y cómo activar o desactivar
  un hook (transiciones del manifiesto).
- **Engram:** "Rust sella con la versión del TS durante la convivencia porque `parseSemver` ignora
  la prerelease" y "`removeManagedSectionGuarded` no usa el floor". Son fáciles de re-litigar.
