# Claude first — verificación de capacidades nativas y pre-registro

> Tarea **T1** de la spec 0039 (fase F0a). Consulta del **2026-09-30** con Claude Code **2.1.286**
> instalado. Fuentes de la lista:
> [`evidence.md`](../../specs/0039-claude-first/evidence.md) § "Capacidades nativas de Claude Code
> a verificar" y [`design.md`](../../specs/0039-claude-first/design.md) § "Verificaciones
> pendientes".

## Método

- Cada página se descargó en su versión Markdown (`https://code.claude.com/docs/en/<página>.md`) y
  se buscó la cita textual. No se aceptó el resumen de un modelo como prueba. La página de Codex
  se leyó en HTML y se buscaron las cadenas citadas.
- Solo cuentan hosts de la allowlist de R3 (D2): `code.claude.com`, `learn.chatgpt.com`,
  `developers.openai.com`. Nada se da por verificado desde memoria ni desde `evidence.md`.
- **Estados:**
  - `verificada`: la doc lo dice explícitamente.
  - `sin verificar`: la doc no lo dice, o lo dice de otro modo.
  - `requiere sonda live (T2)`: solo una captura real lo resuelve.
  - `verificada (sonda T2)` / `refutada (sonda T2)`: la sonda live de T2 lo confirmó o lo desmintió
    (host 2.1.287). Una fila `refutada` solo admite `complementa`.
- **Veredicto permitido:** una fila que no esté `verificada` solo admite `complementa` (R3).
  Una fila `verificada` admite cualquier veredicto, sujeto al refine de D2 y a la revisión humana
  del PR. Que la capacidad exista no decide el veredicto.
- **Versión de CC:** la columna trae la versión mínima que cita la doc, o `—` si no cita ninguna.

## Tabla de capacidades

Fecha de consulta de todas las filas: **2026-09-30**.

### Frontmatter de subagentes

URL: https://code.claude.com/docs/en/sub-agents

| Capacidad | Versión CC | Cita | Estado | Veredicto permitido |
|---|---|---|---|---|
| `model` en el agente | — | "`model` … `sonnet`, `opus`, `haiku`, `fable`, a full model ID … or `inherit`" | verificada | cualquiera |
| `effort` en el agente | — | "`effort` … Effort level when this subagent is active. Overrides the session effort level." | verificada | cualquiera |
| `maxTurns` en el agente | ≥ 2.1.246 (marca parcial) | "Maximum number of agentic turns before the subagent stops. When the subagent reaches the limit, Claude Code returns its output marked as partial" | verificada | cualquiera |
| Unidad de conteo de `maxTurns` | — | La doc dice "agentic turns" y no define si son mensajes, rondas de herramienta o llamadas paralelas · Sonda T2: "cappedpar … 3 `message.id` con 3 `tool_use` cada uno = 9 llamadas"; cuenta mensajes del asistente, no llamadas (`packages/cli/src/lib/__tests__/fixtures/claude-live-2.1.287/probe2-maxturns-unit.json`) | verificada (sonda T2) | cualquiera |
| Forma de la marca parcial en el `tool_response` de `Agent` | ≥ 2.1.246 | "Claude Code marks the returned output as partial". La tabla de campos de `tool_response` de `Agent` en `/hooks` no lista ningún campo de parcial · Sonda T2: "status": "completed" y la marca es solo texto: "NOTE: this agent stopped at its 3-turn limit before finishing." (`packages/cli/src/lib/__tests__/fixtures/claude-live-2.1.287/probe2-agent-posttooluse-foreground-partial.json`) | verificada (sonda T2) | cualquiera |
| `skills` precargadas | — | "The full skill content is injected, not only the description." | verificada | cualquiera |
| `background` | — | "Set to `true` to keep this subagent in the background even when Claude asks to run it in the foreground." | verificada | cualquiera |
| `omitClaudeMd` | ≥ 2.1.271 | "launch this subagent without the user, project, and local CLAUDE.md files … Requires Claude Code v2.1.271 or later" | verificada | cualquiera |

### Anidación de subagentes

URLs: https://code.claude.com/docs/en/sub-agents y
https://code.claude.com/docs/en/env-vars (esta última solo para `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`).

| Capacidad | Versión CC | Cita | Estado | Veredicto permitido |
|---|---|---|---|---|
| Despacho desde un subagente, hasta tres capas | ≥ 2.1.219 (default 3) | "By default, a subagent can spawn subagents of its own, up to three layers below the main conversation." | verificada | cualquiera |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | ≥ 2.1.219 | "Number of subagent layers allowed below the main conversation (default: 3) … set `1` to turn nesting off." | verificada | cualquiera |
| `Agent(a, b)` en `tools` **de un subagente** como allowlist | — | "In a subagent definition, listing `Agent` in `tools` lets that subagent spawn subagents of its own … but any type list inside the parentheses is ignored." · Sonda T2: `nester` (`tools: Bash, Agent(cappedpar)`) despachó `cappedpar` y también `capped`, que no estaba en su lista (`packages/cli/src/lib/__tests__/fixtures/claude-live-2.1.287/probe5-ask-hook-and-nesting.json`) | verificada (sonda T2; la lista se ignora, ver § Contradicciones) | cualquiera |

### Hooks

URL: https://code.claude.com/docs/en/hooks, salvo donde la fila cita
https://code.claude.com/docs/en/env-vars.

| Capacidad | Versión CC | Cita | Estado | Veredicto permitido |
|---|---|---|---|---|
| Condición `if` en el handler | — | "The hook command only runs if the tool call matches the pattern." `if` "Only evaluated on tool events"; en otros eventos, "a hook with `if` set never runs" | verificada | cualquiera |
| `if` revisa subcomandos de Bash | — | "`"Bash(git *)"` runs when any subcommand of the Bash input matches `git *`". Salvedad: "Because the `if` filter is best-effort, use the permission system … to enforce a hard allow or deny." | verificada | cualquiera |
| `if` admite una sola regla | — | "The `if` field holds exactly one permission rule. There is no `&&`, `\|\|`, or list syntax" | verificada | cualquiera |
| `Agent(<nombre>)` como valor de `if` | — | `if` usa sintaxis de regla de permiso y `/permissions` documenta `Agent(my-custom-agent)`; ninguna página muestra la combinación · Sonda T2: `Agent(capped)`, `Agent(capped*)` y `Task(capped)` no disparan el hook; `Agent(*)`, `Agent` y `Task` sí (`packages/cli/src/lib/__tests__/fixtures/claude-live-2.1.287/probe5-agent-if-matching.json`) | refutada (sonda T2) | `complementa` |
| `PostToolUse` solo en éxito | — | "`PostToolUse` \| After a tool call succeeds" | verificada | cualquiera |
| `PostToolUseFailure` y sus campos | — | Recibe "the same `tool_name` and `tool_input` fields as PostToolUse, along with error information": `error`, `is_interrupt`, `duration_ms`. Bash: "a first line `Exit code N`, then any output the command produced". No lista `tool_response` · Sonda T2: "error": "Exit code 3\nto-stdout-MARKER\nto-stderr-MARKER\nls: /nonexistent-t2: No such file or directory"; sin `tool_response` (`packages/cli/src/lib/__tests__/fixtures/claude-live-2.1.287/probe1-posttoolusefailure-bash.json`) | verificada (doc y sonda T2) | cualquiera |
| `effort` en el input de `Stop` | — | "Present for events that fire within a tool-use context, such as `PreToolUse`, `PostToolUse`, `Stop`, and `SubagentStop`, when the current model supports the effort parameter." · Sonda T2: "effort": {"level": "low"} con sonnet `--effort low`; la clave no aparece con haiku (`packages/cli/src/lib/__tests__/fixtures/claude-live-2.1.287/probe3-stop-effort-sonnet-low.json`) | verificada (doc y sonda T2) | cualquiera |
| `$CLAUDE_EFFORT` en hooks y Bash | — | "Set automatically in Bash tool subprocesses and hook commands to the effort level" (env-vars) | verificada | cualquiera |
| Evento `SubagentStop` | — | "SubagentStop hooks receive `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, and `last_assistant_message`." | verificada | cualquiera |
| Tope de continuaciones en `Stop`/`SubagentStop` | — | "`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` \| Maximum number of consecutive times a Stop or SubagentStop hook may block … (default: 8)" (env-vars) | verificada | cualquiera |
| Tope de `additionalContext` | — | "capped at 10,000 characters". Si se excede, "Claude Code writes the text to a file … with a preview of up to the first 2,000 characters" | verificada | cualquiera |
| `tool_response` de `PostToolUse(Agent)` | ≥ 2.1.198 (background por default) | `status` es "`"completed"` for foreground subagents, `"async_launched"` for background subagents"; en background "`tool_response` carries no usage fields" | verificada | cualquiera |
| `CLAUDE_CODE_SESSION_ID` en el subproceso Bash | — | "Set automatically to the current session ID in Bash and PowerShell tool subprocesses, hook command subprocesses … this matches the `session_id` field in the hook JSON input" (env-vars) · Sonda T2: `echo SID=$CLAUDE_CODE_SESSION_ID` en Bash dio el mismo valor que `session_id` del hook (`packages/cli/src/lib/__tests__/fixtures/claude-live-2.1.287/probe4-bash-env-session-id.json`) | verificada (doc y sonda T2) | cualquiera |
| `ask` de un hook `PreToolUse` dentro de un subagente | — | La doc solo cubre los prompts de permiso: "When a background subagent reaches a tool call that needs permission, Claude Code surfaces the prompt in your main session" (sub-agents). No dice nada del `ask` de un hook · Sonda T2: `ask` se comporta como `deny` en `-p`: `tool_result` con `is_error: true` y el comando no corre, en hilo principal y en subagente (`packages/cli/src/lib/__tests__/fixtures/claude-live-2.1.287/probe5-ask-hook-and-nesting.json`) | verificada (sonda T2) | cualquiera |
| Registro de compactación en el transcript | — | Existen `PreCompact`/`PostCompact` y `SessionStart` con `source: "compact"`. La doc no describe qué entrada deja la compactación en el `.jsonl` · Sonda T2: "type": "system", "subtype": "compact_boundary" y un mensaje `user` con "isCompactSummary": true (`packages/cli/src/lib/__tests__/fixtures/claude-live-2.1.287/probe7-compaction.json`) | verificada (sonda T2) | cualquiera |

### Memoria y reglas

URL: https://code.claude.com/docs/en/memory

| Capacidad | Versión CC | Cita | Estado | Veredicto permitido |
|---|---|---|---|---|
| Memoria automática: por repo, compartida entre worktrees | — | "Per repository, shared across worktrees" | verificada | cualquiera |
| Memoria automática: carga 200 líneas o 25 KB | — | "The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation." | verificada | cualquiera |
| Memoria automática: fuera de subagentes | — | "The main conversation's auto memory isn't loaded into subagents; the exception is a fork" | verificada | cualquiera |
| Memoria automática: local a la máquina | — | "Auto memory is machine-local. … Files are not shared across machines or cloud environments." | verificada | cualquiera |
| `.claude/rules/` con `paths` | ≥ 2.1.198 (symlinks) | "Path-scoped rules trigger when Claude reads files matching the pattern, not on every tool use." | verificada | cualquiera |

### Revisión, worktrees, permisos, estilo y telemetría

URLs por fila.

| Capacidad | URL | Versión CC | Cita | Estado | Veredicto permitido |
|---|---|---|---|---|---|
| `/code-review` local | https://code.claude.com/docs/en/code-review | — (alias `/review` ≥ 2.1.223) | "The `/code-review` command reviews a diff in your terminal without installing the GitHub App. It reports correctness bugs and reuse, simplification, and efficiency cleanups." | verificada | cualquiera |
| `REVIEW.md` | https://code.claude.com/docs/en/code-review | — | Solo aplica al Code Review gestionado ("research preview, available for Team and Enterprise"). Del `/code-review` local: "it doesn't read `REVIEW.md`" | verificada | cualquiera |
| `/security-review` | https://code.claude.com/docs/en/commands | — | "Analyze the changes on your current branch for security vulnerabilities. Reviews the diff between your branch and origin's default branch … Needs an `origin` remote" | verificada | cualquiera |
| Limpieza de worktrees de subagentes | https://code.claude.com/docs/en/worktrees | ≥ 2.1.246 (marcador) | "Each subagent gets a temporary worktree that Claude Code removes automatically when the subagent finishes without changes". El barrido periódico usa `cleanupPeriodDays` y conserva "any worktree without" su marcador | verificada | cualquiera |
| `autoMode.soft_deny` / `hard_deny` | https://code.claude.com/docs/en/auto-mode-config | — | "`hard_deny` rules block unconditionally." y "`soft_deny` rules block next. User intent and `allow` exceptions can override these." | verificada | cualquiera |
| Output styles | https://code.claude.com/docs/en/output-styles | — | "An output style is a set of instructions that sets Claude's role, tone, and response format for every response in a session." Salvedad: "It doesn't guarantee that something always happens or never happens." | verificada | cualquiera |
| Métricas OTel con `query_source` | https://code.claude.com/docs/en/monitoring-usage | ≥ 2.1.268 (`query_source_safe`) | "`query_source`: Category of the subsystem that issued the request. One of `"main"`, `"subagent"`, or `"auxiliary"`" | verificada | cualquiera |
| Memoria de Codex (R50) | https://learn.chatgpt.com/docs/customization/memories?surface=app | n/a | "Local Codex memories are off by default." y "The main memory files live under ~/.codex/memories/" | verificada | cualquiera |

### Resumen

- 39 filas en total.
- Tras T2, 38 `verificada` (en cualquiera de sus variantes). Cuatro se confirman además con una
  captura live (campos de `PostToolUseFailure`, `effort` en `Stop`, `CLAUDE_CODE_SESSION_ID` en Bash
  y `tool_response` de `Agent`), cuatro filas pasaron de `requiere sonda live (T2)` a `verificada` y `Agent(a, b)` pasó de
  `sin verificar` a `verificada (sonda T2)`: la lista se ignora, como dice la doc.
- 1 `refutada (sonda T2)`: `Agent(<nombre>)` como `if`.
- Las flags de `tgrep` y `codegraph` no tienen página oficial; sus resultados están en
  § Resultados de las sondas (T2).

## Contradicciones con design.md

1. **`Agent(a, b)` no restringe dentro de un subagente (D8, R36).** D8 dice que la doc confirma
   "la lista `Agent(a, b)`", y R36 agrega `Agent(scout, scribe)` a `architect.md`. La doc
   ([sub-agents](https://code.claude.com/docs/en/sub-agents)) dice: "The `Agent(agent_type)`
   allowlist syntax applies only to an agent running as the main thread with `claude --agent`. In
   a subagent definition, listing `Agent` in `tools` lets that subagent spawn subagents of its own
   … but any type list inside the parentheses is ignored." En la práctica, el `architect` con
   `Agent(scout, scribe)` podría despachar cualquier tipo. Si R36 quiere acotarlo, necesita
   `permissions.deny` o un hook. El split de `tools:` que respeta paréntesis (m4) sigue sirviendo
   para no romper el parseo.
2. **`PostToolUseFailure` no documenta `tool_response`** ("Verificaciones pendientes": "con
   `error` y `tool_response`"). La doc ([hooks](https://code.claude.com/docs/en/hooks)) lista
   `tool_name`, `tool_input`, `error`, `is_interrupt` y `duration_ms`. La salida del comando va
   dentro de `error`: "a first line `Exit code N`, then any output the command produced as one
   block with stdout and stderr interleaved", truncada al medio si es larga. Para C (R17) esto
   basta si la sonda lo confirma. No hay que contar con `tool_response`.
3. **`/security-review` no está en la URL que cita evidence.md.** La tabla apunta a
   `/docs/en/code-review`, pero el comando se documenta en
   [commands](https://code.claude.com/docs/en/commands) y
   [security](https://code.claude.com/docs/en/security). La fila se registra con la URL correcta.
4. **`/code-review` y `REVIEW.md` no van juntos.** evidence.md los agrupa frente a `review-diff`,
   pero el `/code-review` local "doesn't read `REVIEW.md`" (sigue `CLAUDE.md`). `REVIEW.md` solo
   aplica al Code Review gestionado (Team/Enterprise, research preview).

Hallazgos que no contradicen design.md, pero lo afectan:

- **`CLAUDE_CODE_SESSION_ID` en Bash** figura como UNVERIFIED en design.md y la doc ya lo afirma
  (env-vars). La sonda de T2 queda como confirmación.
- **R42 y el `tool_response` de `Agent`:**
  - Desde 2.1.198 los subagentes corren en background por default. Un `PostToolUse(Agent)` en
    background trae `status: "async_launched"`, sin `content` final.
  - Con `SubagentHandback` (≥ 2.1.271, auto mode), `content` trae "a short note about that
    hand-back" en lugar del informe.
  - Consecuencia: `subagent-stop-handoff` en `PostToolUse(Agent)` puede no ver ni el informe ni la
    marca parcial. La sonda de T2 debe cubrir los tres casos: foreground, background y handback.

## Sondas pendientes (T2)

Ninguna se ejecutó en T1. Entre paréntesis, lo que cambia si la sonda da falso (de design.md
§ "Verificaciones pendientes").

1. **Forma de la marca parcial en el `tool_response` de `Agent`**, en foreground, background y
   con `SubagentHandback`. (R42 no dispara.)
2. **Unidad de conteo de `maxTurns`:** un agente con `maxTurns: 3`, comparado con el conteo por
   `message.id`. (Se recalcula el valor de R41 en la unidad del host.)
3. **Payload real de `PostToolUseFailure`** en un Bash con exit ≠ 0. (Si `error` no trae la
   salida, C se difiere, R17.)
4. **`effort` real en el payload de `Stop`.** (Queda el respaldo `$CLAUDE_EFFORT`.)
5. **`CLAUDE_CODE_SESSION_ID` en el subproceso Bash.** La doc lo afirma; se confirma. (R55 y el
   atasco no registran.)
6. **`Agent(<nombre>)` como `if` y `ask` dentro de un subagente.** (R40 lanza el hook en cada
   `Agent`.)
7. **Flags de `tgrep search` y `tgrep status`.** (Texto del remedio de D6.)
8. **Flags de `codegraph status`:** `npx @colbymchenry/codegraph@1.6.0 status --help`. (Cableado
   de R32 en `navori doctor`.)
9. **Registro de compactación en el transcript.** (R65 no cuenta compactaciones.)

## Pre-registro

Confirmado por el usuario el **2026-09-30**. Este archivo se commitea antes de cualquier
medición de R33, R41 o R43. La fecha del commit es la prueba del pre-registro. Estos criterios no
se cambian después de ver datos. Cambiarlos exige un commit nuevo que lo diga y la razón.

### R34 — codegraph en el default

- **Protocolo:** R33 (D7), con **≥ 12 tareas** de descubrimiento y tres brazos: textual,
  codegraph con `maxFiles: 4` y codegraph con `maxFiles: 12`.
- **Métricas:** las de `navori audit`: contexto acumulado, turnos y corrección contra una
  referencia.
- **Criterio:** codegraph **conserva el default** solo si algún brazo (`maxFiles: 4` o
  `maxFiles: 12`) baja **≥ 15%** la mediana de contexto acumulado frente al brazo textual, con
  corrección **≥** la del brazo textual.
- **Si ningún brazo cumple:** el veredicto es **`quitar-del-default`**.
- **Menos de 12 tareas:** la medición no es válida para decidir.

### R43 — tokens del `implementer`

- **Métrica de éxito:** mediana de cache read **por lanzamiento de `implementer`**, con el mismo
  minero y el mismo `audit.mode` en todas las ventanas.
- **Éxito:** una reducción de **−10%** o más de esa mediana frente a la línea base.
- **Tamaño mínimo:** **n ≥ 100** lanzamientos de `implementer` en cada ventana. Una ventana con
  menos no decide.
- **Banda de ruido:** diferencia entre las medianas de **dos ventanas base consecutivas** (m10).
  Una diferencia menor que esa banda **no cuenta** como efecto, aunque llegue a −10%.
- **Otras líneas base:** R43 también pide la mediana de cache read por sesión y los hooks por
  llamada Bash. Se registran en T9 con su n. Este pre-registro no les fija criterio de éxito.

### R41 — tope de turnos del `implementer` y disparador de reversión

- **Valor:** `maxTurns: 160`. Si T2 muestra que el host cuenta en otra unidad, el valor se
  recalcula en esa unidad, conservando el mismo corte de la distribución medida.
- **Disparador de reversión:** se **sube el tope** si en la ventana posterior pasa cualquiera de
  estas dos cosas:
  - más del **25%** de los parciales terminan en un re-despacho que vuelve a cortarse;
  - un parcial precede a un `CHANGES_REQUESTED` en más del **10%** de las features con parcial.

## Línea base (T9)

Instantánea `claude-first-base`, generada con `navori audit --snapshot claude-first-base`.

- **Alcance:** solo navori-harness, navori@0.11.0, rango 2026-09-21..2026-10-01, 95 sesiones y 745
  agentes.
- **Mediana:** es la mediana inferior (`quantile`), no el promedio de los dos centrales.
- **Ubicación:** la instantánea vive bajo la raíz de auditoría
  (`~/.navori/audits/navori-harness/ranges/2026-09-21--2026-10-01/snapshot-claude-first-base.json`),
  nunca en el repo.

| Métrica | p50 | p90 | n |
| --- | --- | --- | --- |
| Cache read por sesión | 8,181,176 | — | 95 |
| Cache read por lanzamiento de `implementer` | 3,394,101 | — | 175 |
| `hooks.perBashCall` | 4.88 | 6 | 24,254 llamadas Bash |
| Pico de contexto del hilo principal | 139,764 | 328,574 | 95 |

Bytes de resultado (R33):

| Herramienta | p50 | p90 | n |
| --- | --- | --- | --- |
| `codegraph_explore` | 22,249 | 25,101 | 142 |
| `Read` | 3,788 | 16,802 | 3,439 |
| `Bash` | 502 | 4,483 | 21,067 |
| `Grep` | 171 | 171 | 1 |

**Default de R44 derivado:** la mediana del pico de contexto (139,764) redondeada a 25k da
**150,000**, que reemplaza al 175,000 provisional.

## Comparación preliminar T44 — ventana 2026-10-02

Esta lectura es descriptiva, no un veredicto de éxito. Se generó comparando la instantánea T9
con el reporte diario del repositorio:

```sh
node packages/cli/dist/index.js audit --cwd /Users/ulisescm/Documents/dev-docs/navori-harness --since 2026-10-02 --until 2026-10-02 --compare /Users/ulisescm/.navori/audits/navori-harness/ranges/2026-09-21--2026-10-01/snapshot-claude-first-base.json
```

El reporte está en
`~/.navori/audits/navori-harness/ranges/2026-10-02--2026-10-02/report.json`.
Ambas ventanas indican `navori@0.11.0`; la base contiene 95 sesiones y la actual 8.

| Métrica | T9 (base) | 2026-10-02 | Diferencia observada |
| --- | ---: | ---: | ---: |
| Cache read p50 por sesión | 8,181,176 (n=95) | 2,541,900 (n=8) | −68.9% |
| Cache read p50 por lanzamiento de `implementer` | 3,394,101 (n=175) | 657,376 (n=22) | −80.6% |
| `hooks.perBashCall` (llamadas Bash; p90) | 4.88 (24,254; p90=6) | 5.16 (2,484; p90=6) | +0.28 (+5.7%) |

La subida agregada de hooks no demuestra una regresión posterior a la activación de R28: las ocho
sesiones actuales comenzaron antes del merge final de dev, registrado a las
`2026-10-02T21:16:47Z`; es una ventana de despliegue mixto. Además, el checkout runtime raíz sigue
en `main` (`42fae5b4`). Como evidencia de mecanismo, las pruebas estáticas R28 pasan con los conteos
actuales `bPre=5`, `bPost=2`, `bPostFail=1`: la ruta exitosa añade una llamada menos que antes de
T16, la fallida conserva el conteo, y la ruta bloqueada es como máximo una llamada menor que la
base. Esto no sustituye una ventana de ejecución posterior a la activación.

**R43 sigue inconcluso.** Los 22 lanzamientos actuales de `implementer` están por debajo del mínimo
pre-registrado de 100. No hay una ventana post-activación verificada ni una comparación válida de
ruido. Aunque el snapshot y el reporte exponen `generatedBy: navori@0.11.0` y
`sessions.transcript`, no incluyen metadatos `audit.mode` ni del minero para certificar de forma
independiente que ambos periodos usaron el mismo modo y minero. No se infiere éxito de la reducción
observada.

La ventana prospectiva de R41 **aún no está activa**: su inicio será la marca de tiempo de la primera
sesión Claude fresca y verificada después de que el harness completo mergeado a dev se haya renderizado
y cargado realmente. No se retrotrae al merge. La medición posterior deberá registrar parciales,
re-despachos que vuelven a alcanzar el límite y `CHANGES_REQUESTED` posteriores a parciales para
aplicar, sin alterar, los disparadores pre-registrados de >25% y >10%.

## Cierre T44 — comparación formal diferida a la spec 0042

Revisado el 2026-10-06 sobre `main` `3eee19d7` (navori@0.11.2, reporte `schemaVersion` 11). T44 se
cierra **sin veredicto de R43**: la comparación formal no se puede ejecutar con el minero actual y
se reprograma en #1177. Los criterios pre-registrados no cambian.

**Bloqueos verificados:**

1. **`--compare` y `--snapshot` están deshabilitados a propósito.** Con el reporte en schema 11,
   `navori audit --compare` sale con `snapshot-schema-unavailable: schema11-snapshot-pending`
   (`lib/audit/snapshot.ts`, `commands/audit.ts`). Se reactivan con la 0042 T11 (snapshots con
   cohortes y disponibilidad).
2. **El presupuesto de lectura trunca el rango.** `factsPerReport` = 100,000 se agota antes de leer
   las sesiones de un rango de tamaño T9: sobre 2026-09-21..2026-10-01 el descubrimiento solo
   recupera 31 de las 95 sesiones de la base; el resto queda sin encabezado legible. Además, con el presupuesto marcado
   como truncado, cada sesión queda en `tools.state: partial` (`incomplete-enumeration`) y el
   reporte de rango la excluye: en 2026-10-04..2026-10-06 las dos sesiones Claude se leen completas
   y aun así `sessions.transcript`, el cache read y `hooks.perBashCall` salen nulos.
3. **El tamaño mínimo no se alcanza.** R43 exige n ≥ 100 lanzamientos de `implementer` por ventana;
   con el bloqueo 2 ninguna ventana actual llega a ese n.

**Corregido en este cierre:** el descubrimiento marcaba como `wrong-format` todo transcript de
Claude Code 2.1.28x, porque exigía que la primera línea fuera el registro de identidad. Esos
transcripts abren con hasta 9 registros de servicio sin `cwd` (`last-prompt`, `ai-title`,
`permission-mode`, `queue-operation`, `file-history-snapshot`…) y la identidad llega en un
registro `attachment` o `user`. Con la corrección, la ventana 2026-10-02 vuelve a verificar 10
sesiones (antes 1) y 2026-10-03..2026-10-06, 13 (antes 2). Las cifras preliminares de arriba se
tomaron antes de esta regresión y siguen siendo la única lectura descriptiva disponible.

**R28** queda cubierto por las pruebas estáticas de T17 y T29 (`hooks-per-bash.test.ts`); la cifra
medida de `hooks.perBashCall` se anota cuando la comparación formal sea posible.

**Inicio de la ventana de R41:** `2026-10-04T18:53:45.984Z`, sesión Claude `53b30c6e`, la primera en
este repo con el harness 0.11.2 renderizado (`navoriRendered: "0.11.2"`) después de que el release
que integra 0039 en `main` se mergeara (#1199, `2026-10-04T02:03:29Z`). Las sesiones intermedias
registraron un render 0.11.0 y no cuentan.

**Para cerrar el veredicto (#1177):** cuando la 0042 T11 reactive las instantáneas y el reporte de
rango no excluya sesiones por truncado, recalcular la base T9 con el minero vigente (mismo minero en
ambas ventanas), medir la banda de ruido con dos ventanas base consecutivas y comparar una ventana
posterior a la de R41 con n ≥ 100.

### Actualización 2026-10-07 — R43 cerrado como no evaluable (#1177)

R43 se cierra **sin veredicto: no evaluable**. Los criterios pre-registrados no cambian y no se
declara éxito ni fallo.

**Defectos del minero encontrados y corregidos en `fix/1177-audit-range-metrics`:**

1. **El recorte de texto libre contaba como pérdida.** El recorte de visualización y los registros
   que superaban el tope se marcaban como pérdida y degradaban toda la evidencia a `partial`. Ahora
   el recorte no es pérdida y los registros grandes se proyectan conservando `usage` y `tool_use`
   (`db95a7f2`, `7d47a938`).
2. **Tipos de registro 2.1.29x no reconocidos.** `mode`, `atis-latch`, `ai-title`,
   `file-history-delta`, `cost-state`, `continued-in`, `agent-name` y el bloque `tool_reference`
   caían fuera de la lista permitida (`473e8c05`).
3. **El descubrimiento agotaba el presupuesto compartido.** El escaneo de rutas del host y las vistas
   de log consumían unos 46k de los 100k hechos antes de parsear; ahora usan un pool propio
   (`975b3d48`, `7d47a938`).
4. **`identity-conflict` espurio.** Los hilos hijos de Codex (`session_id` = raíz del árbol,
   `parent_thread_id` presente) y los transcripts de solo títulos marcaban la población del host como
   incompleta (`d286a9f2`).

**Antes y después sobre la ventana de R41 (2026-10-04..2026-10-07):**

| Métrica | Antes | Después |
| --- | --- | --- |
| `coverage0` | `null` (`incomplete-enumeration`) | audited 11 / host 205 / captured 11, ratio 0.0537 |
| `agent.implementer.launches` | `null` | 9 |
| `agent.implementer.sessions` | `null` | 3 |
| `agent.implementer.cacheRead.p50` | `null` | 1,133,553 (n = 9) |
| `hooks.perBashCall` | `null` | 5.22 (p90 6) |

Antes había 8 agentes `implementer` en disco, 3 transcripts parciales y disponibilidad observada
0 / parcial 8. Después, los lanzamientos observados son 9/9 y los 3 transcripts quedan en estado
`observed` (`schemaVersion` 11). Son 9 y no 8 porque la sesión viva ganó un `implementer` entre
mediciones. Estas cifras son **solo descriptivas**: no hay base contra la cual compararlas.

**Por qué no es evaluable:**

- **La base T9 es irrecuperable.** En disco solo quedan 4 de los 24 transcripts de la base y
  7 lanzamientos de `implementer`; no se puede recalcular con el minero corregido.
- **n ≥ 100 es inalcanzable** para la base y para cualquier ventana actual.
- **Las instantáneas escritas antes de esta corrección subcuentan** (recorte y registros sobre el
  tope contados como pérdida) y no son válidas para R43.

Los `null` del cierre del 2026-10-06 eran un defecto de entrada (evidencia degradada a `partial`),
no una compuerta de cobertura. R28 y el disparador de R41 siguen como están.

## Resultados de las sondas (T2)

Host Claude Code **2.1.287**, `claude -p`, repo scratch. Costo total aproximado: **USD 0.47** (10
sesiones, ocho con haiku y dos con sonnet `--effort low`). Fixtures redactadas en
`packages/cli/src/lib/__tests__/fixtures/claude-live-2.1.287/`.

1. **`PostToolUseFailure` (gate de R17): pasa.** `error` trae `Exit code N` y después stdout y
   stderr intercalados; no hay `tool_response`. Con salida grande (~10 KB) el host trunca en el
   medio (`... [20012 characters truncated] ...`) y la cola real se pierde. **T23 y T24 proceden**:
   la firma sale del código de salida más la cabeza normalizada, no de la cola.
2. **Unidad de `maxTurns`:** cuenta mensajes del asistente (`message.id` deduplicado), no llamadas
   a herramientas; un lote de 3 llamadas paralelas cuenta como un turno. Coincide con la medición
   de T3/T9, así que el **`maxTurns: 160` de T36 se mantiene**. Tras `SendMessage` el contador se
   reinicia.
3. **Marca parcial (R42):** no hay campo estructurado; `status` es `"completed"` y la marca es
   texto (`stopped at its N-turn limit`).
   - Solo es visible en el `tool_response` de `PostToolUse(Agent)` en foreground.
   - **`SubagentStop` no se dispara al alcanzar el tope.**
   - En background y en agentes reanudados con `SendMessage` el hook no la ve: llega solo al
     orquestador, como task-notification.
   - El transcript del subagente no marca nada, así que `error_max_turns`/`max_turns` siempre dan
     `false` en 2.1.287 (consecuencia para T3 y T45).
4. **`Agent(<nombre>)` como `if`: no matchea por nombre.** Solo disparan `Agent(*)`, `Agent`, `Task` o
   sin `if`. R40: el hook corre en cada `Agent` y filtra `subagent_type` en el script.
5. **`ask` de un hook en `-p` actúa como `deny`,** igual en el hilo principal y en el subagente.
   Sin verificar: sesión interactiva.
6. **`Agent(a, b)` dentro de un subagente se ignora:** el anidado se permite y la lista de nombres no
   restringe destinos (`nester` con `Agent(cappedpar)` despachó también `capped`). R36 aplica y R37
   no se activa.
7. **`effort` en `Stop`** llega como objeto `{level}` (`.effort.level`); con haiku la clave no
   aparece. Respaldo: `$CLAUDE_EFFORT` o "desconocido".
8. **`CLAUDE_CODE_SESSION_ID`** está presente en el env de Bash y coincide con `session_id`.
9. **`tgrep status` no tiene `--json`;** D6 parsea el texto `Server: not running`.
10. **`codegraph status --json` sale con exit 0 aun sin índice** (`{"initialized":false,…}`): R32 y
    `navori doctor` deciden por `.initialized`, no por el exit code.
11. **Compactación:** el transcript registra `subtype: compact_boundary` más un mensaje con
    `isCompactSummary`; R65 cuenta solo `compact_boundary` (sumar ambos duplica). La compactación
    dispara además un `SubagentStop` con `agent_type: ""`, que todo hook de `SubagentStop` debe
    ignorar.

Fixtures por sonda: `probe1*` (PostToolUseFailure), `probe2-maxturns-unit`, `probe2-*` (marca
parcial y task-notification), `probe3-*` (effort), `probe4-*` (session id), `probe5-*` (`if`, `ask`,
anidado), `probe6-*` (tgrep, codegraph) y `probe7-compaction`.
