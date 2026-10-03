# Paridad de garantías en Codex — Tasks

Tracking de la spec (no `TaskCreate`). Cada tarea declara sus `R<n>` y su test con
`// Covers: R<n>`. Las tareas de sonda (marcadas **sonda**) corren en Codex real y piden
autorización al usuario al ejecutarse; usan checkout descartable y `CODEX_HOME` aislado (por eso
T3 va antes). Una fila de paridad pasa a `igual`/`equivalente` solo con su sonda en verde
(R25); mientras tanto se queda `limite-codex` con su fuente.

## Lote 0 — Defectos actuales del render Codex (sin sondas)

- [x] **T1** (R28) — `buildAgentToml` en `engines/codex/index.ts` resuelve las condiciones con
  `engine: "codex"` antes de emitir; ningún `.codex/agents/*.toml` conserva `navori:if`. · test:
  `engines/__tests__/render-codex.test.ts` › "no agent toml keeps navori:if markers" (nombra el
  agente) con `// Covers: R28`
- [x] **T2** (R13, R30) — `codexInstalledScripts(config, plugins)` gobierna `placeHook` y la poda
  de `.codex/hooks/` y `.codex/scripts/`; la poda usa `isRemovableNavoriFile` con
  `requirePristine` y reporta lo conservado (`keptOrphanCodex`). `engine-scripts` sale de
  `unsupportedSurfaces` (H10) y `UnsupportedSurface` gana `renderedPaths`. · test:
  `render-codex.test.ts` › "installed scripts equal registered set", "edited orphan is kept and
  reported", "pristine orphan is pruned with backup", y `engine-capabilities.test.ts` › "no
  unsupported surface has rendered files" con `// Covers: R13, R30`
  Nota: la poda conserva y reporta un huérfano con texto fuera de su bloque managed
  (`requirePristine` vía `expected` en `execute-plan.ts`).
- [x] **T3** (R23) — `lib/codex/home.ts` con `codexHome()` (`$CODEX_HOME` o `~/.codex`), usado por
  `lib/codex/trust.ts`, `commands/codex.ts` y `commands/doctor.ts`. · test:
  `lib/__tests__/codex-trust.test.ts` › "uses CODEX_HOME when set" y "falls back to ~/.codex" con
  `// Covers: R23`

## Lote 1 — Contrato de paridad

- [ ] **T4** (R1, R2, R3, R4) — `engines/shared/codex-parity.ts` con `CodexParitySchema`,
  `CODEX_PARITY`, `CODEX_VERIFICATIONS` y `minCodexVersion()` (D1, D2); `OverlapRowSchema` exige
  `codexParity`; `UnitKind` gana `permission-rule` y `plugin-script`; `CodexHookRow` pierde
  `unsupported` y `CODEX_HOOK_UNSUPPORTED_SURFACES` se deriva de la paridad. Clasificación inicial
  según la tabla "Clasificación inicial de paridad" del diseño: toda fila que dependa de una sonda
  arranca `limite-codex` con su fuente. · test: `native-overlap.test.ts` › "has exactly one row
  for every unit" extendido (R3), refine "limite-codex requires official URL, version and date"
  (R2), "registered hook without igual/equivalente row fails"; `codex-parity.test.ts` ›
  `minCodexVersion` igual/menor/ignora `limite-codex` (R4) con `// Covers: R1, R2, R3, R4`
- [ ] **T5** (R14, R15, R26) — Filas `permission-rule` para cada patrón `ask`/`deny` no Bash, cada
  `dropped` y cada `narrowed` de `buildCodexRules`, agrupadas en `NARROWED_PATTERN_FAMILIES` (D3,
  D4); `allow-not-translated` como `limite-codex` con F8. · test: `native-overlap.test.ts` ›
  "every narrowed pattern belongs to a family"; `codex-rules.test.ts` › "never emits allow" y "no
  PermissionRequest registration"; `lib/__tests__/guard-destructive.test.ts` › payload Codex por
  cada variante que el prefijo no cubre (`rm -rf /etc`, `rm -R ~/x`, `--no-preserve-root`) con
  `// Covers: R14, R15, R26`
- [ ] **T6** (R5) — `renderOverlapDoc` agrega las columnas *Paridad Codex · Mecanismo · Fuente ·
  Codex · Verificada*; `docs/native-overlap.md` regenerado. · test: `native-overlap.test.ts` ›
  doc byte a byte con `// Covers: R5`

## Lote 2 — Sondas previas a los guards (**sonda**, autorización del usuario)

- [ ] **T7** (R22) — `docs/research/codex-paridad-verificacion.md` con una sección `## V<n>` por
  verificación (versión, URL oficial, fecha, resultado). Corre las sondas que no dependen de
  código nuevo: V1 (`prompt` live en hilo principal y en subagente), V3-payload (nombre de hook,
  campos y legibilidad de `message` del spawn en V1 con `gpt-5.6-luna` y V2 con `gpt-6-sol`), V4
  (timing del rollout N−1), V6 (`unified_exec` por agente; marcadores en
  `agent_transcript_path`), V7 (disparo advisory; `additionalContext` en `UserPromptSubmit`), V10
  (`agent_type: "orchestrator"` falla). Actualiza `CODEX_VERIFICATIONS`. · test: refine de R25 en
  `codex-parity.test.ts` › "each verification has its research section with same URL, version
  and date" con `// Covers: R22`

## Lote 3 — Guards por rol y plan-gate

- [ ] **T8** (R6, R7, R8) — `RosterAgent.writes` en `roster.ts` como fuente única (D6);
  `engines/shared/role-policy.ts` (`buildRolePolicyShell`); `core-assets/hooks/role-guard.sh`
  sobre `^apply_patch$`, registrado solo en Codex en `lateRegistrations` (D5, D8). Partial
  `hook-input.sh`: `nv_spawn_target_type`, `nv_event_agent_type`, `nv_is_spawn_tool` (H16). ·
  test: `lib/__tests__/role-guard.test.ts` › patch multi-archivo con uno fuera del rol, `..` que
  escapa, symlink fuera del repo, temporales; rol `default`/desconocido; hilo principal permitido;
  `implementer`/`scribe` permitidos; fragmento renderizado = `buildRolePolicyShell` sin prefijos
  literales en el asset; `.claude/hooks/role-guard.sh` ausente en el render Claude con
  `// Covers: R6, R7, R8`
- [ ] **T9** (R17, R31) — Rama `spawn_agent$` de `role-guard` que deniega cuando el que llama es un
  subagente (D13, OQ1); `config.toml` sin `[agents]` ni `multi_agent_v2`; prosa `orquestacion` sin
  `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` para Codex (M4). · test: `render-codex.test.ts` ›
  "config has no agents table nor multi_agent_v2"; `role-guard.test.ts` › "spawn from a subagent
  is denied naming the caller role", "spawn from main thread is allowed" con
  `// Covers: R17, R31`
- [ ] **T10** (R9) — `lib/plan/gate.ts` `parsePayload` reconoce V1 (`agent_type`, `message`) y V2
  (`agent_type?`, `task_name`, `message`); forma sin rol legible deniega; registro de `plan-gate`
  en `spawn_agent$` con `when: planTiers`. Si T7/V3 mostró `message` ilegible en V2: lectura de
  `.navori/state/handoffs/dispatch_<feature>.json` (OQ2). · test:
  `lib/plan/__tests__/plan-gate.test.ts` › V1, V2 con `agent_type`, V2 sin `agent_type` con
  `task_name: "implementer"`, forma desconocida, `message` ilegible; `nv_spawn_target_type` nunca
  devuelve el tipo del que llama con `// Covers: R9`

## Lote 4 — Confirmaciones y vigilancia

- [ ] **T11** (R10) — `general-purpose-confirm.sh` con rama Codex de deny-como-confirmación (D12);
  la confirmación de publicación por regla `prompt` de `.codex/rules` (sin handler
  `PermissionRequest`). Filas a `equivalente` solo con V1/V3 en verde. · test:
  `lib/__tests__/general-purpose-confirm.test.ts` › payload Codex sin confirmar → deny, confirmado
  → allow; `codex-rules.test.ts` › "publish commands are prompt rules" con `// Covers: R10`
- [ ] **T12** (R11) — Línea `bash-outcome` dentro de `routing-watch.sh` para Codex, reutilizando el
  partial `bash-outcome.sh` y leyendo el exit code del rollout (D10); matcher de `routing-watch`
  ve los spawns V2 (H17). Si T7/V4 mostró que el rollout llega tarde, la fila queda
  `limite-codex` con F3/F4 y la línea no se emite. · test: `routing-watch` con rollouts de
  fixture (tercer fallo → aviso; sin rollout → silencio); `lib/__tests__/hooks-per-bash.test.ts`
  › conteo Codex desde `resolveCodexHooks` igual al `EXPECTED` fijado con `// Covers: R11`
- [ ] **T13** (R12, R1) — `subagent-no-background.sh` con rama `SubagentStop` de Codex si T7/V6b
  pasó (si no: fila `limite-codex` con F5, sin copiar el script); `model-advisor.sh` con modos
  `codex-user-prompt`/`codex-stop` comparando `model` (D17, F21). · test:
  `lib/__tests__/subagent-no-background.test.ts` › proceso abierto → bloquea; cerrado,
  interrumpido, ilegible o `stop_hook_active` → permite; `model-advisor.test.ts` › cambio de
  `model` entre turnos avisa una vez con `// Covers: R12, R1`

## Lote 5 — Prosa, master-plan y tgrep

- [ ] **T14** (R18, R19) — `conditionOrchestration(content, config, engine)` reconoce `onCodex` y
  `computeRenderPlan` lo aplica a todos los bloques core; `CODEX_VOCABULARY` agrega
  `SendMessage` → `send_input` y `/master-plan` → `$master-plan`; spans `if-not onCodex` en
  `orquestacion`, `sdd`, skills `spec-bootstrap`/`debug-failure`/`verify-before-done`/`master-plan`
  y agentes `implementer`/`reviewer`. · test: `render-codex.test.ts` › "no Claude-only tool leaks
  into Codex surfaces" (nombra archivo y bloque; incluye mensajes `[navori]` de hooks registrados
  con allowlist motivado); golden de `cursor`/`copilot`/`agents-md`/Pi sin cambio con
  `// Covers: R18, R19`
- [ ] **T15** (R20, R21) — `resolveHarnessPlan` con `engine?: EngineId` en lugar de
  `includeClaudeOnly*`; `WORKFLOW_SKILL_ENGINES` y `HOOK_ENGINES` en `roster.ts`;
  `master-plan`/`context-intake` en `.agents/skills/` con `agents/openai.yaml`;
  `master-plan-context` registrado en Codex con `when: masterPlan` y `nv_project_dir`;
  `master-accept-confirm` por deny-como-confirmación (D11). · test: `render-codex.test.ts` ›
  "masterPlan registers master-plan-context and emits both skills"; render de engines de prosa
  no las emite con `// Covers: R20, R21`
- [ ] **T16** (R29) — Extensión `tgrep` neutral al engine: la línea de `guard-destructive` hace
  `source` relativo a su propio directorio y `guard-search-routing.sh` resuelve la raíz con
  `nv_project_dir`; `applyHookExtension` sube al spine compartido y Codex lo aplica sobre
  `.codex/hooks/`. · test: `guard-destructive` Codex con `tgrep` bloquea `grep -r` (exit 2) y no
  contiene `CLAUDE_PROJECT_DIR` ni `.claude/scripts`; test Claude existente sigue verde con
  `// Covers: R29`

## Lote 6 — CLI

- [ ] **T17** (R4, R27) — `scanCodexHealth` en `commands/doctor.ts` recorre
  `git worktree list --porcelain`, corre `readCodexTrustState` por cada worktree con
  `.codex/config.toml` y advierte con hook, ruta y `cd <ruta> && navori codex trust`; advierte si
  la versión instalada es menor que `minCodexVersion()` o mayor que la última verificada. · test:
  `codex-doctor.test.ts` › worktree sin aprobar → advertencia con hook, ruta y comando; versión
  menor y mayor con `// Covers: R4, R27`
- [ ] **T18** (R24) — `parseCodexSession` en `lib/audit/parse.ts` y descubrimiento en
  `discovery.ts` (ruta registrada o `codexHome()/sessions/**/rollout-*-<sessionId>.jsonl`), con
  adaptador aislado; engine identificado en el reporte. · test: `lib/audit/__tests__/` › rollout
  de fixture sanitizado de 0.160.0 → sesión Codex; ilegible → `unavailable` con `// Covers: R24`
- [ ] **T19** (R16) — Test de simetría de modelos por rol (D16, H12). · test:
  `engine-parity.test.ts` › "`model:` in Claude iff `model` in Codex, per role" con
  `// Covers: R16`

## Lote 7 — Cierre (**sonda**, autorización del usuario)

- [ ] **T20** (R25, R22) — Smoke real por cada fila `igual`/`equivalente` que bloquea o pide
  confirmación: V2 (`role-guard` deny), V3 (plan-gate deny sin workplan y allow con workplan
  verde, en V1 y V2), V5 (deny de spawn desde subagente), V8 (`master-plan-context`), V9 (guard
  `tgrep`), más las confirmaciones con humano en la TUI. Promueve en `CODEX_PARITY` solo las filas
  con `smoke: "pass"`; las demás quedan `limite-codex` con su fuente. Regenera
  `docs/native-overlap.md` y los goldens declarados en la tabla de impacto. · test: refine de
  `enforcing` en `codex-parity.test.ts` › "row without V or smoke pass cannot be igual/equivalente";
  "spawn verification requires v1 and v2" con `// Covers: R25, R22`
