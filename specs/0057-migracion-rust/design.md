# Migración de navori a Rust — Design

**Estado:** revisado tras el challenge (`.navori/state/handoffs/challenge_0057-migracion-rust.md`,
aceptado completo por el orquestador) y las decisiones del usuario · **Fecha:** 2026-10-23 ·
**Base verificada:** `git fetch origin dev` → `FETCH_HEAD` = `origin/dev` = `1478d954`, que es el
`HEAD` con que nació `migration/rust`. Toda afirmación "ya existe" se leyó en ese commit. Las
entregas abren PR contra `migration/rust`. Solo el corte (R24) llega a `dev`, salvo E-Pi, que es TS
puro y va a `dev` (ver Plan de entregas).

**Alcance del documento:** diseño del programa completo. La spec 0057 ejecuta la fase 1 (E1–E3);
E4 en adelante y E-Pi se ejecutan en las specs de fase 0058–0060 (`requirements.md` § "Fases del
programa"), que reutilizan estas decisiones. Los `R<n>` que aquí se citan y ya no están en
`requirements.md` (R14, R18–R22, R24) son requisitos del programa que esas specs redeclaran.

**Señal arquitectónica:** migración del plano de control completo; áreas críticas (escrituras,
backups y borrados en el repo del usuario, hooks y reglas deny/ask, markers gestionados y guard
anti-rollback); contratos compartidos (el comando registrado de cada hook, el hash de trust de
Codex, la salida byte a byte del CLI); rama de larga vida con sincronización periódica.

**Decisiones del usuario incorporadas:** (1) el corte distribuye macOS y Linux (arm64/x64); las
demás plataformas reciben el último build TS previo al corte, congelado, y la suite TS sale del
gate tras el corte (R21, R22, R18). (2) Los prompts interactivos exigen paridad de comportamiento
(mismas preguntas, opciones y efectos), no paridad visual. (3) El scope npm de los paquetes de
plataforma sigue abierto y lo resuelve la entrega de corte. (4) No se agrega ningún aviso de
convivencia en los docs de `dev` antes del corte.

## Decision drivers

Salen de `docs/DIRECTION.md` (§ Design principles and invariants, § Non-goals: calidad > tokens >
velocidad), de `CLAUDE.md` (áreas críticas; simple > clever) y de `requirements.md`.

1. **El TS es el oráculo hasta el corte.** Ningún comportamiento nace en Rust. Si Rust difiere del
   TS, el que está mal es Rust (R9–R11).
2. **Fallar hacia lo seguro, nunca hacia el silencio.** Ante cualquier duda (binario ausente o
   roto, versión distinta, archivo editado, bloque desconocido) corre la implementación vigente o
   el veredicto seguro. Nunca se adivina (R5, R12, R13).
3. **Velocidad sin bajar calidad.** La velocidad es la prioridad más baja de DIRECTION. Solo vale
   si cada paso queda probado: corpus, diferencial vivo y sombra antes de que un hook Rust decida.
4. **`dev` libre de Rust.** Ni código, ni wiring, ni avisos, ni artefactos Rust en `dev`, en npm o
   en el release antes del corte (R4; decisión 4 del usuario).
5. **Mínima superficie de conflicto con `dev`.** Lo exclusivo de `migration/rust` vive en archivos
   nuevos y en el menor número posible de puntos de llamada TS (R23).
6. **Los invariantes 1–10 siguen valiendo en Rust:** capas, multi-engine, config como fuente,
   markers con hash/version, preview + backup + escritura atómica con fsync, plugins como bundles,
   un solo pipeline, cero huella, generar sin ejecutar y auto-hospedaje.

## Approach

Patrón **strangler** sobre un binario multi-llamada, `navori-rust`. Lo que el manifiesto
`crates/ported.json` declara portado (por comando **y conjunto de flags**) corre nativo; el resto
se delega con `exec` al CLI TS. Un oráculo diferencial compara byte a byte el TS y `navori-rust`
sobre repos fixture. Un hook Rust solo decide después de tres pruebas: el corpus de veredictos, un
diferencial vivo shell-vs-Rust con entradas generadas y un periodo en **sombra**, donde corren los
dos y decide el shell. El orden de porteo lo fijan el costo real por proceso (0055) y las
dependencias entre primitivas, no la estructura interna del TS.

### Qué ya existe (evidencia en `1478d954`)

- **Oráculo de hooks.** `scripts/js/hook-verdict-replay.mjs` (`replayCorpus`, `generateCorpus`,
  `ENGINE_DIRS`, `hasPlaceholderCommand`) y el corpus
  `packages/cli/src/__tests__/fixtures/hook-verdict-corpus/` (21 hooks, `coverage.json`).
  - Es una lista cerrada con cobertura desigual: `guard-destructive` tiene 770 casos Claude, 110 Pi
    y 6 Codex; `plan-gate` solo tiene casos Codex; `model-advisor` no tiene ninguno.
  - De 2 996 casos, 163 terminan en 126/127 y son **artefactos del runtime shell**, no veredictos:
    `parse error near` bajo zsh en `engram-write-guard`/`role-guard`, `{{rolePolicy}}: command not
    found` de un asset sin renderizar, y `cat: command not found` con PATH recortado.
- **Oráculo de superficie.** `packages/cli/src/__tests__/cli-surface.test.ts`,
  `packages/cli/scripts/capture-cli-surface.mjs` (`runSurface`, `parseSubcommands`) y
  `fixtures/cli-surface.golden.json` (formato citty).
- **Golden de render.** `packages/cli/src/engines/__tests__/golden-render-tree.test.ts` tiene snaps
  de `agents-md`, `claude`, `codex`, `copilot` y `cursor`, pero **ninguno de Pi**.
- **Comando de cada hook.**
  - `claudeHookCommand` (`engines/claude/build-settings.ts`) ejecuta `bash -n` → `exec bash` y, si
    el parse falla, devuelve `ask`.
  - `codexHookCommand` (`engines/codex/hook-registrations.ts`) ejecuta
    `bash "$(git rev-parse --show-toplevel)/…"`. Codex firma ese string exacto para el trust
    (`codexHookHash`, `lib/codex/trust.ts`, sha256 de un `canonicalJson` propio).
  - En Pi, `runBridgeScript` y `bridgeVerdict` (`.pi/extensions/navori.ts`) bloquean un hook
    `enforced` ante cualquier código que no sea 0 ni 2.
- **Detección de engine por ruta.** Se decide por la ruta del script (`_partials/hook-input.sh`,
  `case "$0"`), no por el payload.
- **Los hooks traen código ajeno.** `guard-destructive.sh` cierra con la sección de usuario
  (`# user: add extra guards here`). En este repo además carga el bloque `tgrep-search-lane` de
  `@navori/plugin-tgrep`, que hace `source` de `scripts/guard-search-routing.sh`, un archivo
  hermano.
- **Hash de marker.** `hashContent` (`lib/render/marker.ts`) es **sha1 truncado a 8 hex** sobre
  `normalize`, que convierte `\r\n?` en `\n` y recorta `\s+$` con la semántica `\s` de JS.
- **Escritura atómica.** `writeFileAtomic` (`lib/primitives/atomic.ts`):
  - abre `.<base>.navori.tmp.<12 hex>` con modo `0o644` (sujeto a umask), escribe, hace `fsync`,
    `close` y `rename`;
  - no hace fsync del directorio;
  - si falla, borra el temporal.
- **Backups.** `lib/render/backup.ts`:
  - nombre `<basename(repo)>-<fecha local con guiones>-<ms>-p<PID>-<seq>`;
  - retención de 30 días y 2 GiB.
- **Markers y anti-rollback.** `injectManagedSection` (`isDowngrade`, `maxSemver`, la variable de
  módulo `ambientFloorVersion`, `meta.floorVersion`) y `removeManagedSectionGuarded` (rama
  `newer`) en `marker.ts`; `harnessVersion` en `lib/diagnose/distribution.ts`.
- **Auditoría.** `lib/audit/cli-event.ts` usa `randomUUID`, `Date.now()` y `toISOString()`, y
  deriva ids como `sha256(repo + NUL + feature)` desde la ruta absoluta del repo. Los hooks
  escriben eventos con `_partials/audit-log.sh`, y el replay los compara en el modo `active`.
- **Pi no es una dependencia de runtime del CLI.**
  - `@earendil-works/pi-ai` y `pi-coding-agent` son `devDependencies`. Solo los importan el
    **texto** de la extensión generada (`renderPiExtensionSource`, `engines/pi/extension-source.ts`)
    y los tests.
  - Ese texto incrusta funciones del build minificado (`serializeAnonymousFunction`).
  - El CLI solo ejecuta `pi --version` (`lib/diagnose/pi-health.ts`).
- **Hooks que llaman al CLI en caliente.** `plan-gate.sh` (`plan gate`), `quality-gate-pre-commit.sh`
  (`gate probe`, `gate foreign`), `session-start-context.sh` (`tools session-context`,
  `tools notice`, `audit --arm`, `plan resume`, `dominio inject`) y `subagent-stop-handoff.sh`
  (`audit --capture-child`).
- **Tamaño.** ~102 k LOC TS de producción y ~154 k de tests; 9 226 líneas de shell en hooks y
  parciales; 29 subcomandos raíz (`cli.ts`, `subCommands`). `dist/` es autocontenido
  (`scripts/copy-assets.mjs` copia los assets).
- **CI.** En `.github/workflows/ci.yml`, `plan`/`affected` solo corren con base `dev`, y `test`
  solo en push o con base `main`.

Mediciones locales (mediana/p95 de 40 corridas):

| Comando | Mediana | p95 |
|---|---|---|
| `bash -c :` | 2.2 ms | 2.4 ms |
| `bash -n` sobre `guard-destructive.sh` (2 987 líneas) | 6.0 ms | 8.6 ms |
| `bash` + `command -v` + `exec` | 3.6 ms | 4.1 ms |

### Escalera de opciones para la decisión de mayor riesgo: la convivencia

- **Patrón existente: seguir en TS y optimizar (0055).** Descartado: el usuario decidió migrar, y
  0055 dejó el arranque de Node como piso.
- **Extensión: binario con delegación por comando+flags y manifiesto (strangler). Elegida.** Cada
  paso es reversible: quitar una entrada del manifiesto devuelve el comportamiento al TS o al shell.
- **Nueva arquitectura: reescritura total con corte único.** Descartada: la paridad de ~100 k LOC
  se probaría de una sola vez al final.
- **Rust como addon napi cargado por Node.** Descartado: conserva el arranque de Node y mete un
  ABI nativo en npm antes del corte, lo que viola R4.

## Components

### Workspace `crates/` (R2, R15, R16)

- **Raíz del workspace.**
  - `Cargo.toml` del workspace (`resolver = "3"`) y `Cargo.lock` versionado.
  - `rust-toolchain.toml` con `channel = "1.99.1"` (último stable: 2026-10-13 según
    `channel-rust-stable.toml`), `components = ["rustfmt", "clippy"]` y los targets
    `aarch64-apple-darwin`, `x86_64-apple-darwin`, `aarch64-unknown-linux-musl` y
    `x86_64-unknown-linux-musl`. — R2, R21
- **`crates/navori-core` (lib).**
  - config;
  - modelo JSON con semántica JS (D14);
  - assets embebidos;
  - markers: hash sha1/8 con `normalize` de JS e inject/remove guardados;
  - anti-rollback;
  - capa `Fs` (escritura atómica, backup, poda; D15);
  - metadata de auditoría y bridge al escritor CLI (D12);
  - salida de UI no-TTY y prompts (D16);
  - tablas de engine y pipeline de render.

  — R14, R19
- **`crates/navori-hooks` (lib).** Runner de hooks (D6), integridad (D8), modo sombra (D9) y una
  implementación por hook con `HookSpec { id, gating }`. — R11–R13
- **`crates/navori-cli` (bin `navori-rust`).** Parser compatible con citty (D2), despacho por
  manifiesto, delegación (D3) y subcomando interno `hook`. — R3, R5–R7, R17
- **`crates/navori-oracle-tests` (solo tests).** Tests con pseudo-TTY para prompts (D16) y tests
  de propiedad JS-vs-Rust (D14). No se instala.
- **`crates/ported.json`** (D4) y **`crates/ported-history.jsonl`** (D1, registro de portes y
  despoteos). — R7, R9, R10

`navori-hooks` no inicializa nada del render: el binario es uno solo, pero la ruta caliente del hook
solo toca payload, auditoría e integridad.

### Assets embebidos (siguen siendo datos)

`crates/navori-core/build.rs` recorre `packages/core/core-assets/` y `packages/plugins/*/` (las
mismas raíces que `bundled-assets.ts`):

- genera una tabla `include_bytes!`;
- emite `cargo:rerun-if-changed` por directorio;
- lee la versión de `packages/cli/package.json`;
- calcula el `implHash` de cada hook (D8): sha256 de los fuentes de `navori-hooks/src/hooks/<id>/`
  más el runner común.

No hace falta ninguna dependencia nueva para esto (`include_dir` 0.7.4 no recibe cambios desde
2024-06).

### Wiring de convivencia en TS (solo en `migration/rust`)

- **`packages/cli/src/lib/render/native-hook.ts` (nuevo).**
  - Lee `crates/ported.json`.
  - Decide la **conformidad** de cada hook en el render (D8).
  - Genera **un solo** fragmento shell, `nativeRunnerShell({ entry, safeVerdict })`, que se inserta
    en dos lugares: como prólogo del script y como brazo del comando Claude (D7).
  - Si el manifiesto no lista hooks, la salida es idéntica a la de `dev`. — R13
- **Dos puntos de llamada:** `claudeHookCommand` y la expansión del script de hook
  (`expandHookIncludes`, `lib/render/hook-includes.ts`).
- **Sin cambios en Codex ni en Pi:** el comando de Codex queda igual (se conserva el hash de trust)
  y el puente de Pi no se toca.

### Oráculo, fuzz, sombra y bench

- `scripts/js/rust-oracle.mjs` + `bun run oracle:rust` (D5). — R8–R10, R14
- `scripts/js/rust-oracle/fixtures/<nombre>/` y `cases.json`.
- `scripts/js/hook-verdict-replay.mjs --impl rust` (R11) y `scripts/js/hook-fuzz.mjs`
  (`bun run fuzz:hooks`, D9).
- `scripts/js/bench-hooks.mjs --impl rust` (R17).
- `scripts/js/rust-sync-age.mjs` (D10, R23).
- `scripts/js/cutover-check.mjs` + `bun run cutover:check` (D17).

### CI (solo en `migration/rust`)

- **`.github/workflows/rust.yml` (nuevo).** Se dispara con `pull_request` a `migration/rust` y con
  `push` a `migration/rust`. **No tiene `schedule`:** GitHub solo ejecuta cron desde la rama por
  defecto, y ahí no puede haber Rust (D10). Jobs:
  - `quality`: fmt, clippy y test (R15);
  - `oracle` (R8–R10);
  - `hooks`: replay + fuzz con semilla fija (R11);
  - `freshness` (R23);
  - `manifest`: recalcula hashes y revisa el historial;
  - `tarball` (R4);
  - `install` (R3).
- **`ci.yml`, un único cambio.** Las condiciones `github.base_ref == 'dev'` de `plan` y `affected`
  aceptan también `migration/rust`.

## Decisions

### D1 — Rama de larga vida, sincronización y registro de portes (R1, R4, R23, R24)

- `migration/rust` nace de `dev`. Su primer commit (E1) edita `docs/DIRECTION.md` (R1). `dev` no
  recibe ningún aviso hasta el corte (decisión 4 del usuario).
- **Sentido único hasta el corte.** `dev` → `migration/rust` siempre por merge, nunca por rebase.
  Ningún cambio viaja de `migration/rust` a `dev` antes del corte, ni siquiera como cherry-pick.
- **TS de `migration/rust` = TS de `dev` + wiring de convivencia.** Todo cambio de comportamiento TS
  nace en `dev`. Los refactors que preparan el porteo (E-Pi, D11) son PRs TS normales contra `dev`.
- **Conflictos al sincronizar:**
  1. **Espejo renderizado:** se toma el lado de `dev` y se regenera con `bun run render:apply`.
     Nunca se edita a mano.
  2. **Wiring TS:** se conserva `dev` y se vuelve a aplicar el punto de llamada (una línea por
     sitio).
  3. **Assets que Rust reproduce:** gana `dev`. El desajuste de hashes (D4) y el oráculo indican qué
     reportar a Rust en el mismo PR.
  4. **Docs y `package.json` raíz:** se conservan ambos lados.
- **Válvula "despotear" con contabilidad.** Si un PR de sincronización no logra la paridad, quita
  la entrada del manifiesto y añade una línea a `crates/ported-history.jsonl`:
  `{"date":"2026-11-02","op":"unport","id":"…","reason":"…","pr":123}`. Volver a portar añade `op:
  "port"`.
  - El job `manifest` **falla** si una entrada desaparece de `ported.json` (frente a la merge-base)
    sin su línea `unport`.
  - El mismo job emite un *warning* por cada despoteo sin re-porte con más de 14 días.
  - `cutover:check` falla mientras quede un despoteo abierto.

### D2 — Parser de argumentos propio, sin clap (R5, R9)

El oráculo exige que `--help`, `<sub> --help` y los errores de uso salgan byte a byte en el
formato de citty (ver `cli-surface.golden.json`). clap 4.6.7 tiene su propio formato de ayuda, sus
propios errores y sus propios códigos de salida.

Se usa `lexopt` 0.3.2 para tokenizar, más un parser con la semántica de citty (`--k=v`, `--no-k`,
booleanos, posicionales, aliases) y un renderizador de ayuda, ambos sobre la misma tabla
declarativa. Cada comando portado trae su fila en esa tabla y la valida su caso `<sub> --help`.

### D3 — Contrato de delegación (R5, R6, R7)

- **Selección (D4):** argv se compara con las entradas del manifiesto por ruta de comando **y**
  conjunto de flags. Si ninguna coincide, se delega.
- **Re-delegación interna:** un comando nativo que descubre que está fuera de su subconjunto
  portado (por ejemplo, `render` con un engine sin portar en la config) llama a `delegate()`
  **antes de cualquier salida o efecto**. Lo verifica el oráculo con un fixture por cada condición
  declarada.
- **Mecanismo:** `std::os::unix::process::CommandExt::exec`. El proceso se reemplaza, así que
  argumentos, stdio, entorno, cwd, señales y código de salida pasan tal cual (R5). No usa `unsafe`.
- **Resolución del TS, en orden:**
  1. `NAVORI_TS_CLI`;
  2. `<checkout>/packages/cli/dist/index.js`, con `<checkout>` = `CARGO_MANIFEST_DIR/../..` fijado
     en compilación;
  3. `navori` en `PATH`, excluyendo los candidatos cuyo `canonicalize` es el propio binario.

  Un archivo `.js` se ejecuta con `node` resuelto desde `PATH`.
- **Versión:** antes de `exec` se lee la versión del TS elegido (`package.json` junto a `dist/`, o
  `navori --version` en el caso 3). Si difiere de la de `navori-rust`, sale **una** línea de aviso en
  stderr que nombra ambas versiones y la ruta. Durante la convivencia el oráculo enmascara solo
  esta línea literal (D5), porque las versiones Rust y TS del mismo checkout difieren.
- **Anti-bucle acotado:** al delegar se fija `NAVORI_DELEGATED=<pid propio>`. `exec` conserva el
  pid, así que solo hay bucle si al arrancar `NAVORI_DELEGATED == getpid()`; en ese caso sale con 70.
  Si el valor es otro pid (un descendiente legítimo), la variable se ignora y se borra antes de
  seguir.
- **Sin TS o sin `node` (R6):** sale con 69 y un mensaje que nombra el subcomando, las tres rutas
  probadas y, si el candidato era un `.js`, que falta `node` en `PATH`.
- **R7 por construcción:** el despacho nativo consulta el manifiesto. Un test recorre la tabla y
  comprueba que toda implementación sin entrada en el manifiesto se delega.

### D4 — Manifiesto `crates/ported.json` (R7, R9, R10, R11, R12, R13)

```json
{
  "schema": 1,
  "commands": [
    { "path": ["--version"] },
    { "path": ["spec", "check"], "flags": ["json"] },
    { "path": ["render"], "flags": [], "when": { "engines": ["claude"] } }
  ],
  "hooks": {
    "guard-destructive": {
      "mode": "shadow",
      "gating": true,
      "blocks": {
        "guard-destructive-base": "sha256:9f2c4e…(64 hex)",
        "tgrep-search-lane": "sha256:41ab07…(64 hex)"
      },
      "deps": { "scripts/guard-search-routing.sh": "sha256:c3d518…(64 hex)" },
      "impl": "sha256:7e90aa…(64 hex)",
      "divergences": [
        {
          "case": "role-guard.sh#codex#zsh#17",
          "category": "shell-runtime",
          "reason": "zsh parse error of the raw asset; not a verdict",
          "requirement": "R11"
        }
      ]
    }
  }
}
```

Los valores `sha256:` del ejemplo están abreviados. En el archivo real son los 64 hex completos que
calcula el test del job `manifest`.

- **`commands`:**
  - `path`: tokens del comando;
  - `flags`: nombres citty normalizados (`--no-x` se cuenta como `x`). La invocación es nativa solo
    si **sus** flags están contenidos en la lista, y una lista vacía solo admite la invocación sin
    flags;
  - `when` (opcional): condiciones que se leen de la config (hoy solo `engines`); si no se cumplen,
    hay re-delegación (D3).
- **`hooks.<id>`:**
  - `mode`: `shadow` (decide el shell, D9) o `active` (decide Rust);
  - `gating`: si el hook decide que una acción proceda (alimenta la tabla de D6);
  - `blocks`: sha256 del asset fuente con includes expandidos para cada bloque gestionado que Rust
    reproduce; un bloque de plugin es una unidad aparte;
  - `deps`: sha256 de cada script hermano que se ejecuta con `source` (por ejemplo, el de
    `tgrep-search-lane`);
  - `impl`: el `implHash` del build;
  - `divergences`: cada caso del corpus que Rust no reproduce, con `category` (`shell-runtime` para
    los 126/127 de arriba, `fail-closed` para R12) y el requirement que lo justifica.

  Que un caso esté en `divergences` no lo excluye de la verificación: el replay comprueba que Rust
  produce el veredicto de su categoría.
- **El job `manifest` recalcula** `blocks`, `deps` e `impl`. Cualquier desajuste, típico después de
  sincronizar `dev`, falla CI hasta que se reporte el cambio a Rust o se despotee el hook (R10).
  `scripts/js/rust-manifest-check.mjs` resuelve bloques del core y `hookExtensions` de plugins,
  expande includes con el expansor TS y lee las dependencias desde los assets fuente.
  `impl` recorre `navori-hooks/src/hooks/<id_con_guiones_bajos>/` y los fuentes comunes de `src/`
  fuera de `hooks/`: orden lexicográfico por ruta relativa, ruta + NUL + bytes exactos + NUL.
  E2 debe usar esta misma receta en el build antes de agregar el primer hook al manifiesto.
- **Formato JSON:** lo leen Node y Rust sin un parser nuevo.

### D5 — Oráculo diferencial `bun run oracle:rust` (R8, R9, R10, R14)

- **Misma ruta, en secuencia.** Cada caso copia el fixture a **una misma ruta** (`<tmp>/w/repo`), lo
  ejecuta con TS, guarda el resultado y borra el árbol. Luego copia de nuevo a la misma ruta y lo
  ejecuta con `navori-rust`. Así desaparecen las diferencias que vienen de la ruta (como
  `sha256(repo + NUL + feature)`) sin normalizar nada.
- **Entorno hermético:** el de `createTempFile` (`vitest.tempLifecycle.ts`) con `HOME`, `TMPDIR`,
  `NAVORI_BACKUP_ROOT` y `NAVORI_AUDITS_ROOT` en rutas fijas por caso, y además:
  - las variables `GIT_CONFIG_*`/`GIT_TEMPLATE_DIR`/`XDG_CONFIG_HOME` aisladas y ningún `GIT_*`
    heredado;
  - `NAVORI_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1` y `NODE_NO_WARNINGS=1`;
  - sin TTY;
  - `NAVORI_TS_CLI` apuntando al `dist/` del checkout;
  - `TZ=UTC` y `LC_ALL=C`.
- **Qué compara:**
  - código de salida;
  - stdout y stderr byte a byte;
  - árbol final del repo: ruta, tipo, modo y bytes, incluido `.git/` salvo `index`, `logs/` y
    `objects/`;
  - árbol de `NAVORI_BACKUP_ROOT`;
  - árbol de `NAVORI_AUDITS_ROOT`.
- **Normalización: lista cerrada, con formato estricto.** Cada regla reconoce **solo** el formato
  exacto que emite el TS. Si cambia el formato (`+00:00` en lugar de `Z`, otra precisión,
  otra longitud de hash), la regla deja de coincidir y la diferencia queda a la vista.

  | Token | Patrón exacto | Fuente |
  |---|---|---|
  | `@ISO@` | `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z` | `toISOString()` |
  | `@EPOCHMS@` | 13 dígitos, solo como valor de las claves `tsMs` y `observedAt` | `Date.now()` |
  | `@UUID@` | UUID v4 en minúsculas, 8-4-4-4-12 | `randomUUID` |
  | `@BACKUP@` | `<basename>-YYYY-MM-DDTHH-mm-ss-SSS-p<pid>-<seq>` con la gramática de `backup.ts` | nombre de backup |
  | `@PID@` | `p\d+` solo dentro de `@BACKUP@` y en las claves JSON `pid` | `process.pid` |
  | `@MS@` | `\d+(\.\d+)?ms` solo en líneas de resumen de duración | duraciones |

  Cada regla tiene dos tests de mutación: uno donde una diferencia **fuera** de su patrón sigue
  fallando (por ejemplo, un byte cambiado dentro de un marker) y otro donde una variante de formato
  (por ejemplo, `+00:00`) también falla.
- **Fixtures:**
  - `empty`;
  - `fresh-init`;
  - `self-hosted` (la config de este repo, todos los engines y plugins);
  - `user-content` (prosa y bloques del usuario fuera de los markers en `CLAUDE.md`, `AGENTS.md`,
    `settings.json` y en las secciones de usuario de los hooks; R9);
  - `drifted-block`;
  - `monorepo`;
  - `codex-trusted`;
  - `pi`;
  - los de escritura de D15 (`aged-backups`, `foreign-blocks`, `sync-conflicts`);
  - la matriz anti-rollback de D15.

  Cada fixture es un árbol declarativo más un `git init` determinista.
  En E1 los fixtures Markdown se guardan con sufijo `.md.fixture`, que se quita al copiar.
  Los fixtures de escritura D15, `codex-trusted` y la matriz anti-rollback se incorporan cuando
  se porte un comando que escriba; no se consideran cubiertos por el humo delegado de E1.

  Durante la convivencia, Rust y TS tienen versiones diferentes: el oráculo quita de stderr
  de Rust solo la línea literal de aviso de delegación D3 (incluye ambas versiones y la ruta).
  Para `--version` y `--help` nativos sustituye el literal de versión de cada lado solo en stdout.
  Estas excepciones no normalizan los archivos ni el resto de stderr. La paridad de `--help`
  incluye el relleno exacto de columnas, que el golden de superficie normaliza.
- **Golden independiente (circularidad):** el prólogo, el brazo de Claude y los comandos
  registrados de los tres engines se comparan además con
  `crates/navori-hooks/tests/golden/wiring.snap`. Ese snapshot se revisa a mano y **no** se deriva
  del TS, porque el TS de esta rama genera ese mismo wiring.
- **Qué corre en CI:**
  - los casos de los `commands` del manifiesto (respetando `flags` y `when`);
  - un humo de delegación (5 comandos no portados más uno que llama a un comando portado con una
    flag no portada);
  - el replay y el fuzz de los hooks del manifiesto.
- **TS vigente:** el `dist/` del mismo checkout (`bun run ensure-dist`). El TS de la rama solo
  cambia por merge de `dev`, y D10 limita su antigüedad.
- **R9:** el PR que agrega un comando al manifiesto debe traer casos en cada fixture aplicable,
  incluido `user-content`. Un test falla si alguno falta.

### D6 — Runner de hooks: contrato de salida y fail-closed (R11, R12)

- **Entradas:** `navori-rust hook --via-script <ruta> [args]` (desde el prólogo) o `navori-rust hook
  --via-command <evento> <ruta> [args]` (desde el brazo de Claude). El engine se deduce de la ruta,
  igual que en `hook-input.sh`.
- **Contrato de códigos del binario: solo 0, 1, 2 y 3.**
  - 0, 1 y 2 son veredictos.
  - 3 significa "difiero", y solo se emite **antes de leer stdin** (fallo de integridad, D8).
  - El binario **nunca** sale con 126 ni 127: el prólogo los reserva para "no arrancó".
  - Cuando el shell produciría otro código, Rust emite 1. Los tres hosts tratan igual cualquier
    código distinto de 0 y 2: Claude como error no bloqueante, Codex como fallo de ejecución y Pi
    como bloqueo si el hook es `enforced` o como permitir si es advisory.
- **Salida en búfer:** stdout se acumula en memoria y se escribe en una sola llamada al final.
  Además, el prólogo captura stdout (D7), así que el host nunca ve JSON a medias.
- **Panic y E/S.** El perfil release usa `panic = "unwind"`, `catch_unwind` en `main` y un
  `set_hook` que guarda el mensaje. En un hook `gating`, un panic o un error de E/S producen el
  veredicto seguro de la tabla. En un hook sin compuerta producen exit 1 más la causa (R12).
  Si falla o entra en panic la escritura/flush final de stdout, un hook con compuerta sale con 2
  incluso en Claude: por un canal roto ya no se puede entregar el JSON `ask`. Un advisory sale
  con 1. El wrapper valida también su propia escritura con redirección explícita `>&1`.
- **Payload ilegible:** Rust reproduce el veredicto del shell para ese payload (R12, segunda frase).
  El corpus y el fuzz lo prueban con payloads truncados, no-UTF-8 y vacíos.

**Veredicto seguro por engine** (lo emite el binario cuando falla de forma controlada, y el prólogo
cuando el binario muere; D7):

| Engine | Hook `gating` | Veredicto seguro | Por qué |
|---|---|---|---|
| Claude | PreToolUse | stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"navori: <hook> could not evaluate this call (<causa>); confirm it manually"}}`, exit 0 | Es el mismo brazo `ask` que `claudeHookCommand` usa si el script no parsea. Cualquier código ≠ 0/2 deja pasar la acción (doc de hooks de Claude Code) |
| Codex | PreToolUse | exit 2 y la causa en stderr | Codex dice que `ask` está "parsed but not supported yet" y continúa la tool call |
| Pi | `tool_call` `enforced` | exit 2 y la causa en stderr | `bridgeVerdict` bloquea |
| Cualquiera | sin compuerta | exit 1 y la causa en stderr | No hay acción que permitir. Es el brazo actual fuera de PreToolUse |

En la tabla, `<hook>` y `<causa>` son variables del mensaje, no huecos sin resolver.

- **Fuera de alcance:** timeout o SIGKILL del host. Rige la semántica del host, igual que con el
  shell.

### D7 — Llegada al binario, mapeo de salidas y fallback (R12, R13, R17)

Un binario multi-llamada en lugar de uno por hook: un solo artefacto, y el payload, la auditoría, la
integridad y el veredicto seguro se implementan una sola vez.

**Fragmento único** (`nativeRunnerShell`), insertado en dos sitios:

```sh
if [ "${NAVORI_HOOK_IMPL:-}" != shell ] && nv_native=$(command -v navori-rust 2>/dev/null); then
  nv_out=$(if "$nv_native" hook --via-script "$0" "$@"; then nv_status=0; else nv_status=$?; fi; printf '.%s' "$nv_status")
  nv_rc=${nv_out##*.}; nv_out=${nv_out%.*}
  case "$nv_rc" in
    0|1|2) printf '%s' "$nv_out" >&1 || exit 2; exit "$nv_rc" ;;
    3|126|127) : ;;
    *) <veredicto seguro de este hook y engine, renderizado como texto fijo> ;;
  esac
fi
```

- **Sin `exec`.** El binario corre como hijo y su stdout queda capturado. El `printf '.%s'` final
  conserva los saltos de línea finales y el código de salida.
  - Con **3** (difiere) y **126/127** (el binario no arrancó: no es ejecutable, es de otra
    arquitectura o no está), stdin sigue intacto y **el cuerpo shell que viene después decide**
    (R13, también con el binario presente pero roto).
  - **Cualquier otro código** (señal 128+n, abort, 101) produce el veredicto seguro de D6, escrito
    como texto fijo por el render. No depende del binario.
- **Prólogo (Codex, Pi y cualquier `bash script`).** Va después del shebang y dentro de
  `<hook>-base`. La línea de integridad D8 queda fuera del marker, inmediatamente antes del bloque
  base: si `file=` participara en su SHA-1, habría un ciclo entre el hash del marker y el del archivo.
  El comando registrado de Codex no cambia,
  así que se conserva el trust, y el puente de Pi no se toca.
- **Brazo de Claude.** El mismo fragmento con `--via-command PreToolUse "$f"` se antepone al comando
  actual de `claudeHookCommand`. Con 3/126/127 la ejecución sigue al `bash -n` y al `exec bash` de
  siempre, y se conserva el `ask` de "cannot be parsed". Esto ahorra los 6–9 ms del `bash -n`
  cuando responde Rust.
- **Modo sombra:** el fragmento pasa `--shadow` (D9).
- **`NAVORI_HOOK_IMPL`:**
  - `shell` fuerza el shell (salida de emergencia);
  - `rust` convierte el diferimiento en un error (exit 1 con la causa) y lo usan el replay y el
    fuzz;
  - sin valor, modo automático.
- **Nombre del binario:** `NATIVE_HOOK_BIN` vale `navori-rust` durante la convivencia y cambia en el
  corte (D17).
- **Finalización tras los plugins.** `native-hook-render.ts` compara el script completo contra su
  referencia fresca antes de firmar, y solo procesa destinos seleccionados por el inventario.
  Los scripts hermanos de extensiones alojadas deben figurar en `deps`. La selección de settings
  (`skip` y scope minimal incluidos), su tracking coexist y el anti-rollback se conservan al
  introducir el brazo nativo; un `noop` anterior no autoriza un cambio posterior.
- **Diferimientos conservadores de M6.** Hooks que necesitan `transform`/`extraVars` compiladas
  distintas de la referencia fresca siguen en shell hasta portar su constructor específico.
  Los argumentos Claude con expansiones shell conservan el comando legacy para no evaluarlos
  dos veces al diferir. El manifiesto y el registro Rust de producción siguen sin hooks hasta T26.
- **Descartado:**
  - la forma exec de Claude (`args`): no admite fallback;
  - cambiar el comando de Codex: desaprueba todos los hooks;
  - `exec` en el prólogo: un `exec` fallido nunca llega al cuerpo shell, y un binario que muere deja
    al host un código que significa "permitir" (challenge 1.1).

### D8 — Integridad y conformidad: cuándo Rust responde por un script (R11, R13)

Hay dos niveles: el render decide la **conformidad** y el binario verifica la **integridad** en
cada llamada.

- **Conformidad (en el render).** El render emite el prólogo y el brazo de Claude **solo** si se
  cumple todo esto:
  - el cuerpo de `<hook>-base` corresponde al asset cuyo sha256 está en `blocks`;
  - todo otro bloque gestionado del archivo está en `blocks`;
  - cada script `source`ado está en `deps` y su hash coincide;
  - la región de usuario (desde el cierre del último bloque gestionado hasta el final del archivo)
    es **byte a byte** la plantilla por defecto del asset, sin normalizar.

  Si el usuario editó aunque sea el comentario de ejemplo, ese hook queda en shell. Es
  conservador, está documentado, y `NAVORI_RUST_TRACE=1` dice el motivo.
- **Línea de integridad**, escrita por el render en el prólogo:
  Se almacena como comentario externo antes del marker base, sin alterar el hash normal de markers.

  ```sh
  # navori:native-hook v=1 file=sha256:<64 hex> impl=sha256:<64 hex>
  ```

  `file` es el sha256 de los **bytes exactos** del archivo con su propio valor `file=` puesto en
  64 ceros, junto con los bytes de cada `deps` en orden. `impl` es el `implHash` del manifiesto.
  Igual que en D6, `<64 hex>` es la notación de la gramática.
- **Integridad (en cada llamada, antes de leer stdin).** El binario re-hashea el archivo y los
  `deps` y exige:
  1. `file` coincide con lo que calcula. Así detecta cualquier edición posterior al render,
     incluidos CRLF, espacios finales o marcadores de conflicto, sin normalizar nada.
  2. `impl` es igual al `implHash` compilado en el binario. Un binario viejo con el mismo asset, o
     cualquier `navori-rust` ajeno en `PATH`, difiere (challenge 1.3 y 2.4).

  Si falla cualquiera de las dos, sale con 3 y responde el shell.
- **El hash de los markers** sigue siendo el de `marker.ts`: sha1, 8 hex, sobre `normalize`.
  `navori-core` lo reproduce con una función `js_trim_end` que aplica el conjunto `\s` de JS
  (incluye U+FEFF y los espacios Unicode de la categoría Zs). Un test de propiedad lo compara con
  Node. Es independiente de la integridad: el binario no se fía del `hash=` del marker para decidir
  si responde.
- **Modelo de amenaza:** es un cinturón de seguridad, no una caja fuerte. Un binario malicioso en
  `PATH` que imprima la línea correcta queda fuera de alcance, igual que con los hooks shell de hoy.

### D9 — Diferencial vivo y sombra antes de activar un hook (R11, R12, R19)

- **Fuzz diferencial (`bun run fuzz:hooks`).** Para cada hook portado, ejecuta shell y Rust
  (`NAVORI_HOOK_IMPL=shell`/`rust`) sobre las mismas entradas y compara exit, stdout, stderr y los
  eventos de auditoría.
  - **Entradas:** mutaciones del corpus y comandos generados desde una gramática con el
    vocabulario de las reglas del hook. La gramática incluye comillas simples, dobles y
    `$'…'`, here-docs y here-strings, globs y `case`, clases POSIX, continuaciones, `;`/`&&`/`|`,
    Unicode y CRLF, y payloads truncados o no-UTF-8.
  - **En CI:** semilla fija y N = 2 000 por hook con compuerta (500 por hook sin compuerta).
  - **Antes de activar:** N = 100 000 en local, con el reporte adjunto al PR de activación.
  - Una divergencia vuelve al corpus como caso fijo.
- **Modo sombra (`mode: "shadow"`).**
  1. El binario lee stdin y calcula su veredicto **sin efectos**: la capa `Fs` va en modo registro
     y la auditoría no se escribe.
  2. Ejecuta `bash <script>` con `NAVORI_HOOK_IMPL=shell` y le pasa el mismo stdin.
  3. **Devuelve el resultado del shell** para códigos 0, 1 y 2. Una salida anómala, señal o fallo
     de transporte produce el veredicto seguro del engine (D6/R12): Claude con compuerta recibe
     JSON `ask`; Codex/Pi con compuerta reciben 2; advisory recibe 1. Se descarta stdout parcial
     antes de emitir ese fallo. Normalizar todo a 1 permitiría un fallo abierto en Claude.
  4. Registra cada divergencia en `.navori/state/rust-shadow/<hook>.jsonl`, que es local y está en
     `.gitignore`. El payload solo se guarda en las divergencias, nunca se sube a CI ni al repo.

  Si Rust falla en sombra, se registra como divergencia y decide el shell igual.
- **Paso de `shadow` a `active`:** un PR propio que cambia `mode` y exige:
  - replay a cero;
  - fuzz local de 100 000 entradas a cero;
  - un log de sombra con ≥ 500 invocaciones reales en ≥ 14 días de uso en este repo, cero
    divergencias y al menos un engine host distinto de Claude **en cada engine donde el hook está
    registrado**.

  El resumen del log (conteos por engine, cero divergencias) va en el PR.
- **R19 vivo:** la sombra en sesiones reales de Claude, Codex y Pi es el ejercicio en vivo de los
  hooks Rust bajo cada host. Las suites de aceptación (T11) lo complementan invocando los hooks por
  su **comando registrado exacto** (`sh -c '<comando>'` con el entorno del host), no llamando al
  binario directamente.

### D10 — Frescura de `dev` sin cron y sin bloqueo mutuo (R23)

- `scripts/js/rust-sync-age.mjs` toma los commits **de primer padre** de `origin/dev` que no están
  en el `HEAD` del PR (`git rev-list --first-parent HEAD..origin/dev`) y mira la fecha de commit
  del más antiguo. Esa fecha marca cuándo aterrizó el cambio en `dev`: el merge o el squash, no la
  fecha de autoría de sus commits internos. Falla si tiene más de 7 días.
- Es el job `freshness` de `rust.yml`, con `fetch-depth: 0` y `git fetch origin dev`. Si falta el
  ref, falla y nombra la causa; nunca da verde por omisión.
- **Un PR de sincronización nunca se bloquea a sí mismo.** Su `HEAD` incluye el `origin/dev` que
  mergeó. Lo único pendiente es lo que entró en `dev` después, y eso tiene menos de 7 días. El
  resto de las entregas queda en rojo mientras la sincronización esté atrasada; esa es la presión
  buscada, y se resuelve con un merge.
- **Quién sincroniza:** quien abra el siguiente PR contra `migration/rust` si `freshness` lo
  marca, y como mínimo una vez por semana mientras haya entregas en curso. El procedimiento está en
  CONTRIBUTING de la rama.
- **Sin `schedule`:** GitHub solo ejecuta cron desde la rama por defecto, y ahí no puede haber Rust
  ni avisos (decisión 4 del usuario).

### D11 — Pi: la extensión sigue siendo TypeScript generado; refactor previo en `dev` (R19)

> **Sustituida en parte por D29 de `specs/0059-rust-sesion-engines/design.md` (Q14, 2026-10-27).**
> Rust emite la extensión desde un asset derivado del CLI TS construido, con un solo marcador
> (`mcpPluginIds`), y no hay refactor E-Pi en `dev`. Sigue vigente que Rust no habla con Pi. La
> plantilla editable queda para la fase 4.

- Rust **no** habla con Pi. La extensión es un artefacto generado que ejecuta Pi (invariante 9).
  Rust la emite como texto.
- **E-Pi (TS, contra `dev`):**
  - mueve `bridge-source.ts`, `managed-lane-source.ts`, `trust-source.ts` y el cuerpo de
    `renderPiExtensionSource` a `packages/core/core-assets/pi/extension.ts.tmpl`;
  - mueve `mcpServerStates` y `createRuntimeCheck` a `core-assets/pi/mcp-server-states.ts` y
    `core-assets/pi/runtime-check.ts`. El CLI los **importa** (los empaqueta tsdown) y el render
    los **inserta como texto crudo** del mismo archivo: una sola fuente;
  - los marcadores de la plantilla son **solo JSON**: `{{json:mcpPluginIds}}`, `{{json:roleNames}}`,
    `{{json:roleTools}}`, `{{json:roleTimeoutMs}}`, `{{json:piMinVersion}}`,
    `{{json:nodeMinVersion}}` y `{{json:capabilities}}`. El escape es la serialización
    `JSON.stringify`, que Rust reproduce con D14;
  - añade el snap `pi` a `golden-render-tree.test.ts`.

  El texto de `.pi/extensions/navori.ts` cambia una vez (el código sale sin minificar) y esa versión
  llega a los usuarios por el release normal de `dev`.
- **R19 para Pi:** las suites `engines/pi/__tests__/first-class-*.test.ts` cargan la extensión
  renderizada por `navori-rust` con hooks Rust en `PATH`, más la sombra en vivo (D9).
- **Descartado:** Pi en modo RPC/JSON desde Rust (el CLI no conduce sesiones; violaría el
  invariante 9) y un adaptador TS como subproceso (resuelve un problema que no existe).

### D12 — Escritor de eventos de auditoría, antes del primer hook que audita (R11, R19)

E2 porta la **metadata de eventos de hook y el bridge al escritor CLI existente** de
`_partials/audit-log.sh`. El CLI TypeScript sigue siendo el único escritor del log:

- Rust detecta actividad mediante markers exactos y conserva el snapshot de inicio; un log que
  aparece después produce `ms: 0`. El modo shadow no registra eventos.
- El DTO cerrado conserva campos, categorías y serialización JS del shell (D14), sin contenido
  humano. El bridge entrega argv de identidad y metadata por stdin a `audit --record-metadata`.
- El CLI valida identidad, permisos y cabecera, asigna wire IDs y realiza el append seguro.
  Rust no escribe logs, arms ni spool directamente. Un fallo del bridge no cambia el veredicto.

M7 comprueba bytes contra el partial shell real y ejecuta el escritor TS real en pruebas aisladas
(`cargo test -p navori-core --test audit --locked`). La aceptación anterior mediante replay con
`--impl rust --audit active --only audit-writer` no era válida: el runner ignoraba esos flags y no
tenía ese caso. El soporte real de replay/fuzz llega en M8; el fast path de spool queda pendiente.
Los comandos `audit --arm` y
`audit --capture-child` llegan en E6 junto con sus hooks, como entradas de manifiesto por flag
(`{ "path": ["audit"], "flags": ["arm"] }`). El resto de `audit` queda para E8.

### D13 — Barra de calidad Rust (R15, R16)

```toml
[workspace.lints.rust]
unsafe_code = "deny"            # override only with #[allow(unsafe_code, reason = "…")]

[workspace.lints.clippy]
unwrap_used = "deny"
expect_used = "deny"
allow_attributes_without_reason = "deny"
undocumented_unsafe_blocks = "deny"

[profile.release]
panic = "unwind"
lto = "thin"
codegen-units = 1
```

- `clippy.toml` lleva `allow-unwrap-in-tests = true` y `allow-expect-in-tests = true`.
- `unsafe_code` está en `deny` y no en `forbid` porque R16 admite excepciones con motivo.
- CI ejecuta `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D
  warnings` y `cargo test --workspace --locked`. Como `-D warnings` convierte en error un nombre de
  lint desconocido, E1 prueba de paso la propia configuración.

**Crates** (último stable en crates.io a 2026-10-23; `Cargo.lock` fija la versión exacta):

| Crate | Versión | Uso |
|---|---|---|
| `serde` (derive) | 1.0.229 | config, manifiesto, payloads |
| `serde_json` | 1.0.154 | parseo de entrada; la **salida** usa el serializador JS de D14 |
| `ryu-js` | 1.0.3 | formato de números como `Number.prototype.toString` (D14) |
| `toml` | 1.1.8+spec-1.1.0 | lectura de `~/.codex/config.toml` |
| `regex` | 1.13.1 | reglas de hooks |
| `sha1` | 0.11.0 | hash de marker (sha1/8) |
| `sha2` | 0.11.1 | integridad, manifiesto, `canonicalJson` de Codex, ids de auditoría |
| `lexopt` | 0.3.2 | tokenizar argv (D2) |
| `dialoguer` | 0.12.0 | prompts interactivos (D16) |
| `assert_cmd` (dev) | 2.2.2 | tests del binario |
| `similar-asserts` (dev) | 2.0.0 | diffs legibles |
| `proptest` (dev) | 1.12.0 | propiedades JS-vs-Rust (D14) y la capa `Fs` |
| `expectrl` (dev) | 0.9.0 | pseudo-TTY para la paridad de prompts (D16) |

No se usan:

- clap (D2);
- `include_dir` (lo cubre build.rs);
- `tempfile`: sus temporales son `0600` y con otro patrón de nombre, y la capa `Fs` reproduce
  `writeFileAtomic` (D15);
- `anyhow`/`thiserror`: los mensajes son contrato del oráculo.

`fancy-regex` 0.19.2 entra solo si un patrón usa retroreferencias, y el PR debe dar el motivo.

### D14 — Serialización JSON con semántica JS (R9, R14, R19)

`navori-core::js_json` ofrece un `JsValue` propio:

- números como `f64`;
- objetos con el orden de propiedades de JS: primero las claves que son índices enteros
  (`0`…`2^32−2`) en orden ascendente, después las demás en orden de inserción;
- un serializador equivalente a `JSON.stringify(v)` y `JSON.stringify(v, null, 2)`.

Reglas que reproduce: `1.0` → `1`, `-0` → `0`, `1e21` y la notación exponencial de JS (vía
`ryu-js`), escapes de `JSON.stringify` bien formado (sustitutos solitarios como `\uXXXX`; U+2028 y
U+2029 sin escapar) y omisión de `undefined`. `canonicalJson` de Codex (`lib/codex/trust.ts`) se
porta sobre este mismo `JsValue`.

**Tests de propiedad (E1 M3 y E4):** `proptest` genera documentos. Un proceso Node persistente
devuelve `JSON.stringify(JSON.parse(x))`, sus variantes indentadas y `canonicalJson`, y Rust debe
coincidir byte a byte.

### D15 — Protocolo de escritura con tests dedicados, no solo el oráculo (R14)

- **Capa `Fs` (trait).** Tiene una implementación real y otra de registro que anota cada
  operación (`backup`, `create_temp`, `write`, `fsync`, `close`, `rename`, `remove`,
  `set_mtime`).
- **Escritura atómica = `writeFileAtomic`:**
  - temporal `.<base>.navori.tmp.<12 hex>` en el mismo directorio, abierto como `openSync(…, "w",
    0o644)`: `O_CREAT|O_TRUNC|O_WRONLY` sin `O_EXCL` y modo `0o644` sujeto a umask. Enmendado por
    0058 (Q7): el texto anterior decía `create_new`, que no es lo que hace el TS;
  - write, `sync_all`, close, rename;
  - si falla, borra el temporal.

  La garantía es la del TS: fsync del archivo y rename atómico. El fsync del directorio sigue fuera,
  igual que en TS. Si se quiere, es una mejora TS que va a `dev` primero.
- **Tests Rust dedicados**, sobre la implementación de registro y sobre disco real en tmp:
  - **orden:** en cada comando que escribe, el `backup` de un archivo precede a su primer `rename`
    o `remove`;
  - **fsync:** todo `rename` va precedido por un `fsync` del temporal;
  - **modos:** con umask `022` y `077`, el modo final de un archivo nuevo y el de uno existente con
    modo propio coinciden con los del TS (la referencia se mide una vez desde Node en el test);
  - **inyección de fallos** (feature `fault-injection`, solo en tests) después del backup, después
    del write y antes del rename: el original queda intacto y no sobra ningún temporal;
  - **poda de retención:** 30 días y 2 GiB, con mtimes sintéticos (`File::set_modified`);
  - **borrados:** cada rama de `removeManagedSectionGuarded` (`removed`, `modified`, `foreign`,
    `newer`) en `remove`, `sync` y la poda de huérfanos.
- **Matriz anti-rollback (oráculo + unitarios).** Cruza:
  - floor del registro (`harnessVersion`) {ausente, menor, igual, mayor};
  - `version=` del marker {ausente, menor, igual, mayor};
  - versión del CLI;
  - operación {inject, remove, hook, `settings.json` `$navori.version`}.

  `ambientFloorVersion` deja de ser estado de módulo: en Rust es un campo explícito del contexto de
  render, inicializado por el comando que lee la config.
- **Preview por defecto:** todo comando que escribe recibe `Fs` en modo registro salvo con
  `--apply`. Un test comprueba que sin `--apply` la lista de operaciones reales está vacía.

### D16 — Prompts interactivos con paridad de comportamiento (decisión 2 del usuario)

- Se usa `dialoguer` 0.12.0. No se reproduce el dibujo de `@clack/prompts`.
- **Contrato que sí se respeta:** la misma secuencia de preguntas (mismo texto de pregunta), las
  mismas opciones (mismas etiquetas, mismo orden, mismo valor por defecto) y los mismos efectos en
  disco y en el código de salida para cada guion de respuestas.
- **Test:** `crates/navori-oracle-tests` usa `expectrl` para conducir con el mismo guion
  `node dist/index.js <cmd>` y `navori-rust <cmd>` bajo pseudo-TTY. Quita ANSI y el dibujo, extrae
  las preguntas y las opciones, y compara eso más el árbol resultante y el código de salida.
  Cubre `init`, `add`, `configure`, `sync --interactive`, `adopt` y `update`.
- La salida no-TTY (los `log.*` de clack cuando no hay terminal) sí se compara byte a byte en el
  oráculo.

### D17 — Corte, distribución y fallback congelado (R18, R20, R21, R22, R24)

- **`cutover:check` falla si:**
  - falta en el manifiesto algún subcomando o flag de la tabla de `cli.ts`, o algún hook o bloque
    de `core-assets`/`plugins`;
  - algún hook sigue en `shadow`;
  - queda un despoteo abierto;
  - el último `bench:hooks --impl rust` incumple R17;
  - el último `check:post-cutover` incumple R18.

  `check:post-cutover` es el gate con la composición de después del corte: cargo, el oráculo
  congelado de hooks, las suites de artefacto (D11) y los checks de docs/render, **sin** la suite
  TS. Se mide en `migration/rust` antes del corte, así R18 es verificable antes de R20. La
  aprobación del usuario es aparte (R20).
- **Plataformas (R21):** darwin arm64/x64 y linux arm64/x64. En Linux el target es **musl
  estático**: un solo binario por arquitectura que funciona con glibc y con musl.
- **Paquetes (patrón esbuild):**
  - `navori` lleva `bin/navori`, un lanzador JS, y dos binarios declarados: `navori` y
    `navori-native-hook`;
  - cuatro paquetes de plataforma en `optionalDependencies`, filtrados con `os`/`cpu`;
  - en las plataformas con binario, un `postinstall` enlaza el binario sobre ambos `bin` solo si
    `<binario> --version` coincide con la versión del paquete.
- **Fallback congelado (R22):**
  - el paquete incluye `legacy/`: el `dist/` **exacto** del último `navori` TS publicado, extraído
    del tarball de npm y verificado con su `integrity`;
  - en una plataforma sin binario, el lanzador ejecuta `node legacy/index.js`, que muestra su propia
    versión y renderiza sus propios hooks shell;
  - si el postinstall no corre (`--ignore-scripts`, o scripts bloqueados por defecto en bun/pnpm)
    en una plataforma **con** binario, el lanzador ejecuta el binario a través de Node: pierde
    velocidad, no comportamiento.
- **Hooks tras el corte:** `NATIVE_HOOK_BIN` = `navori-native-hook`. Donde no hay binario, ese
  `bin` es un shim POSIX que sale con 127, así el prólogo cae al cuerpo shell (D7). Un usuario en
  una plataforma congelada que trabaja con colegas en Rust se encuentra con el anti-rollback (los
  markers de versiones nuevas no se rebajan). Es lo esperado y queda documentado.
- **La suite TS sale del gate (R18, R22):** el PR de corte borra `packages/cli/src` y sus tests. Se
  quedan las suites que prueban **artefactos generados** (la extensión Pi, D11), porque prueban
  salida y no implementación.
- **Release:** un workflow construye los cuatro binarios (macOS: runner arm64 con target x64 por
  `--target`; Linux: runners x64 y arm64) y los tarballs de plataforma. `npm publish` sigue siendo
  el paso manual 7 de README § Releases, extendido a esos paquetes.
- **R24:** el PR `migration/rust` → `dev` re-apunta `rust.yml` a `dev`, agrega el release, el
  empaquetado y `legacy/`, elimina la delegación y el oráculo TS, y requiere el gate full verde.

## Contracts

- **`crates/ported.json`** (D4):
  - `schema: 1`;
  - `commands: { path: string[], flags?: string[], when?: { engines?: string[] } }[]`;
  - `hooks: Record<id, { mode: "shadow" | "active", gating: boolean, blocks: Record<id, "sha256:…">,
    deps?: Record<rel, "sha256:…">, impl: "sha256:…", divergences?: { case, category: "shell-runtime"
    | "fail-closed", reason, requirement }[] }>`.
- **`crates/ported-history.jsonl`:** una línea por evento, `{ date, op: "port" | "unport" |
  "activate", id, reason, pr }`.
- **Invocación de hook:** `navori-rust hook (--via-script <ruta> | --via-command <evento> <ruta>)
  [--shadow] [args…]`. stdin = el payload.
  - Códigos: 0/1/2 = veredicto; 3 = difiere (sin haber leído stdin).
  - El binario nunca emite 126/127.
- **Línea de integridad:** `# navori:native-hook v=1 file=sha256:<hex> impl=sha256:<hex>` (D8).
- **Variables de entorno:**
  - `NAVORI_TS_CLI`;
  - `NAVORI_DELEGATED` (el pid del delegador; D3);
  - `NAVORI_HOOK_IMPL` (`shell` | `rust`);
  - `NAVORI_RUST_TRACE`.
- **Códigos de salida propios de `navori-rust` (fuera de `hook`):** 69 = no hay TS o falta `node`
  (R6); 70 = bucle de delegación.
- **Sin cambios:** el comando de `.codex/config.toml`, el formato y el hash de los markers,
  `$navori.version` y `harnessVersion`.

## Failure modes

| # | Falla | Contención |
|---|---|---|
| F1 | El binario muere (señal, abort), no arranca o `exec` falla | El fragmento de D7 corre el binario como hijo: 126/127 → shell; otro código → veredicto seguro fijo |
| F2 | Panic o E/S en un hook con compuerta | `catch_unwind` → veredicto seguro de D6 |
| F3 | Un input fuera del corpus cambia el veredicto | Fuzz diferencial en CI y antes de activar; sombra en sesiones reales (D9) |
| F4 | Un binario viejo o ajeno responde con lógica vieja | `impl` en la línea de integridad (D8) → difiere |
| F5 | Script editado después del render (CRLF, espacios, conflicto) o script hermano editado | Hash `file` sobre los bytes exactos más `deps` (D8) → difiere |
| F6 | Guard del usuario o bloque de plugin ignorado | La conformidad del render no emite el prólogo (D8) |
| F7 | Un comando portado se invoca con una flag o una config no portadas | Manifiesto por flags y `when`, y re-delegación antes de cualquier efecto (D3, D4) |
| F8 | Se delega a un TS de otra versión | Aviso de versión en stderr (D3) |
| F9 | Falso "bucle" en un descendiente | Token por pid (D3) |
| F10 | El oráculo normaliza de más o de menos | Misma ruta en secuencia; tokens con formato estricto y tests de mutación (D5) |
| F11 | El oráculo es circular sobre el wiring | Golden revisado a mano (D5) |
| F12 | Escritura interrumpida, backup tardío, modos distintos, poda o borrados | Tests dedicados de D15 |
| F13 | Diferencias de serialización JSON (claves enteras, `1.0`) | `js_json` + propiedades contra Node (D14) |
| F14 | `dev` avanza y el oráculo compara contra TS viejo | `freshness` por primer padre (D10) |
| F15 | Despoteos que se acumulan sin que nadie los vea | Historial obligatorio, aviso a los 14 días, `cutover:check` (D1) |
| F16 | Prompts con otro comportamiento | Pseudo-TTY con guion (D16) |
| F17 | El postinstall no corre en el corte | El lanzador ejecuta el binario o `legacy/` (D17) |

## Migration

- **Durante la convivencia:** ningún contrato de usuario cambia. El prólogo y el brazo solo existen
  en harnesses renderizados desde `migration/rust` (este repo y los repos de prueba).
- **E-Pi:** cambia una vez el texto de `.pi/extensions/navori.ts` en `dev`, con un release normal y
  el marker de versión al día.
- **En el corte:** el primer `render`/`sync` reescribe los bloques `<hook>-base` (con prólogo e
  integridad) y el comando de Claude. El comando de Codex no cambia, así que nadie tiene que volver
  a aprobar nada.
- **Reversión:**
  - antes del corte: despotear (con registro) o `NAVORI_HOOK_IMPL=shell`;
  - después del corte: publicar una versión con los hooks en `shadow`, que deja decidir al shell
    sin quitar el binario.

## Testing strategy

Cada test responde a un riesgo de arriba. Los IDs de entrega están en el Plan de entregas.

- **T1 — Delegación (R5; F7, F8).** Humo en el oráculo: comandos no portados, uno con stdin, uno con
  código ≠ 0, uno que depende del cwd y un comando portado con una flag no portada. El diferencial
  debe ser cero. Además, el aviso de versión aparece solo cuando las versiones difieren.
- **T2 — Sin TS o sin `node` (R6).** `assert_cmd` cubre las tres rutas ausentes y también el `.js`
  presente sin `node`. Espera exit 69, el mensaje completo y ningún proceso hijo.
- **T3 — Solo lo listado y anti-bucle (R7; F9).** Un test recorre la tabla nativa. Otro comprueba
  que `NAVORI_DELEGATED` con el propio pid sale con 70 y que con otro pid sigue normal.
- **T4 — Paridad por comando (R8, R9; F10, F11, F13).** El oráculo corre sobre todos los fixtures.
  Hay mutación por regla de normalización, un golden independiente del wiring y propiedades
  `js_json`/`canonicalJson` contra Node.
- **T5 — Regresión TS en lo ya portado (R10; F14, F15).** `rust.yml` corre `oracle`, `manifest` y
  `freshness`. Un PR sintético que cambia un asset portado sin tocar Rust debe ponerse rojo, igual
  que uno que quita una entrada sin su línea `unport`.
- **T6 — Corpus de hooks (R11).** `hook-verdict-replay.mjs --impl rust` con `NAVORI_HOOK_IMPL=rust`,
  en los modos `off` y `active` (eventos de auditoría, D12). Cada caso en `divergences` debe dar el
  veredicto de su categoría. Antes de portar un hook, su corpus necesita al menos un caso por clase
  de veredicto en cada engine donde está registrado.
- **T7 — Diferencial vivo (R11, R12; F3).** `fuzz:hooks` en CI (semilla fija) y en local antes de
  activar (D9).
- **T8 — Fail-closed y mapeo de salidas (R12, R13; F1, F2).** Por cada engine (Claude
  `--via-command`, Codex y Pi `--via-script`) y por cada hook con compuerta, un binario de prueba
  que:
  - sale con 0, 1 y 2 (pasa tal cual);
  - sale con 3 (cae al shell);
  - es un archivo no ejecutable (126 → shell);
  - es de otra arquitectura (126 → shell);
  - no existe (127 → shell);
  - muere por SIGSEGV y SIGABRT (veredicto seguro);
  - sale con 101 (veredicto seguro);
  - hace panic inyectado (veredicto seguro emitido por Rust);
  - deja la salida estándar cerrada.

  En ningún caso un hook con compuerta termina en "permitir" si el shell no lo hacía.
- **T9 — Integridad y conformidad (R13; F4, F5, F6).** El hook difiere al shell, con el mismo
  resultado que el shell, en todos estos casos:
  - archivo con CRLF;
  - espacio al final;
  - marcador de conflicto;
  - script hermano editado;
  - `impl` distinto;
  - otro `navori-rust` en `PATH`;
  - región de usuario con el comentario de ejemplo borrado y región de usuario con un guard propio
    (ninguno de los dos recibe prólogo);
  - bloque de plugin no portado.
- **T10 — Escrituras (R14; F12).** Los tests de D15 (orden, fsync, modos con dos umask, fallos
  inyectados, poda, borrados) y la matriz anti-rollback.
- **T11 — Engines (R19).** Las suites de aceptación TS por engine (aprobaciones, auditoría,
  handoffs, gate de plan; para Pi, `first-class-*.test.ts`) corren sobre un árbol renderizado por
  `navori-rust`, con los hooks invocados por su comando registrado y `navori-rust` en `PATH`. El
  resumen del log de sombra de cada engine se adjunta al PR de activación (D9).
- **T12 — Sin Rust en npm (R4).** `npm pack --dry-run --json` en `packages/cli` no lista ningún
  binario ni nada de `crates/`, y no define `postinstall`.
- **T13 — Instalación (R3).** `cargo install --path crates/navori-cli --locked` deja `navori-rust`
  en `~/.cargo/bin`, y `command -v navori` resuelve al mismo archivo que antes.
- **T14 — Rendimiento (R17).** `bench:hooks --impl rust` mide el p95 de la invocación directa del
  binario con los payloads del corpus (con la comparabilidad de 0055 D10). `--version` mide el p95
  de 100 procesos nuevos.
- **T15 — Prompts (D16; F16).** Guiones bajo pseudo-TTY para cada comando interactivo.
- **T16 — Distribución (R20–R22; F17).** Sondas de E9 en macOS y Linux (arm64/x64): npm, pnpm y bun,
  global y local, con y sin `--ignore-scripts`. Ejecuta el binario sin notarizar en un macOS limpio.
  En una plataforma sin binario (un contenedor con `os` falseado), `legacy/` debe responder igual
  que el último TS publicado: oráculo cero contra ese tarball.
- **T17 — Gate (R18).** `check:post-cutover` cronometrado en reposo, con el registro que lee
  `cutover:check`.

## Plan de entregas

Cada entrega es un PR. Las que van a `migration/rust` exigen `rust.yml` y `ci.yml` en verde.
Los hooks se portan en `shadow` y se activan en un hito posterior, una vez cumplidos los criterios
de D9.

### E1 — Cimientos (→ `migration/rust`)

- **M1 — Dirección y esqueleto.** Enmienda de DIRECTION (R1). Workspace, toolchain y lints (R2,
  R16). Los tres crates. build.rs con assets y versión. `--version` nativo (R17, primera parte).
- **M2 — Delegación.** Parser citty mínimo (D2) para la raíz. Delegación con resolución, aviso de
  versión, token por pid y errores 69/70 (D3; R5–R7). Esquema de `ported.json` y
  `ported-history.jsonl` (D4, D1).
- **M3 — Oráculo.** `oracle:rust` con misma ruta, entorno hermético, tokens estrictos y tests de
  mutación (D5; R8). Casos de superficie del golden. Humo de delegación. `js_json` con propiedades
  contra Node (D14).
- **M4 — CI e instalación.** `rust.yml` con los jobs `quality`, `oracle`, `manifest`, `freshness`
  (primer padre), `tarball` e `install` (R3, R4, R10, R15, R23). El cambio de `ci.yml`.
  CONTRIBUTING de la rama (instalación y sincronización).

### E-Pi — Extensión Pi como asset (TS → `dev`; independiente, debe estar en `dev` antes de E7)

- **M1 —** Plantilla y módulos en `core-assets/pi/` con una sola fuente para CLI y texto (D11).
- **M2 —** Snap `pi` en `golden-render-tree` y suites `first-class-*` en verde con el texto nuevo.

### E2 — Runtime de hooks (→ `migration/rust`)

- **M1 — Runner.** Contrato de salidas 0/1/2/3, búfer, `catch_unwind` y veredicto seguro (D6).
  Integridad `file`/`impl`/`deps` (D8). Hash de marker sha1/8 con `normalize` de JS.
- **M2 — Wiring.** `native-hook.ts` con conformidad, `nativeRunnerShell`, prólogo y brazo de Claude
  (D7). Golden independiente del wiring. T8 por engine.
- **M3 — Auditoría.** Metadata de eventos de hook y bridge al escritor CLI único (D12).
- **M4 — Herramientas.** Replay `--impl rust`, `fuzz:hooks`, modo sombra con su log y bench
  `--impl rust`. Aumento del corpus por engine. `divergences` con los 163 casos `shell-runtime`
  clasificados.
- **M5 — Primer hook.** `subagent-no-background` (232 casos Claude+Pi, sin llamadas al CLI) en
  `shadow`.

### E3 — `guard-destructive` (→ `migration/rust`)

- **M1 —** Activar `subagent-no-background` (criterios de D9).
- **M2 —** `guard-destructive-base` y `tgrep-search-lane` (con `deps` del script de búsqueda) en
  `shadow`, más fuzz con la gramática completa de reglas.

### E4 — Config, markers y render en preview (→ `migration/rust`)

- **M1 —** `NavoriConfig` en serde con mensajes de error en paridad. `inject_managed_section` y
  `remove_managed_section_guarded` con el contexto de floor explícito (D15).
- **M2 —** `render` sin flags y con `when.engines = ["claude"]`, con re-delegación probada.
  Propiedades `canonicalJson`.

### E5 — Escrituras (→ `migration/rust`)

- **M1 —** Capa `Fs`, escritura atómica, backup y poda, con los tests de D15 (R14).
- **M2 —** `render --apply`, `sync`, `remove` y `adopt` (Claude), con fixtures de escritura y la
  matriz anti-rollback.
- **M3 —** Activar `guard-destructive`.

### E6 — Ruta caliente de sesión (→ `migration/rust`)

- **M1 —** `plan-gate` con `plan gate`; `quality-gate-pre-commit` con `gate probe`/`gate foreign`.
- **M2 —** `session-start-context` con `tools session-context`, `tools notice`, `audit` (flag
  `arm`), `plan resume` y `dominio inject`; `subagent-stop-handoff` con `audit` (flag
  `capture-child`).
- **M3 —** Captura del corpus de `model-advisor`. Activar los hooks de E6 que ya cumplan D9.

### E7 — Resto de engines (→ `migration/rust`; requiere E-Pi sincronizado)

- **M1 —** Codex: render, trust con `canonicalJson` y fixture `codex-trusted`.
- **M2 —** agents-md, cursor y copilot.
- **M3 —** Pi: render de la plantilla y suites `first-class-*` sobre el árbol Rust (R19).

### E8 — Cola larga (→ `migration/rust`)

- **M1 —** Hooks restantes en `shadow` y activación de los pendientes.
- **M2 —** Comandos de lectura: `doctor`, `status`, `spec`, `handoff`, `audit` (resto),
  `receipt`, `master`, `tools`, `gate` (resto) y `bench`.
- **M3 —** Comandos con escritura o red: `init`, `add`, `configure`, `update`, `refresh`, `scan`,
  `workspace`, `registry`, `backup`, `migrations`, `preset`, `codex`, `dominio` y `ticket`, con los
  prompts de D16.

### E9 — Ensayo de distribución, sin publicar (→ `migration/rust`)

- **M1 —** Workflow que construye los cuatro binarios. Empaquetado con `postinstall`,
  `navori-native-hook` y `legacy/`, probado con `npm pack`.
- **M2 —** Sondas T16 (gestores de paquetes, binario sin notarizar, plataforma sin binario).
  Resolver Q1 (scope npm).
- **M3 —** `check:post-cutover` y `cutover:check` en verde (R17, R18).

### E10 — Corte (→ `dev`, R24)

- **M1 —** Aprobación explícita del usuario (R20).
- **M2 —** El PR único descrito en D17 con el gate full verde. Release con binarios para macOS y
  Linux (R21) y `legacy/` (R22).

**Por qué este orden.**

- La auditoría (E2 M3) va antes del primer hook que audita.
- Config entra con su primer consumidor (E4).
- Las escrituras (E5) llegan cuando el oráculo ya está maduro.
- Cada hook que llama al CLI se porta junto con su subcomando y la flag exacta (E6).
- Pi depende solo de E-Pi, no de quedar al final.
- La distribución se ensaya (E9) antes de la entrega irreversible (E10).

## Cambios tras el challenge

| Hallazgo | Dónde se resuelve |
|---|---|
| 1.1 crash, señal o `exec` fallido = permitir | D7 (hijo y mapeo), D6 (contrato 0/1/2/3), T8 |
| 1.2 corpus fijo | D9 (fuzz y sombra), T7, T11 |
| 1.3 binario viejo con el mismo asset | D8 `impl` |
| 1.4 hash de marker mal descrito; integridad débil | D8 (sha1/8 con `normalize` de JS; `file` sobre bytes exactos) |
| 1.5 scripts `source`ados | D4 `deps`, D8 |
| 1.6 región de usuario | D8 (comparación byte a byte, la región definida), T9 |
| 2.1 granularidad | D4 `flags` y `when`, D3 re-delegación |
| 2.2 TS obsoleto | D3 aviso de versión |
| 2.3 `NAVORI_DELEGATED` heredado | D3 token por pid |
| 2.4 binario ajeno en `PATH` | D8 `impl` |
| 3.1 normalización | D5 (misma ruta en secuencia, tokens estrictos) |
| 3.2 / 4.1 R14 solo por oráculo | D15, T10 |
| 3.3 circularidad | D5 golden independiente |
| 3.4 anti-rollback | D15 matriz, floor explícito |
| 3.5 JSON | D14 |
| 5.1 cron | D10 (sin `schedule`) |
| 5.2 despotear | D1 historial y avisos |
| 5.3 bloqueo | D10 (primer padre; el PR de sincronización siempre pasa) |
| 6.1 dependencias ocultas | D12, E-Pi propio, Plan de entregas |
| 6.2 interpolación Pi | D11 (marcadores solo JSON, enumerados) |
| § 7 R6 sin `node` | D3, T2 |
| § 7 R11 vs R12 | D4 `divergences` |
| § 7 R18 inalcanzable | D17 `check:post-cutover` |
| § 7 R21/R22 sin sonda previa | E9 |

## NOT in scope

- **Windows y otras plataformas:** reciben el TS congelado (R22).
- **Corregir o mejorar comportamiento al portar** (por ejemplo, fsync del directorio). Las mejoras
  van primero a `dev` en TS.
- **Reescribir en Rust las suites de aceptación de artefactos** (extensión Pi). Prueban salida
  generada y se quedan en Node.
- **Paridad visual de los prompts** (decisión 2 del usuario).
- **Adoptar `onFailure: "block"` o la forma exec en Claude** (requiere Claude Code ≥ 2.1.295 y
  cambia el contrato con el host).
- **Publicar en crates.io** o distribuir `navori-rust`.
- **Cambiar el formato de los markers, del trust o de `navori.config.json`.**
- **Defensa contra un binario malicioso en `PATH`.** Es el mismo modelo de amenaza que los hooks
  shell.

## Observaciones sobre requirements

- **R23** se aplica en el momento de uso: un PR contra `migration/rust` no se mezcla con un TS de más
  de 7 días (D10). En semanas sin entregas no se ejecuta ningún disparador, porque no hay cron
  posible fuera de la rama por defecto. Si R23 debe valer también para semanas inactivas, hace falta
  un recordatorio fuera de GitHub Actions o un workflow en la rama por defecto, y esto último choca
  con la decisión 4 del usuario.
- **R11** dice "cada caso del corpus", pero 163 casos son artefactos del runtime shell
  (126/127). El diseño los declara en `divergences` con la categoría `shell-runtime` y verifica que
  Rust emita su veredicto de categoría (D4). Si se prefiere, se puede regenerar el corpus filtrando
  esos artefactos con un cambio en `generateCorpus`. Eso es una mejora TS para `dev`.
- **R14** dice "verificados con el diferencial de R8". El diseño suma tests dedicados (D15) porque
  el diferencial no puede observar el orden, el fsync ni los fallos intermedios.

## Preguntas abiertas

- **Q1 [human, la decide E9]** — Scope npm de los paquetes de plataforma: `@navori/…` (falta
  confirmar que el scope sea tuyo) o sin scope (`navori-darwin-arm64`, etc.). No bloquea E1–E8.
- **[repo, E2]** — Confirmar que en **todos** los hooks `<hook>-base` abre en la línea 1 y que no
  hay código ejecutable antes del prólogo. Visto en `guard-destructive` (Claude), y en
  `subagent-stop-handoff` (Codex) y `subagent-no-background` (Pi).
- **[repo, E3]** — Qué variables ve el subshell `( . guard-search-routing.sh )`. Rust lanza el script
  como subproceso con esas variables exportadas; T6/T7 prueban los códigos 42 y 43.
- **[assumed]** — `navori-rust` es solo Unix (`exec`, señales POSIX). Windows recibe `legacy/`.

## Durable knowledge

- **DIRECTION.md (`migration/rust`, R1; a `dev` en el corte):** el no-objetivo retirado y la regla
  de convivencia (el TS es el oráculo, sentido único de sincronización, despoteo con registro).
- **CONTRIBUTING.md (`migration/rust`):** instalar `navori-rust`, el procedimiento de
  sincronización (cuatro clases de conflicto, `freshness`), cómo portar un comando (entrada con
  flags más casos) y cómo portar y activar un hook (sombra, fuzz, criterios de D9).
- **Engram:** "sin clap por paridad de superficie", "Pi no es dependencia de runtime", "el hash de
  marker es sha1/8 con `normalize` de JS" y "el prólogo no usa exec: los códigos 126/127 caen al
  shell". Son hallazgos que se re-litigan fácil.

## Fuentes

Consultadas el 2026-10-23.

- Claude Code, Hooks reference (códigos de salida, timeouts, forma shell/exec, `onFailure`):
  https://code.claude.com/docs/en/hooks
- Codex, Hooks (exit 2; `permissionDecision: "ask"` "parsed but not supported yet"):
  https://learn.chatgpt.com/docs/hooks (redirigido desde https://developers.openai.com/codex/hooks)
- Rust stable (rustc 1.99.1, 2026-10-13): https://static.rust-lang.org/dist/channel-rust-stable.toml
- Versiones de crates: API de crates.io `https://crates.io/api/v1/crates/<crate>`.
- Instalación de esbuild (paquetes de plataforma, reemplazo del shim en postinstall, fallback):
  https://github.com/evanw/esbuild/blob/main/lib/npm/node-install.ts
- GitHub Actions, evento `schedule` ("Scheduled workflows will only run on the default branch."):
  https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule
