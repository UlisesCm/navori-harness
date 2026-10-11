# Pi paridad — Tasks

**Estado:** scaffolding del 2026-10-11 (requirements, design revisión 2 tras challenge del auditor F1–F18 y
decisiones del usuario D-U1..D-U4). Ninguna tarea iniciada. Los archivos y casos de test son propuestas de
implementación; cada caso añadirá `// Covers: R<n>` sobre el test.

**Precondición:** una sola entrega y un solo PR (preferencia del usuario: pocos PRs que cierren el issue completo, commits atómicos por milestone); workplan `0048-pi-paridad-e1` con fases = milestones, aprobado por el usuario
antes de despachar al implementer. Cada milestone corre `bun run check:fast` más sus A<n>; la entrega cierra con
`bun check` verde. Cada milestone deja `PI_PARITY`, `ENGINE_CAPABILITIES.pi` y `docs/pi.md` verdaderos para lo que
entrega; el test de inventario lo exige.

## E1 — Paridad Pi: guardas, confirmaciones, ciclo de vida, plugins y roles

Estimated LOC: 5300

### M1 — Inventario de paridad Pi

- **A1** [observable] — Toda unidad emitida para otro engine tiene fila Pi y una unidad sin fila falla nombrándola · `bun run --cwd packages/cli test src/engines/shared/__tests__/pi-parity.test.ts` → exit 0; casos sintéticos sin fila para hook, `permission-rule`, `settingsFragment` y `prompts` fallan con su id.
- [x] **T1** (R1) — Crear `engines/shared/pi-parity.ts` con `PI_PARITY` y `missingPiParityUnits`: una fila por hook core, regla de permisos y pieza de manifiesto de plugin, con estado, frontera y lista de bypass en las filas `enforced (seatbelt)`. `OVERLAP_ROWS` deriva `engines.pi` de la tabla; `claude-hook-parity` remite a ella. Evaluar `routing-watch` con un probe y `model-advisor` como `unsupported`. · effect: behavior · test: `packages/cli/src/engines/shared/__tests__/pi-parity.test.ts`::undeclared unit fails by name

### M2 — Hook bridge, contrato y versión

- **A2** [observable] — Los scripts compartidos corren desde la extensión Pi con veredicto determinista y fail-closed · `bun run --cwd packages/cli test src/engines/pi/__tests__/hook-bridge.test.ts src/engines/pi/__tests__/runtime-version.test.ts` → exit 0; gate verde con stdout ruidoso permitido, JSON desconocido/exit 1/timeout/bash ausente bloquean en `enforced` y callan en `advisory`; Pi < 1.1.0 o prerelease bloquea bash/edit/write/powershell con lectura intacta y un solo aviso.
- [ ] **T2** (R2, R15) — Crear `engines/pi/hook-bindings.ts` (`PI_HOOK_BINDINGS`) y `engines/pi/bridge-source.ts`: payload con brazo `pi` en `_partials/hook-input.sh` y `_partials/audit-log.sh`, bash obligatorio sin `shellPath` del proyecto, ejecución concurrente de scripts no interactivos, veredicto solo desde stdout JSON con `{`, stderr cabeza+cola. `placeHook` emite `.pi/navori/hooks/<id>.sh`; manifiesto v2 (`ownedPaths`, `hooks`, `permissionRules`) con anti-downgrade; `.pi/navori/**` entra a `ENGINE_OUTPUTS.pi` y al prune. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/hook-bridge.test.ts`::verdict contract fails closed
- [ ] **T3** (R15) — `MIN_PI_VERSION` a 1.1.0 reutilizando `verifiedFrom`, prerelease como no verificada; versión no verificada registra solo el bloqueo de escritura con aviso único; `powershell` se desactiva con `setActiveTools` en `session_start`; `navori doctor` diagnostica versión, `powershell` por defecto y extensiones Pi ajenas. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/runtime-version.test.ts`::unverified version blocks writes keeps reads

### M3 — Guardas destructivas, archivos gestionados y drift

- **A3** [observable] — Comandos destructivos, reglas `deny`, escrituras a archivos gestionados y al plano de control se bloquean en padre, hijo y llamada anidada; el drift avisa · `bun run --cwd packages/cli test src/engines/pi/__tests__/first-class-guards.test.ts src/engines/shared/__tests__/pi-policy-parity.test.ts` → exit 0; un `.pi/agents/*.md` ajeno y la `user-section` siguen editables; comandos benignos dan exit ∈ {0,2} en ambas copias.
- [ ] **T4** (R2, R18) — Brazo `pi` de `guard-destructive.sh`: plano de control (`.pi/navori/**`, `.pi/extensions/**`, `.pi/settings.json`, `.pi/navori.json`) en todo verbo de shell e intérprete en línea, bloqueo de `pi --no-extensions`, y reglas `deny` de permisos traducidas con `translateShellPattern` (extraído de `codex/build-rules.ts` a `permission-rules.ts`). · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/first-class-guards.test.ts`::destructive and deny rules blocked in parent child and nested
- [ ] **T5** (R3) — Carril `edit`/`write` en `PI_EXTENSION_SOURCE`: gramática de marcadores anclada y balanceada, rutas normalizadas como Pi (`@`, `~`), destinos de `ownedPaths` aún inexistentes y formas de `edits` desconocidas bloqueados; `managed_path` del brazo `pi` con solo nombres exactos de Navori. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/first-class-guards.test.ts`::managed writes blocked user-section editable
- [ ] **T6** (R9) — `managed-drift-watch.sh` con raíces `.pi` y stamp propio en el brazo `pi`; el contrato advisory convierte exit 2 + stderr en aviso; un test cruza `managed_path`, raíces de drift, `ownedPaths` y `ENGINE_OUTPUTS`. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/hook-bridge.test.ts`::drift exit 2 becomes advisory

### M4 — Identidad de Claude y Codex

- **A4** [observable] — Activar Pi no cambia el comportamiento de Claude ni de Codex · `bun run --cwd packages/cli test src/engines/shared/__tests__/pi-policy-parity.test.ts src/lib/__tests__/golden-render-tree.test.ts src/engines/shared/__tests__/engine-parity.test.ts` → exit 0; render(X) ≡ subárbol X de render(X+pi) para Claude y Codex, `.codex/rules/navori.rules` sin cambios, la copia Claude de cada script da el mismo veredicto que antes del cambio.
- [ ] **T7** (R16) — Corpus diferencial de comandos benignos y casos dorados del guard contra copias Claude y Pi; goldens actualizados de forma explícita (D-U1) y test de identidad de outputs. · effect: tests · test: `packages/cli/src/engines/shared/__tests__/pi-policy-parity.test.ts`::claude copy verdict unchanged


### M5 — Probe IPC y relay al padre

- **A5** [observable] — Una operación que pide aprobación en un hijo se rechaza ahí y llega al padre con el comando exacto, sin depender de texto del modelo · `bun run --cwd packages/cli test src/engines/pi/__tests__/runtime.test.ts src/engines/pi/__tests__/first-class-approvals.test.ts` → exit 0; el probe IPC en `pi` 1.1.0 registra su resultado y, si el canal no existe, el fallback devuelve `isError`, nunca éxito.
- [ ] **T8** (R6) — Probe del canal IPC hijo→extensión en `pi` 1.1.0 como primera tarea; relay determinista desde la extensión del hijo con el fallback decidido (argumentos de `tool_execution_start`, si no `isError`); admisión `child-ipc-relay` en `runtimeAdmissions`. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/first-class-approvals.test.ts`::child relays approval request over IPC

### M6 — Gate y confirmaciones

- **A6** [observable] — Commit y push pasan por el gate; operaciones publicadoras y reglas `ask` piden confirmación ligada al contenido · `bun run --cwd packages/cli test src/engines/pi/__tests__/first-class-gate.test.ts src/engines/pi/__tests__/first-class-approvals.test.ts` → exit 0; gate rojo o sin runner bloquea; `git reset --hard` confirmado, denegado y sin UI; `gh pr create` con cuerpo cambiado tras el diálogo bloqueado.
- [ ] **T9** (R4) — `quality-gate-pre-commit.sh` cubre `git push` en el brazo `pi`; plazo por rol con la invariante plazo ≥ gate + 10 min. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/first-class-gate.test.ts`::commit and push gated
- [ ] **T10** (R5) — Brazo `pi` de `pr-publisher-confirm.sh` (siempre `ask`), `comment-draft-confirm.sh` y `master-accept-confirm.sh` vía bridge; partial `_partials/draft-body.sh`; aprobación con `sha256` de los archivos de cuerpo re-comprobado antes de permitir. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/first-class-approvals.test.ts`::publishing confirmed bound to body hash
- [ ] **T11** (R18) — Reglas `ask` de permisos compartidos evaluadas en el brazo `pi` del guard: confirmación en el padre, rechazo y relay desde hijo. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/first-class-approvals.test.ts`::shared ask rules confirm in parent relay from child

### M7 — Backgrounding en subagentes

- **A7** [observable] — `cmd &`, `nohup`, `setsid` y `disown` se bloquean en subagentes de Pi y Claude; `&&` y `2>&1` pasan · `bun run --cwd packages/cli test src/engines/pi/__tests__/first-class-guards.test.ts src/lib/__tests__/subagent-no-background.test.ts` → exit 0.
- [ ] **T12** (R8) — Carril de shell en `subagent-no-background.sh` para todos los engines que lo registran (D-U2), con `_partials/inert-skeleton.sh` extraído de `guard-destructive.sh` y header actualizado; fila de `CODEX_PARITY` lo declara. · effect: behavior · test: `packages/cli/src/lib/__tests__/subagent-no-background.test.ts`::background operators blocked in subagents


### M8 — Handoff con frescura

- **A8** [observable] — Un implementer o reviewer sin handoff nuevo y válido termina como fallido · `bun run --cwd packages/cli test src/engines/pi/__tests__/first-class-handoff.test.ts` → exit 0; handoff viejo, sin cambio de hash o inválido → `isError`; reviewer sin `beginReview.startedAt` posterior al dispatch → `isError`.
- [ ] **T13** (R7) — Validación del handoff al terminar el hijo con `navori handoff check` más modo `review`, frescura por hash/mtime y `checkSealedEvidence`; `handoff-shape` pasa a `enforced`. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/first-class-handoff.test.ts`::stale or invalid handoff fails child

### M9 — Fin de sesión y fin de turno

- **A9** [observable] — El cierre reclama solo worktrees seguros y sella audit-mode; el fin de turno con cambios avisa sin bloquear · `bun run --cwd packages/cli test src/engines/pi/__tests__/first-class-lifecycle.test.ts src/engines/pi/__tests__/runtime.test.ts` → exit 0; worktree con trabajo sin push y con `.navori/state` ignorado conservados; nada corre en hijos `--no-session` ni en `resume`/`fork`; presupuesto de 15 s.
- [ ] **T14** (R10) — `session_shutdown` en el padre con `reason` quit/new ejecuta `worktree-reclaim.sh` (solo si existe `.claude/worktrees`, preservando estado ignorado en el brazo `pi`) y `audit-mode-close.sh`; admisión `session-end-event`. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/first-class-lifecycle.test.ts`::shutdown reclaims safe worktrees only
- [ ] **T15** (R11) — `agent_before_settle` añade el recordatorio de verificación como `custom_message` visible sin otra petición al modelo; admisión `settle-boundary-entries`; `routing-watch` solo si T1 lo admitió. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/first-class-lifecycle.test.ts`::settle reminder with uncommitted changes


### M10 — Plugins y diagnóstico MCP

- **A10** [observable] — Skills y prosa de plugins llegan a Pi con un solo escritor por destino; el diagnóstico MCP no escribe ni hace eco de valores · `bun run --cwd packages/cli test src/engines/pi/__tests__/first-class-plugins.test.ts` → exit 0; con y sin Codex, transición Codex on→off, `-`/`_` normalizados, JSON inválido con mensaje fijo, `.pi/mcp.json` sin trust reportado como condicional.
- [ ] **T16** (R12) — `ctx.plugins` reales en `renderPiEngine`: skills a `.agents/skills` y `AGENTS.md` con `includePluginBlocks` solo sin Codex, prosa sin MCP anexada a `.pi/agents/<rol>.md`, hooks y `hookExtensions` a `.pi/navori/` (`hookExtensionTarget` "pi"). · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/first-class-plugins.test.ts`::plugin skills and prose projected single writer
- [ ] **T17** (R13) — Diagnóstico MCP de solo lectura sobre `.pi/mcp.json` y `${PI_CODING_AGENT_DIR}/mcp.json`: solo nombres y `enabled`, acción `pi mcp add`, nunca escribe. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/first-class-plugins.test.ts`::missing mcp server diagnosed without echo

### M11 — Roles auditor, architect y publisher

- **A11** [observable] — Los tres roles se despachan con su lista de herramientas y el publisher pasa por gate y confirmación · `bun run --cwd packages/cli test src/engines/pi/__tests__/first-class-roles.test.ts` → exit 0; publisher que intenta `gh pr create` en hijo devuelve el relay al padre; plazo del publisher ≥ gate + margen.
- [ ] **T18** (R14) — Admitir auditor/architect (`read, grep, find, ls, bash, write`) y publisher (`read, grep, find, ls, bash`) en `ROLE_TOOLS`; despacho anidado del architect bajo `navori:if-not onPi` (`conditionOrchestration`); retirar `additional-analytic-roles`; plazos por rol. · effect: behavior · test: `packages/cli/src/engines/pi/__tests__/first-class-roles.test.ts`::auditor architect publisher dispatch

### M12 — Verificación en vivo y documentación

- **A12** [observable] — Ciclo Pi-only en vivo completo y RED/GREEN registrados por el usuario · `bun run --cwd packages/cli test src/engines/pi/__tests__/first-class-e2e.test.ts` → exit 0 y `specs/0048-pi-paridad/evals.md` con el ciclo en vivo (instalación, plan, implementación, docs, revisión, commit y push con gate, PR confirmado, cierre con evidencia) y la tabla RED/GREEN con resultados adversos conservados.
- [ ] **T19** (R17) — Extender el e2e sin credenciales con guardas, gate, confirmaciones, relay y roles nuevos; latencia p50/p95 por llamada bash; `docs/pi.md` con tabla generada desde `PI_PARITY`, clases de bypass y contrato del bridge; guion del smoke manual y `evals.md`. · effect: docs · test: `packages/cli/src/engines/pi/__tests__/first-class-e2e.test.ts`::support matrix matches PI_PARITY
