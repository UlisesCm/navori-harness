# Paridad de garantías en Codex — Design

**Fecha:** 2026-10-02 · **Revisión:** 2 (aplica el veredicto `verdict_0041.md` V1–V11 sobre
`challenge_0041.md`; cubre R1–R30 de `requirements.md`).
**Base verificada:** `origin/dev` = `6f5f4742` (`git fetch origin dev` exitoso).
**Señal arquitectónica:** contrato compartido (matriz de paridad), áreas críticas (hooks, reglas
`ask`/`deny`, render/backup/prune de `.codex/`), decisión difícil de revertir (orden posicional
de `trusted_hash`).
**Fuentes Codex:** solo documentación oficial (`learn.chatgpt.com/docs/…`, destino de las
redirecciones 308 de `developers.openai.com/codex/…`) y el source de `openai/codex` en el tag
`rust-v0.160.0` (la versión instalada, `codex-cli 0.160.0`). Fecha de consulta de todas:
2026-10-02. Lo que no está confirmado lleva `UNVERIFIED` y una sonda (`V<n>`).

## Approach

La garantía se declara **por unidad** en una tabla hermana de `OVERLAP_ROWS`. Todo lo demás se
deriva de esa tabla o se contrasta contra ella con un test. El diseño no supone ninguna versión
de multi-agente: tanto V1 como V2 pueden estar activos (F16), así que cada mecanismo que mira
`spawn_agent` reconoce las dos formas de payload.

1. **Contrato de paridad (R1–R5, R26, R30).**
   - `engines/shared/codex-parity.ts` declara `CODEX_PARITY` (`kind:id` → `igual` |
     `equivalente` | `limite-codex`) y `CODEX_VERIFICATIONS` (`V<n>` fechadas).
   - `OVERLAP_ROWS` se une con esa tabla al construirse y `renderOverlapDoc` imprime la columna.
   - `CODEX_HOOK_REGISTRATIONS` deja de llevar el texto `unsupported`.
   - `ENGINE_CAPABILITIES.codex.unsupportedSurfaces` se deriva de la tabla y un test lo contrasta
     contra lo que se renderiza (R30).
2. **Contención por rol, solo en `apply_patch` (R6–R8).**
   - Hook nuevo exclusivo de Codex: `role-guard.sh`, `PreToolUse` con matcher `^apply_patch$`.
     Lee rutas estructuradas (`nv_edited_paths`), las normaliza y rechaza `..` y symlinks que
     salgan del repo.
   - Las rutas permitidas salen de `RosterAgent.writes`.
   - Bash queda `igual` que en Claude: ninguna contención por ruta y ninguna regex nueva, así que
     no toca el presupuesto de la Spec 0039 R28.
   - **No se registra en Claude.**
3. **Hooks que Codex sí puede imponer (R9, R11, R12, R13, R21, R29).**
   - Se registran `plan-gate` (ambas formas de payload), `master-plan-context` y `model-advisor`
     en `UserPromptSubmit`/`Stop`.
   - La guarda `tgrep` va dentro de `guard-destructive`, con rutas neutrales.
   - Hay dos líneas condicionadas a sonda: `bash-outcome` dentro de `routing-watch` y
     `subagent-no-background` en `SubagentStop`.
   - Los grupos nuevos van **después** de los grupos de plugin, así que ningún índice publicado
     se mueve.
   - Codex solo copia lo que registra. La poda usa la verificación de hash de §8.7e.
4. **Confirmaciones (R10, R14, R15, R21, R26).** Usan reglas `prompt` de `.codex/rules` o
   deny-como-confirmación. **No hay handler `PermissionRequest`.**
   - Cada patrón que se estrecha a prefijo tiene fila propia.
   - El "no volver a preguntar" de la UI de Codex es `limite-codex` con source.
5. **Profundidad 1 (R17).** No se toca `agents.max_depth`. El orquestador corre `scout` antes y
   `scribe` después (`equivalente`). Bajo V2 un subagente recibe `spawn_agent` aunque haya
   `max_depth` (F17), así que mantener la profundidad 1 exige un deny en `PreToolUse` cuando el
   que llama es un subagente. Esto extiende V3 con evidencia y se confirma en Open question 1.
6. **Prosa por engine (R18, R19, R28).**
   - Hay una clave reservada `onCodex` en la gramática `navori:if`. Los spans exclusivos de
     Claude se envuelven en `navori:if-not onCodex`.
   - Claude y los demás engines no cambian una sola letra de prosa.
   - Las condiciones se resuelven también en los `.toml` de agentes (H9).
7. **CLI (R23, R24, R27).** Un único `codexHome()` sirve a trust, doctor y audit. `doctor` revisa
   la confianza en cada worktree. `parseCodexSession` lee el rollout.

**Primero se verifica.** Una fila no cambia de estado sin su `V<n>`, y las que bloquean o piden
confirmación necesitan además un smoke real (R25). El test lo exige.

**Alternativas descartadas (nivel arquitectura):**
- *Agregar valores al enum `EngineSupport`.* Mezcla "qué se escribe" (`filterInventory` lee
  `native`) con "qué garantía da".
- *Usar `ENGINE_CAPABILITIES.controls` como fuente.* Hay 11 controles y unas 60 unidades, y R1
  es por unidad. Los controles quedan como vista contrastada.
- *Fijar multi-agente V1 con `multi_agent_v2 = false`.* Falso por evidencia: el catálogo del
  modelo decide la versión (F16). Retirado por el veredicto V1.
- *`role-guard` sobre Bash con heurísticas de texto.* Da falsos positivos sin el ancla `.md`
  (challenge A1) y viola la Spec 0039 R28. Retirado por V3.

## Impacto en Claude y otros engines (declarado, V8)

**Regla.** Claude cambia solo en el **contenido de scripts compartidos**: los hooks se copian
byte-idénticos a los dos engines (#389), y no hay otra forma. Su `settings.json`, su prosa, sus
agentes y sus skills no cambian. Cada punto lleva su test.

| Cambio | `claude.snap` | `codex.snap` | `cursor`/`copilot`/`agents-md`.snap | Pi |
|---|---|---|---|---|
| `_partials/hook-input.sh`: `nv_subagent_type` se separa en destino del spawn y agente del evento (V2) | cambia (inlined en hooks de Claude) | cambia | — | — |
| `tgrep` `guard-destructive-search-lane.sh` y `guard-search-routing.sh` con raíz neutral (R29) | cambia: sub-bloque de `guard-destructive.sh` y script | cambia | — | — |
| `routing-watch.sh`: línea `bash-outcome` solo para `nv_engine=codex` (R11) | cambia el script; **no** cambia el registro; `hooks-per-bash` `EXPECTED` de Claude sin cambio | cambia | — | — |
| `model-advisor.sh`: modos `codex-user-prompt`/`codex-stop` (R1, V7) | cambia el script, no el registro | cambia | — | — |
| `master-plan-context.sh` incluye `hook-input` (`nv_project_dir`) (R21) | cambia el script cuando `masterPlan` | cambia | — | — |
| `subagent-no-background.sh`: rama `SubagentStop` de Codex (R12, si V6b pasa) | cambia el script, no el registro | cambia | — | — |
| `plan-gate.sh`: encabezado y forma V2 en `lib/plan/gate.ts` (R9) | cambia el comentario del script | cambia | — | — |
| `role-guard.sh` (nuevo, alcance **solo Codex**) | **no aparece** | aparece | — | — |
| `conditionOrchestration(…, engine)` en todos los bloques y agentes, clave `onCodex` | **byte-idéntico** (los spans `if-not onCodex` se renderizan) | cambia (spans omitidos) | **byte-idéntico** | byte-idéntico |
| Skills `master-plan`/`context-intake` y hooks de master-plan con alcance `{claude, codex}` (D3 del usuario) | sin cambio | aparecen | **sin cambio** (siguen fuera) | sin cambio |

## Hallazgos adicionales

H9, H10 y H11 ya están en `requirements.md`. Este diseño agrega:

| # | Hallazgo | Evidencia |
|---|---|---|
| H12 | H5 es deriva de config: `navori.config.json` no tiene `models.architect`, así que Claude tampoco declara `model` para `architect`. El comportamiento tiene test | `.claude/agents/architect.md`; `render-codex.test.ts` › "leaves architect model and effort unset when the role has no profile" |
| H13 | El probe de #1082 corrió bajo **V2**: `task_name` es argumento solo de V2 y el nombre aplanado sale del namespace V2 | `SpawnAgentArgs` en `multi_agents_v2/spawn.rs` frente a `multi_agents/spawn.rs`; `function_hook_tool_name` en `registry.rs` @rust-v0.160.0 |
| H14 | El comentario de `parseCodexSession` dice que Codex no trae `agent_id` en las fases de herramienta. El schema 0.160 sí lo trae dentro de un subagente | `lib/audit/parse.ts` frente a `PreToolUseCommandInput` en `codex-rs/hooks/src/schema.rs@rust-v0.160.0` |
| H15 | El modo `one_shot` (sin background) solo existe con `unified_exec` apagado, y "Managed requirements are the only configuration path that can keep unified exec disabled" | `codex-rs/core/src/tools/spec_plan.rs@rust-v0.160.0` |
| H16 | `nv_subagent_type` cae al `agent_type` de nivel superior cuando falta `tool_input.agent_type`. En un PreToolUse de spawn ese valor es el del **que llama**, no el del hijo | `_partials/hook-input.sh` frente a F1 (challenge C2) |
| H17 | `routing-watch` en Codex usa `^(Bash\|apply_patch\|spawn_agent)$`, que no ve los spawns V2 con namespace | `CODEX_HOOK_REGISTRATIONS` frente a F19 |

## Hechos de Codex usados por el diseño

Las URLs de source son `github.com/openai/codex/blob/rust-v0.160.0/codex-rs/<ruta>`.

| F | Hecho | Fuente oficial (consultada 2026-10-02) | Estado |
|---|---|---|---|
| F1 | PreToolUse, PostToolUse y PermissionRequest traen `agent_id`/`agent_type` opcionales (solo dentro de un subagente). La doc solo lo documenta en `SubagentStart`/`SubagentStop` | `hooks/src/schema.rs` (`PreToolUseCommandInput`); `learn.chatgpt.com/docs/hooks` | source, **no es interfaz documentada** (D14) |
| F2 | PreToolUse acepta `deny`; con `ask` el hook "parsed but not supported yet" falla y la llamada pasa | doc hooks; `hooks/src/events/pre_tool_use.rs` | verificado |
| F3 | El `tool_response` de Bash es solo la salida, sin código de salida, y no se emite mientras el proceso sigue vivo | `ExecCommandToolOutput::post_tool_use_response`, `core/src/tools/context.rs` | verificado |
| F4 | El resultado de una llamada se registra **después** de sus hooks PostToolUse | `core/src/tools/registry.rs` | verificado |
| F5 | El `tool_input` de Bash en PreToolUse es solo `{command}` | `ExecCommandHandler::pre_tool_use_payload` (`core/src/tools/handlers/unified_exec/exec_command.rs`) | verificado |
| F6 | Una `prompt` produce `NeedsApproval` con `on-request` sin importar el sandbox; con `never` es `Forbidden` | `core/src/exec_policy.rs` (`prompt_is_rejected_by_policy`); `learn.chatgpt.com/docs/agent-configuration/rules` | source; **live UNVERIFIED (V1)** |
| F7 | Al aprobar una `prompt` se puede proponer una enmienda de política persistente ("no volver a preguntar") | `try_derive_execpolicy_amendment_for_prompt_rules`, `core/src/exec_policy.rs` | verificado |
| F8 | Una regla `allow` sobre todos los segmentos se salta el sandbox (`Skip { bypass_sandbox }`) | rama `Decision::Allow`, `core/src/exec_policy.rs` | verificado |
| F9 | Una `prefix_rule` empareja tokens en orden; cada elemento puede ser una lista de alternativas; no hay glob dentro de un token | `execpolicy/README.md` | verificado |
| F10 | En V1 el nombre de hook es `spawn_agent` y `tool_input` = `{message, agent_type?, items?, …}` | `registry.rs` (`function_hook_tool_name`), `core/src/tools/handlers/multi_agents/spawn.rs` | source; **live UNVERIFIED (V3)** |
| F11 | `SubagentStop` trae `agent_type` y `agent_transcript_path`, y puede bloquear con prompt de continuación | doc hooks; `hooks/src/events/stop.rs` | verificado |
| F12 | `CODEX_HOME` (por defecto `~/.codex`) es la raíz del estado local | `learn.chatgpt.com/docs/config-file/config-advanced` | doc |
| F13 | Los rollouts viven en `$CODEX_HOME/sessions/` (`SESSIONS_SUBDIR`); el formato no está documentado como interfaz | `rollout/src/lib.rs`; observación local 0.160.0 | source + observación |
| F14 | `request_user_input` en modo Default está detrás de una feature `UnderDevelopment` apagada | `features/src/lib.rs` | verificado |
| F15 | Las reglas `<repo>/.codex/rules/` cargan solo si la capa `.codex/` es de confianza; "Rules are experimental" | doc rules | doc |
| F16 | La versión de multi-agente la decide el **catálogo del modelo** salvo que `multi_agent_v2` esté activo; `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra` y `gpt-5.6-sol` son `v2`, solo `gpt-5.6-luna` es `v1` | `multi_agent_version_for_model`, `core/src/config/mod.rs`; `models-manager/models.json` | verificado |
| F17 | En V2 un subagente recibe herramientas de spawn si su modelo es V2; `max_depth` es "Ignored by V2" y el spawn V2 no compara profundidad | `collab_tools_enabled`, `core/src/tools/spec_plan.rs`; `AgentsToml.max_depth`, `config/src/config_toml.rs`; `core/src/tools/handlers/multi_agents_v2/spawn.rs` | verificado |
| F18 | Spawn V2: `{message, task_name, agent_type?, model?, …}`; sin `agent_type` el hijo es `default` | `multi_agents_v2/spawn.rs` (`SpawnAgentArgs`, `DEFAULT_ROLE_NAME`) | verificado |
| F19 | En V2 la herramienta puede ir en un namespace del catálogo; el nombre de hook se aplana (`<namespace>spawn_agent`) | `core/src/tools/multi_agent_tool.rs`; `registry.rs` | source; nombre exacto **UNVERIFIED (V3)** |
| F20 | Los parámetros V2 "retain harness-owned encryption annotations" | `core/src/tools/multi_agent_tool.rs` (doc del módulo) | source; legibilidad de `message` **UNVERIFIED (V3)** |
| F21 | `UserPromptSubmit` y `Stop` traen `model` | `UserPromptSubmitCommandInput`, `StopCommandInput` en `hooks/src/schema.rs` | verificado |

## Components

- **`engines/shared/codex-parity.ts` (nuevo).** Contiene `CodexParitySchema`, `CODEX_PARITY`,
  `CODEX_VERIFICATIONS` y `NARROWED_PATTERN_FAMILIES` (D4). No importa como valor
  `hook-registrations.ts` ni `engine-capabilities.ts`. Cubre R1, R2, R4, R22, R25 y R26.
- **`engines/shared/native-overlap.ts`.**
  - `OverlapRowSchema` exige `codexParity`.
  - `UnitKind` gana `permission-rule` y `plugin-script`.
  - `renderOverlapDoc` agrega las columnas *Paridad Codex · Mecanismo · Fuente · Codex ·
    Verificada*.
  - `FLOWS.codex` se reemplaza por paridad.

  Cubre R1, R3, R5, R14, R15 y R26.
- **`docs/native-overlap.md`** (generado) y **`docs/research/codex-paridad-verificacion.md`**
  (nuevo, una sección `## V<n>` por verificación). Cubren R5, R22 y R25.
- **`engines/codex/hook-registrations.ts`.**
  - `CodexHookRow` pierde `unsupported`.
  - Una `lateRegistrations` se emite **después** de los hooks de plugin en `resolveCodexHooks`
    (D8), en este orden:
    1. `role-guard` (`^apply_patch$`, incondicional);
    2. la guarda de spawn si se acepta OQ1;
    3. `plan-gate` (`spawn_agent$`, `when: planTiers`);
    4. `master-plan-context` (SessionStart, `when: masterPlan`);
    5. `model-advisor` en `UserPromptSubmit` y `Stop`;
    6. `subagent-no-background` en `SubagentStop` si V6b pasa.
  - Cambia el matcher de `routing-watch` (H17).
  - `minCodexVersion()` se deriva de las verificaciones (R4).

  Cubre R4, R9, R11, R12, R13, R17 y R21.
- **`engines/shared/engine-capabilities.ts`.**
  - `CODEX_HOOK_UNSUPPORTED_SURFACES` se deriva de `CODEX_PARITY`.
  - Se quitan `engine-scripts` (H10) y, cuando R29 entra, `plugin-hook-extensions`.
  - `UnsupportedSurface` gana `renderedPaths` (globs que no deben existir en el render) para el
    test de R30.
  - Los controles de Codex se actualizan desde la paridad: `plan-gate` y `analytic-write-tools`
    a `enforced` tras su V; `repeat-failure-advice` según V4.

  Cubre R1 y R30.
- **`engines/shared/roster.ts`.**
  - `RosterAgent.writes?: readonly string[]` (prefijos relativos al repo; admite
    `{{sdd.specsDir}}`).
  - `CLAUDE_ONLY_WORKFLOW_SKILLS` se reemplaza por `WORKFLOW_SKILL_ENGINES`
    (`master-plan`/`context-intake` → `{claude, codex}`).
  - `HOOK_ENGINES` declara el alcance de cada hook: hooks de master-plan → `{claude, codex}`;
    `role-guard` → `{codex}`.

  Cubre R7 y R20.
- **`engines/shared/harness-plan.ts`.** `resolveHarnessPlan` cambia las opciones
  `includeClaudeOnlySkills`/`includeClaudeOnlyHooks` por `engine?: EngineId`. Sin `engine` (Pi,
  `render.ts`, `doctor`) incluye solo las unidades universales, como hoy. Todos los que lo llaman
  se actualizan: `claude/index.ts`, `build-settings.ts`, `global-plugin.ts`, `codex/index.ts`,
  `doctor.ts`. `skills-index.ts` (`buildSkillRows`) y `prose-harness.ts` (`buildHarnessProse`)
  reciben `engine` para el índice de skills de `AGENTS.md` cuando lo escribe Codex. Cubre R20,
  R21 y V8.
- **`engines/shared/role-policy.ts` (nuevo).** `buildRolePolicyShell(config)` compila
  `RosterAgent.writes` en un `case` de shell que se interpola en `role-guard.sh` (`extraVars` en
  `placeHook`). Cubre R7.
- **`core-assets/hooks/role-guard.sh` (nuevo).** Ver Contracts. Cubre R6 y R8.
- **`core-assets/hooks/_partials/hook-input.sh`.** `nv_subagent_type` pasa a
  `nv_spawn_target_type`: en PreToolUse/PostToolUse de spawn devuelve solo
  `tool_input.agent_type`; en `SubagentStop` devuelve el `agent_type` de nivel superior. Se agrega
  `nv_event_agent_type` (el agente que ejecuta el evento) y `nv_is_spawn_tool` (V1 `spawn_agent`
  o un nombre V2 que termina en `spawn_agent`) (H16). Cubre R9 y R17.
- **`lib/plan/gate.ts` y `core-assets/hooks/plan-gate.sh`.** `parsePayload` reconoce V1
  (`agent_type`, `message`) y V2 (`agent_type?`, `task_name`, `message`). Ver Contracts. Cubre R9.
- **`core-assets/hooks/routing-watch.sh`.** Agrega la línea `bash-outcome` para Codex (D10),
  reutilizando el partial `bash-outcome.sh`. Cubre R11.
- **`core-assets/hooks/model-advisor.sh`.** Agrega los modos `codex-user-prompt`/`codex-stop`
  (compara `model` contra el último visto en la sesión). Cubre R1 (V7).
- **`core-assets/hooks/master-plan-context.sh`.** Usa `nv_project_dir`. Cubre R21.
- **`core-assets/hooks/subagent-no-background.sh`.** Rama `SubagentStop` de Codex, condicionada a
  V6b. Cubre R12.
- **`core-assets/hooks/general-purpose-confirm.sh`.** Rama Codex de deny-como-confirmación
  (D12). Cubre R10.
- **`packages/plugins/tgrep/managed/guard-destructive-search-lane.sh` y
  `scripts/guard-search-routing.sh`.** Dejan de depender de Claude: la línea hace `source` a
  `"$(cd "$(dirname "$0")/.." && pwd)/scripts/guard-search-routing.sh"`, y el script resuelve la
  raíz con `nv_project_dir`, que ya existe porque está inlined en `guard-destructive`. El
  `applyHookExtension` (hoy en `engines/claude/index.ts`) sube al spine compartido y Codex lo
  aplica sobre `.codex/hooks/`. Cubre R29.
- **`engines/codex/index.ts`.**
  - `placeHook` y `orphanScans` usan `codexInstalledScripts(config, plugins)`: los scripts de
    hooks resueltos, más los que referencia una `hookExtension` aplicada, más los scripts de
    plugin con registro.
  - La poda llama a `isRemovableNavoriFile` con `requirePristine` (V9).
  - `buildAgentToml` resuelve condiciones con `engine: "codex"` (R28).

  Cubre R13, R28 y R29.
- **`lib/render/render-plan.ts` y `engines/shared/render-managed-file.ts`.**
  `conditionOrchestration(content, config, engine = "claude")` reconoce la clave reservada
  `onCodex`. `computeRenderPlan` la aplica a todos los bloques core (hoy solo a `orquestacion`).
  Cubre R18.
- **`engines/codex/compat.ts`.** `CODEX_VOCABULARY` agrega `` `SendMessage` `` → `` `send_input` ``
  (V1; bajo V2 el span va en `if-not onCodex`) y `/master-plan` → `$master-plan`. Cubre R18 y R20.
- **Assets de prosa.** Spans en `if-not onCodex`, con la alternativa Codex en `if onCodex`, en:
  - bloques `orquestacion` (incluida la mención `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, M4) y
    `sdd`;
  - skills `spec-bootstrap`, `debug-failure`, `verify-before-done` y `master-plan` (es/en,
    inline en cada sitio, D11);
  - agentes `implementer`/`reviewer`.

  Cubre R18 y R20.
- **`lib/codex/home.ts` (nuevo).** `codexHome()`. Lo usan `trust.ts`, `commands/codex.ts`,
  `doctor.ts` y `lib/audit/*`. Cubre R23.
- **`commands/doctor.ts`.** `scanCodexHealth` enumera `git worktree list --porcelain` y corre
  `readCodexTrustState` por cada worktree que tenga `.codex/config.toml`. Advierte con nombre del
  hook, ruta y `cd <ruta> && navori codex trust`. También advierte si la versión instalada es
  mayor que la última verificada (D14). Cubre R4 y R27.
- **`lib/audit/parse.ts` y `discovery.ts`.** `parseCodexSession` lee el rollout (la ruta
  registrada, o `codexHome()/sessions/**/rollout-*-<sessionId>.jsonl`) con un adaptador aislado.
  Cubre R24.

## Decisions

- **D1 — Tabla hermana (R1, R3).** `CODEX_PARITY` es un `Record` por `kind:id`. La razón única de
  "por qué no" en Codex vive en la fila. Si una unidad cumple su garantía solo en parte, queda
  `limite-codex` con la fuente de lo que falta y una `containment` que nombra lo que sí se da.
- **D2 — Fuente válida para `limite-codex` (R2).** `https` en `learn.chatgpt.com`,
  `developers.openai.com` o `github.com/openai/codex/blob/rust-v<semver>/…`. Con GitHub, la versión
  del tag debe ser igual a `codexVersion`. Fecha no futura. El mensaje nombra `kind:id`.
- **D3 — `permission-rule` en el inventario (R1, R14, R15).**
  - Hay filas de clase: `bash-ask→prompt` y `bash-deny→forbidden` (`equivalente`).
  - `allow-not-translated` queda como **`limite-codex`** con F8 (traducirlo saltaría el sandbox).
    La asimetría que se acepta: con `danger-full-access` + `on-request`, Codex no pregunta por
    comandos sin regla (F6, rama `OnRequest`/`Unrestricted`; D2 del usuario). La fila lo dice.
  - `prompt-amendment` es **`limite-codex`** (F7): el usuario puede convertir una confirmación en
    `allow` persistente desde la UI de Codex; Claude `ask` no tiene ese efecto (V4).
  - `Agent(orchestrator)` (el único `not-bash` hoy) es `equivalente`: Codex no renderiza el rol
    (V10).
  - El inventario sale de `collectShellPermissionRules(FULL_CONFIG, allBundledPlugins)`.
- **D4 — Patrones estrechados (R26).** `buildCodexRules` estrecha 85 de los patrones de
  `settings-base.json` (calculado con `translatePattern`). Cada uno tiene fila propia, generada
  desde `NARROWED_PATTERN_FAMILIES`. Un patrón estrechado que no cae en ninguna familia rompe el
  test. Las familias:

  | Familia | Patrones | Estado | Mecanismo / fuente |
  |---|---|---|---|
  | `rm` recursivo sobre `/`, `~`, `$HOME` (19 variantes × 3) | 57 `deny` | `equivalente` | `guard-destructive` regla 3 (root/home/system con cualquier combinación de flags); test con payload Codex por variante que el prefijo no cubre (p. ej. `rm -rf /etc`) |
  | `--no-preserve-root` | 20 `deny` | `equivalente` | `guard-destructive` regla 3b; test Codex |
  | `git push --force*` | 1 `ask` | `limite-codex` | F9 (no hay glob dentro de un token). Contención: el prefijo cubre `--force`, `-f` tiene regla propia, `guard-destructive` bloquea el push forzado a la rama base. **No cubre** `--force-with-lease`/`--force-if-includes` fuera de la base |
  | `git reset --hard*`, `git clean -f*`/`-d*`, `git branch --delete*`, `git stash drop*`/`clear*` | 6 `ask` | `limite-codex` | F9. El prefijo cubre la opción exacta; las variantes pegadas (`-fd`, `-fx`) no las cubre nada |
  | `mkfs*` | 1 `deny` | `limite-codex` | F9. `mkfs.ext4` y similares no se cubren |

  Mejora que se queda en el traductor y no cambia el estado: F9 permite alternativas por token,
  así que `buildCodexRules` puede enumerar variantes conocidas (`["git","push",["--force",
  "--force-with-lease","--force-if-includes"]]`, `["mkfs.ext4", …]` como primer token). La fila
  sigue `limite-codex` porque el resto (tokens desconocidos) no se cubre.
- **D5 — `role-guard` solo en `apply_patch`, solo en Codex (R6, V3).**
  - Las rutas de `apply_patch` son estructuradas (`nv_edited_paths`), así que no hace falta
    heurística de texto.
  - Bash queda `igual` que en Claude, porque allí los roles de solo lectura tienen `Bash`/`Write`
    sin contención por ruta. Las filas de los agentes analíticos lo dicen.
  - Un rol que no es del roster (`default`, rol desconocido) recibe el conjunto común: es
    literalmente "rol que no es `implementer` ni `scribe`" (R6). Consecuencia: el hijo catch-all
    de Codex solo escribe handoffs y temporales, más estricto que `general-purpose` en Claude. Lo
    dice la fila de `general-purpose-confirm`.
  - Alcance `{codex}` en `HOOK_ENGINES`: el script no llega a `.claude/hooks/`.
- **D6 — Fuente única de rutas (R7).** `RosterAgent.writes` en `roster.ts` (el registro de
  postura que ya declara `sandbox`), compilado al hook por interpolación en el render.
  - Descartado un subcomando `navori` por llamada: un arranque de node en cada `apply_patch`.
  - Descartado una clave `writes:` en el frontmatter: filtraría a `.claude/agents/*.md`.
  - Valores:
    - todos: `.navori/state/handoffs/` y temporales del SO;
    - `architect`, `auditor` y `scout`: además `{{sdd.specsDir}}/`;
    - `reviewer`, `publisher` y roles fuera del roster: solo lo común.
- **D7 — Profundidad 1 sin tocar config (R17, V1).** `.codex/config.toml` no emite `[agents]` ni
  `multi_agent_v2`.
  - Bajo **V1**, `DEFAULT_AGENT_MAX_DEPTH = 1` deja a los subagentes sin herramientas de spawn
    (`collab_tools_enabled`).
  - Bajo **V2** no hay límite de profundidad (F17), así que mantener la profundidad 1 necesita un
    deny en `PreToolUse` (`spawn_agent$`) cuando el que llama es un subagente
    (`nv_event_agent_type` no vacío). Lo implementa el hook de D13, sujeto a OQ1.
  - La fila `nested-agent-dispatch` es `equivalente` (secuencia del orquestador) con
    `verification` V5, que cubre los dos modos.
  - La prosa de `orquestacion` deja la secuencia para los dos engines y cambia el nombre de la
    variable de Claude a un span `if-not onCodex` (M4).
- **D8 — Orden de registro sin mover índices publicados (M1).** Los grupos nuevos van en un
  segmento posterior a los grupos de plugin (`lateRegistrations`).
  - Ningún índice ya aprobado se mueve: no hay ventana sin `check-jscpd`/`check-semgrep`. Solo se
    aprueban los grupos nuevos.
  - Dentro del segmento, el incondicional (`role-guard`) va antes que los condicionales.
  - Costo aceptado: activar o desactivar un plugin con hook PreToolUse renumera el segmento
    tardío. Ese cambio ya exige un trust para el hook del plugin.
  - Excepción declarada: `routing-watch` cambia de matcher (H17), queda `Modified` y debe
    aprobarse de nuevo. Es advisory, así que la ventana no deja guards sin correr.
- **D9 — Background en subagentes (R12).** Va con verificación primero.
  - **Mientras no haya V6b**, la fila es `limite-codex` con F5 y el script no se copia (R13).
  - A, `unified_exec = false` por agente: descartada en principio por H15. V6a la confirma con
    una sonda corta.
  - B: rama Codex de `subagent-no-background` en `SubagentStop`. Lee `agent_transcript_path` (F11)
    y bloquea si hay "Process running with session ID N" sin un "Process exited" posterior para N
    (texto de `ExecCommandToolOutput::response_header`).
    - Bloquea solo si `stop_hook_active` es falso, así que no hay ciclo de continuación.
    - Si no puede leer el rollout, deja pasar (fail-open).
    - Una sesión cortada por `Interrupt` cuenta como cerrada (M7).
    - Si V6b pasa, la fila es `equivalente`: la misma garantía, verificada en el stop y no en el
      lanzamiento.
- **D10 — Fallo repetido de Bash (R11, V7).** Es candidato a `equivalente` por lectura con
  retraso.
  - Una línea `bash-outcome` **dentro de `routing-watch`** (ya en PostToolUse Bash de Codex, así
    que el número de hooks por Bash de Codex no crece, Spec 0039 R28) lee de `transcript_path` las
    salidas de llamadas **anteriores** ya registradas (F4). Extrae `Process exited with code N` y
    alimenta el estado del partial `bash-outcome.sh`.
  - El tercer fallo idéntico se avisa en la siguiente llamada Bash. Basta, porque la repetición se
    detecta igual.
  - Lectura incremental: offset por `session_id` en el scratch de navori.
  - V4 mide dos cosas: que la salida N−1 ya esté en el rollout cuando dispara el PostToolUse N, y
    la latencia.
  - Si falla, la fila es `limite-codex` con F3/F4 y la línea no se activa.
  - La línea corre solo si `nv_engine=codex`, con el precedente del `$0` de
    `comment-draft-confirm`. En Claude no cambia nada (`bash-outcome-watch` sigue en
    `PostToolUseFailure`).
- **D11 — Primitivas Codex para `master-plan` (R20, R21).**
  - La confirmación del usuario es una pregunta en el chat con opciones numeradas y la
    recomendación primero, que **termina el turno**. `request_user_input` no está disponible en
    modo Default (F14).
  - En `master-plan.md` (es/en) cada mención a `AskUserQuestion` lleva un span inline
    `if-not onCodex`/`if onCodex`. Claude queda byte-idéntico (challenge A6.4).
  - `navori master init|mode|ux|advance|part|close` ya son `ask` en `settings-base.json` y se
    traducen a `prompt`: `master-accept-confirm` es `equivalente`, condicionado a V1. Fallback:
    registrar `master-accept-confirm` con su rama `deny` (patrón `comment-draft-confirm`).
  - `master-plan-context` se registra en SessionStart y usa el canal `additionalContext` que
    `session-start-context` ya usa con éxito en Codex.
  - Los hooks y skills entran en Codex por `HOOK_ENGINES`/`WORKFLOW_SKILL_ENGINES` (A7), no
    borrando el set: cursor, copilot, agents-md y Pi no cambian.
- **D12 — Publicación y `general-purpose` (R10, V4, V7).**
  - **Publicación.** `gh pr create` ya es `prompt` (`GH_PR_CREATE_RULE`) y queda `equivalente`.
    Se mantiene el trade-off de la Spec 0035 D4: también le pregunta al `publisher`.
    `git push --force`/`-f` es `ask` en Claude y `prompt` en Codex (D4). Un `git push` simple no
    pide confirmación en Claude (`Bash(git push -u origin HEAD)` está en `allow`), así que no hay
    nada que replicar (M6). Sin handler `PermissionRequest` (R10).
  - **`general-purpose`.** Pasa a `equivalente` por deny-como-confirmación. La rama Codex de
    `general-purpose-confirm.sh` se registra en PreToolUse `spawn_agent$` y deniega un spawn del
    hilo principal **sin `agent_type`** o con un rol fuera del roster. La razón del deny dice:
    "pregunta al usuario; con su sí explícito, vuelve a despachar con
    `agent_type: \"default\"`". El reintento con rol explícito pasa.
  - **Diferencia declarada en la fila:** el portero humano depende de que el modelo pregunte en
    el chat; en Claude lo impone el host con `ask`. La fila cita F2 como la razón de que no se
    pueda hacer igual.
- **D13 — Guarda de spawn bajo V2 (R17, R31, F17; extiende V3, OQ1).** Una rama `spawn_agent$` en
  `role-guard` (matcher `^apply_patch$|spawn_agent$`) deniega cuando `nv_event_agent_type` no está
  vacío: un subagente intenta despachar. Bajo V1 no dispara nunca, porque el hijo no tiene
  herramienta. Bajo V2 es lo único que mantiene la profundidad 1 y cierra el hijo `default` creado
  desde un `implementer` (challenge C2). Si el usuario lo rechaza, R17 no se puede cumplir bajo V2
  y la fila se vuelve `limite-codex` para V2 con F17.
- **D14 — `agent_type` en PreToolUse no está documentado (M5).** F1 sale del source. Si cambia el
  schema, `role-guard` deja pasar sin avisar (R8). Contención:
  - `doctor` advierte cuando la versión instalada supera la última `codexVersion` verificada
    ("re-verificar V2/V3").
  - El smoke de V2 forma parte de la re-verificación por versión.
- **D15 — R13 cubre `.codex/hooks/` y `.codex/scripts/`.** La regla del conjunto deseado está en
  Components (`codexInstalledScripts`). Un test asegura que todo script registrado existe en
  disco (A7).
- **D16 — R16 ya se cumple por construcción (H12).** Se agrega un test de simetría. Corregir la
  deriva de config de este repo queda fuera del diseño (V11).
- **D17 — `model-advisor` (V7).** `equivalente`: se registra además en `UserPromptSubmit` y
  `Stop` de Codex, que traen `model` (F21). El script compara contra el último modelo visto en la
  sesión, el mismo método de estado por evento que usa en Claude. Que `UserPromptSubmit` acepte
  `additionalContext` en Codex está **UNVERIFIED (V7)**; si no lo acepta, el aviso va por
  `systemMessage` y la fila lo dice.

## Contracts

```ts
// engines/shared/codex-parity.ts
type VerificationId = `V${number}`;
interface CodexVerification {
  capability: string;
  url: string;              // allowlisted per D2
  codexVersion: string;     // semver of the probed binary
  verifiedAt: string;       // YYYY-MM-DD, not future
  probe: "pass" | "fail";
  multiAgent?: readonly ("v1" | "v2")[]; // spawn-related probes must cover both (R9)
  smoke?: "pass" | "fail";  // required when a referencing row is enforcing (R25)
}
type CodexParity =
  | { state: "igual"; enforcing: boolean; verification?: VerificationId }
  | { state: "equivalente"; mechanism: string; difference?: string; enforcing: boolean;
      verification: VerificationId }
  | { state: "limite-codex"; source: { url: string; codexVersion: string; verifiedAt: string };
      containment?: string };
// Refine: enforcing ⇒ verification with smoke "pass"; a spawn-related verification lists v1 and v2.
```

- **`role-guard.sh`** (Codex; PreToolUse `^apply_patch$` y, con OQ1, `spawn_agent$`):
  - Sin `agent_type` de nivel superior → `exit 0` (R8).
  - `implementer`/`scribe` → `exit 0` para `apply_patch`.
  - `apply_patch`: por cada ruta de `nv_edited_paths`:
    - se resuelve contra el `cwd` del payload;
    - se normaliza `..` lexicalmente; si sale del repo → deny;
    - si algún componente existente es symlink, se resuelve con `cd -P`/`pwd -P` del directorio
      existente más cercano; si el destino sale del repo y no es temporal del SO → deny;
    - las raíces temporales se comparan ya resueltas (`/tmp` → `/private/tmp`, `$TMPDIR` →
      `/private/var/folders/…`);
    - la ruta se compara por prefijo de componente (no de texto) con los `writes` del rol.
  - Mensaje: `[navori] BLOCKED by role-guard: <rol> no escribe '<ruta>' (permitido: <prefijos>)`,
    `exit 2` (R6).
  - Si no puede leer el payload → `exit 0` (best-effort, como `implementer-no-markdown`).
- **`plan-gate` (R9).** `parsePayload` produce `{form: "v1" | "v2" | "unknown", targetRole,
  opening}`.
  - `targetRole` = `tool_input.agent_type` recortado (nunca el de nivel superior, H16).
  - `opening` = primera línea de `message` (V1 y V2).
  - Decisión con `planTiers` activo:
    - `targetRole === "implementer"` → la evaluación actual del workplan;
    - forma `unknown`, o `message` ilegible (F20) → **deny** con la razón "forma de spawn sin rol
      o sin apertura legible";
    - `targetRole` vacío con forma reconocida → hijo `default`; deny si `task_name` o la apertura
      nombran `implementer` (implementer ambiguo, fail-closed); allow en otro caso.
- **Condiciones.** `conditionOrchestration(content, config, engine)`. `onCodex` es verdadero solo
  con `engine === "codex"`. No se lee `config.harness` para esta clave.
- **`codexHome()`** = `resolve($CODEX_HOME)` si no está vacío, si no `join(safeHomedir(),
  ".codex")`.
- **`.codex/config.toml`.** Sin claves nuevas de raíz. Los grupos `[[hooks.*]]` publicados
  conservan su índice; los nuevos van al final de su evento, después de los de plugin.

### Clasificación inicial de paridad

Es una propuesta: cada fila se fija en su tarea, con su `V`. Agentes, skills y bloques no
listados quedan `igual`, con R19 como guardia de fidelidad. Las filas `permission-rule` son las
de D3 y D4.

| Unidad | Estado | Mecanismo / fuente | V |
|---|---|---|---|
| `guard-destructive`, `comment-draft-confirm` (`deny` en Codex), `quality-gate-pre-commit`, `implementer-no-markdown` | igual (enforcing) | mismo hook | V2 |
| `role-guard` (solo Codex) | igual (enforcing) | `^apply_patch$` (+ `spawn_agent$` con OQ1) | V2, V5 |
| `plan-gate` | equivalente (enforcing) | `spawn_agent$`, formas V1/V2 | V3 (v1+v2) |
| `pr-publisher-confirm` | equivalente (enforcing) | `prefix_rule prompt`; diferencia: también pregunta al publisher | V1 |
| `master-accept-confirm` | equivalente (enforcing) | `prompt` traducido de `ask` (fallback: `deny`) | V1 |
| `general-purpose-confirm` | equivalente (enforcing) | deny-como-confirmación (D12); diferencia: portero mediado por el modelo | V3 |
| `bash-outcome-watch` | equivalente o limite-codex | línea en `routing-watch` con retraso N−1 (D10) | V4 |
| `subagent-no-background` | limite-codex (F5) hasta V6b; luego equivalente | D9 | V6 |
| `model-advisor` | equivalente | `SessionStart` + `UserPromptSubmit`/`Stop` con `model` (D17) | V7 |
| `subagent-stop-handoff` | equivalente | `SubagentStop` en vez de `PostToolUse(Agent)` | V7 |
| `worktree-reclaim` | equivalente | `SessionStart(startup)` siguiente (Spec 0035 D6) | V7 |
| `routing-watch` | igual | matcher `^(Bash\|apply_patch)$\|spawn_agent$` (H17) | V7 |
| `master-plan-context`, skills `master-plan`/`context-intake` | equivalente | SessionStart + pregunta que termina el turno (D11) | V8 |
| `managed-drift-watch`, `session-start-context`, `audit-mode-*`, `stop-verify-reminder` | igual | mismo evento | V7 |
| agente `orchestrator` | equivalente | hilo principal + `AGENTS.md` + `.codex/orchestrator.md` | — |
| agentes `auditor`, `scout`, `reviewer`, `architect`, `publisher` | equivalente | `role-guard` en `apply_patch` en vez de `tools:`; Bash igual que Claude | V2 |
| flow `nested-agent-dispatch` | equivalente | secuencia del orquestador; profundidad 1 (D7, D13) | V5 (v1+v2) |
| flow `master-plan-vs-plan-mode` | equivalente | D11 | V8 |
| flows `native-task-list`, `native-workflows` | igual | prosa sin dependencia del host | — |
| `plugin-script:tgrep/guard-search-routing.sh` | equivalente al entrar R29 | línea en `guard-destructive` con rutas neutrales | V9 |
| `plugin-script:jscpd/*`, `semgrep/*` | igual | registro `^Bash$` existente | V2 |

Las verificaciones:

| V | Qué verifica | Notas |
|---|---|---|
| V1 | `prompt` pregunta live en el hilo principal y dentro de un subagente | |
| V2 | El `agent_type` de nivel superior es el rol en un subagente custom; `deny` impide la escritura; los casos `..`/symlink de `role-guard` | |
| V3 | Spawn V1 y V2: nombre de hook, campos, legibilidad de `message`; `deny` sin hijo; permitido con workplan verde; permitido para un no-implementer; deny-como-confirmación de `general-purpose` | |
| V4 | Timing del rollout N−1 y latencia | |
| V5 | Profundidad efectiva en V1 y V2 y el deny de D13 | |
| V6 | (a) `unified_exec` por agente; (b) marcadores en `agent_transcript_path` | |
| V7 | Disparo de hooks advisory; `additionalContext` en `UserPromptSubmit` | |
| V8 | `additionalContext` de `master-plan-context` | |
| V9 | La guarda `tgrep` bloquea en Codex | |
| V10 | `spawn_agent` con `agent_type: "orchestrator"` falla | |

## Failure modes

- **Falso positivo de `role-guard`.** El mensaje nombra la ruta y los prefijos; el arreglo va en
  `roster.ts`, no en el script.
- **Falso negativo por Bash.** Declarado: la fila del agente dice "Bash igual que Claude".
- **Spawn V2 sin rol o con `message` cifrado.** `plan-gate` deniega (fail-closed). Con modelos V2
  y `planTiers`, el `implementer` podría quedar siempre bloqueado (Open question 2).
- **Cambia el schema de `agent_type`.** `role-guard` deja pasar. `doctor` lo cubre con la
  advertencia de versión no verificada (D14).
- **Ventana de trust.** Los grupos nuevos (y `routing-watch`, que queda `Modified`) no corren
  hasta `navori codex trust` en **cada** ruta de config, worktrees incluidos (R27). Ningún guard
  ya aprobado se apaga (D8).
- **Rollout ilegible o con otro formato (D9, D10, R24).** Cada lector devuelve `null` y no
  decide: no bloquea, no avisa, y audit reporta `unavailable: "transcript"`.
- **`approval_policy = never` por override del host.** `prompt` → `Forbidden` (F6): la
  publicación se bloquea en vez de pedir confirmación (falla cerrado).
- **El usuario elige "no volver a preguntar".** La regla `prompt` queda enmendada a `allow` (F7).
  Es la fila `limite-codex` de D3.

## Migration

1. **Poda en repos instalados (R13, V9).** El siguiente `render --apply` retira de
   `.codex/hooks/` y `.codex/scripts/` lo que no queda registrado ni referenciado:
   - `pr-publisher-confirm`;
   - `bash-outcome-watch`, porque su lógica pasa a `routing-watch`;
   - `subagent-no-background`, hasta V6b;
   - `plan-gate`, si `planTiers` está apagado;
   - `guard-search-routing.sh`, solo si `tgrep` está apagado.

   Se usa `isRemovableNavoriFile` con `requirePristine`. Un script con el cuerpo editado o con
   texto fuera del marcador se conserva y se reporta con `keptOrphanCodex`. Todo retiro pasa por
   backup.
2. **Trust.** Los grupos nuevos (`role-guard`, `general-purpose-confirm`, `plan-gate` con
   `planTiers`, `master-plan-context` con `masterPlan`, `model-advisor` en
   `UserPromptSubmit`/`Stop`) y `routing-watch` (`Modified`) piden un `navori codex trust` en cada
   checkout o worktree. `render` lo indica con `codexTrustCommandHint` y `doctor` lo nombra por
   ruta (R27). Con `CODEX_HOME` definido, el trust se escribe en `$CODEX_HOME/config.toml`.
3. **`.agents/skills/`.** Aparecen `master-plan` y `context-intake` (más su `agents/openai.yaml`).
   `AGENTS.md` los indexa.
4. **Versión mínima.** Pasa a 0.160.0 (V10). `doctor` advierte con las dos versiones. Es un piso
   conservador: "verificado en" no es lo mismo que "requiere" (M3).
5. **Claude.** Solo cambia el contenido de scripts compartidos (ver la tabla de impacto); no hace
   falta re-aprobar nada. `hooks-per-bash` de Claude sin cambio.
6. **Repo navori.** Se regeneran `docs/native-overlap.md` y los goldens declarados.

## Testing strategy

- **R1/R3/R26 — `native-overlap.test.ts` › cierre.** Extiende "has exactly one row for every
  unit" con `permission-rule`: filas de clase, `dropped` y **cada** `narrowed` sobre todos los
  plugins bundled. Un patrón estrechado sin familia en `NARROWED_PATTERN_FAMILIES` falla. Agrega
  también `plugin-script`.
- **R26 — cobertura de familias `equivalente`.** `lib/__tests__/guard-destructive.test.ts`, con
  payload Codex por cada variante que el prefijo no cubre (`rm -rf /etc`, `rm -R ~/x`,
  `rm -rf --no-preserve-root /`). La fila apunta a ese test.
- **R2 — refine.** Falla nombrando `kind:id` sin URL, con host fuera del allowlist, con un tag
  distinto de `codexVersion` o con fecha futura.
- **R25 — refine de `enforcing`.** Sin `V` o sin `smoke: "pass"` falla; una V de spawn sin `v1` y
  `v2` falla. Cada `V` tiene su `## V<n>` en el doc de research, con la misma URL, versión y fecha.
- **Consistencia entre registros.** Un registro sin fila `igual`/`equivalente` falla; un control
  `unsupported` con un hook `igual`/`equivalente` falla.
- **R30.** Para cada `unsupportedSurfaces` de Codex con `renderedPaths`, un render completo no
  produce ningún archivo que coincida. Detecta H10.
- **R4.** `minCodexVersion` con versión igual, menor y verificaciones de filas `limite-codex`
  (que no cuentan), más `codex-doctor.test.ts`.
- **R5.** Byte a byte con las columnas nuevas.
- **R6/R7/R8 — `lib/__tests__/role-guard.test.ts`.**
  - `apply_patch` de varios archivos con uno fuera del rol, `..` que escapa, symlink fuera del
    repo, temporales resueltos.
  - Rol `default` y rol desconocido; hilo principal; `implementer`/`scribe`.
  - R7: el fragmento renderizado es igual a `buildRolePolicyShell` y el asset no tiene prefijos
    literales.
  - `.claude/hooks/role-guard.sh` no existe en el render Claude.
- **R9 — `lib/plan/__tests__/plan-gate.test.ts`.**
  - Payloads V1, V2 con `agent_type`, V2 sin `agent_type` con `task_name: "implementer"`, forma
    desconocida y `message` ilegible.
  - `nv_spawn_target_type` nunca devuelve el tipo del que llama (H16).
- **R10/R14/R15 — `codex-rules.test.ts`.** Se queda "never emits allow". Ninguna fila
  `PermissionRequest` en `CODEX_HOOK_REGISTRATIONS` (R10 SHALL NOT).
- **R11.** Línea `bash-outcome` con rollouts de fixture (tercer fallo N−1 → aviso; sin rollout →
  silencio). Nuevo `hooks-per-bash` para **Codex**, calculado desde `resolveCodexHooks`, con un
  `EXPECTED` fijado sin cambio (Spec 0039 R28).
- **R12.** Si V6b entra: rama `SubagentStop` con proceso abierto → bloquea; cerrado, interrumpido
  o ilegible, o con `stop_hook_active` → permite.
- **R13 — `render-codex.test.ts`.**
  - `.codex/hooks`/`.codex/scripts` = `codexInstalledScripts`; registrado ⇒ existe en disco.
  - Un script con marcador y cuerpo editado se conserva y se reporta; uno prístino se poda con
    backup.
  - Los índices de trust de todos los grupos ya publicados quedan fijos.
- **R16 — `engine-parity.test.ts`.** `model:` en Claude si y solo si `model` en Codex, por rol.
- **R17 — `render-codex.test.ts`.** `config.toml` sin `[agents]` ni `multi_agent_v2`; con OQ1, la
  rama spawn de `role-guard` deniega con un que llama subagente.
- **R18/R19 — `render-codex.test.ts` sobre `proseSurfaces`.**
  - Falla nombrando archivo y bloque ante `SendMessage`, `TaskCreate`, `TaskList`, `TaskStop`,
    `ToolSearch`, `` `Skill` ``, `AskUserQuestion`, `` `Monitor` ``, `run_in_background` o
    `/Claude Code \d/`.
  - En los hooks `.sh` registrados en Codex se revisan las líneas de mensaje `[navori]`. Los
    mensajes con rama por engine de Claude van en un allowlist con archivo y motivo (M6).
- **R28.** Ningún `.codex/agents/*.toml` contiene `navori:if`; el test nombra el agente.
- **R29.** `guard-destructive` de Codex con `tgrep` bloquea un `grep -r` (exit 2) y la línea no
  contiene `CLAUDE_PROJECT_DIR` ni `.claude/scripts`. El test de Claude sigue verde.
- **V8 — goldens.** `claude.snap` cambia solo en los scripts de la tabla de impacto. `cursor`,
  `copilot`, `agents-md` y Pi quedan sin cambio. Lo verifica `golden-render-tree.test.ts` con
  diff revisado.
- **R20/R21.** Render Codex con `masterPlan` registra `master-plan-context` y emite las skills;
  render de un engine de prosa no las emite.
- **R23 — `lib/__tests__/codex-trust.test.ts`.** Con `CODEX_HOME` y sin él.
- **R24 — `lib/audit/__tests__/`.** Rollout de fixture sanitizado desde uno real de 0.160.0, e
  ilegible → `unavailable`.
- **R27 — `codex-doctor.test.ts`.** Worktree con config sin aprobar → advertencia con hook, ruta
  y comando.
- **R22/R25 — smoke real.** Cada tarea de sonda pide autorización al usuario al ejecutarse (V11).
  Checkout descartable, `CODEX_HOME` aislado (R23 va antes) y config global intacta. Las sondas
  de spawn corren con un modelo V1 (`gpt-5.6-luna`) y uno V2 (`gpt-6-sol`) (F16). Las
  confirmaciones necesitan un humano en la TUI.

## NOT in scope

- Cambiar el sandbox global (D2 del usuario) o usar sandbox por agente como contención.
- Subir `agents.max_depth` o fijar la versión multi-agente (R17).
- Contención por ruta de las escrituras por Bash (R6): queda igual que en Claude.
- Registrar `role-guard` en Claude (seguimiento aparte).
- Handler `PermissionRequest` (R10).
- Paridad con Pi, Cursor, Copilot o AGENTS.md universal. Sus renders no cambian (tabla de
  impacto).
- `acceptance-evidence` en Codex: depende del mismo resultado de Bash que D10 y se revisa solo si
  V4 pasa.
- Corregir `models.architect` en la config de este repo (V11).

## Open questions

Resueltas por el orquestador (2026-10-02):

- **OQ1 → aceptada.** `role-guard` agrega el matcher `spawn_agent$` y deniega cuando el que llama
  es un subagente (D13). Es la única forma de sostener R17 bajo V2 (F16, F17). Entra en
  `equivalente` solo tras la sonda V5; mientras tanto la fila de despacho anidado no se promueve.
- **OQ2 → aceptado el fallback condicionado.** Si V3 confirma que `message` llega ilegible bajo
  V2, `navori plan gate` reconoce la apertura por `.navori/state/handoffs/dispatch_<feature>.json`,
  escrito por el orquestador antes del spawn. Si V3 muestra `message` legible, no se implementa.

Texto original de cada pregunta:

1. **La guarda de spawn bajo V2 (D13) extiende V3.** El veredicto V1 supone que la profundidad 1
   se mantiene sin hook. El source lo desmiente bajo V2: `max_depth` "Ignored by V2" en
   `AgentsToml`; `collab_tools_enabled` da spawn a los subagentes cuyo modelo es V2; el spawn V2
   no compara profundidad (todo en `@rust-v0.160.0`). Los modelos que este repo asigna a los
   agentes (`gpt-6-sol`, `gpt-6-luna`) son V2 en `models.json`. Sin la guarda, R17 no se cumple
   bajo V2 y vuelve el bypass C2 (un `implementer` despacha un hijo `default`). ¿Se acepta que
   `role-guard` agregue el matcher `spawn_agent$`, con deny cuando el que llama es un subagente?
2. **R9 bajo V2 puede bloquear siempre al `implementer`.** Si V3 confirma que `message` llega
   cifrado o ilegible en el hook (F20: "harness-owned encryption annotations"; el probe de #1082
   no pudo leer su marcador), R9 manda denegar. Con `planTiers` y modelos V2, el orquestador
   Codex no podría despachar `implementer` nunca. Alternativa que hay que decidir si V3 falla:
   que `navori plan gate` reconozca la apertura por un archivo de despacho que el orquestador
   escribe antes del spawn (`.navori/state/handoffs/dispatch_<feature>.json`), en vez de la
   primera línea del `message`.
