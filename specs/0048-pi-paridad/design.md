# Pi paridad — Design

**Estado:** revisión 2 del architect. Incorpora R18, las decisiones del usuario D-U1..D-U4 y el challenge
`challenge_0048-pi-paridad.md` (F1–F18) según el veredicto del orquestador. Sin veredicto propio. Abrir este
diseño no autoriza workplans de entrega, implementación ni publicación.
**Base verificada:** `origin/dev` = `HEAD` = `e7596c35` (`git ls-remote origin dev`, 2026-10-11). Todas las
afirmaciones "ya existe" se leyeron en ese árbol. Documentación de Pi: paquete instalado
`@earendil-works/pi-coding-agent` **1.1.0** (`~/.pi/agent/install/releases/1.1.0/…`, mismo pin que el
devDependency de `packages/cli`): `docs/extensions.md`, `security.md`, `mcp.md`, `skills.md`, `windows.md`,
`environment-variables.md`, `dist/core/extensions/types.d.ts`, `dist/core/tools/bash.js`,
`dist/utils/shell.js` y `dist/core/agent-session-runtime.js`, consultados el 2026-10-11.
**Señales:** contrato compartido (scripts de hooks, permisos y política destructiva para tres engines), área
crítica (hooks, deny/ask, render/prune en el repo del usuario, marcadores gestionados), migración (manifiesto
Pi, versión mínima de Pi) y ≥2 enfoques genuinos para el mecanismo de bloqueo.

## Approach

### Lo que ya existe (evidencia)

- **Runtime Pi.** `PI_EXTENSION_SOURCE` (`packages/cli/src/engines/pi/extension-source.ts`) ya intercepta
  `tool_call` (aprobación `--approved-by` vía `requireOperatorApproval`, bloqueo Markdown del implementer),
  `tool_result` (`recordEvidence`, `stuckAdvice`), `session_start` (`injectContext`) y `before_agent_start`
  (línea de master-plan). Ya invoca la CLI `navori` con `runNavori` para `plan gate` y `handoff check`
  (`checkDispatch`). No hay manejador de fin de sesión ni de fin de corrida. `runChild` aplica un único
  `TIMEOUT_MS` de 600 s a cualquier hijo.
- **Scripts de hooks, una sola fuente para dos engines.** Codex copia los mismos assets de
  `packages/core/core-assets/hooks/` a `.codex/hooks/` (`hookRequest` en `engines/codex/index.ts`) y los
  registra desde `CODEX_HOOK_REGISTRATIONS` (`engines/codex/hook-registrations.ts`). La identidad del engine
  la decide el script por la ruta `$0` (`_partials/hook-input.sh`, `comment-draft-confirm.sh`,
  `pr-publisher-confirm.sh`, `master-accept-confirm.sh`, `_partials/gate-ask.sh`), nunca por el payload.
  `renderManagedFile` expande `# navori:include` (`expandHookIncludes`) e interpola `{{shq:…}}` y `extraVars`
  (precedente: `rolePolicy` de `role-guard`).
- **Política destructiva.** `guard-destructive.sh` es el único lugar de los bloqueos duros y de la
  reescritura por shell de archivos gestionados (`managed_path`, reglas 6/6b, solo `>`, `sed -i` y `tee`).
  Sus segmentos y su esqueleto de contenido inerte viven en línea dentro del script.
- **Permisos.** `collectShellPermissionRules` (`engines/shared/permission-rules.ts`) es la fuente única de
  `ask`/`deny` (base `core-assets/settings/settings-base.json` más `settingsFragment` de plugins). Claude los
  escribe en `settings.json`; Codex los traduce con `buildCodexRules`/`translatePattern`
  (`engines/codex/build-rules.ts`) a prefijos de tokens, con estrechamientos documentados
  (`NARROWED_PATTERN_FAMILIES`). La lista `deny` incluye `sudo rm *`, `mkfs*` y `engram delete *`, que
  `guard-destructive.sh` no cubre.
- **Gate.** `quality-gate-pre-commit.sh` dispara solo con `git commit` (`TRIGGER_RE`/`TRIGGER_TOKENS`); el
  caso `push` aparece solo como ejemplo en su `user-section`. El gate escribe por stdout.
- **Drift.** `managed-drift-watch.sh` avisa con `exit 2` más stderr, sin JSON, y su lista de raíces no
  incluye `.pi/`.
- **Inventario.** `OVERLAP_ROWS` (`engines/shared/native-overlap.ts`) tiene una fila por unidad, incluidas
  las `permission-rule`, con columna `engines.pi` fijada en `"unsupported"` por `support()`. `CODEX_PARITY`
  (`engines/shared/codex-parity.ts`) es el precedente de tabla por unidad, con `missingParityUnits`.
- **Plugins.** `renderPiEngine` construye `AdapterCtx` con `plugins: []`. Codex ya proyecta skills
  (`composeCodexSkill`), prosa de agentes (`buildAgentToml`), prosa de orquestador
  (`buildAgentsMdRequest`), bloques `managed` (`includePluginBlocks: true`), scripts, hooks
  (`resolvePluginCodexHooks`) y `hookExtensions` (`engines/shared/hook-extension.ts`).
- **Handoffs.** `checkHandoff` (`lib/handoff/check.ts`) valida forma y existencia, no frescura;
  `lib/handoff/review-evidence.ts` (`beginReview`, `sealReview`, `checkSealedEvidence`) ya da estampas con
  nonce y sello para el reviewer.
- **Anti-downgrade de Pi.** `ownsPiManifest` (`engines/pi/owned-file.ts`) solo reconoce `schemaVersion: 1`, y
  `renderPiEngine` no escribe ningún recurso Pi si uno colisiona (`collided`).
- **Pi 1.1.0 (nativo).**
  - No tiene sistema de permisos (`security.md`). La confirmación nativa es `tool_call` + `ctx.ui.confirm`
    (`extensions.md`, "Tool exposure"), y un fallo de un handler `tool_call` bloquea la herramienta.
  - Las llamadas anidadas (`ctx.executeTool`, codemode) pasan por `tool_call`/`tool_result`.
  - Los handlers corren en orden de carga y reciben el mismo `input` mutable, así que una extensión cargada
    después puede cambiarlo.
  - Eventos: `session_shutdown` (`reason: quit|reload|new|resume|fork`, esperado con `await` en
    `AgentSessionRuntime.dispose`/`teardownCurrent`, también en hijos `--no-session`), `turn_end` (por cada
    petición al modelo) y `agent_before_settle` (frontera final; añade entradas sin `continue`).
  - `getShellConfig` se exporta y resuelve Git Bash en Windows, pero cae a `sh` si no hay bash.
  - En Windows, `defaultTools` puede reemplazar `bash` por `powershell` (`windows.md`).
  - Los tools MCP se llaman `mcp__<server>__<tool>`, y `-`/`_` equivalen en el nombre del servidor.
  - El bash integrado no tiene `run_in_background`, pero corre `detached` y retorna sin esperar descendientes
    (`bash.js`), así que `cmd &` sobrevive a la llamada.

### Decision drivers

Derivados de `docs/DIRECTION.md` (source of truth, multi-engine), del `CLAUDE.md` del repo (áreas críticas,
simple > clever), de los límites y decisiones de usuario de 0048 y de la doctrina de 0047/0039:

1. **Una sola fuente de política** por resultado (R16).
2. **Comportamiento idéntico para Claude/Codex** (D-U1, F6). Sus bytes pueden cambiar; toda conducta nueva
   de Pi va en el brazo `pi`. La única excepción la decidió el usuario: D-U2.
3. **Resultado sobre número de hooks**, con una frontera honesta: `enforced (seatbelt)` no es un sandbox
   (F11).
4. **Fail-closed para lo `enforced`, fail-open para lo `advisory`** (R15), sin falsos bloqueos por ruido
   (F4/F5).
5. **Nativo primero**: `tool_call`/`ui.confirm`/`session_shutdown`/`setActiveTools`/IPC de Node.
6. Menor maquinaria nueva; reversibilidad.

### Opciones (mecanismo de bloqueo, R2–R6, R8, R18)

- **A — "Hook bridge": la extensión ejecuta copias Pi de los scripts compartidos con un payload adaptado.**
  - *Pros:* una sola fuente literal; reutiliza más de 1 000 líneas de política probadas, sus tests y los
    `hookExtensions`; precedente Codex.
  - *Contras:* requiere bash; hay que acotar la latencia del spawn por script (F17, se mitiga con
    concurrencia); una tabla de bindings más.
  - *Reversión:* barata.
- **B — Reimplementar la política en TS dentro de la extensión.** Descartada: duplica guard, gate,
  confirmaciones y permisos. Rompe R16 por construcción.
- **C — Módulo de política TS compartido vía CLI para los tres engines.** Descartada para esta spec: migra los
  hooks de Claude/Codex y cambia su comportamiento ante fallos; además paga el arranque de Node por llamada.
- **A′ — Ejecutar `.claude/hooks`/`.codex/hooks` si existen.** Descartada: Pi-only quedaría sin guardas.

**Recomendación: A.**

## Components

- `engines/pi/hook-bindings.ts` (**nuevo**, hermano de `CODEX_HOOK_REGISTRATIONS`): `PI_HOOK_BINDINGS`, una
  fila por script que Pi ejecuta. Cada fila declara evento Pi, herramientas, alcance (`parent|child|all`),
  clase (`enforced|advisory|lifecycle`), timeout, `interactive` (puede pedir `ask`) y `when(config)`. Es la
  única fuente de qué se instala en `.pi/navori/hooks/` y de qué entra al manifiesto. — **R2–R11, R15, R18.**
- `engines/pi/bridge-source.ts` (**nuevo** fragmento de `PI_EXTENSION_SOURCE`):
  - construye el payload, exige bash (D2) y ejecuta en paralelo los scripts no interactivos (F17);
  - mapea la salida según el contrato y serializa las confirmaciones con un mutex;
  - resuelve los `ask` con `requireOperatorApproval`, ampliado con el hash del contenido (D5);
  - emite el relay al padre por IPC (D6).
  — **R2, R4–R6, R8–R11, R15, R18.**
- `PI_EXTENSION_SOURCE` (`extension-source.ts`):
  - conecta el bridge a `tool_call`, `tool_result`, `agent_before_settle` y `session_shutdown`;
  - añade el carril de escrituras gestionadas por `edit`/`write` (D4);
  - comprueba al arrancar que no haya `powershell` ni extensiones ajenas (D10, D4);
  - valida el handoff con frescura (D7) y aplica plazos por rol (D9);
  - recibe el relay IPC del hijo (D6) y amplía el roster.
  — **R3, R6, R7, R9–R11, R14, R15.**
- `engines/pi/index.ts`:
  - `buildAdapter.placeHook` hacia `.pi/navori/hooks/<id>.sh`, con `extraVars` de permisos (D11);
  - `ctx.plugins` reales (D13) y diagnóstico MCP (D14);
  - manifiesto v2 con `ownedPaths` (D4);
  - `piOwnershipVerdict` y roles nuevos.
  — **R1, R3, R12–R14, R16, R18.**
- `engines/pi/owned-file.ts` (`PiManifestPayload`, `serializePiManifest`, `ownsPiManifest`):
  `schemaVersion: 2` con `hooks`, `ownedPaths` y `permissionRules`. — **R2–R11, R15, R18.**
- `engines/pi/runtime-version.ts` (`MIN_PI_VERSION`, `createRuntimeCheck`, `ADMITTED`): piso 1.1.0, manejo
  de prerelease y de cota superior, reutilizando `verifiedFrom` (D10). — **R15.**
- `engines/shared/pi-parity.ts` (**nuevo**, hermano de `codex-parity.ts`): `PI_PARITY` y
  `missingPiParityUnits`. `OVERLAP_ROWS` deriva `engines.pi` de él. — **R1.**
- `engines/shared/permission-rules.ts`: `translatePattern` sale de `codex/build-rules.ts` hacia aquí como
  `translateShellPattern`, compartido por Codex y Pi; la salida de Codex no cambia. — **R2, R16, R18.**
- `engines/shared/engine-capabilities.ts` (`ENGINE_CAPABILITIES.pi`):
  - `handoff-shape` pasa a `enforced`;
  - `claude-hook-parity` remite a `PI_PARITY`;
  - se retira `additional-analytic-roles`;
  - `analyticWriteTools.pi` refleja auditor y architect;
  - nuevas `runtimeAdmissions` (`session-end-event`, `settle-boundary-entries`, `child-ipc-relay`,
    `active-tools-control`);
  - nueva variante `RenderEvidence { kind: "extension-hook"; script; event }`.
  — **R1, R6, R7, R10, R11, R14, R15.**
- Assets compartidos: cambian bytes, no el comportamiento Claude/Codex salvo D-U2 (D3):
  - `_partials/hook-input.sh`: brazo `pi`;
  - `_partials/audit-log.sh`: host `pi`;
  - `guard-destructive.sh`: brazo `pi` con plano de control, permisos y `pi --no-extensions`;
  - `quality-gate-pre-commit.sh`: `push` en el brazo `pi`;
  - `pr-publisher-confirm.sh`: brazo `pi`;
  - nuevo partial `_partials/draft-body.sh`, extraído de `comment-draft-confirm.sh`;
  - `managed-drift-watch.sh`: raíces `.pi/` en el brazo `pi`;
  - `worktree-reclaim.sh`: preservación de estado ignorado en el brazo `pi`;
  - `subagent-no-background.sh`: carril de shell para todos, D-U2;
  - `agents/architect.md` y `conditionOrchestration` (`lib/render/render-plan.ts`): clave reservada `onPi`.
  — **R2–R5, R8–R10, R14, R16, R18.**
- `lib/diagnose/health.ts` (`ENGINE_OUTPUTS.pi`) y `commands/render.ts` (`applyPiOwnership`): `.pi/navori/**`
  entra al escaneo de drift y al prune. — **R3, R9, R12.**
- `engines/shared/hook-extension.ts` (`hookExtensionTarget`): destino `"pi"`. — **R12.**
- `engines/shared/prose-harness.ts` (`renderProseFile`, `buildHarnessProse`): Pi escribe `AGENTS.md` con
  `engine: "pi"` e `includePluginBlocks: true`. — **R12, R13.**
- `commands/handoff.ts`, `lib/handoff/check.ts` y `lib/handoff/review-evidence.ts`: validación con frescura
  (D7). — **R7.**
- `commands/doctor.ts`: diagnóstico de versión de Pi no verificada, `powershell` como herramienta por
  defecto y extensiones Pi ajenas. — **R15.**
- `docs/pi.md` (matriz, tabla generada desde `PI_PARITY`, clases de bypass, contrato del bridge, latencia,
  resultado en vivo) y `specs/0048-pi-paridad/evals.md` (RED/GREEN). — **R1, R17.**
- Tests en `engines/pi/__tests__/` y `engines/shared/__tests__/` (ver Testing strategy). — **R1–R18.**

## Decisions

### D1 — Hook bridge sobre copias Pi de los scripts compartidos (R2–R6, R8, R16, R18)

Pi instala solo los scripts con binding, en `.pi/navori/hooks/<id>.sh`. Los scripts de plugin van a
`.pi/navori/scripts/<dest>`. Se usa el mismo `placeHook`/`renderManagedFile` que Codex: mismo asset, mismos
includes, mismo marcador, mismo backup y prune. Cada copia conserva su `user-section`; las reglas propias en
`.claude/hooks/` no aplican a Pi, como ya pasa en Codex.

En `tool_call(bash)` todos los scripts con binding corren **concurrentemente** (F17): guard (que incluye
permisos), `subagent-no-background`, hooks de plugin, el gate y los scripts de confirmación. El primer `block`
gana y mata a los demás (grupo de procesos). Los `ask` se acumulan y se resuelven al final con **una**
confirmación que muestra todas las razones, el comando exacto y el contenido a publicar.

### D2 — Contrato de payload e identidad por ruta (R2–R5, R15, R16)

- **Payload.** El bridge envía el subconjunto Claude que los scripts ya leen: `hook_event_name`, `tool_name`
  (`Bash|Edit|Write`), `tool_input`, `cwd`, `session_id`, `permission_mode` y, en hijos,
  `agent_id`/`agent_type`. No simula `CLAUDE_PROJECT_DIR` ni `CLAUDE_CODE_*`.
- **Identidad.** `_partials/hook-input.sh` gana el brazo `*"/.pi/navori/"*) nv_engine=pi`, que resuelve
  `nv_project_dir` desde `cwd` como Codex. Los branches existentes comparan `= codex`, así que `pi` hereda la
  semántica Claude; toda conducta nueva va en `[ "$nv_engine" = pi ]`.
- **`permission_mode`.** Vale `default` solo en el padre con UI y `dontAsk` en el resto. Así
  `navori_can_ask` bloquea por sí mismo donde no hay a quién preguntar.
- **Shell fijo (F3, D-U3).** El bridge usa `getShellConfig()` **sin** `shellPath` y exige que lo resuelto sea
  bash: con el fallback a `sh`, o sin bash, los bindings `enforced` bloquean con la acción de `windows.md`. Nunca
  lee `shellPath` de `.pi/settings.json`; el modelo no elige el shell que evalúa sus propios comandos. La ruta
  del script se pasa con `/`.
- `stop-verify-reminder.sh` se invoca sin argumentos (elige engine por `argv`).

### D3 — R16: comportamiento idéntico para Claude/Codex; los bytes pueden cambiar (R16, D-U1)

R16 se cumple así: "comportamiento idéntico para Claude/Codex; los bytes pueden cambiar (D-U1)". Dos
garantías:

1. Activar Pi no cambia ningún output de Claude/Codex: render(X) ≡ render(X+pi), porque Pi escribe solo bajo
   `.pi/` y `.agents/skills`/`AGENTS.md` siguen con un único escritor.
2. La evolución de los assets compartidos cambia bytes de los hooks de Claude/Codex, pero su conducta queda
   detrás de `nv_engine = pi`. Lo verifica un corpus diferencial (Testing strategy).

La única excepción es D-U2 (D12), decidida por el usuario. Los goldens (`claude.snap`, `codex.snap`) se
actualizan de forma explícita y se revisan como "solo bytes". Los trusted hashes de Codex dependen del
comando registrado (`codexHookCommand`), no del contenido, así que no se desaprueban.

### D4 — Archivos gestionados y plano de control (R3, R16, F3, F13)

- **Bash, en `guard-destructive.sh`.** Fuente única; las reglas nuevas solo en el brazo `pi`:
  - `managed_path` añade nombres exactos de Navori: `.pi/extensions/navori.ts`, `.pi/navori.json`,
    `.pi/navori/` y `.pi/agents/<rol>.md` solo para los roles de `ROLE_TOOLS`. Un `.pi/agents/*` del usuario
    no se toca.
  - **Plano de control:** `.pi/navori/**`, `.pi/extensions/**`, `.pi/settings.json` y `.pi/navori.json`
    quedan protegidos contra cualquier verbo de escritura (`>`, `>|`, `tee`, `sed -i`, `rm`, `mv`, `cp`,
    `ln`, `dd`, `install`, `truncate`, `chmod`, `git checkout|restore --`) y contra intérpretes en línea
    (`python -c`, `node -e`, `perl -i`, `ruby -e`) que nombran esas rutas.
  - Bloquea los `pi` lanzados desde bash con `--no-extensions`, porque arrancan un agente sin guardas.
  - El mensaje nombra `navori render --apply`/`navori sync` y, para el plano de control, "edítalo fuera del
    agente".
- **`edit`/`write` de Pi: carril TS en la extensión.**
  1. Normaliza la ruta como Pi: quita `@`, expande `~`, resuelve contra `cwd` y normaliza espacios unicode.
  2. Bloquea siempre las rutas del plano de control y las de `ownedPaths` del manifiesto (destinos
     gestionados aunque aún no existan, F13c).
  3. Para archivos mixtos (`AGENTS.md`, skills) analiza la gramática real de marcadores: inicio/fin
     anclados a línea y balanceados, constantes inyectadas desde el TS que la define, nunca subcadena (F13a).
     `write` se bloquea si el archivo tiene un bloque gestionado; `edit`, si algún `oldText` cae dentro de
     un bloque. El `user-section` sigue editable.
  4. Una forma de `edits` no reconocida sobre esos destinos se bloquea (F13b). Un archivo cuyo marcador
     borró el usuario ya no es de Navori (frontera declarada).
  **UNVERIFIED:** si `tool_call.input` llega ya preparado (`prepareEditArguments`) o crudo. El carril acepta
  ambas formas y bloquea lo demás.
- **Extensiones ajenas (F3).** Los handlers corren en orden de carga y un handler posterior puede mutar
  `input`. Mitigación:
  - En `session_start`, el padre lista `.pi/extensions/` y las entradas `extensions` de la configuración
    del proyecto y avisa una vez por sesión si hay otras extensiones de proyecto; `navori doctor` lo
    diagnostica.
  - En `tool_execution_start`, el bridge compara los argumentos ejecutados con los evaluados (por
    `toolCallId`); si difieren, avisa y lo registra. Es solo detección: Pi no permite bloquear ahí.
- **Tests de deriva.** `managed_path` (pi), las raíces de `managed-drift-watch.sh` (pi) y `ENGINE_OUTPUTS`
  se cruzan en un mismo test.

### D5 — Gate, confirmaciones y vínculo al contenido (R4, R5, F2, F12)

- **Gate.** `quality-gate-pre-commit.sh` es un binding `enforced`. En el brazo `pi` su conjunto de disparo
  añade `git push`, con la misma normalización que `commit`; Claude/Codex siguen solo con commit (F2). Sin
  `qualityGate.fast` no hay binding (igual que Claude y Codex), y la matriz lo declara.
- **Fuentes de confirmación (R5).**
  - `comment-draft-confirm.sh`: comentarios, reviews, `gh issue create`, `acli`.
  - `master-accept-confirm.sh`: `navori master part --approved-by`, `navori master close`.
  - `pr-publisher-confirm.sh`: su brazo `pi` pide `ask` siempre, antes del "allow" de subagente que la rama
    Claude conserva.
  - El lector de borradores pasa de `comment-draft-confirm.sh` a `_partials/draft-body.sh`, compartido; Claude
    no cambia de conducta.
- **Ruta del cuerpo (pi).** En el brazo `pi`, el JSON `ask` añade la clave de nivel superior
  `navoriBodyFiles: [ruta…]`, que Claude nunca ve.
- **Vínculo al contenido (F12).** `requireOperatorApproval` toma su instantánea (HEAD, status, diff) más el
  `sha256` de cada `navoriBodyFiles` al mostrar el diálogo y lo recalcula justo antes de devolver "allow".
  Cualquier cambio → `block` con "pide la aprobación de nuevo". Queda una ventana residual entre el retorno
  del handler y el `exec`; se declara. Reescribir el comando hacia una copia del cuerpo se descartó porque
  muta texto de comandos.

### D6 — Relay determinista del hijo al padre por IPC (R6, R18, F8)

- **Canal.** Los hijos se lanzan con un canal IPC de Node (`stdio: [..., "ipc"]`). Cuando un binding o una
  regla `ask` se resuelve en un hijo, la extensión del hijo bloquea la herramienta con "devuelto al padre" y
  envía por `process.send` `{ kind: "parent-approval", command, reasons, bodyFiles }`. El comando sale del
  `input` del `tool_call`, nunca del texto del modelo.
- **Uso en el padre.** `runChild` acumula hasta 5 mensajes (≤ 8 KiB cada uno) y `navori_subagent` los
  devuelve en `details.parentApprovals` más una línea de contenido. Al ejecutarlo el padre, el bridge pide la
  confirmación normal.
- **Seguridad del canal.** El bash del modelo no hereda el descriptor IPC: Node solo pasa los fds de `stdio`
  declarados. El bridge borra `NODE_CHANNEL_FD` del entorno de sus scripts.
- **Probe (primera tarea de E2).** Que el proceso `pi` 1.1.0 preserve el canal IPC hacia la extensión.
- **Fallback decidido ahora.**
  1. Si el IPC no existe, el comando se toma de los argumentos estructurados `tool_execution_start.args` del
     JSONL, correlacionados por `toolCallId` con un `tool_execution_end` con `isError`. Nunca del texto.
  2. Si tampoco están, `navori_subagent` devuelve `isError` con "el hijo pidió aprobación del padre; comando
     no recuperable". La tarea nunca se reporta como éxito.

### D7 — Handoff validado con frescura (R7, F7)

Antes de lanzar un `implementer` o `reviewer`, `navori_subagent` registra la hora de dispatch y el `sha256`
de `impl_<feature>.json` / `review_<feature>.{md,json}`. Tras un hijo exitoso, la extensión corre
`navori handoff check <feature> --json`:

- **Implementer:** la validación `orchestrator` existente (`checkHandoff`), más la exigencia de que el
  archivo sea nuevo o haya cambiado de hash, más la advertencia `head` de `checkHandoff` promovida a fallo
  cuando el HEAD del handoff no coincide con el checkout.
- **Reviewer:** modo nuevo `--produced-by reviewer`. Exige `review_<feature>.md` no vacío, con
  `APPROVED|CHANGES_REQUESTED`; `review_<feature>.json` válido con `ReviewSidecarSchema`; y evidencia sellada
  (`checkSealedEvidence`) cuyo `startedAt` del stamp `beginReview` es posterior al dispatch. Un `APPROVED` de
  una ronda anterior falla.

Un fallo devuelve `isError: true` con el diagnóstico y el texto del hijo acotado. `feature` es obligatorio
para `implementer` y `reviewer`. La regla del veredicto queda en bash (Claude, advisory) y en TS (Pi); unos
fixtures comunes fijan ambas.

### D8 — Eventos de ciclo de vida (R9–R11, F1, F14)

- **R9 (drift).** `managed-drift-watch.sh` es un binding `advisory` en `tool_result` de `bash|edit|write` (padre
  e hijos). Su canal es `exit 2` + stderr (F1): para bindings `advisory` en `PostToolUse` el contrato
  convierte exit 2 en un aviso (stderr cabeza + cola, ≤ 1 KiB), añadido como bloque de texto con
  `structuredContent` conservado.
  - En el brazo `pi`, el script añade las raíces `.pi/navori` (hooks con marcador shell) y usa un stamp propio
    (`managed-drift-stamp-pi`), para no consumir el reporte de una sesión Claude concurrente.
  - Los recursos `navori:managed-file` (`.pi/agents`, extensión, manifiesto) no tienen hash por bloque: los
    protege D4, y `navori doctor`/render reporta su modificación.
- **R10 (cierre).** `session_shutdown` solo en el padre: sin `NAVORI_PI_CHILD_DEPTH` y con sesión persistente.
  Se ignora en hijos `--no-session` (F14a). Solo `reason ∈ {quit, new}`; `resume`/`fork` no cierran la
  sesión y `reload` tampoco (F14b).
  - Presupuesto total 15 s: `worktree-reclaim.sh` ≤ 12 s, luego `audit-mode-close.sh` ≤ 3 s, con payload
    `SessionEnd` (`quit` → `prompt_input_exit`, `new` → `clear`).
  - El reclaim solo corre si existe `.claude/worktrees`. Pi no crea worktrees: los crean sesiones Claude o el
    usuario. Sin ese directorio, la mitad de reclaim es `n/a` y se declara.
  - En el brazo `pi`, el script además excluye todo worktree con archivos ignorados bajo `.navori/state/`
    (handoffs, evidencia), porque `git worktree remove` los descartaría (F14c). El resto de la barra no
    cambia: limpio, con upstream y PR mergeado.
  - Un `SIGKILL` no dispara el evento; el siguiente cierre barre.
- **R11 (recordatorio).** "Turno" se mapea a la corrida del agente (`agent_before_settle`). `turn_end` dispara
  por cada petición al modelo y repetiría el aviso. Con `hooks.verifyOnStop`, `stop-verify-reminder.sh` corre
  en el padre; su texto entra como `custom_message` visible, sin `continue`.

### D9 — Roles nuevos y plazos por rol (R14, F10)

`ROLE_TOOLS` se genera desde una sola constante TS para `index.ts` y para el source:

| Rol | Herramientas | Plazo del hijo |
| --- | --- | --- |
| scout | `read, grep, find, ls, write` | 10 min |
| scribe | `read, grep, find, ls, bash, edit, write` | 10 min |
| reviewer | `read, grep, find, ls, bash, write` | 20 min |
| auditor | `read, grep, find, ls, bash, write` | 20 min |
| architect | `read, grep, find, ls, bash, write` | 20 min |
| implementer | `read, grep, find, ls, bash, edit, write` | 30 min |
| publisher | `read, grep, find, ls, bash` | 40 min |

- **Plazos.** Invariante con test: plazo del rol ≥ timeout del gate (600 s) + 10 min para los roles que pueden
  hacer commit o push (implementer, publisher). El tiempo del gate corre dentro del plazo del hijo (F10).
- **Sin web en hijos.** Pi no trae herramientas web: `WebFetch`/`WebSearch` son `unsupported` en hijos.
- **Architect.** Su despacho anidado (`Agent(scout, scribe)`) queda bajo `navori:if-not onPi`; el flujo
  `nested-agent-dispatch` declara Pi `unsupported`.
- **Plugins MCP.** Su prosa no se inyecta en hijos (`--no-mcp`); `mcpRoleDiagnostics` los nombra.
- **Publisher.** `git commit`/`git push` corren el gate dentro del hijo (R4). `gh pr create`, los comentarios y
  las reglas `ask` (R18) se rechazan en el hijo y vuelven por D6.

### D10 — Versión no verificada, `powershell` y arranque (R15, D-U3, F16)

- **Piso.** `MIN_PI_VERSION` pasa a `1.1.0`, y los bindings y eventos nuevos se declaran como `runtimeAdmissions`
  con `verifiedFrom` (sin un segundo mecanismo de gate).
- **Parser de versión.** `parseStableVersion` acepta prerelease (`x.y.z-tag`) y lo trata como **no
  verificado**. Una versión mayor que la mayor `verifiedFrom` probada sigue admitida mientras no se publique una
  incompatibilidad; esa cota superior se declara explícitamente en `docs/pi.md`. Una versión no parseable no
  se verifica.
- **Versión no verificada.** La extensión registra un único `tool_call` que bloquea `bash`, `edit`, `write` y
  `powershell`, y deja activos `read`, `grep`, `find` y `ls`. Muestra el diagnóstico una vez por sesión
  (`ctx.ui.notify` o un `custom_message`) y en cada bloqueo da una razón corta. `navori doctor` reporta la
  versión. No registra `navori_subagent`.
- **`powershell`.** Se trata en `session_start` (padre e hijos): si está activa, se quita con
  `pi.setActiveTools` y se avisa una vez con la acción para usar Git Bash. Si reaparece, el `tool_call` la
  bloquea. `navori doctor` detecta `defaultTools` con `powershell`.

### D11 — Inventario R1: tabla de paridad Pi, con permisos y piezas de plugin (R1, F9)

No se extiende `ControlId`, porque mezclaría resultado y unidad. `PI_PARITY` tiene una fila por unidad
`kind:id`:

- los 22 `HOOK_IDS`;
- todas las unidades `permission-rule` que ya existen en `OVERLAP_ROWS`: clases `class:bash-ask`,
  `class:bash-deny`, `class:allow-not-translated` y `class:prompt-amendment`, cada `dropped:` y cada
  `narrowed:`;
- por plugin empaquetado, cada subunidad de su manifiesto: `skills[]`, `hooks[]` por ordinal, `scripts[]`,
  `hookExtensions[]`, `managed[]`, `mcpServer`, `settingsFragment` y `prompts[]`.

Cada fila es `{ state, seatbelt?, mechanism, boundary }` o `{ control: ControlId }` cuando un control ya
declara el resultado. `state` ∈ `enforced|advisory|unsupported|n/a`; `n/a` exige razón (p. ej. `role-guard`,
`engram-write-guard`, `dropped:Agent(orchestrator)`, porque el roster Pi no tiene orquestador, y
`prompts[]`, que son del asistente de configuración e independientes de engine). Los `allow` de
`settingsFragment` (p. ej. `mcp__engram__*`) son `n/a`: Pi no traduce allow, como Codex.

**`enforced (seatbelt)` (F11).** Toda fila de política textual lleva `seatbelt: true` y en `boundary` la lista
de bypass: `sh -c`/`eval`/`xargs`/ofuscación, un script escrito y luego ejecutado, `pi --no-extensions`
fuera de la forma cubierta, tools MCP de escritura del padre (`mcp__github__*`) y extensiones ajenas que
mutan `input` después del handler. `docs/pi.md` las muestra como "enforced (seatbelt)" y cita
`security.md`.

`model-advisor` queda `unsupported`: su payload es el contrato Claude de `host-contracts.ts`, y en Pi el
modelo se elige con `/model` y se transmite a los hijos (0047 R17). `routing-watch` se evalúa con un probe en
E1; si emite su aviso con los payloads del bridge, entra como `advisory` en E3, y si no, queda `unsupported`
con el motivo observado.

### D12 — Backgrounding en subagentes (R8, D-U2)

`subagent-no-background.sh` es un binding `enforced (seatbelt)` solo en hijos. Por D-U2 el carril nuevo
aplica a **todos** los engines donde el script corre (Claude y Pi), sin brazo `pi`. Codex no registra el
script (`CODEX_HOOKS_WITHOUT_REGISTRATION`); su fila de `CODEX_PARITY` dice que el carril existe y Codex no lo
registra.

- **Qué bloquea.** El operador `&` al final de un segmento: no `&&`, `|&`, `>&`, `&>`, `2>&1`, ni el que está
  dentro de comillas, heredoc o un valor `-m`/`--body`. También `nohup`, `setsid` y `disown` como comando de un
  segmento.
- **Implementación.** El esqueleto de contenido inerte y la segmentación salen de `guard-destructive.sh` a
  `_partials/inert-skeleton.sh` (dos usuarios; se extrae porque copiar 1 000 líneas de lógica sensible es
  peor). Los bytes de `guard-destructive` cambian sin cambio de conducta, y el corpus diferencial lo fija.
  `guard-destructive` sigue tratando `nohup`/`setsid` como envoltorios benignos en su propio análisis.
- **Header del script.** Se reescribe: hoy dice que el `&` suelto queda "OUT OF SCOPE ON PURPOSE", y pasa a
  documentar el carril, sus falsos positivos evitados y D-U2.

### D13 — Proyección de plugins a Pi (R12)

`renderPiEngine` pasa `loadEnabledPlugins(config.plugins).loaded` (sin los nativos en Pi) a
`AdapterCtx.plugins`, con un escritor por destino:

| Unidad de plugin | Destino Pi | Con Codex activo |
| --- | --- | --- |
| skill sin `injectInto` | `.agents/skills/<id>/SKILL.md` | la escribe Codex |
| skill → skill | sub-bloque en `.agents/skills/<target>/SKILL.md` | la escribe Codex |
| skill → rol hijo, plugin sin `mcpServer` | anexo a `.pi/agents/<rol>.md` | Pi (archivo propio) |
| skill → rol hijo, plugin con `mcpServer` | no se inyecta; diagnóstico | igual |
| skill → `orchestrator.md` | sub-bloque en `AGENTS.md` si Pi escribe el contexto | lo hace Codex |
| `managed[]` | `AGENTS.md` con `includePluginBlocks: true`, `engine: "pi"` | lo hace Codex |
| `hooks[]` `PreToolUse`/`Bash` traducibles (gramática de `resolvePluginCodexHooks`) | `.pi/navori/scripts/<dest>` + binding | Pi (copia propia) |
| `hookExtensions[]` | sub-bloque en `.pi/navori/hooks/<id>.sh` | Pi (copia propia) |
| `settingsFragment.permissions.ask/deny` | entran a `permissionRules` vía `collectShellPermissionRules` (D11, R18) | Pi |

- **`agents-md` como dueño.** Si `agents-md` (sin Codex) es dueño de `AGENTS.md`, Pi no escribe ahí y avisa
  (`prosePluginBlocksOmitted`).
- **Copias por engine.** `.codex/scripts` y `.pi/navori/scripts` son copias ejecutables por engine, no
  contexto duplicado.
- **Escritura y prune.** Todo pasa por `collectPlan`/`commitWrites` y por `orphanScans` de Pi. Una
  transición Codex on→off o la desactivación de un plugin no poda archivos de Codex ni deja huérfanos (test).

### D14 — Diagnóstico MCP de solo lectura (R13, F15)

En render, por cada plugin con `mcpServer`, se busca un servidor cuyo nombre normalizado (`-` ≡ `_`) sea el
id del plugin:

- **Dónde.** En `${PI_CODING_AGENT_DIR:-~/.pi/agent}/mcp.json` y en `.pi/mcp.json`. El archivo del proyecto
  nunca cuenta como "configurado" sin más: en render no hay `ctx.isProjectTrusted` (solo existe en runtime,
  `trust-source.ts`), así que un servidor que solo está en `.pi/mcp.json` se reporta como "efectivo solo si
  confías en el proyecto (`/trust`)". La extensión del padre repite la comprobación en `session_start` con
  `ctx.isProjectTrusted()` y avisa una vez si el proyecto no es de confianza. Se aplica la precedencia documentada: el proyecto reemplaza; una entrada sin `command`/`url`/`type`
  solo cambia `enabled`.
- **Qué se lee.** Solo nombres y `enabled`; ningún valor se copia, registra ni muestra. Un error de parseo
  produce un mensaje fijo ("no se pudo leer `<ruta>`; revisa su JSON"), nunca `cause.message`.
- **Acción.** Si falta o está deshabilitado, se sugiere `pi mcp add <id> [-l] -- <command> <args…>`, con
  `--env KEY=<valor>` como marcador.
- **Alcance.** Es `advisory`. "Configurado" no es "conectado", y `--no-mcp`, `-builtin:mcp` o una extensión
  que reemplaza el MCP nativo no se detectan; se declara así. Navori no escribe ningún `mcp.json` ni registra
  servidores.

### D15 — Permisos compartidos en Pi: `deny` bloquea, `ask` confirma (R2, R18, D-U4, F9)

- **Fuente única.** `collectShellPermissionRules` (base más `settingsFragment`), traducida con
  `translateShellPattern`, la misma traducción y los mismos estrechamientos que Codex.
- **Render.** Las reglas `Bash(…)` `ask`/`deny` se renderizan como prefijos de tokens en la copia Pi de
  `guard-destructive.sh` (`extraVars.piPermissionRules`, JSON-escapado en render) y en el manifiesto, para
  `PI_PARITY` y `doctor`. Las copias Claude y Codex reciben la variable vacía.
- **Evaluación.** En el brazo `pi`, el guard compara cada segmento que ya calcula contra los prefijos:
  - `deny` → `exit 2`, con la regla y "no hay ruta";
  - `ask` → JSON `ask` con la regla.
  La segmentación sigue siendo la del guard, sin un parser TS paralelo.
- **Resolución.** Padre con UI → una confirmación (D1/D5). Hijo o sin UI → rechazo y relay (D6).
- **Fronteras.** Los patrones que la traducción descarta (comodín interno, no-Bash) son filas `dropped:` con
  estado `unsupported`, salvo `Agent(orchestrator)`, que es `n/a`. `allow` no se traduce, igual que en Codex.

## Contracts

**Manifiesto `.pi/navori.json` v2** (`ownsPiManifest` estricto):

- **Claves:** `_navori, agents, controls, hooks, ownedPaths, permissionRules, schemaVersion`.
- **`hooks[]`:** `{ script, path, on: "tool_call"|"tool_result"|"agent_before_settle"|"session_shutdown",
  tools?, scope: "parent"|"child"|"all", class: "enforced"|"advisory"|"lifecycle", interactive, timeoutMs }`,
  filtrados por `when`.
- **Anti-downgrade (F18), verificado por lectura:** un CLI viejo ve v2 como ajeno (`ownsPiManifest` exige
  `schemaVersion: 1`); `collided` hace que no escriba **ningún** recurso Pi, ni siquiera la extensión.
- **Versiones incompatibles:** la extensión v2 con un manifiesto v1, o un CLI nuevo ante un `schemaVersion`
  mayor que el suyo, se tratan como "no puede evaluar". Los bindings `enforced` bloquean con
  "corre `navori render --apply` con la CLI actual"; el render se niega a escribir una versión menor
  (`downgrade-skipped`).

**Payload por evento** (D2):

| Evento Pi | `hook_event_name` | `tool_name` / extra |
| --- | --- | --- |
| `tool_call` bash | `PreToolUse` | `Bash`, `tool_input.command` |
| `tool_result` bash/edit/write | `PostToolUse` | `Bash`/`Edit`/`Write`, `command` o `file_path` |
| `agent_before_settle` | `Stop` | `stop_hook_active: false` |
| `session_shutdown` | `SessionEnd` | `reason` mapeado (D8) |

**Veredicto del script → resultado Pi (F4/F5):** stdout solo se interpreta si, recortado, empieza por `{`
y parsea como objeto con `hookSpecificOutput` o `systemMessage`; cualquier otro stdout es ruido (salida del
gate incluida) y no se acota ni se lee más allá de 64 KiB, sino que se descarta en streaming. Stderr se
conserva como cabeza 2 KiB + cola 2 KiB.

| Salida | `enforced` (`PreToolUse`) | `advisory` (`PostToolUse`/`Stop`) | `lifecycle` |
| --- | --- | --- | --- |
| exit 0, sin JSON | allow | — | — |
| exit 2 | `block`, razón = stderr | aviso = stderr (≤ 1 KiB) | ignorar |
| JSON `permissionDecision: "deny"` | `block` | ignorar | ignorar |
| JSON `permissionDecision: "ask"` | `ask` (D5/D6) | ignorar | ignorar |
| JSON `permissionDecision: "allow"` | allow (no anula a otros) | — | — |
| JSON `additionalContext`/`systemMessage` | allow | aviso (≤ 1 KiB) | ignorar |
| JSON con decisión desconocida, `updatedInput` o `continue:false` | `block` | ignorar | ignorar |
| exit ∉ {0,2}, señal, timeout, spawn fallido, bash ausente | `block` "Navori `<script>` no pudo evaluar…" | ignorar | ignorar |

**Mensajes:**

- R2 reenvía `BLOCKED by guard-destructive: <regla>` y `route:` cuando la regla tiene ruta.
- R3 nombra `navori render --apply`/`navori sync`.
- R6/R18 dicen "devuelto al padre para aprobación".

**`navori_subagent`:**

- **Entrada:** `role` admite `auditor|architect|publisher`; `feature` es obligatorio para
  `implementer|reviewer|scribe`.
- **Resultado:** `details.parentApprovals` (D6) e `isError` si el handoff es inválido o viejo (D7); plazos por
  rol (D9).
- **IPC hijo→padre:** `{ kind: "parent-approval", command: string, reasons: string[], bodyFiles: string[] }`,
  con un tamaño acotado.

**`navori handoff check`:** el modo `--produced-by reviewer` y la frescura del implementer (D7) dan JSON y
códigos de salida iguales a los actuales.

## Failure modes

- **Exit 1 latente** en scripts con `set -euo pipefail`: Claude lo oculta y Pi bloquea (R15). Un corpus
  diferencial de comandos benignos exige exit ∈ {0,2} antes de cada entrega (F5). Un caso que salga 1 es un
  bug del script, no un permiso.
- **Bash ausente, o `sh` como fallback:** `block` de lo `enforced` con la acción de Git Bash; los avisos se
  omiten. **UNVERIFIED** en Windows real.
- **Timeout del gate o abort:** se mata el grupo de procesos y el resultado es `block`. El gate no puede
  superar el plazo del hijo (D9).
- **Llamadas paralelas:** el bridge es reentrante y las confirmaciones van serializadas. Si cambian el
  estado o el cuerpo, se vuelve a pedir (D5). El resultado del gate vale para el árbol del momento: una edición
  hermana posterior queda fuera (frontera).
- **Extensión ajena que muta `input`:** se detecta en `tool_execution_start` y no se puede bloquear (D4).
- **Herramientas reemplazadas:** un `bash` sin `command` string → `block`; `powershell` desactivada o
  bloqueada (D10); los tools MCP de escritura no se inspeccionan (seatbelt).
- **Cierre lento:** 15 s como máximo y solo en `quit`/`new` (D8).
- **Manifiesto o extensión de otra versión:** bloqueo con la acción de render (Contracts).
- **Render parcial:** una colisión no escribe nada de Pi; `.pi/navori/**` entra al mismo `collided`.
- **Comandos `!cmd` del usuario** (`user_bash`): no son del agente y no se interceptan.

## Migration

- **Manifiesto v1 → v2** por `render --apply`; el downgrade queda bloqueado por construcción (Contracts).
- **`MIN_PI_VERSION` 0.87.1 → 1.1.0**; se actualizan `docs/pi.md` y el contrato que parsea
  `first-class-e2e.test.ts`.
- **`.pi/navori/`**: lo cubren `ENGINE_OUTPUTS.pi` y `applyPiOwnership`; al desactivar Pi se elimina solo si
  está intacto.
- **Assets compartidos**: cambio de bytes sin cambio de conducta Claude/Codex (D3), salvo el carril de `&`
  (D-U2). Los goldens se actualizan de forma explícita.
- **Codex**: extraer `translatePattern` a `permission-rules.ts` no cambia `.codex/rules/navori.rules`, y un
  test lo fija.

## Testing strategy

Cada caso declara `// Covers: R<n>`.

- **Contrato del bridge** (`pi/__tests__/hook-bridge.test.ts`). Cada script con binding, renderizado en un
  fixture Pi, recorre la tabla de veredictos. Incluye el gate verde con stdout ruidoso → allow (F4), stdout >
  64 KiB, JSON con decisión desconocida → `block`, stderr cabeza+cola, exit 1/timeout/bash ausente/`sh` →
  `block` en `enforced` y silencio en `advisory`, y drift con exit 2 → aviso (F1). R2, R4, R5, R8, R9, R11,
  R15, R18.
- **Corpus diferencial** (`shared/__tests__/pi-policy-parity.test.ts`):
  - los casos dorados del guard más un corpus de comandos benignos registrados;
  - la copia Claude y la copia Pi de cada script dan exit ∈ {0,2} en todo comando benigno (F5);
  - la copia Claude da el mismo veredicto que antes del cambio (comportamiento idéntico, D3);
  - la copia Pi añade solo los bloqueos de su brazo.
  R2, R3, R8, R16, R18.
- **Identidad de outputs** (extiende `golden-render-tree.test.ts`/`engine-parity.test.ts`): render(claude) ≡
  subárbol Claude de render(claude+pi); ídem Codex; `.codex/rules/navori.rules` no cambia. R16.
- **Inventario** (`shared/__tests__/pi-parity.test.ts`):
  - una unidad sintética sin fila falla nombrándola, también para `permission-rule`, `settingsFragment` y
    `prompts`;
  - en ambos sentidos, binding o evidencia ⇔ fila no `unsupported`;
  - toda fila `seatbelt` tiene la lista de bypass.
  R1.
- **Rutas gestionadas:** `managed_path` (pi), raíces de `managed-drift-watch` (pi), `ownedPaths` y
  `ENGINE_OUTPUTS` coinciden; un `.pi/agents/*.md` ajeno no queda protegido. R3, R9.
- **Carril `edit`/`write`:** un archivo que cita la gramática sin bloque real no se bloquea; `@ruta`, `~` y
  rutas absolutas; forma desconocida de `edits` → `block`; destino de `ownedPaths` aún inexistente → `block`;
  `user-section` editable; plano de control bloqueado por tool y por cada verbo de shell. R3.
- **E2E sin credenciales** (extiende `first-class-e2e.test.ts` y los `first-class-*`):
  - guardas: bloqueo destructivo y `deny` de permisos en padre, hijo y llamada anidada; `pi --no-extensions`
    bloqueado;
  - gate: commit y push con gate verde, rojo y sin runner;
  - confirmaciones: regla `ask` (`git reset --hard`) confirmada, denegada, sin UI y desde hijo con relay IPC;
    `gh pr create` aprobado, cuerpo cambiado tras el diálogo → `block`, y desde hijo con relay;
  - hijos: `cmd &` y `nohup` en hijo bloqueados, `&&` y `2>&1` permitidos; handoff viejo o inválido →
    `isError`; plazo del publisher ≥ gate + margen;
  - ciclo de vida: aviso de drift; aviso en settle; cierre que reclama un worktree limpio y conserva uno con
    trabajo sin push y otro con estado ignorado; ningún reclaim en hijos ni en `resume`/`fork`;
  - plugins y MCP: skills y prosa con y sin Codex, transición Codex on→off; diagnóstico MCP con `-`/`_`,
    parseo fallido sin eco y proyecto sin trust;
  - roles nuevos: auditor, architect y publisher;
  - versión y Windows: Pi < 1.1.0 y prerelease → bloqueo de escritura con lectura intacta y un solo aviso;
    `powershell` desactivada al arrancar;
  - downgrade: un manifiesto v2 ante un CLI viejo no escribe nada.
  R2–R15, R18.
- **Probes de runtime** (`runtime.test.ts`): IPC hijo→extensión en `pi` 1.1.0 (D6, primero en E2);
  `session_shutdown` en `dispose` y en hijos `--no-session`; `agent_before_settle` sin otra petición;
  `setActiveTools` quita `powershell`; `tool_execution_start` con argumentos finales. R6, R10, R11, R15.
- **Latencia:** p50/p95 por llamada bash sin gate, con los scripts concurrentes, registrado en `docs/pi.md`.
  Referencia del challenge: unos 25–28 ms por script en serie (F17).
- **Manual (R17):** lo corre el usuario en una sesión interactiva de Pi con su `/login`.
  - Ciclo Pi-only completo: instalación, plan aprobado, implementación, documentación, revisión, commit y push
    con gate, PR confirmado en el diálogo y cierre con evidencia.
  - Comparación RED/GREEN del contexto always-on: mismo proyecto, tarea y modelo; solo cambia el contexto
    Navori. Escenarios de arranque, planificación y cierre, registrados en `specs/0048-pi-paridad/evals.md`
    con los resultados adversos conservados.
  - Solo el smoke prueba el render del diálogo TUI y el cumplimiento del modelo.

## NOT in scope

- **MCP en hijos** (`child-mcp-grants`): sigue `deferred`.
- **Bloqueo Markdown por bash del implementer:** `markdown-ownership` sigue `advisory`; ningún R lo pide.
- **Claude/Codex:** el bloqueo de `Edit` sobre bloques gestionados y las protecciones `.pi/` no se activan en
  ellos (D3).
- **Confirmaciones de reglas `ask` y bloqueos `deny` en hilos Claude/Codex:** siguen siendo nativos de cada
  host.
- **Bypasses seatbelt** (`sh -c`, `eval`, scripts escritos, MCP de escritura, extensiones ajenas): se declaran
  y no se cierran (D11).
- Opción C, sandbox de SO, herramientas web en hijos Pi, `general-purpose-confirm`/`role-guard`/
  `engram-write-guard` (`n/a`), `audit-mode-trigger` (la captura de audit de Pi es la de 0047 R12),
  `compact-advice`, escribir `.pi/mcp.json` o `~/.pi/agent/*` y extensiones comunitarias.

## Preguntas abiertas

- **[assumed]** Piso Pi 1.1.0 con cota superior abierta (D10), `feature` obligatorio para el implementer
  (D7), plazos por rol de D9 y bloqueo, no confirmación, del plano de control `.pi/settings.json` y
  `.pi/extensions/**` (D4). Son reversibles y se toman salvo objeción.
- **[repo, UNVERIFIED]** Canal IPC en `pi` 1.1.0 (D6; probe al inicio de E2, con fallback decidido);
  `tool_call.input` crudo o preparado (D4); Git Bash en Windows (D2). Se verifican antes de declarar `enforced`
  las filas que dependen de ellos.
- **[human, menor]** El aviso de R11 es texto fijo en español en el script (preexistente). ¿Se deja así?

## Conocimiento durable propuesto

- Contrato del bridge (payload, tabla de veredictos, clases, `seatbelt`) → `docs/pi.md` y JSDoc de
  `engines/pi/hook-bindings.ts`.
- "Una política, copias por engine, identidad por `$0`; toda conducta nueva va en el brazo del engine" →
  comentario de módulo de `_partials/hook-input.sh`.
- Lectura de R16 (D3) → `docs/DIRECTION.md`, invariante multi-engine.

## Entregas propuestas

Ordenadas por riesgo. Cada una deja `PI_PARITY`, `ENGINE_CAPABILITIES.pi` y `docs/pi.md` verdaderos para lo que
entrega; el test de inventario lo exige en cada PR.

- **E1 — Inventario, bridge, guardas, permisos `deny`, archivos gestionados y drift (foundation).**
  - `PI_PARITY` completo con permisos y piezas de plugin, más la evaluación de `routing-watch` (R1).
  - `hook-bindings.ts`, `bridge-source.ts` con el contrato F4/F5 y concurrencia, manifiesto v2 con
    anti-downgrade, y `.pi/navori/hooks` con ownership y prune.
  - Brazo `pi` en `hook-input`/`audit-log`. Guard con plano de control, `managed_path` pi,
    `pi --no-extensions` y reglas `deny` de permisos (R2).
  - Carril `edit`/`write` (R3) y drift con exit 2 y raíces `.pi` (R9).
  - Fail-closed de versión y `powershell` (R15), corpus diferencial e identidad (R16).
  **R1, R2, R3, R9, R15, R16.**
- **E2 — Relay, confirmaciones, gate y aislamiento de hijos.** Primera tarea: probe IPC (D6), con el fallback
  decidido. Luego:
  - relay al padre (R6);
  - reglas `ask` compartidas (R18);
  - gate de commit y push en el brazo `pi` (R4);
  - confirmaciones con brazo `pi`, `draft-body` y hash del cuerpo (R5);
  - carril de `&`/`nohup`/`setsid`/`disown` para Claude y Pi, con el header actualizado (R8);
  - plazos por rol (D9).
  **R4, R5, R6, R8, R18.**
- **E3 — Handoffs y ciclo de vida.** Validación con frescura (R7); `session_shutdown` acotado y con
  preservación de estado ignorado (R10); aviso en `agent_before_settle` (R11); `routing-watch` si E1 lo admitió.
  **R7, R10, R11.**
- **E4 — Plugins, MCP, roles y verificación en vivo.**
  - Proyección de plugins (R12) y diagnóstico MCP (R13).
  - Auditor, architect y publisher con `onPi` y plazos (R14; depende de E2).
  - Smoke en vivo, `evals.md` RED/GREEN y `docs/pi.md` final (R17).
  **R12, R13, R14, R17.**
