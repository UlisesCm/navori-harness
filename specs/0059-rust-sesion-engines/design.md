# Migración a Rust, fase 3: hooks de sesión y engines restantes — Design

**Estado:** aceptado; Q14–Q18 resueltas por el usuario (§ "Decisiones del usuario") · **Fecha:**
2026-10-27 · **Base verificada:** `origin/migration/rust` = `702be44f` (merge de #1433). Las
afirmaciones sobre `crates/` también se contrastaron con `origin/feat/0058-rust-e3-delivery`
(#1434, borrador) y con #1432. Las referencias citan archivo y símbolo, no línea.

**Alcance del documento:** fase 3 del programa (`specs/0057-migracion-rust/requirements.md` §
"Fases del programa"). Se reutilizan sin cambios D1–D17 (0057) y D18–D27 (0058). La numeración
continúa: decisiones desde D28, modos de falla desde F29 y preguntas desde Q14. Corresponde a E6, E7
y E-Pi del "Plan de entregas" de 0057, recortadas y reordenadas como explica § "Plan de entregas".

**Autoría.** Este diseño lo escribió el orquestador sin `architect` ni el challenge del `auditor`
que exige spec-bootstrap para áreas críticas: los subagentes no arrancaban (la API rechazaba las
llamadas de los procesos hijo con un 400 por falta de saldo de uso extra), y el usuario decidió
ejecutar toda la fase sin subagentes (Q18). Como en 0058, cada PR necesita revisión independiente
antes del merge.

**Señal arquitectónica:** hooks con compuerta en tres engines (`quality-gate-pre-commit`,
`plan-gate`), escritura y borrado en el repo del usuario para cuatro engines nuevos, propiedad de
archivos de Pi, hash de trust de Codex y el contrato `crates/ported.json`.

## Decision drivers

Los de 0057 y 0058 (TS como oráculo, fallar hacia lo seguro, `dev` libre de Rust, mínima superficie
de conflicto), más cuatro propios:

1. **El costo está en el arranque del CLI, no en la lógica.** `navori` en frío cuesta 114–128 ms y
   `node -e 0` unos 28 ms (`specs/0055-suite-rapida/requirements.md` § "Contexto").
   `session-start-context` llama al CLI y a `node`; `plan-gate` llama a `navori plan gate` en cada
   despacho; `quality-gate-pre-commit` corre en **cada** llamada Bash de Claude y Codex. Portar un hook
   sin su subcomando no quita el arranque, y portar un subcomando sin el hook tampoco.
2. **No todo subcomando que toca un hook merece portarse.** `audit --capture-child` arrastra
   `lib/audit` (~20 800 líneas) y solo corre con un log de audit-mode existente
   (`subagent-stop-handoff.sh`, función que llama a `navori audit --capture-child`). `gate foreign`
   solo corre en commits hacia otro repo registrado. Lo raro se queda en el TS.
3. **Pi cambia casi a diario en `dev`.** Solo el 2026-10-26 y el 2026-10-27 entraron 8 commits en
   `packages/cli/src/engines/pi` de `origin/dev` (entre ellos #1430, el `session_id` de Pi en
   `plan-gate` y el disparo de audit-mode desde la extensión), todavía sin sincronizar en
   `migration/rust`. Un refactor previo en `dev` (E-Pi) choca con ese trabajo y cambia el texto de la
   extensión de todos los usuarios sin aportar nada a `dev`.
4. **Activar exige tiempo de uso real.** Un hook de sesión no junta 500 invocaciones en 14 días en
   Codex; el criterio de D9 se diseñó para hooks de cada tool call.

## Qué ya existe (evidencia en `702be44f`)

### En `crates/`

- **Runtime de hooks.** `crates/navori-cli/src/hook.rs`: `NATIVE_HOOKS` con dos entradas,
  `Handler::{Pure, Prepared}` (los hechos del host se recogen antes de leer stdin y un error difiere
  al shell), `Invocation.args` con los argumentos de modo, y `defer` (exit 3). `NativeHook.phase` es
  una sola cadena, pero `model-advisor` declara una fase por modo (`model-advisor.sh`, `case "$mode"`).
- **Diferir solo antes de stdin.** `crates/navori-hooks/src/runner.rs` (`Verdict`): un hook devuelve
  0, 1 o 2, y diferir es cosa del preflight. El prólogo (D7 de 0057) solo conserva stdin intacto si
  el binario no lo leyó.
- **Hechos del host en caché.** `crates/navori-cli/src/facts_cache.rs` guarda las sondas del host por
  inodo, tamaño y fechas del binario resuelto en `PATH`, con 24 h de vida, en `.navori/state/rust-facts/`.
- **Piezas de shell ya portadas dentro de `guard_destructive`** (#1432):
  `hooks/guard_destructive/{landing,ratchet,copy_dest,repo}.rs` (resolución del worktree de
  destino, trinquete de `progress/`) y `shell/{payload,prepare}.rs` (extracción del comando y del
  payload). `quality-gate-pre-commit` incluye los mismos parciales (`extract-cmd`, `hook-input`,
  `resolve-worktree`, `progress-ratchet`).
- **Auditoría de hooks.** `crates/navori-core/src/audit.rs`: metadata y bridge al escritor CLI único
  (D12 de 0057). No cubre los eventos que escribe el **CLI** (`appendCliEvent`).
- **Render.** `crates/navori-core/src/render/*` porta el motor Claude, y #1434 añade `owned_paths`,
  `.gitignore` anidados, la capa `Fs`, backup y los comandos con escritura. No hay código de Codex,
  Pi ni engines de prosa. El manifiesto limita `render` a `when.engines = ["claude"]` (T17 de 0058).

### Hooks de sesión hoy

| Hook | Claude | Codex | Pi | Llamadas caras | Corpus (Claude/Codex/Pi) |
|---|---|---|---|---|---|
| `quality-gate-pre-commit` | PreToolUse `Bash` | PreToolUse `^Bash$` | `tool_call` bash, enforced (commit **y** push) | `navori gate probe --clean` en commit; `navori gate foreign` en commit a otro repo | 22 / 3 / 1 |
| `plan-gate` | PreToolUse `Agent` (`planTiers`) | PreToolUse `spawn_agent$` (`planTiers`) | no registrado: la extensión llama `navori plan gate` | `navori plan gate` siempre; `navori --version` en la rama de error | 0 / 15 / — |
| `session-start-context` | SessionStart | SessionStart | no registrado: handler `session_start` de la extensión | `navori tools session-context --notice-reserve`; `navori --version`; `node` para el JSON; `navori plan resume --json` solo en Codex `resume`; `navori dominio inject` de respaldo | 24 / 16 / — |
| `subagent-stop-handoff` | PostToolUse `Agent\|Task` | SubagentStop `codex`; SubagentStart `codex capture-start` | no registrado: la extensión llama `navori handoff check` | `node` para el JSON; `navori audit --capture-child` solo con log de audit-mode | 7 / 0 / — |
| `model-advisor` | SessionStart, PostModelSwitch, Stop | SessionStart; PreToolUse `codex-pretool-profile` (`codexIntegration`) | no soportado (`pi-parity.ts`) | `node` en cada modo; `navori codex profile hook` en `codex-pretool-profile` | 0 / 0 / — |

Fuentes: `engines/claude/build-settings.ts` (`claudeHookCommand` por destino),
`engines/codex/hook-registrations.ts` (`CODEX_HOOK_REGISTRATIONS`), `engines/shared/pi-parity.ts`
(`hookEntries`), `.pi/extensions/navori.ts` (`runNavori(cwd, ["plan", "gate"]…)`) y
`packages/cli/src/__tests__/fixtures/hook-verdict-corpus/*.sh.jsonl`.

### Subcomandos de la ruta caliente

- **`plan gate`** (`commands/plan.ts`, `gateSubCommand` → `lib/plan/gate.ts`, `applyPlanGate`).
  Unas 2 000 líneas transitivas (`gate`, `classify`, `check`, `expected`, `schema`, `spec/tasks`,
  `spec/locate`, `roster`). Lee stdin, ejecuta `git rev-parse`, reclama el marcador de despacho con
  `renameSync` y lo borra con `rmSync`, y en `allow` escribe un evento CLI solo si `hasAuditTarget`
  (`emitDispatchOutcome`).
- **`gate probe`** (`commands/gate.ts` → `lib/gate/cache.ts`, `probeGreen`): ~300 líneas, hash de
  contenido del índice o del árbol, con lock de archivo.
- **`tools session-context` y `tools notice`** (`commands/tools.ts` →
  `lib/primitives/tool-version-notice.ts`, `remote-version-cache.ts`,
  `lib/workspace/dominio-inject.ts`): ~450 líneas. La consulta de versiones corre en un worker que el
  CLI se lanza a sí mismo con un flag privado y un token (`spawnPrivateWorker`) y que hace peticiones
  a npm y GitHub.
- **`dominio inject`** (`commands/dominio.ts` → `dominioInjectText`): ~50 líneas de lectura de
  `~/.navori/workspaces`.

### Engines restantes

- **Orquestación.** `commands/render.ts`, `prepareRenderTarget` y `prepareNonClaudeEngines`: Codex y Pi
  se preparan (`prepare*Engine`) y se finalizan antes de cualquier escritura. Los engines de prosa
  (`agents-md`, `cursor`, `copilot`) se escriben en `commit` con `renderProseFile`. `agents-md` se
  omite con advertencia si otro engine es dueño de `AGENTS.md` (`ENGINE_CAPABILITIES[...].ownsAgentsMd`).
  Para Codex se añade la pista de trust (`appendCodexTrustHint`).
- **Prosa.** `engines/shared/prose-harness.ts` (267 líneas) y los adaptadores (`AGENTS.md`,
  `.cursor/rules/navori.mdc`, `.github/copilot-instructions.md`), con 48, 55 y 41 líneas.
- **Codex.** `engines/codex/` (~2 400 líneas: `index.ts`, `build-config-toml.ts`, `build-rules.ts`,
  `hook-registrations.ts`, `compat.ts`) más `lib/codex/trust.ts` (`codexHookHash`,
  `readCodexTrustState`; el render solo **lee** `~/.codex/config.toml`) y
  `lib/codex/model-catalog.ts` para los modelos de los agentes.
- **Pi.** `engines/pi/` (~3 400 líneas). El texto de la extensión sale de
  `renderPiExtensionSource(mcpPluginIds)` (`extension-source.ts`), que concatena constantes
  (`PI_TRUST_SOURCE`, `PI_EXTENSION_DENIALS`, `PI_BRIDGE_SOURCE`, `PI_MANAGED_LANE_SOURCE`, roles,
  herramientas y plazos), funciones serializadas con `toString()` (`mcpServerStates`,
  `createRuntimeCheck`) y **un solo valor que depende de la config**: `MCP_PLUGIN_IDS`.
  `serializePiSource` (`owned-file.ts`) antepone una línea `navori:managed-file` con el sha256 del
  cuerpo. `ownsPiSource` además exige que el archivo existente parsee como TypeScript, con
  `stripTypeScriptTypes` o, en Bun, con un `node` hijo. El resto del render Pi produce
  `.pi/navori.json` (manifiesto v2), `.pi/agents/*.md`, `.pi/navori/hooks/*`, `.pi/navori/scripts/*`
  y los bloques de plugins de `AGENTS.md`.
- **Pruebas de aceptación.** 15 suites `engines/pi/__tests__/first-class-*.test.ts`. 12 llaman a
  `renderPiEngine` en proceso y no hay un helper común. Codex tiene 9 suites en
  `engines/codex/__tests__/`. `engines/__tests__/golden-render-tree.test.ts` tiene snaps para
  `claude`, `codex`, `agents-md`, `cursor` y `copilot`, pero no para `pi`.
- **Fixtures del oráculo.** `scripts/js/rust-oracle/fixtures/` ya trae `pi` y `self-hosted`. 0058
  T31 añade `codex-trusted`.

## Approach

Tres entregas contra `migration/rust` y ninguna contra `dev`:

1. **E1 — Hooks de sesión en sombra**, con los subcomandos que quitan el arranque del CLI en sus
   ramas frecuentes. Puede avanzar en paralelo con 0058 E3: toca `crates/navori-hooks`,
   `crates/navori-cli` y `navori-core::{plan,gate,tools}`, no el render.
2. **E2 — Render multi-engine**: prosa, Codex y Pi, en preview y con escritura, y la ampliación de
   `sync`, `remove --yes` y `adopt` a esos engines.
3. **E3 — Activación** de los hooks de sesión que cumplan su umbral, en un solo PR.

### Escalera de opciones para la decisión de mayor riesgo: cómo emite Rust la extensión Pi

- **Patrón existente: portar a Rust los generadores de texto TS** (`renderPiExtensionSource`, las
  fuentes de bridge, lane y trust, y las funciones serializadas). Descartado: son ~1 500 líneas de
  texto que cambian casi cada semana en `dev`. Cada merge (R23) obligaría a re-portar a mano, y la
  serialización con `toString()` depende del bundler.
- **Extensión: asset derivado del CLI TS construido (elegida, D29).** Un script genera el texto con
  el CLI del checkout y lo guarda con un único marcador JSON para `MCP_PLUGIN_IDS`. CI regenera y
  compara. No toca `dev`, no cambia el texto que reciben los usuarios, y un merge de `dev` que cambie
  la extensión pone CI en rojo hasta regenerar (R10, R67).
- **Nueva arquitectura: E-Pi de 0057 (plantilla única en `core-assets/pi/` refactorizada en `dev`).**
  Descartada para esta fase: exige un PR a `dev` sobre el área que más se mueve, cambia el texto
  publicado y su beneficio (una sola fuente) solo importa después del corte, cuando el TS se congela.
  Queda como opción de la fase 4 (Q14).

## Components

- **`crates/navori-hooks`:**
  - `shell::{extract_cmd, hook_input, landing, ratchet, gate_trigger, audit_signal}`: se mueven a
    `shell` los módulos que hoy viven dentro de `guard_destructive`, sin cambiar su comportamiento
    (D32), y se añaden los parciales que faltan;
  - `hooks::{quality_gate, plan_gate, session_start, subagent_stop, model_advisor}` (D30, D31).
- **`crates/navori-cli`:**
  - `hook.rs`: `NativeHook.phase` pasa a ser una función del modo, y la lista de modos diferidos
    (D31);
  - `hook_facts.rs`: hecho nuevo "versión del `navori` de `PATH`", con caché (D30);
  - comandos nativos `plan gate`, `gate probe`, `tools session-context`, `tools notice` y
    `dominio inject` (D33, D34).
- **`crates/navori-core`:**
  - `plan::{gate, classify, check, expected, schema}`, `spec::{tasks, locate}`, `roster` (D33);
  - `gate::cache` (D33);
  - `tools::{session_context, notice}` y `workspace::dominio` (D34);
  - `render::{prose, codex, pi, engines}` (D36–D38);
  - `assets/pi/extension.ts.in`, el asset derivado (D29).
- **`scripts/js/`:**
  - `gen-pi-extension-asset.mjs`, generador y comprobación (D29);
  - `hook-verdict-replay.mjs`: captura del corpus de `model-advisor` (D35);
  - `rust-oracle/`: fixtures y casos nuevos (§ "Testing strategy").
- **`crates/ported.json`:** cinco hooks, cinco comandos nuevos y `when.engines` ampliado.
- **`.github/workflows/rust.yml`:** el job `oracle` corre la comprobación del asset Pi (D29).

## Decisions

### D28 — Tres PRs, ninguno contra `dev` (todas las R)

- **E1 y E2 van separadas** porque dependen de cosas distintas (#1432 y 0058 E3) y tocan áreas
  distintas (hooks y render). Juntas, un PR esperaría al más lento y mezclaría dos áreas críticas en
  una sola revisión.
- **E3 va aparte** por la misma regla de 0058: una activación depende de una ventana de tiempo y de
  la aprobación del usuario en su propio PR, y un hito de área crítica no se agrupa con trabajo ajeno.
- **Las activaciones van juntas.** Un solo PR activa todos los hooks que cumplan su umbral, cada uno
  con su línea `activate` en `ported-history.jsonl` y su evidencia (R60). El que no llegue se queda
  en `shadow` y pasa a la fase 4 (R61), sin abrir un PR más en esta fase.
- **Alternativa de dos PRs:** llevar E3 a la fase 4 junto con los hooks de la cola larga. Ahorra un
  PR a cambio de retrasar la ganancia de latencia hasta 0060 (Q17).

### D29 — Extensión Pi como asset derivado (R67, R10)

- **Generación.** `scripts/js/gen-pi-extension-asset.mjs` crea un repo temporal con
  `engines: ["pi"]` y sin plugins MCP, corre el `navori render --apply` del checkout
  (`packages/cli/dist`, el mismo binario que usa el oráculo) y lee `.pi/extensions/navori.ts`:
  - quita la primera línea (`// navori:managed-file …`), que Rust recalcula;
  - sustituye la única línea `const MCP_PLUGIN_IDS: readonly string[] = [];` por
    `const MCP_PLUGIN_IDS: readonly string[] = {{json:mcpPluginIds}};`;
  - falla si esa línea no aparece exactamente una vez o si `{{json:` ya existía en el texto.
- **Asset.** `crates/navori-core/assets/pi/extension.ts.in`, embebido por `build.rs`. Rust sustituye
  el marcador con `js_json::stringify` de la lista de `mcpPluginIds(config)` (D14 de 0057), arma el
  cuerpo y antepone la línea de `serializePiSource` con el sha256.
- **Frescura.** `gen-pi-extension-asset.mjs --check` regenera en memoria y compara byte a byte. Corre
  en el job `oracle` de `rust.yml`, que ya construye el TS. Un merge de `dev` que cambie la extensión
  pone ese job en rojo hasta que se regenere el asset en el mismo PR de sincronización (clase
  "regenerable" de D1).
- **Por qué con el binario construido y no con las fuentes:** `serializeAnonymousFunction` usa
  `toString()`, y su salida depende del bundler. El oráculo compara contra `dist`, así que el asset
  tiene que salir de `dist`.
- **Después del corte** (fase 4) el asset deja de ser derivado. Convertirlo en plantilla editable es
  decisión de 0060 (Q14).

### D30 — Subcomandos en proceso solo con la misma versión (R52, R53)

- El shell llama al `navori` de `PATH`, que puede ser una versión distinta de la del checkout con que
  se compiló `navori-rust` (D20 de 0058). Si el hook nativo ejecutara siempre en proceso, en sombra
  divergiría cada vez que la versión instalada difiera, y en `active` cambiaría el comportamiento.
- **Regla.** El hecho del host `navori_cli` es la versión que imprime `navori --version` en el
  `navori` resuelto por `PATH`. Se recoge antes de leer stdin y se guarda en el `facts_cache` con su
  inodo, tamaño y fechas, así que la sonda (~120 ms) solo se repite cuando cambia el binario.
  - Si coincide con `TS_CLI_VERSION`: el subcomando corre en proceso.
  - Si difiere: el hook ejecuta ese `navori` como subproceso, con los mismos argumentos, stdin,
    entorno y plazo que el shell (R52).
  - Si no hay `navori`: la rama "not installed" del shell, con el mismo texto.
- La misma regla vale para las ramas que esta fase no porta (`gate foreign`, `audit --capture-child`,
  `plan resume --json`). Ahí el subproceso siempre es el `navori` de `PATH`, exactamente como el
  shell.

### D31 — Diferir por modo antes de stdin; fase por modo (R51, R50)

- `model-advisor codex-pretool-profile` llama a `navori codex profile hook` (comandos `codex`, fase
  4). `subagent-stop-handoff codex capture-start` registra el arranque de la captura de hijos de
  Codex (spec 0042). Ambos difieren con exit 3 en el preflight, antes de leer stdin, así que el
  cuerpo shell decide con el payload intacto (D7 de 0057).
- `NativeHook.phase` pasa de cadena a función `fn(&Invocation) -> &'static str`, con la misma tabla
  que el `case "$mode"` del script. Así la auditoría de cada modo conserva su `navori_audit_phase`.
- Un modo desconocido difiere: nunca se adivina.

### D32 — Parciales de shell compartidos (R50)

- Los parciales que `quality-gate-pre-commit` comparte con `guard-destructive` (`extract-cmd`,
  `hook-input`, `resolve-worktree`, `progress-ratchet`) ya están portados dentro de
  `hooks/guard_destructive`. Se mueven a `navori_hooks::shell` en un commit propio, sin cambiar el
  comportamiento: el replay y el fuzz de `guard-destructive` deben dar cero antes y después.
- `implementation_hash` de `guard-destructive` cambia porque cambian sus fuentes. Ese commit
  actualiza el `impl` de su entrada en `ported.json` con su línea en `ported-history.jsonl`, sin
  cambiar el modo.
- Faltan `gate-trigger` y `audit-signal`. Se portan como módulos de `shell`, con propiedades contra
  el parcial real (fuzz de comandos `git` con comillas, `-C`, alias y cadenas).

### D33 — `plan gate` y `gate probe` nativos (R56, R57, R58)

- **Puerto literal** de `evaluatePlanGate`, incluida la reclamación atómica del marcador
  (`renameSync` al nombre de reclamo y luego `rmSync`). Las escrituras pasan por `RealFs`: un
  subcomando de hook no tiene preview.
- **Auditoría sin escritor propio.** `emitDispatchOutcome` solo escribe si hay un log de audit-mode
  para la sesión. Rust no porta `appendCliEvent`; re-delega toda la invocación al TS **antes de leer
  stdin** cuando:
  - en el entorno hay una identidad de auditoría (`NAVORI_AUDIT_HOST`/`NAVORI_AUDIT_SESSION_ID`,
    `CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID` o `CODEX_THREAD_ID`), **y**
  - la raíz de auditoría del repo contiene al menos un `session-*.log` regular.

  La condición es un superconjunto de `hasAuditTarget`, así que la paridad no depende de reproducir
  `auditTarget`. Como audit-mode es raro, la ruta normal sigue siendo nativa.
- **`gate probe`**: puerto de `probeGreen` con el mismo hash de contenido y el mismo lock
  (`withFileLock`). `--clean` exige índice igual a árbol, como el TS.
- `gate` (sin `probe`) y `gate foreign` no entran: corren el quality gate del repo, que tarda minutos
  y no gana nada con Rust.

### D34 — `tools session-context`, `tools notice` y `dominio inject` (R56, R59)

- Puerto de `prepareToolNotices`, `ackToolNotices`, el contrato de salida
  `#navori-session-context v1` (`SESSION_CONTEXT_BEGIN`, secciones `notice` y `dominio`) y
  `dominioInjectText`.
- **La red se queda en TS.** Donde el TS llama a `spawnPrivateWorker(flag, token)`, Rust lanza el
  `navori` de `PATH` con el mismo flag y token, desacoplado y con stdio ignorado. Ese worker es TS y
  hace las peticiones (R59). Rust nunca abre un socket.
- El oráculo corre con `HOME` hermético y sin red, así que compara el estado en `~/.navori/` (el
  claim, el token y los stamps) y no el resultado de la red. El lanzamiento del worker se verifica en
  un test con un `navori` falso en `PATH` que registra su argv.

### D35 — Corpus y umbral de activación por clase de evento (R54, R60, R61)

- **Corpus antes de la sombra (R54).** Al menos un caso por clase de veredicto y por modo en cada
  engine registrado:
  - `plan-gate`: casos Claude (hoy 0);
  - `subagent-stop-handoff`: casos Codex de `SubagentStop` (hoy 0);
  - `quality-gate-pre-commit`: Pi (hoy 1) y Codex (hoy 3), con commit, push, cache verde y gate rojo;
  - `model-advisor`: captura nueva de los modos `claude-session-start`, `claude-post-model-switch`,
    `claude-stop` y `codex-session-start`, con `hook-verdict-replay.mjs --generate` sobre la captura
    cruda.
- **Umbral por clase de evento (R60; Q15).** D9 pide ≥ 500 invocaciones reales en ≥ 14 días por
  engine. Esta fase propone fijarlo por la frecuencia del evento registrado, en cada engine:

  | Clase | Hooks y eventos | Umbral en 14 días |
  |---|---|---|
  | Por tool call | `quality-gate-pre-commit` (Bash) | 500 |
  | Por turno o despacho | `model-advisor` `Stop` (Claude), `plan-gate`, `subagent-stop-handoff` | 100 |
  | Por sesión | `session-start-context`, `model-advisor` `SessionStart` (Codex) | 30 |

  Un hook registrado en varios eventos usa en cada engine la clase de su evento más frecuente. El
  resto de D9 no cambia: cero divergencias, replay a cero y fuzz (100 000 con compuerta, 20 000
  advisory).
- Si el usuario prefiere el criterio de 500 sin cambios (Q15 b), los hooks de sesión se quedan en
  `shadow` hasta cumplirlo y R61 los pasa a la fase 4.

### D36 — Render multi-engine en el mismo orden que el TS (R62, R64, R65)

- `render::engines` reproduce `prepareRenderTarget`: un único `OwnedPathInventory`, luego la
  preparación de Claude, Codex y Pi (en el orden de `config.engines`), la validación de destinos y el
  `finalize` de todos. Ninguna escritura ocurre antes de que todos finalicen. Los engines de prosa se
  escriben en `commit`, después, como en el TS.
- `AGENTS.md`: Codex y Pi son dueños según `ENGINE_CAPABILITIES.ownsAgentsMd`. `agents-md`
  redundante produce su advertencia (`agentsMdRedundantWithCodex`) y no escribe. Pi añade sus bloques
  de plugins (`includePluginBlocks`).
- El manifiesto amplía `when.engines` de `render`, `sync`, `remove` y `adopt` al conjunto de R62. Un
  engine fuera del conjunto, un monorepo con workspaces o las flags excluidas por 0058 siguen
  re-delegando antes de cualquier salida.

### D37 — Codex: TOML como texto, trust solo de lectura (R66, R62)

- `.codex/config.toml` y `.codex/rules/navori.rules` se emiten como **texto** con el mismo
  constructor que `build-config-toml.ts` y `build-rules.ts`, con markers de comentario `#` (D21 de
  0058). No se usa un serializador TOML: su formato no coincidiría byte a byte.
- El crate `toml` (ya en la lista de D13 de 0057) solo **lee** `~/.codex/config.toml` para
  `readCodexTrustState`. `codexHookHash` usa la `canonicalJson` de `lib/codex/trust.ts`, con
  propiedades contra Node como `js_json`.
- `lib/codex/model-catalog.ts` se porta en la parte que usa el render: resolución de `codexMap` contra
  el catálogo local, también para los agentes Pi.
- Los comandos `navori codex *`, `approval-*`, `profile-*` y `native-integration` son de la fase 4.

### D38 — Pi: propiedad y validación de recursos (R68, R67)

- Puerto de `ownsPiManifest`, `ownsPiAgent` y `ownsPiSource`, del rechazo por esquema de manifiesto
  más nuevo (`PI_MANIFEST_SCHEMA`) y de la regla todo-o-nada de `.pi/navori/**`.
- **Parseo TypeScript.** Para un `.pi/extensions/navori.ts` existente con hash válido, Rust ejecuta
  el mismo `node --input-type=commonjs --eval 'require("node:module").stripTypeScriptTypes(…)'` que
  usa el TS en Bun, con el mismo límite de 1 MiB y 5 s. Pi ya exige Node, así que no es una
  dependencia nueva. Si no hay `node`, el resultado es "no es nuestro", igual que el TS cuando falla el
  `spawnSync`.
- El contenido que genera Rust no se re-parsea: la comprobación de frescura de D29 garantiza que es
  el mismo texto que el TS ya valida.

### D39 — R19 por igualdad de árbol más humo de carga (R19, R62)

- Las suites `first-class-*` prueban el **artefacto**, y su render lo hace `renderPiEngine` en
  proceso, sin un helper común (12 de 15 suites). Reescribirlas para que rendericen con Rust abriría
  conflictos en cada merge de `dev` sobre el área más cambiante.
- **Criterio.** Para cada dimensión de config que esas suites ejercen (controles `planTiers`,
  `masterPlan`, `scribeOwnsMarkdown`; `qualityGate.fast`; roles `publisher` y `scout`; plugins MCP;
  `codexMap`; recurso editado por el usuario), el oráculo tiene un fixture y el árbol de Rust es
  idéntico byte a byte al del TS. Con árboles idénticos, lo que las suites prueban vale para el árbol
  Rust.
- **Humo.** Una suite nueva que solo existe en `migration/rust`
  (`engines/pi/__tests__/rust-tree.test.ts`) renderiza el fixture `pi` con `navori-rust render
  --apply` y carga la extensión con el cargador real de `@earendil-works/pi-coding-agent`, como
  `render-syntax.test.ts`. Para Codex, lo equivalente es leer `.codex/config.toml` con el parser de
  Codex que ya usan las suites de trust.
- Un test enumera las dimensiones de la lista y falla si alguna no tiene fixture.

### D40 — Sombra solo en las ramas sin efectos (R50, R54)

- **Problema.** En `shadow` el nativo corre antes que el shell y no debe tener efectos (D9 de
  0057). `quality-gate-pre-commit` tiene ramas con efectos: el `eval` de `qualityGate.fast`, `navori
  gate foreign` y el aviso `gate-started`. Correrlas en el nativo cobra el gate dos veces por commit,
  y el verde que deja en cache hace que el shell responda "skipped": una divergencia falsa en cada
  commit.
- **Regla.** En sombra, un hook nativo decide hasta la primera rama con efectos. Al llegar a ella
  devuelve "no observado": `Comparison` gana ese estado, no cuenta como divergencia ni como
  invocación hacia el umbral de D35, y el journal lo registra aparte. Fuera de sombra (`active` y
  `NAVORI_HOOK_IMPL=rust`) el nativo sí ejecuta esas ramas.
- **Qué se observa en vivo.** Todo lo que no es commit (la ruta de R55), el payload vacío, el
  commit a otro repo sin config o sin `navori`, el trinquete de `progress/`, `nativeHooks`, el
  acierto de `gate probe` y el runner ausente (`ask` o bloqueo).
- **Qué no.** La corrida del gate propio y la de `gate foreign`: las prueban el replay del corpus y
  el fuzz con `--impl rust`, que corren aislados.
- **User-section.** El nativo no ejecuta la user-section del script. Si el script trae en ella algo
  distinto de la plantilla del asset, la preparación falla y el hook difiere antes de stdin.
- **Alternativas descartadas.** Correr el gate también en el nativo (doble costo y divergencia
  falsa por cache). Diferir todo commit antes de stdin: saber si es commit exige leer el payload.

## Contracts

- **`crates/ported.json`:**
  - hooks `quality-gate-pre-commit`, `plan-gate`, `session-start-context`, `subagent-stop-handoff` y
    `model-advisor` en `shadow`, con `gating` según el registro, `blocks` y `deps` (parciales y, en
    `quality-gate-pre-commit`, el script de progreso si aplica);
  - comandos `plan gate`, `gate probe`, `tools session-context`, `tools notice` y `dominio inject`
    con sus flags exactas;
  - `when.engines` de `render`, `sync`, `remove` y `adopt` ampliado.
- **`crates/ported-history.jsonl`:** líneas `port` de lo anterior, el cambio de `impl` de
  `guard-destructive` por D32 y, en E3, una línea `activate` por hook.
- **Asset `crates/navori-core/assets/pi/extension.ts.in`:** derivado, con el marcador
  `{{json:mcpPluginIds}}` como único hueco (D29).
- **Sin cambios:** el comando registrado de cada engine, el contrato `#navori-session-context v1`, el
  formato de los marcadores de despacho, `.codex/config.toml` del usuario, el hash de trust, el
  manifiesto Pi v2 y el texto de la extensión que reciben los usuarios.

## Failure modes

| # | Falla | Contención |
|---|---|---|
| F29 | `navori` instalado con otra versión que el checkout: el hook nativo responde con otra lógica | Hecho de versión con caché; subproceso al `navori` de `PATH` si difiere (D30) |
| F30 | Un hook nativo lee stdin y descubre una rama que no porta | Diferir solo por modo y antes de stdin (D31); las ramas por payload van por subproceso (D30) |
| F31 | `plan gate` nativo con audit-mode activo y sin escritor de eventos CLI | Re-delegación conservadora antes de stdin (D33) |
| F32 | Un merge de `dev` cambia la extensión Pi y el asset queda viejo | `--check` en el job `oracle` (D29); regenerar es parte de la sincronización |
| F33 | La sonda de versión de `navori` cuesta 120 ms en cada invocación | `facts_cache` por inodo, tamaño y fechas (D30) |
| F34 | Los hooks de sesión no llegan al umbral en Codex | Umbral por clase (D35, Q15); el que no llega se queda en `shadow` (R61) |
| F35 | Mover los parciales cambia el veredicto de `guard-destructive` | Commit propio con replay y fuzz a cero antes y después (D32) |
| F36 | El worker de versiones se lanza dos veces o con otro token | Test con `navori` falso que registra su argv (D34); el estado de claim se compara en el oráculo |
| F37 | Un render multi-engine escribe Claude y luego falla Codex o Pi | `finalize` de todos antes de escribir (D36); fixture con un recurso Pi ajeno (R65) |
| F38 | Un serializador TOML reordena o reformatea `.codex/config.toml` | Emisión como texto (D37); `toml` solo para leer |
| F39 | La sombra corre el gate en el nativo y en el shell | Las ramas con efectos devuelven "no observado" en sombra (D40) |

## Migration

- `render --apply` de este repo pasa a ser nativo cuando E2 se integra: es la primera vez que
  `navori-rust` escribe `.codex/` y `.pi/` en un repo real. El primer apply se hace sobre un worktree
  limpio y se compara contra el TS con `git diff --exit-code` antes de aceptarlo.
- Los hooks entran en `shadow` con un `navori render --apply` del TS en E1. No cambia ningún comando
  registrado, así que no hace falta volver a aprobar el trust de Codex.
- `NAVORI_HOOK_IMPL=shell` sigue siendo la salida de emergencia para los cinco hooks (D7 de 0057).

## Testing strategy

- **Hooks (R50, R51, R54, R55).**
  - Replay `--impl rust` por hook y engine, con auditoría `off` y `active`.
  - Fuzz con gramática por hook: comandos `git` (`quality-gate-pre-commit`), payloads `Agent` y
    `spawn_agent` con aperturas `workplan:`/`nivel-0:`/`spec:` (`plan-gate`), fuentes de
    `SessionStart` (`session-start-context`), modelos y scratchpads (`model-advisor`).
  - `native-hook-failclosed.test.ts` sobre los dos hooks con compuerta.
  - `bench-hooks --impl rust` para R55.
  - Un test por modo diferido que comprueba exit 3 sin haber leído stdin.
- **Subcomandos (R56–R59).** Casos del oráculo por fixture, con estado en `.navori/state/` y
  `~/.navori/`. Corpus de `plan gate` reproducido como casos de subcomando (stdin del payload). Test
  de versión distinta con un `navori` falso en `PATH` (R53). Test del worker (D34).
- **Render (R62–R69, R19).**
  - Fixtures nuevos: `prose-engines` (`agents-md`, `cursor`, `copilot`), `multi-engine`
    (`claude`, `codex`, `pi` con contenido de usuario en `AGENTS.md`), `pi-controls` (todos los
    controles, `publisher`, `scout`, `qualityGate.fast`), `pi-mcp` (plugins MCP), `pi-foreign`
    (`.pi/extensions/navori.ts` editado por el usuario) y `codex-untrusted` (pista de trust).
  - Snap `pi` en `golden-render-tree` (solo en `migration/rust`, archivo nuevo de snapshot).
  - Propiedades `canonicalJson` y `codexHookHash` contra Node.
  - `gen-pi-extension-asset.mjs --check` y su test de mutación (una línea cambiada en la fuente
    pone el check en rojo).
  - Matriz anti-rollback de 0058 sobre los markers de `.codex/config.toml` y `AGENTS.md`.
  - `rust-tree.test.ts` (D39).

## Plan de entregas

### E1 — Hooks de sesión en sombra (→ `migration/rust`; tras #1432)

- **M1 —** Base compartida: parciales a `shell` (D32), fase por modo y diferir por modo (D31), hecho
  de versión con caché (D30) y corpus ampliado (D35).
- **M2 —** `quality-gate-pre-commit` y `gate probe` nativos.
- **M3 —** `plan-gate` y `plan gate` nativos.
- **M4 —** `session-start-context`, `subagent-stop-handoff` y `model-advisor`, con
  `tools session-context`, `tools notice` y `dominio inject`. Los cinco hooks en `shadow`.

### E2 — Render multi-engine (→ `migration/rust`; tras 0058 E3)

- **M5 —** Engines de prosa y orquestación multi-engine (D36).
- **M6 —** Codex (D37).
- **M7 —** Pi: asset derivado (D29) y propiedad (D38).
- **M8 —** `render`, `sync`, `remove --yes` y `adopt` con `when.engines` ampliado; R19 (D39).

### E3 — Activación de los hooks de sesión (→ `migration/rust`; tras E1, la ventana de sombra y 0058 E1)

- **M9 —** Evidencia por hook y engine (R60) y activación de los que la cumplen; los demás, a la fase
  4 (R61).

**Por qué este orden.**

- E1 no depende del render y su ventana de sombra es lo más lento de la fase, así que arranca
  primero.
- Dentro de E1, `quality-gate-pre-commit` va antes porque es el único hook de cada tool call y es el
  que más ahorra.
- E2 espera a 0058 E3 porque reutiliza su capa `Fs`, el inventario de paths propios y los comandos con
  escritura.
- E3 necesita las herramientas de activación de 0058 E1 (transiciones del manifiesto y reporte por
  engine).

## NOT in scope

- `audit` (incluido `--capture-child`), `gate foreign`, `gate` sin `probe`, `plan resume`,
  `handoff check` y `codex *`: siguen en el TS; los hooks los llaman como subproceso (fase 4).
- Los hooks de la cola larga (`managed-drift-watch`, `routing-watch`, `bash-outcome-watch`,
  `role-guard`, `comment-draft-confirm` y los demás): fase 4.
- Que la extensión Pi llame a `navori-rust` en lugar de `navori`. La extensión ejecuta `navori plan
  gate` y `navori handoff check` (`runNavori`), que hasta el corte son el TS.
- Monorepos con workspaces, `render --all`, `--workspace`, `--prune` y `--verbose`: fase 4 (Q8 de
  0058).
- Prompts interactivos (D16 de 0057; R48).
- E-Pi en `dev` y convertir el asset Pi en plantilla editable (Q14; fase 4).
- Corregir o mejorar comportamiento al portar.

## Observaciones sobre requirements

- **R17** pide p95 ≤ 5 ms por hook portado. No es alcanzable en las ramas que ejecutan `git`, el
  quality gate o el `navori` de `PATH` (D30). R55 lo precisa: 5 ms en la ruta sin procesos externos
  de `quality-gate-pre-commit`, y "más rápido que el shell" en el resto.
- **R19** se redeclara con la misma intención que la fila de la fase 3 ("mismas pruebas de
  aceptación que en TS"). D39 la satisface por igualdad de árbol en lugar de re-ejecutar las suites
  con otro renderer. Si el usuario exige re-ejecutarlas, hace falta un helper común en `dev` (Q16).
- **R60** cambia el umbral de D9 para los hooks de sesión. Es un cambio del programa que el usuario
  aceptó (Q15).

## Decisiones del usuario (2026-10-27)

| Q | Decisión |
|---|---|
| Q14 | Asset derivado (D29) en lugar de E-Pi; se enmiendan la fila de la fase 3 de 0057 y D11 |
| Q15 | Umbral por clase de evento (D35): 500 / 100 / 30 |
| Q16 | R19 por igualdad de árbol más humo de carga (D39) |
| Q17 | Tres PRs (E1, E2, E3) contra `migration/rust`, con la rama actualizada entre cada uno |
| Q18 | Toda la fase sin subagentes; sin challenge del `auditor`; revisión independiente en cada PR |
| Q19 | (2026-10-28) Sombra solo en las ramas sin efectos y user-section de plantilla (D40) |

## Preguntas (resueltas)

- **Q14 [human] — E-Pi.** Sustituir el refactor en `dev` (D11 de 0057) por el asset derivado de D29,
  y dejar la plantilla editable para la fase 4. Recomendación: sí. Si se acepta, se enmienda la fila
  de la fase 3 en `specs/0057-migracion-rust/requirements.md` y D11 recibe una nota que remite a D29.
- **Q15 [human] — Umbral de sombra.** (a) Por clase de evento como en D35 (500/100/30); (b) 500 para
  todos y esperar; (c) modo por engine en el manifiesto (cambio de esquema). Recomendación: (a).
- **Q16 [human] — R19.** Igualdad de árbol más humo (D39), o re-ejecutar las suites con el render
  Rust, lo que exige un helper común en `dev`. Recomendación: igualdad de árbol.
- **Q17 [human] — Número de PRs.** Tres (E1, E2, E3) o dos, con la activación en la fase 4.
  Recomendación: tres.
- **Q18 [process] — Challenge pendiente.** El `auditor` de spec-bootstrap no pudo correr. Debe
  correr sobre este diseño antes de despachar el primer `implementer` de E1, y sus hallazgos se
  incorporan aquí.

## Durable knowledge

- **Engram:** "la extensión Pi en Rust es un asset derivado del `dist` del TS, con un solo marcador
  (`mcpPluginIds`)"; "un hook nativo solo corre subcomandos en proceso si el `navori` de `PATH` tiene
  la versión del checkout"; "diferir solo es posible antes de leer stdin".
- **CONTRIBUTING (`migration/rust`):** regenerar el asset Pi al sincronizar `dev`
  (`node scripts/js/gen-pi-extension-asset.mjs`).
