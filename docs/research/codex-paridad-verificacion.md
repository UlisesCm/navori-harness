# Verificación en vivo de la paridad Codex (spec 0041, T7 y T20)

Evidencia fechada de las sondas V (T7) y los smokes S (T20) que respaldan `CODEX_VERIFICATIONS`
en `packages/cli/src/engines/shared/codex-parity.ts`. Cada sección `## V<n>` / `## S<n>` coincide
con una clave de esa tabla (`codex-parity.test.ts` compara las anclas).

Todas las corridas: Codex CLI **0.160.0**, fecha **2026-10-03**. Los prompts fueron sintéticos
(prefijo `PROBE-0041`) y no se reproducen aquí; solo se citan mensajes `[navori]` y claves observadas.

## Montaje

- Repo desechable en el scratchpad de la sesión (`codex-probe-0041`), renderizado con
  `navori render` y `engines: ["codex"]`. Para T20 se re-renderizó con el CLI de la rama más
  `plugins.tgrep`, `harness.planTiers` y `harness.masterPlan`.
- El repo se confió con `navori codex trust --yes` contra el `~/.codex` real del usuario.
- Captura de payloads: wrappers sobre dos hooks ya confiados (`guard-destructive` en PreToolUse
  `^Bash$` y `routing-watch` en PostToolUse) que registran solo las claves. Los argumentos del
  spawn se leyeron del rollout de la propia sesión.
- Respaldos del trust: `~/.codex/config.toml.probe-0041.bak.1791045701` (T7) y
  `~/.navori/backups/codex-config-2026-10-03T14-18-58-325.toml` (T20).

## V1

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** TUI con `gpt-5.6-luna`, `danger-full-access`, aprobación `on-request`; regla
  `prefix_rule ["git","branch","-D"]` con decisión `prompt`.
- **Resultado:** dividido. Hilo principal: pasa, Codex pidió aprobación. Subagente `scout`:
  falla, `git branch -D` corrió sin ningún prompt (sonda registrada como `fail`).
- **Evidencia:** en el hilo principal apareció "You approved codex to run git branch -D ... this
  time"; en el subagente no hubo solicitud de aprobación.
- **Fuente oficial:** https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/execpolicy/README.md
- **Hecho de diseño:** una regla `prompt` no es una confirmación dentro de subagentes (por ejemplo
  un `publisher` que corre `gh pr create`); R10 usa deny-como-confirmación, porque los hooks sí
  disparan en subagentes (V2).

## V2

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** subagente `scout` ejecutando Bash, con los wrappers de captura (parcial: solo la
  carga útil del hook).
- **Resultado:** pasa.
- **Evidencia:** en PreToolUse/PostToolUse(Bash) dentro del subagente aparecen `agent_type`
  (rol custom) y `agent_id` al nivel superior. Claves: `agent_id, agent_type, cwd,
  hook_event_name, model, permission_mode, session_id, tool_input, tool_name, tool_use_id,
  transcript_path, turn_id`. En el hilo principal no hay `agent_type` ni `agent_id`.
- **Fuente oficial:** https://learn.chatgpt.com/docs/hooks
- **Hecho de diseño:** confirma F1; el rol del llamador es legible en los hooks.

## V3

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** `spawn_agent` bajo `multi_agent_version: v1` (`gpt-5.6-luna`) y bajo `v2`
  (`gpt-6-sol`), leyendo PostToolUse y el rollout.
- **Resultado:** pasa en ambas, con consecuencia en v2.
- **Evidencia:** v1: `tool_name` = `spawn_agent`, `tool_input` con claves `agent_type,
  fork_context, message`, `message` legible. Un spawn con `agent_type` sobre un fork de historial
  completo falla ("Full-history forked agents inherit the parent agent type"); el rollout del
  hijo muestra `agent_role = scout`, profundidad 1. v2: el rollout registra `function_call`
  `spawn_agent` en el namespace `collaboration` con `agent_type, fork_turns, message, task_name`;
  el matcher `^(Bash|apply_patch|spawn_agent)$` no lo capturó en PostToolUse (el nombre llega
  aplanado, usar `spawn_agent$`); `agent_type` es legible pero `message` llega cifrado.
- **Fuente oficial:** https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs
- **Hecho de diseño:** confirma F10, F18, F19 y F20; bajo v2 plan-gate necesita el archivo de
  despacho como respaldo (OQ2).

## V4

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** segunda corrida con `false` seguido de `echo hi`, leyendo el rollout en
  PostToolUse(Bash).
- **Resultado:** pasa; refuta F4 para códigos de salida.
- **Evidencia:** al dispararse PostToolUse el rollout ya contiene una línea con el `tool_use_id`
  del hook: un `event_msg` / `item_completed`. En el rollout final, los `item_completed` con
  `item.type = CommandExecution` traen `exit_code` (1 para `false`, 0 para `echo`), `command`,
  `status` y `duration`. El `function_call_output` no lleva el `tool_use_id`.
- **Fuente oficial:** https://learn.chatgpt.com/docs/hooks
- **Hecho de diseño:** el código de salida de la llamada actual se lee del rollout en
  PostToolUse (`item_completed.item.exit_code` con `item.id == tool_use_id`); R11 puede ser
  `equivalente`.

## V5

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** subagente `scout` pidiendo un spawn, bajo `gpt-6-sol` (v2) y `gpt-5.6-luna` (v1).
- **Resultado:** pasa; la profundidad 2 es real bajo v2.
- **Evidencia:** bajo v2 el subagente despachó un nieto (rollout con `depth: 2`); bajo v1 el
  hijo no tenía herramienta de spawn.
- **Fuente oficial:** https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs
- **Hecho de diseño:** confirma F17; R31 es obligatorio.

## V6

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** subagente `scout` al que se le pidió dejar `sleep 45` en segundo plano; corrió
  `nohup sleep 45 >/dev/null 2>&1 &` (V6b).
- **Resultado:** corrida, sin marcador de runtime.
- **Evidencia:** el rollout muestra un `CommandExecution` `item_completed` con `status:
  completed`, `exit_code: 0` y un `process_id`; nada indica que el proceso siga vivo. Codex no
  tiene campo `run_in_background` ni herramienta `Monitor`.
- **Fuente oficial:** https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs
- **Hecho de diseño:** `subagent-no-background` en Claude solo bloquea `run_in_background` y
  `Monitor`; el `&` de shell es solo prosa en ambos engines. R12 queda `equivalente` sin hook
  (el vector no existe en Codex) y no hace falta un chequeo en `SubagentStop`. V6a no se corrió.

## V7

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** captura de payloads PreToolUse/PostToolUse en hilo principal y subagente (parcial).
- **Resultado:** pasa.
- **Evidencia:** `model` está al nivel superior de ambos payloads. `additionalContext` en
  `UserPromptSubmit` no se sondeó.
- **Fuente oficial:** https://learn.chatgpt.com/docs/hooks
- **Hecho de diseño:** consistente con F21.

## V10

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** `spawn_agent` con `agent_type: "orchestrator"`.
- **Resultado:** pasa.
- **Evidencia:** `error=unknown agent_type 'orchestrator'`.
- **Fuente oficial:** https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs
- **Hecho de diseño:** el orquestador no es un rol despachable en Codex.

## S1

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** `codex exec` en el repo desechable; un `scout` intenta `apply_patch` con `*** Add
  File: src/role-guard-probe.txt`.
- **Resultado:** pasa (`hook:role-guard`).
- **Evidencia:** "BLOCKED by role-guard: scout no escribe 'src/role-guard-probe.txt' (permitido:
  .navori/state/handoffs/ specs/)"; el archivo no se creó.
- **Fuente oficial:** https://learn.chatgpt.com/docs/hooks
- **Hecho de diseño:** role-guard deniega escrituras de un `scout` fuera de sus prefijos.

## S2

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** `codex exec` con `gpt-6-sol` (v2); un `scout` intenta `spawn_agent`.
- **Resultado:** pasa (`hook:role-guard`, `flow:nested-agent-dispatch`).
- **Evidencia:** "BLOCKED by role-guard: scout no despacha subagentes (profundidad 1)...".
  Bajo v1 el hijo no tiene herramienta de spawn (V5).
- **Fuente oficial:** https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs
- **Hecho de diseño:** el spawn desde un subagente se deniega (R31).

## S3

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** `codex exec` con `gpt-5.6-luna` (v1); `spawn_agent` sin y con línea de apertura.
- **Resultado:** pasa (`hook:plan-gate`, mitad v1 del par S4).
- **Evidencia:** sin línea de apertura: "BLOCKED by plan-gate: the encargo does not open with
  `workplan:`..."; con `nivel-0: README.md` en la primera línea del `message` (S3b) el hijo se
  creó y respondió OK.
- **Fuente oficial:** https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs
- **Hecho de diseño:** bajo v1 el `message` es legible y plan-gate lo valida directamente.

## S4

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** `codex exec` con `gpt-6-sol` (v2). S4 es el par declarado v1+v2: la mitad v1 es S3.
- **Resultado:** pasa, con un bug hallado y corregido (S4d).
- **Evidencia:**
  - Deny (v2): el nombre del hook es `collaborationspawn_agent`; sin archivo de despacho el spawn
    se deniega.
  - S4e (allow): un `dispatch_probe.json` fresco (`createdAt` con `Z`) permitió el spawn y el
    despacho se consumió. Se corrió con el CLI de la rama mediante un shim en el PATH.
  - S4d (bug): el orquestador de Codex escribió su propio despacho con `createdAt:
    "2026-10-03T20:27:54.004865+00:00"` y plan-gate lo reportó "is malformed".
    `DispatchSchema.createdAt` usaba `z.string().datetime()`, que rechaza offsets
    (`packages/cli/src/lib/plan/gate.ts:104`). Ahora es `datetime({ offset: true })`.
  - S4f (tras el fix): el orquestador (`gpt-6-sol`) escribió su propio despacho siguiendo la
    prosa de `AGENTS.md`, el spawn se permitió y el despacho se consumió (CLI de la rama vía
    shim). Pasa.
- **Fuente oficial:** https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs
- **Hecho de diseño:** bajo v2 el `message` va cifrado, así que plan-gate depende del archivo de
  despacho (OQ2).

## S5

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** `codex exec`; el modelo corre `grep -rn PROBE .` con `plugins.tgrep` activo (S5b).
- **Resultado:** pasa solo con un índice de tgrep.
- **Evidencia:** "BLOCKED by guard-search-routing: recursive content search through the shell".
  Sin índice, el guard deja pasar por diseño (exit 43).
- **Fuente oficial:** https://learn.chatgpt.com/docs/hooks
- **Hecho de diseño:** la fila `plugin-script:tgrep/guard-search-routing.sh` pasó de
  `limite-codex` a `equivalente` (una fila `limite-codex` no puede ser enforcing); el fail-open
  sin índice está dicho en la propia fila.

## S7

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** `codex exec`; el modelo corre `gh pr create` en el hilo principal.
- **Resultado:** pasa (`hook:pr-publisher-confirm`), solo en el hilo principal.
- **Evidencia:** "[navori] this `gh pr create` opens a PR and Codex hooks cannot prompt...".
- **Fuente oficial:** https://learn.chatgpt.com/docs/hooks
- **Hecho de diseño:** como un hook de Codex no puede preguntar, la confirmación es un deny que
  pide al usuario correr el comando.

## S8

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** `codex exec`; tres corridas de `ls /nonexistent-probe-dir` (exit 1).
- **Resultado:** pasa (`hook:bash-outcome-watch`).
- **Evidencia:** tras la tercera falla consecutiva el modelo reportó el consejo de falla repetida
  del hook.
- **Fuente oficial:** https://learn.chatgpt.com/docs/hooks
- **Hecho de diseño:** el hook lee el `exit_code` del rollout gracias a V4.

## S9

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** `codex exec`; `spawn_agent` con un `general-purpose`.
- **Resultado:** pasa (`hook:general-purpose-confirm`).
- **Evidencia:** "[navori] general-purpose is dispatched here and Codex hooks cannot prompt...".
- **Fuente oficial:** https://learn.chatgpt.com/docs/hooks
- **Hecho de diseño:** igual que S7, deny-como-confirmación.

## S10

- **Versión / fecha:** Codex 0.160.0, 2026-10-03.
- **Comando:** sesiones del repo desechable con `harness.masterPlan` activo.
- **Resultado:** pasa de forma indirecta (`hook:master-plan-context`); el hook no se probó solo.
- **Evidencia:** en cada sesión el modelo ofreció continuar `specs/_master/INDEX.md`.
- **Fuente oficial:** https://learn.chatgpt.com/docs/hooks
- **Hecho de diseño:** la fila queda con `enforcing: false` por evidencia indirecta.

## Notas

- **Migración (plan-gate):** el hook llama al binario `navori` global (0.11.1 se publicó durante
  los smokes). La ruta de archivo de despacho de V2 requiere un release de navori que la
  contenga; los smokes V2 usaron un shim en el PATH hacia el CLI de la rama. `doctor` aún no
  avisa de esto.
  Actualización: ahora `doctor` detecta un `navori` global más viejo que el CLI del repo.
- **Sin índice de tgrep** el guard deja pasar (exit 43).
- **V6a no se corrió:** el toggle `unified_exec` por agente no hizo falta tras V6b.
- **MCP globales:** las sondas cargan los MCP globales del usuario; engram guardó 2-3 resúmenes
  de sesión sintéticos `PROBE-0041`.
- **Revertir el trust del repo desechable:** restaurar el respaldo de `~/.codex/config.toml` (o
  `~/.navori/backups/codex-config-...toml`), o borrar el bloque
  `[projects."<scratchpad>/codex-probe-0041"]` y sus entradas `hooks.state` con las herramientas
  de `navori codex trust`. El repo desechable vive solo en el scratchpad de la sesión.
