# Paridad Codex — Design

**Base:** `bb1470d5` · **Requirements:** [requirements.md](requirements.md) · **Challenge:**
[challenge.md](challenge.md) (hallazgos 1–5 incorporados) · **Reemplaza:** la decisión D5 de la spec
0033 en lo que toca a Codex.

Los hechos de Codex que cita este documento se verificaron contra el código fuente de
`openai/codex` en `rust-v0.157.0` (rutas bajo `codex-rs/`) y contra `codex-cli 0.157.0`.

## Approach

El render de Codex ya copia los 16 scripts; lo que falta es **registrarlos** y que **entiendan el
payload de Codex**. La spec 0033 D5 declaró `advisory` esos controles porque en 2026-09-24 no se
había comprobado qué eventos y payloads ofrece Codex. Ahora sí se comprobó: Codex 0.145+ tiene un
evento equivalente para 13 de los 16 registros de Claude. La estrategia es:

1. **Una tabla de registro por hook** (`CODEX_HOOK_REGISTRATIONS`) que sustituye el registro a
   mano de `buildCodexConfigToml`. Cada hook de Claude tiene una fila: evento y matcher de Codex, o
   `unsupported` con razón. Un test cruza esa tabla contra el registro de Claude (R3).
2. **Un solo adaptador de payload** en `_partials`, no ramas por script. El partial sabe que corre
   bajo Codex porque el script vive en `.codex/hooks/`, y normaliza lo que cambia (nombre de
   herramienta, rutas editadas por `apply_patch`, tipo de subagente, raíz del proyecto, carpeta de
   progreso). Bajo Claude no cambia nada (R4). Los comandos registrados no cambian de forma, así que
   las aprobaciones que el usuario ya dio siguen valiendo.
3. **Lo que Codex no puede preguntar, lo pregunta su política de ejecución.** Codex descarta `ask`
   en un hook. Sus reglas `.codex/rules/*.rules` sí tienen `prompt`. Las mismas reglas traducen
   los permisos de terminal (R5, R9, R10).
4. **La instalación se vuelve un paso explícito:** `navori codex trust` hace lo mismo que `/hooks`
   (escribe la confianza del proyecto y el `trusted_hash` de cada hook), pero después de mostrar
   todo y pedir confirmación (R13–R15). `doctor` y el cierre del render detectan el estado con el
   mismo cálculo, sin escribir (R16, R17).

**Descartado:**

- **Ramas por script** (`if codex …` en cada hook): 12 scripts con la misma normalización
  duplicada; jscpd la rechazaría y cada hook nuevo tendría que recordarla.
- **Detectar el engine por la forma del payload** (`turn_id`, `apply_patch`): funciona hasta que
  Claude agregue un campo con el mismo nombre.
- **Prefijar cada comando con `NAVORI_ENGINE=codex`:** era la primera versión de este diseño. El
  challenge mostró que cambiar el comando invalida el `trusted_hash` de los 4 hooks ya aprobados
  (`hooks/src/engine/discovery.rs` hashea `command`), y `guard-destructive` dejaría de correr hasta
  volver a aprobar. La ubicación del script da la misma certeza sin tocar el comando.
- **Aprobar hooks con `--dangerously-bypass-hook-trust`**: apaga la revisión para toda la sesión y
  para cualquier hook, no solo los de navori.
- **Dejar la confianza como aviso** (solo detectar): el usuario pidió instalación en un paso.

## Components

- **`packages/cli/src/engines/codex/hook-registrations.ts`** (nuevo) — `CODEX_HOOK_REGISTRATIONS`:
  una fila por hook con `script`, `event`, `matcher`, `timeout`, `statusMessage`, condición de config
  y versión mínima de Codex, o `{ unsupported: reason }`. Exporta `resolveCodexHooks(config)`, que
  devuelve los grupos a registrar en orden estable. — R1, R3, R6, R7, R18.
- **`engines/codex/build-config-toml.ts`** (`buildCodexConfigToml`) — deja de escribir hooks a mano y
  serializa `resolveCodexHooks(config)`. Agrega `project_doc_max_bytes` cuando corresponde. — R1, R3,
  R6, R7, R12.
- **`packages/core/core-assets/hooks/_partials/hook-input.sh`** (nuevo) — adaptador de payload.
  Define `nv_engine`, `nv_project_dir`, `nv_progress_dir`, `nv_tool` (nombre de Claude equivalente),
  `nv_edited_paths` (rutas de `apply_patch` o `tool_input.file_path`), `nv_subagent_type` y
  `nv_emit_context` (salida de `additionalContext` en el formato de cada engine). — R2, R4.
- **Los 12 scripts que se registran de nuevo** (`session-start-context`, `plan-gate`,
  `implementer-no-markdown`, `managed-drift-watch`, `routing-watch`, `audit-mode-trigger`,
  `audit-mode-close`, `worktree-reclaim`, `subagent-stop-handoff`, `stop-verify-reminder`, más
  `guard-destructive` y `quality-gate-pre-commit` por sus literales `.claude/`) — leen el payload y
  las rutas solo a través de `hook-input.sh`. — R2, R4.
- **`engines/shared/permission-rules.ts`** (nuevo) — `collectShellPermissionRules(config, plugins)`:
  la lista `allow`/`ask`/`deny` ya fusionada que hoy arma `buildSettings`
  (`engines/claude/build-settings.ts`: `settings-base.json` + `derivedAllow` + preset y plugins).
  `buildSettings` pasa a consumirla, así los dos engines leen la misma fuente. — R9.
- **`engines/codex/build-rules.ts`** (nuevo) — `buildCodexRules(rules)`: traduce a `prefix_rule` y
  devuelve `{ body, dropped }`. Escribe `.codex/rules/navori.rules` con el marcador de archivo
  managed de navori. Incluye la regla `gh pr create → prompt` que sustituye a `pr-publisher-confirm`.
  — R5, R9, R10.
- **`engines/codex/index.ts`** (`CODEX_MODEL_BY_CLAUDE_TIER`) — nuevo mapeo por defecto;
  `models.codexMap` sigue ganando. — R11.
- **`engines/shared/engine-capabilities.ts`** (`ENGINE_CAPABILITIES.codex`) — `plan-gate` y
  `markdown-ownership` pasan a `enforced` con evidencia `hook`. `unsupportedSurfaces` suma las
  filas `unsupported` de la tabla de registro. — R6, R7, R8.
- **`packages/cli/src/lib/codex/trust.ts`** (nuevo) — núcleo sin I/O de consola:
  `codexHookHash(group)` (algoritmo de Codex), `codexHookKey(configPath, event, groupIdx, handlerIdx)`,
  `readCodexTrustState(repoRoot)` (lee `~/.codex/config.toml`, devuelve confianza del proyecto y
  `Trusted`/`Modified`/`Untrusted` por hook) y `planTrustEdit(state)` (el texto nuevo del archivo).
  — R13, R14, R16, R17.
- **`packages/cli/src/commands/codex.ts`** (nuevo) — comando `navori codex` con subcomando `trust`
  (citty + `@clack/prompts`). — R13, R14, R15.
- **`commands/doctor.ts`** (`scanCodexHealth`) — suma la sección de confianza con
  `readCodexTrustState` y la comprobación de versión mínima derivada. — R16, R18.
- **`commands/render.ts`, `sync.ts`, `init.ts`** — al terminar un render con `codex`, corren
  `readCodexTrustState` y, si falta algo, imprimen `navori codex trust` como siguiente paso en lugar
  de `codexTrustHint`. — R17.

## Decisions

### D1 — Tabla de registro por hook (R1, R3, R6, R7, R18)

| Hook | Claude | Codex | Mín. Codex | Nota |
|---|---|---|---|---|
| `guard-destructive` | PreToolUse `Bash` | PreToolUse `^Bash$` | 0.129 | ya registrado |
| `comment-draft-confirm` | PreToolUse `Bash` | PreToolUse `^Bash$` | 0.129 | ya registrado; ya evita `ask` |
| `quality-gate-pre-commit` | PreToolUse `Bash`, si `qualityGate.fast` | igual | 0.129 | ya registrado |
| `model-advisor` | SessionStart, PostModelSwitch, PreToolUse `.*` | SessionStart | 0.129 | ya registrado; Codex no tiene evento de cambio de modelo (spec 0028) |
| `session-start-context` | SessionStart `startup\|resume\|clear\|compact\|fork` | igual | 0.133 | `fork` dispara desde 0.155; antes no ocurre |
| `plan-gate` | PreToolUse `Agent`, si `planTiers` | PreToolUse `^spawn_agent$` | 0.135 | `spawn_agent` pasa por hooks desde 0.135 |
| `implementer-no-markdown` | PreToolUse `Bash\|Edit\|Write\|NotebookEdit`, si `scribeOwnsMarkdown` | PreToolUse `^(Bash\|apply_patch)$` | 0.134 | necesita `agent_type` en el payload |
| `managed-drift-watch` | PostToolUse `Bash\|Edit\|Write\|NotebookEdit` | PostToolUse `^(Bash\|apply_patch)$` | 0.129 | |
| `routing-watch` | PostToolUse `Bash\|Edit\|Write\|NotebookEdit\|Agent\|Task` | PostToolUse `^(Bash\|apply_patch\|spawn_agent)$` | 0.135 | |
| `subagent-stop-handoff` | PostToolUse `Agent\|Task` | SubagentStop (sin matcher) | 0.133 | Codex entrega `agent_type` y `last_assistant_message` directo |
| `audit-mode-trigger` | UserPromptSubmit | igual | 0.129 | |
| `audit-mode-close` | SessionEnd | SessionEnd, timeout 3 | 0.145 | Codex topa SessionEnd a 3 s |
| `worktree-reclaim` | SessionEnd | SessionStart `startup` | 0.133 | ver D6 |
| `stop-verify-reminder` | Stop, si `hooks.verifyOnStop` | igual | 0.129 | |
| `pr-publisher-confirm` | PreToolUse `Bash` (`ask`) | no se registra: regla `prompt` | — | ver D4 |
| `subagent-no-background` | PreToolUse `Bash\|Monitor` | `unsupported` | — | Codex no tiene `Monitor`. Sus comandos largos siguen vivos como sesiones de `unified_exec`, pero el hook los ve como `Bash` con solo `command` (`core/src/tools/handlers/unified_exec/exec_command.rs` quita `yield_time_ms` del payload, y `write_stdin` no emite PreToolUse): ningún hook puede distinguir un comando en segundo plano |

**Versión mínima derivada:** el máximo de la columna entre los registros activos. Con la
configuración por defecto es **0.145.0**, la misma `MIN_CODEX_VERSION` de hoy; se calcula de la
tabla en vez de fijarse a mano, para que un registro nuevo la suba solo (R18).

**Orden de grupos estable:** el orden de la tabla fija el índice de grupo de cada evento, que forma
parte de la clave de aprobación de Codex. Los 4 registros de hoy conservan su comando, matcher,
timeout, `statusMessage` e índice, y todo registro nuevo se agrega **después** de ellos dentro de su
evento. Así un re-render no invalida ninguna aprobación existente: los hooks nuevos quedan
`Untrusted` y los viejos siguen `Trusted`. Un test fija el `trusted_hash` de los 4 registros
actuales para que ningún cambio futuro los mueva sin querer.

### D2 — Adaptador de payload por ubicación del script (R2, R4)

El comando registrado en Codex no cambia de forma:
`bash "$(git rev-parse --show-toplevel)/.codex/hooks/<script>.sh"`. El partial `hook-input.sh`
fija `nv_engine=codex` cuando el directorio del script (`BASH_SOURCE`) termina en `.codex/hooks`, y
`claude` en cualquier otro caso. Después resuelve:

| Función | Claude | Codex |
|---|---|---|
| `nv_project_dir` | `$CLAUDE_PROJECT_DIR` | `git -C "$cwd" rev-parse --show-toplevel`, con `cwd` del payload |
| `nv_progress_dir` | `.claude/progress` | `.codex/progress` (el espejo de `CODEX_MIRRORED_DIRS`) |
| `nv_tool` | `tool_name` | `apply_patch`→`Edit`, `spawn_agent`→`Agent`, resto igual |
| `nv_edited_paths` | `tool_input.file_path` / `notebook_path` | encabezados `*** Add File:`, `*** Update File:`, `*** Delete File:` y `*** Move to:` del parche |
| `nv_subagent_type` | `tool_input.subagent_type` | `tool_input.agent_type` en PreToolUse; `agent_type` en SubagentStop |
| `nv_emit_context` | salida que ya usa cada script | `{"hookSpecificOutput":{"hookEventName":…,"additionalContext":…}}` |

`CODEX_MIRRORED_DIRS` solo decide **dónde se escriben** los archivos en el render; no reescribe los
literales `.claude/` dentro de los scripts. Por eso los 8 scripts con literales `.claude/` pasan a
usar `nv_progress_dir`/`nv_project_dir`. La decisión de bloquear o permitir no cambia: el partial
solo normaliza la entrada, y la salida de bloqueo (`exit 2` + stderr, o `deny` con razón) ya es
válida en los dos engines.

**Compatibilidad con #1046:** ese issue moverá el estado efímero a un directorio neutral. Con este
diseño el cambio queda en una línea de `nv_progress_dir`, no en 8 scripts.

### D3 — Contexto de arranque bajo Codex (R2)

Bajo Codex, `session-start-context` emite solo la parte **viva**: rama, aviso de rama base, commits
recientes, `progress/current.md`, worktrees conservados y estado de audit mode. No emite
`.claude/context/*.md`: esa doctrina ya llega completa dentro de `AGENTS.md`, y repetirla gastaría el
límite de `additionalContext` (2500 tokens por defecto, unos 10 000 caracteres). La parte viva
reusa el mismo tope de 8000 caracteres y el mismo puntero "léelo con Read" que Claude cuando
`progress/current.md` no cabe.

### D4 — Lo que Claude pregunta con `ask` (R5)

Codex descarta `permissionDecision: "ask"` y deja pasar la llamada. `pr-publisher-confirm` no se
registra en Codex; su intención (que un humano confirme un `gh pr create`) se expresa con
`prefix_rule(pattern=["gh", "pr", "create"], decision="prompt")` en `.codex/rules/navori.rules`.

**Trade-off aceptado:** la regla no distingue quién lanza el comando, así que bajo Codex el
`publisher` también recibe la confirmación. Crear un PR es una acción hacia afuera, y una
confirmación de más cuesta menos que un PR sin revisar. La alternativa (bloquear con `deny` fuera
del `publisher`) rompe la regla del propio hook de no bloquear nunca.

Un test recorre `core-assets/hooks/*.sh` y falla si un script registrado en Codex puede emitir
`"ask"` sin rama para `nv_engine=codex`.

### D5 — Traducción de permisos a reglas de Codex (R9, R10)

Fuente: `collectShellPermissionRules`, extraída de `buildSettings` para que los dos engines lean la
misma lista (invariante de fuente única). Traducción de cada `Bash(<patrón>)`:

- `allow`→`allow`, `ask`→`prompt`, `deny`→`forbidden`.
- El patrón se parte en tokens por espacios. Un ` *` o `:*` al final significa "prefijo" y se quita.
- Un `*` pegado al **último** token (`git tag -l*`, `git remote -v*`, `git push --force*`) se
  traduce al token exacto sin el asterisco. Claude acepta además variantes como `--force-with-lease`;
  Codex solo el token exacto.
  - En `allow` eso es más estricto que Claude, así que es seguro: ese comando solo pedirá
    aprobación más seguido.
  - En `prompt` y `forbidden` es **menos** estricto. La regla se escribe igual, porque cubre el caso
    principal, y se reporta como "acotada" en la advertencia. `guard-destructive` sigue cubriendo
    esas variantes en tiempo de ejecución.
- Si queda un comodín (`*`, `?`, `[`) en cualquier otra posición, la regla no cabe como prefijo y
  se omite (R10). Ejemplo: `Bash(rm -rf /*)`.
- Las reglas que no son `Bash(...)` (`Read`, `Glob`, `Agent(orchestrator)`) se omiten (R10).

El render emite **una sola advertencia agregada**, que no bloquea, con el conteo de reglas omitidas
y acotadas por motivo. La lista completa sale en `navori render --json`, no una línea por regla.

### D6 — `worktree-reclaim` se mueve a SessionStart en Codex

Codex topa `SessionEnd` a 3 s y la limpieza de worktrees corre `git worktree` sobre cada uno, lo
que puede tardar más. Bajo Codex corre al **inicio** de la siguiente sesión (`startup`), con el
timeout normal. El resultado es el mismo con una sesión de retraso: la limpieza nunca es urgente.
`audit-mode-close` sí queda en `SessionEnd` con timeout 3: solo cierra un log y ya es fail-open.

### D7 — Modelos (R11)

`CODEX_MODEL_BY_CLAUDE_TIER = { opus: "gpt-6-sol", sonnet: "gpt-6-sol", haiku: "gpt-6-luna" }`,
decisión del usuario del 2026-09-25. opus y sonnet comparten modelo y se distinguen por
`model_reasoning_effort`, que ya sale de `effort`.

### D8 — Tope de `AGENTS.md` (R12)

`buildCodexConfigToml` recibe el tamaño en bytes del `AGENTS.md` planeado. Si pasa de 32768,
escribe `project_doc_max_bytes` con la siguiente potencia de dos que sea mayor o igual al tamaño más
8192 bytes, para dejar lugar a los `AGENTS.md` anidados que Codex suma a la cadena. Hoy el render
escribe `AGENTS.md` y `config.toml` en el mismo plan, así que el tamaño se toma del contenido
planeado, no del disco.

### D9 — `navori codex trust` (R13, R14, R15)

**Forma:** comando nuevo `navori codex` con subcomando `trust`, para dejar lugar a otros
subcomandos del engine sin llenar la raíz. Flags: `--yes` (no interactivo) y `--cwd`.

**Qué escribe:** para cada `.codex/config.toml` que navori generó en el repo, la raíz y cada
workspace con `codex`. Codex carga la capa `.codex/` de cada directorio entre el `cwd` de la sesión
y la raíz del proyecto (`config/src/loader/mod.rs`), así que la configuración de un workspace solo
se activa cuando la sesión arranca dentro de él. Aprobarla de antemano evita que esa primera sesión
corra sin hooks:

- `[projects."<raíz git>"] trust_level = "trusted"`, una vez por repo. Codex busca la confianza en la
  raíz git, así que los worktrees la heredan.
- `[hooks.state."<clave>"] trusted_hash = "<hash>"` por cada hook de `resolveCodexHooks`.

**Cómo calcula el hash:** reimplementa en TypeScript el algoritmo de Codex (`discovery.rs`,
`config/src/fingerprint.rs`): `"sha256:" + sha256` del JSON compacto con llaves ordenadas de
`{event_name, matcher?, hooks:[{type, command, timeout, async, statusMessage?}]}`. Los datos salen
del mismo modelo que serializa el TOML, no de volver a leerlo. Un test dorado fija los 4 hashes
que Codex 0.157 escribió para este repo. Se descartó preguntarle a Codex con `hooks/list`
durante la escritura: está marcado como experimental, requiere el binario y levantar un proceso,
y el comando tiene que funcionar antes de que Codex abra el repo por primera vez.

**Verificación posterior:** si `codex` está instalado, tras escribir se consulta `hooks/list`
(`codex app-server`) y se reporta cualquier hook que Codex no vea como `Trusted`. Si el binario no
está, se dice que la verificación se omitió. Esto caza el día en que Codex cambie su algoritmo.

**Cómo edita `~/.codex/config.toml`:** edición de texto acotada, no reserializar. Por cada clave:
si la tabla existe, se reemplaza solo su línea `trusted_hash` o `trust_level`; si no, se agrega la
tabla al final. El resultado se valida con un parser TOML antes de escribir; si no parsea, no se
escribe. Escritura atómica (temporal + rename) que conserva el modo `0600`. Respaldo previo en
`~/.navori/backups/codex-config-<timestamp>.toml`, el mismo directorio que usa `navori global`.
Ninguna otra clave se toca, incluidas aprobaciones viejas de navori con índices que ya no existen:
son inofensivas.

**Confirmación:** muestra la ruta del proyecto y una tabla con evento, matcher y comando de cada
hook, y cuántos ya estaban aprobados. Sin confirmación explícita, o sin TTY y sin `--yes`, termina
con código distinto de 0 y sin escribir (R15). Es idempotente: si todo está aprobado, lo dice y no
escribe ni respalda.

**Dependencia nueva:** `smol-toml`, solo para validar el resultado. Es pequeña y sin dependencias,
y lo que está en juego es corromper la configuración global del usuario. Validar con expresiones
regulares no basta para eso.

### D10 — Detección sin escritura (R16, R17)

`readCodexTrustState` compara lo que `resolveCodexHooks` generaría contra `~/.codex/config.toml`,
con el mismo cálculo de hash: `Trusted` si coincide, `Modified` si hay hash distinto y `Untrusted`
si no hay. No levanta procesos, así que `doctor` y el cierre del render siguen siendo rápidos y
funcionan sin Codex instalado. Si `~/.codex/config.toml` no existe, todo es `Untrusted` y el
proyecto no es de confianza.

`doctor` agrega a la sección Codex una fila por estado y nombra `navori codex trust` como el
arreglo. Hay dos mensajes distintos. Si el proyecto no es de confianza, dice "Codex no carga nada
de este repo, ni `AGENTS.md`", y lo marca como error. Si el proyecto es de confianza pero hay hooks
sin aprobar, lo marca como advertencia y dice cuántos. `render`/`sync`/`init` imprimen una sola línea con ese comando si algo falta, y reemplazan
el `codexTrustHint` genérico de hoy.

## Contracts

- **`.codex/config.toml`:** los 4 registros actuales quedan idénticos y en el mismo índice. Los
  grupos nuevos se agregan después de ellos en cada evento. Se agrega `project_doc_max_bytes` cuando
  corresponde.
- **`.codex/rules/navori.rules`:** archivo nuevo, managed completo por navori, con encabezado de
  marcador y versión como los demás archivos generados. Entra en el backup y en el anti-rollback
  igual que el resto del render.
- **Scripts de hook:** bajo Claude, entrada y salida idénticas a hoy. Bajo Codex, misma decisión
  para el payload equivalente.
- **`~/.codex/config.toml`:** navori solo escribe dos formas de tabla (`projects.<ruta>` y
  `hooks.state.<clave>`) y solo desde `navori codex trust` con confirmación.
- **`ENGINE_CAPABILITIES.codex`:** `plan-gate` y `markdown-ownership` pasan a `enforced`. Esto
  reemplaza la decisión D5 de la spec 0033 para Codex; los demás engines no cambian.

## Failure modes

- **Codex cambia el algoritmo de hash.** La escritura produce `Modified` en vez de `Trusted`. La
  verificación con `hooks/list` lo detecta y lo reporta; el usuario todavía puede aprobar con
  `/hooks`. El test dorado se actualiza con los hashes de la versión nueva.
- **Ruta con enlaces simbólicos.** Si Codex construye la clave con una ruta distinta a la que
  calcula navori, el hook queda `Untrusted`. La verificación posterior lo caza; la clave se construye
  con la ruta absoluta sin resolver enlaces, igual que las claves que ya existen.
- **`~/.codex/config.toml` modificado mientras corre `trust`.** Se relee justo antes de escribir;
  si cambió desde que se mostró la confirmación, se aborta sin escribir.
- **Hook que falla bajo Codex por un payload inesperado.** Todos los hooks nuevos son fail-open
  salvo `plan-gate` e `implementer-no-markdown`, que ya bloquean bajo Claude. Si el partial no puede
  leer el payload, estos dos siguen la política que ya tienen para payloads ilegibles en Claude.
- **Versión de Codex menor que la mínima.** Codex ignora eventos que no conoce o no los dispara.
  `doctor` y el render lo advierten con la versión mínima derivada (R18).
- **Proyecto sin confianza.** Codex no carga **nada** del proyecto: ni `.codex/` (config, hooks y
  reglas) ni `AGENTS.md` (`core/src/agents_md.rs`, `load_project_instructions` sale temprano con
  `is_untrusted()`). La sesión corre sin harness. D10 separa este caso ("el proyecto no es de
  confianza: Codex no carga ni `AGENTS.md`") del caso "proyecto de confianza con hooks sin aprobar",
  porque el primero es mucho más grave.

## Migration

En los repos que ya renderizaron Codex (este, `monorepo-fullstack` y moonar), los 4 hooks ya
aprobados **siguen aprobados**: su comando, sus campos y su índice no cambian (D1, D2). Los hooks
nuevos llegan `Untrusted` y no corren hasta aprobarlos. El cierre del render lo detecta (D10) y pide
correr `navori codex trust`. En ningún momento un repo queda con menos protección que hoy. No se
migra `~/.codex/config.toml` automáticamente.

## Testing strategy

- **Aprobaciones existentes intactas:** el `.codex/config.toml` renderizado reproduce los 4
  `trusted_hash` que Codex escribió para los registros actuales, en sus mismas claves.
- **R3 — ningún hook se queda sin decidir:** para cada hook que registra `buildSettings`, existe
  una fila en `CODEX_HOOK_REGISTRATIONS`, registrada o `unsupported` con razón, y cada
  `unsupported` aparece en `ENGINE_CAPABILITIES.codex.unsupportedSurfaces`.
- **R4 — mismo veredicto con los dos payloads:** fixtures pareados (Claude y Codex) para
  `plan-gate`, `implementer-no-markdown`, `guard-destructive` y `subagent-stop-handoff`; el test
  corre el script con cada uno y compara decisión y código de salida.
- **R1/R2 — contexto de arranque:** correr `session-start-context` con payload de Codex en un repo
  temporal y verificar JSON válido con rama, commits y `progress/current.md` en `additionalContext`.
- **R5 — sin `ask` bajo Codex:** el recorrido de scripts descrito en D4.
- **R6/R7/R8 — controles aplicados:** `control-inventory.test.ts` deja de excluir a Codex y
  verifica evento y matcher de cada `enforced` en el `.codex/config.toml` renderizado.
- **R9/R10 — reglas:** tabla de casos de traducción (prefijo, `*` pegado al último token en
  `allow` y en `forbidden`, comodín interno, no-Bash) y un test
  de que la lista de `buildSettings` y la de `buildCodexRules` vienen de la misma función.
- **R11/R12:** golden del TOML de un agente por tier; `project_doc_max_bytes` presente solo por
  encima de 32768.
- **R13–R15 — escritura segura:** hash dorado con los 4 hashes reales; edición sobre un
  `config.toml` con comentarios y tablas ajenas, verificando que todo lo demás queda byte a byte;
  sin confirmación no hay escritura ni backup; segunda corrida idempotente.
- **R16/R17:** los tres estados (`Trusted`, `Modified`, `Untrusted`) y el proyecto sin confianza,
  con mensajes distintos para cada caso.
- **R18:** versión mínima derivada de la tabla, y advertencia con Codex más viejo.
- **Humo manual antes del PR final:** `navori codex trust` en `monorepo-fullstack` y una sesión real
  de `codex exec` que confirme el contexto de arranque y que `plan-gate` bloquee un `spawn_agent` sin
  workplan.

## NOT in scope

- **#1046 (directorio de estado neutral):** este diseño solo lo deja a una línea de distancia (D2).
- **Restringir MCP por agente en Codex:** el TOML de agentes no tiene un equivalente a `tools:`; es
  otra superficie.
- **Agente `orchestrator` para Codex:** el hilo principal ya cumple ese rol (spec 0007).
- **Sincronizar `~/.codex/AGENTS.md` con `~/.claude/CLAUDE.md`:** es prosa del usuario, fuera del
  harness del repo.
- **Aprobar sin confirmación** o con `--dangerously-bypass-hook-trust`.
- **Permisos que no son de terminal** (lectura y escritura por ruta): Codex no tiene un mecanismo
  equivalente; quedan en el sandbox (`workspace-write`).
