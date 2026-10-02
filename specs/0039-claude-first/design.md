# Claude first — Design

**Estado:** revisado tras el challenge (`.navori/state/handoffs/challenge_0039.md`) con el
veredicto del orchestrator aplicado. No autoriza implementación.
**Señales:** decisión difícil de revertir (dirección y retiro de unidades por engine), contrato
compartido (matriz de solapamiento, workplan, handoff, reporte de audit), área crítica (hooks,
prune y backup en el repo del usuario, marcadores managed, reglas `ask`), migración de repos ya
instalados.
**Base inspeccionada:** `01f3ac97`. `git fetch origin main` el 2026-09-30 dio `origin/main` =
`01f3ac97` = `HEAD`. Anclas = archivo + símbolo, id de bloque managed o encabezado. Rutas
`commands/`, `lib/` y `engines/` son relativas a `packages/cli/src/`; `core-assets/` a
`packages/core/`.
**Absorbe** el diseño de la 0038 ([`specs/0038-aprendizajes-curso-harness/design.md`](../0038-aprendizajes-curso-harness/design.md)) y su challenge. Sus decisiones D1–D11 se conservan para B, C, D e I (R46–R47) con los
R-ids renumerados; los únicos cambios son los que exige R28 (D5). **R45 está retirado** en
requirements.md (B3) y no tiene componente.

## Approach

Claude Code es el engine de referencia. Cada unidad distribuida tiene una fila tipada en una matriz
de solapamiento que el render consume; una unidad solo deja de emitirse en Claude cuando su fila
cita una capacidad nativa verificada en la doc oficial, con fecha, y los demás engines la siguen
recibiendo. El resto son mecanismos pequeños sobre piezas existentes: evidencia y atasco en hooks
de observación fail-open, el guard de búsqueda rescatado de la historia, campos nativos de agente
(`maxTurns`, `tools`) y una sola extensión de `lib/audit` que produce líneas base y comparaciones.

### Decision drivers

`docs/DIRECTION.md` — invariante 9: navori no ejecuta el `command` de un criterio. Invariantes 2 y
7: el soporte por engine es una tabla sobre el spine, no ramas por adapter. Invariantes 4 y 5 y el
área crítica de `CLAUDE.md` § Contexto del proyecto: un retiro por engine reutiliza
`lib/render/removable.ts` — `isRemovableNavoriFile` y el backup de `engines/shared/execute-plan.ts`;
no nace una cuarta vía de borrado. `Metas` (calidad > tokens > velocidad) y R28: ningún camino de
una llamada Bash corre más hooks. `Criterio de admisión de agentes`: ampliar `scout`/`architect`
declara garantía, señal y retiro. `requirements.md` § Alcance: sin doc oficial verificada no hay
retiro; lo no verificable es no soportado.

### Qué ya existe (verificado en `origin/main` = `01f3ac97`)

| Ancla | Qué resuelve hoy | Hueco |
|---|---|---|
| `engines/shared/roster.ts` — `RETIRED_AGENTS`, `RETIRED_SKILLS`, `RETIRED_HOOKS`, `Retired.markerIdByAdapter` | Retiro global append-only con marcador por adapter. El encargo citaba `lib/retired-names.ts`; el archivo real es `lib/assets/retired-names.ts` y solo barre ids retirados en assets | No hay retiro **por engine**: `sweepRetiredNames` falla si el id sigue en cualquier asset distribuido |
| `engines/claude/index.ts` — §8.7b/c/d, `planRetiredHookRemoval`, `planRetiredAgentRemoval`, `planDirSkillRemoval`, `reportKeptRetired`; loop de `RETIRED_PLUGIN_SUB_BLOCKS` con `removeManagedSection` (`lib/render/marker.ts`) | Prune de archivos y secciones managed, con marcador y versión | `removeManagedSection` (`lib/render/marker.ts`) no mira `version=` ni hash; `isRemovableNavoriFile` sin `verifyHash` borra archivos con texto de usuario fuera del marcador (B2) |
| `engines/shared/engine-capabilities.ts` — `ControlId`, `CONTROL_DEFINITIONS`, `ENGINE_CAPABILITIES`; `lib/diagnose/control-gaps.ts` — `scanControlGaps` | Declaración de controles por engine y reporte en doctor | Faltan los controles nuevos |
| `engines/claude/build-settings.ts` — `buildClaudeSettings(config, plugins)`; `engines/claude/coexist-settings.ts` — `injectHooks`, `stripTrackedHooks` | Registra hooks core desde constantes `*_HOOK_DEST` y hooks de plugin desde `plugin.manifest.hooks`; en coexist rastrea por `command` | No recibe `HarnessPlan`: filtrar el plan no quita la registración (B1). Coexist deduplica por `command` y perdería handlers con distinto `if` (M1) |
| `core-assets/hooks/routing-watch.sh` | PostToolUse(Bash\|Edit\|Write\|…) incondicional, con ruta rápida fork-free, stamp por sesión, sweep de 7 días | — |
| `git show 7c6930dc^:packages/plugins/tgrep/scripts/guard-search-routing.sh` y su test `lib/__tests__/guard-search-routing.test.ts` | Segmentador que respeta comillas, distingue pipe de inicio, `names_a_file`, heredoc inerte, tope de 20k caracteres. Medido: 55% de búsquedas genuinas, cero extracciones | Remedio apuntaba al wrapper retirado |
| `lib/config/plugins.ts` — `HookEntrySchema`; `packages/plugins/jscpd/plugin.json` `hooks` | Un plugin ya registra hooks PreToolUse | Sin campo `if` |
| `core-assets/hooks/master-accept-confirm.sh` | `ask` para `navori master part … --approved-by` | Solo esa forma literal |
| `lib/render/removable.ts` — `navoriAuthorship(path, markerId, { verifyHash })` | Veredictos `ours`/`newer`/`foreign`/`modified` con hash opcional | La opción existe pero ningún prune de retiro la usa |
| `lib/audit/report.ts` — `buildReport` (`totals.byAgentType`), `tallySkills`, `skillRangeSection`; `lib/audit/signals.ts` — `unused-agents` | Tokens por tipo de agente, skills con ceros | Faltan filas por sesión, hilo principal, hooks, tamaños, turnos, Codex e instantáneas (grupo L) |

### Opciones por decisión

**Matriz (R2–R4).** (1) Markdown curado: descartada, R3 y R4 no se hacen cumplir sobre prosa. (2)
**Módulo tipado que el spine consume, con doc generada — recomendada.** (3) Campo
`nativeReplacement` por asset: descartada, dispersa la matriz en ~60 archivos y no cubre plugins ni
flujos (R57). **Retiro (R5).** (1) Sembrar en `RETIRED_*`: descartada, `sweepRetiredNames` rompe
mientras otro engine reciba el asset. (2) **Loop nuevo del adapter Claude sobre filas `claude:
native` que reutiliza los planificadores de §8.7 — recomendada.** **Guard (R29).** (1) Reescribir:
descartada, la heurística medida es el valor. (2) Portar `7c6930dc^` como hook aparte con `if`:
viable, pero deja un camino en +1 (D5). (3) **Portar el script y ejecutarlo como carril del plugin
dentro de `guard-destructive` — recomendada.** **R28.** Ver D5: ningún camino sube si
`model-advisor` pasa a `Stop`, el carril de éxito de la evidencia vive en `routing-watch` y el guard
no agrega registración.

## Fases

Cada fase es un PR, o dos donde se indica. Toda fase que agrega una unidad distribuida agrega su
fila de la matriz y sus contadores de R70 en el mismo PR (el test de cobertura de D2 lo exige).

| Fase | Contenido | Requisitos | Depende de |
|---|---|---|---|
| **F0a** Verificación | Doc de verificación: cada capacidad de `evidence.md` con URL y fecha. Pre-registro de R34, R43 y del disparador de R41. Sondas live: `PostToolUseFailure` (R17), forma de la marca parcial y conteo de turnos de `maxTurns`, `effort` en `Stop`, `CLAUDE_CODE_SESSION_ID` en Bash, `Agent(<nombre>)` en `if` | R3 (insumo), R17, R34, R43 (criterio) | — |
| **F0b** Medición | Extensión de `lib/audit` (I + L) y el **marco** de conteo de R70 (sin contadores de mecanismos que aún no existen). Cierra con la instantánea base: R43, hooks por Bash de R28, tamaños de R33 | R46–R49, R61–R71 | F0a |
| **F1** Matriz | Módulo, inventario filtrado para archivos **y** registraciones, doc generada, R1, loop de retiro con guardas, filas de R57 | R1–R5, R57 | F0a |
| **F2** Hooks | `rm -f`, audit de `plan-gate`, dedupe del handoff, `model-advisor` a `Stop`, test de R28 por camino | R23–R28 | F0a |
| **F3** Evidencia y atasco | Carry-over de 0038 D1–D8 con D5 | R6–R17 | F2, F0a (R17) |
| **F4** Reviewer | Carry-over de 0038 D9–D10 | R18–R22 | F3 |
| **F5a** Guard | Guard tgrep + fix de coexist | R29–R31 | F2, F0a |
| **F5b** codegraph | Cableado, medición y veredicto | R32–R35 | F0b, F1 |
| **F6** Agentes | `architect`, `scout`, `general-purpose` | R36–R40 | F0a, F5b (R38) |
| **F7** Tokens | `maxTurns`, handoff parcial, aviso de compactación | R41–R44 | F0b, F2 |
| **F8** Memoria | Evaluación de engram y su fila | R50, R51 | F0b, F1 |
| **F9** Master plan | Grupo K completo | R52–R60 | F0b (writer de eventos CLI); F1 solo para las filas de R57 |

F2, F5a y F9 son independientes entre sí. **Cierre:** `navori audit --compare` contra la
instantánea de F0b para R28 y R43.

## Components

| Componente / ancla | Cambio | Req. |
|---|---|---|
| `docs/research/claude-first-verificacion.md` (nuevo) | Capacidad → URL, fecha, versión de CC y cita; pre-registros; capturas de F0a | R3, R17, R34, R43 |
| `lib/audit/parse.ts` — `AgentRun`, orquestador | `turns` (dedupe por `message.id`), `turnLimitHit`, `toolResultBytes`, `contextPeak`, `compactions`; sesión Codex solo desde el log | R64, R65, R71 |
| `lib/audit/model.ts` — `AuditReport` | `schemaVersion: 10`; `rangeMetrics: Record<string, number \| null>`; `byAgentType[*].sessions`; fila `main-thread` | R48, R63–R65, R70 |
| `lib/audit/report.ts` — `buildReport`, `agentRangeSection` (nueva), `hookRangeSection`, `toolRangeSection`, `mechanismSection` | Agentes por sesión con ceros; web por agente; hooks por rango; bloqueos por regla con 3 ejemplos; tamaños; turnos; tabla genérica de veredictos | R46–R49, R63–R66, R70 |
| `lib/audit/signals.ts` | Candidatos managed con N sesiones; ports de `mine-search-routing.py` y `mine-activation.py` (+ % de ediciones del hilo principal) | R47, R67 |
| `lib/audit/discovery.ts` | Todos los repos de `~/.navori/audits/`; sesiones del host por slug del repo **y** sus `--claude-worktrees-*` | R61, R62 |
| `lib/audit/snapshot.ts` (nuevo); `commands/audit.ts` — `--all-repos`, `--snapshot <nombre>`, `--copy-to <ruta>`, `--compare <archivo>` | Instantánea con formato versionado propio bajo la raíz de audit; copia al repo solo a ruta explícita; diff por métrica | R61, R68, R69 |
| `lib/audit/cli-event.ts` (nuevo) | `appendCliEvent(cwd, { name, verdict })` al log de sesión, si existe | R55, R70 |
| `engines/shared/native-overlap.ts` (nuevo) | `OVERLAP_ROWS`, `OverlapRowSchema`, `filterInventory({ plan, plugins }, engine)`, `nativeEmissionsFor(engine)` | R2–R4, R35, R37, R51, R57 |
| `engines/claude/build-settings.ts` — `buildClaudeSettings`; `engines/claude/index.ts` (sitio de llamada); `engines/claude/global-plugin.ts`; `engines/codex/hook-registrations.ts` (resolución) | Registraciones core y de plugin derivadas del inventario filtrado; el plugin global aplica el mismo filtro | R4 |
| `engines/claude/index.ts` — §8.7e (nuevo); `lib/render/marker.ts` — `removeManagedSectionGuarded` (nuevo); `lib/render/removable.ts` — opción `requirePristine` | Prune por engine con anti-rollback, hash y texto fuera del marcador; salta rutas ya en `pending` | R5 |
| `docs/native-overlap.md` (generada); `docs/DIRECTION.md` — `Criterio de admisión por superficie` | Vista de la matriz con URL y fecha por fila, fijada por golden; párrafo "Claude primero, nativo primero" | R1, R2 |
| `core-assets/hooks/guard-destructive.sh` — regla 3 (`rm_kill`) | Variable como destino exige `-r`, `-R` o `--recursive`; raíz, home y tmp sin cambio | R23, R24 |
| `core-assets/hooks/plan-gate.sh` | `# navori:include audit-log` y trap de veredicto | R25 |
| `core-assets/hooks/subagent-stop-handoff.sh` | Stamp por (ruta, hash); carril de parcial; carril de compactación (solo modo Claude) | R26, R42, R44 |
| `core-assets/hooks/model-advisor.sh`; `build-settings.ts`; `lib/diagnose/host-contracts.ts` (`claude-model-advisor-payload`); `engines/shared/harness-plan.ts` — JSDoc de `MAIN_THREAD_ONLY_HOOKS` | Modo `claude-stop` en lugar de `claude-pre-tool-use`, registro en `Stop` | R27 |
| `lib/__tests__/hooks-per-bash.test.ts` (nuevo) | Cuenta entera por camino sobre fixtures con tgrep y en coexist, evaluando los `if` | R28 |
| `core-assets/hooks/_partials/bash-outcome.sh` (nuevo); `routing-watch.sh` (carril de éxito); `core-assets/hooks/bash-outcome-watch.sh` (nuevo, solo `PostToolUseFailure`) | Evidencia y reset en éxito; atasco en fallo | R6, R13–R15 |
| `lib/plan/acceptance-index.ts`, `lib/plan/evidence.ts` (nuevos); `commands/plan.ts` — `updateSubCommand`, `writeWorkplanAndRender`; `lib/plan/schema.ts` — `WorkplanSchema.evidence` | Índice, comparación y rechazo ERROR/WHY/FIX (0038 D1–D3) | R6–R10 |
| `lib/plan/render.ts` — `renderAcceptance`; `lib/plan/check.ts`; `core-assets/agents/reviewer.md` — `Pass 1` | Casos con y sin evidencia (0038 D4) | R11, R12 |
| `engines/shared/engine-capabilities.ts`; `engines/codex/hook-registrations.ts` (filas `unsupported` al final) | Controles `acceptance-evidence`, `repeat-failure-advice`, `search-routing-guard`, `general-purpose-confirm`, `compact-advice` | R10, R16, R60 |
| `lib/handoff/schema.ts` — `ImplHandoffSchema.doubts`; `reviewer.md` — `Setup`, `Verdict format`; `lib/handoff/review-schema.ts`, `commands/handoff.ts` — `log-review`; `core-assets/settings/settings-base.json` | 0038 D9–D10 | R18–R22 |
| `packages/plugins/tgrep/scripts/guard-search-routing.sh` (restaurado); `plugin.json` `scripts` + `hookExtensions`; `lib/config/plugins.ts`; `core-assets/hooks/guard-destructive.sh` — `navori:user-section`. Fallback: `HookEntrySchema.if` + `coexist-settings.ts` con identidad `(command, if)` | Guard como carril de `guard-destructive`, remedio `--no-index` con el servidor apagado, fail-open | R29–R31 |
| `lib/diagnose/codegraph-wiring.ts` (nuevo) + `commands/doctor.ts`; señal `codegraph-projectpath-mismatch`; `docs/research/codegraph-costo-neto.md` | Cableado; medición; veredicto en la matriz | R32–R35 |
| `core-assets/agents/architect.md`, `scout.md` — `tools`; `frontmatter-merge.ts`, `agent-mcp-tools.ts` — `rewriteAgentTools` (split que respeta paréntesis); `core-assets/managed/orquestacion.md`; `core-assets/hooks/general-purpose-confirm.sh` (nuevo) + `build-settings.ts` | Despacho anidado o fallback; web en `scout`; `ask` para `general-purpose` | R36–R40 |
| `core-assets/agents/implementer.md` — `maxTurns` (Codex no la emite: `buildAgentToml` usa una lista explícita de claves) | Tope nativo de turnos | R41 |
| `lib/config/schema.ts` — `harness.compactAdviceTokens` | Umbral configurable, interpolado con `{{shq:…}}` | R44 |
| `docs/research/engram-vs-memoria-nativa.md` (nuevo) + fila de la matriz | Evaluación con evidencia | R50, R51 |
| `lib/master/status.ts` — `readMasterStatus`, `statusLine`; `lib/master/close.ts` — `runMasterClose`; `lib/master/init.ts` — `runMasterInit`; `commands/master.ts` — `statusSubCommand`, `advanceSubCommand`, `partSubCommand`, `closeSubCommand` | Primer uso, `allDone`/`closable`, `STATUS.md`, eventos CLI | R52–R55 |
| `core-assets/hooks/master-accept-confirm.sh`; `core-assets/skills/master-plan.md`; `commands/__tests__/master-first-use.test.ts` (nuevo) | Trigger ampliado; prosa; escenario ejecutable | R56, R58, R59 |

## Decisions

### D1 — Un inventario filtrado alimenta archivos y registraciones (R2–R4, R57)

`OVERLAP_ROWS` lleva una fila por unidad distribuida: agentes y skills de `roster.ts`, hooks de
`resolveHarnessPlan`, bloques de `core-assets/managed/`, plugins de `packages/plugins/` y los flujos
de R57 (`kind: "flow"`: master-plan frente a plan mode, lista de tareas y workflows nativos).
`filterInventory({ plan, plugins }, engineId)` devuelve plan y plugins sin las unidades `native`
del engine, y es **la única fuente** de lo que se escribe y de lo que se registra (B1): el adapter Claude lo llama una vez y pasa el resultado a la escritura de archivos y a
`buildClaudeSettings(config, inventory)`, que registra cada hook core solo si su id está en
`inventory.hooks` y los hooks de plugin solo de `inventory.plugins`;
`engines/claude/global-plugin.ts` aplica el mismo filtro tras su propio `resolveHarnessPlan` (m5), y
la resolución de `hook-registrations.ts` en Codex consume el inventario de Codex.

`nativeEmissionsFor("claude")` devuelve una unión cerrada de lo que se emite en lugar de la unidad
(`settings-patch` → `build-settings`, `agent-frontmatter` → `frontmatter-merge`, `none`); solo se
agregan variantes que un veredicto real exija. Un `retirar` va a `RETIRED_*` en el commit que deja
de renderizar la unidad (contrato de `roster.ts`).

### D2 — R3 es un refine del schema, probado sobre todas las filas

`OverlapRowSchema.superRefine`: `verdict ≠ "complementa"` exige `native.url` con host en allowlist
(`code.claude.com`, `learn.chatgpt.com`, `developers.openai.com`) y `native.verifiedAt`
`YYYY-MM-DD` no futura; `reemplazar-por-nativo` exige además `engines.claude === "native"`,
`nativeEmission` y `emit` donde la unidad exista; `retirar` exige el id en `RETIRED_*`.
`native-overlap.test.ts` exige exactamente una fila por unidad del inventario. El refine es
sintáctico (m11): no prueba que la página respalde la capacidad. Por eso la doc generada imprime
URL y fecha por fila y la revisión humana del PR es el control real. Los veredictos de R35 y R51
viven en `evaluation`: `quitar-del-default` sigue siendo `complementa` y `reemplazar` de engram
mapea a `reemplazar-por-nativo`, sujeto al refine.

### D3 — Retiro por engine con las garantías del invariante 4 (R5)

§8.7e itera filas `claude: native` y **salta toda ruta que ya esté en `pending`** en esa corrida
(m6). Para no prometer lo que las funciones actuales no dan (B2):

**Archivos enteros** (hooks, skills, agentes): los planificadores de §8.7 (`planRetiredHookRemoval`,
`planDirSkillRemoval`/`planFlatSkillRemoval`, `planRetiredAgentRemoval`) se llaman con una opción
nueva de `isRemovableNavoriFile`, `requirePristine`. Esa opción usa `navoriAuthorship(path,
markerId, { verifyHash: true })` y además exige que fuera del bloque solo haya lo que navori escribe
(frontmatter, shebang, sección de usuario vacía). `newer`, `modified` o texto de usuario ⇒ se
conserva y `reportKeptRetired` lo reporta, ampliado a esos dos veredictos. El borrado sigue dentro
de `isRemovableNavoriFile`, así que `removal-parity.test.ts` sigue viendo una sola vía. **Bloques
dentro de un archivo** (`managed-block` en `CLAUDE.md`): `removeManagedSectionGuarded` en
`lib/render/marker.ts` lee `readMarkerAttrs`. Si `version` > CLI (`isDowngrade`) o el hash guardado
≠ `computeManagedHash` del cuerpo, no quita y devuelve el motivo para `warnings`. Si no, delega en
`removeManagedSection`. Todo borrado pasa por `commitWrites`, con backup. Codex y los engines de
prosa no cambian.

Una fila pasa a `native` en el mismo commit en que `filterInventory` la excluye; el test verifica
además que el archivo y su registración desaparecen juntos.

### D4 — Carry-over de B, C, D e I (0038 D1–D11, renumerado)

Sin cambios de contrato salvo dónde vive el carril de éxito (D5). Evidencia: el host corre, el hook
registra, `plan update` compara (R6–R9); regla por engine con `CLAUDE_CODE_CHILD_SESSION` (R10);
check/render/reviewer distinguen sin tocar `ok` (R11, R12). Atasco: clave comando + `cwd` +
`agent_id`, firma normalizada, umbral 3, tope 50 líneas, fail-open (R13–R15); Codex `unsupported`
(R16). La doc de hooks lista para `PostToolUseFailure` los campos `error` y `tool_response` (salida
antes del fallo), así que el prior de R17 es "implementar"; la captura live de F0a sigue siendo el
gate (m2). Reviewer: dudas, `Coverage`, sidecar y `findings.jsonl`; `maxWords` = medido + 10
(R18–R22). R46–R47 se implementan dentro de D10.

### D5 — R28: cuenta entera por camino

`B_pre` = hooks `PreToolUse` que corren en una llamada Bash; `B_post` = hooks `PostToolUse` de
éxito. En este repo, 9 y 2. `hooks-per-bash.test.ts` los calcula sobre dos fixtures (default con
tgrep habilitado, y coexist) evaluando cada `if` contra comandos fixture. Con la recomendación de
D6 (guard como carril de `guard-destructive`, sin registración nueva):

| Camino | Hoy | Después | Δ |
|---|---|---|---|
| Éxito, cualquier comando | B_pre + B_post | (B_pre − 1) + B_post | −1 |
| Fallo (exit ≠ 0), cualquier comando | B_pre | (B_pre − 1) + 1 | 0 |
| Bloqueado por el guard de búsqueda | B_pre + B_post o B_pre | B_pre − 1 | ≤ −1 |

Los cambios son tres. `model-advisor` sale de `PreToolUse(.*)` (−1 en todo camino) y pasa a
`Stop`. La doc de hooks, consultada el 2026-09-30, lista `effort` "for events that fire within a
tool-use context, such as PreToolUse, PostToolUse, Stop, and SubagentStop", y el script ya lee
`$CLAUDE_EFFORT` como respaldo; F0a lo sondea (m1). Costo aceptado: el aviso llega al cerrar el
primer turno y no antes de la primera herramienta. El carril de
evidencia y reset corre dentro de `routing-watch`, que ya corre en cada éxito (0). Y
`bash-outcome-watch` corre solo en `PostToolUseFailure` (+1 en fallo). Si el guard se registrara
aparte con `if` (fallback de D6), el camino "`grep`/`rg` permitido que falla", por ejemplo un
`| grep` sin coincidencias con exit 1, quedaría en B_pre + 1: **+1, viola R28**. Por eso no es la
recomendación.

**Colocación del carril en `routing-watch.sh` (M3).** Hoy el script sale temprano en este orden:
`nv_tool`, `case` de descarte, sonda `navori_has_write_token`, luego stamp `#delegated`/`#notified`.
El carril va justo después de confirmar `tool_name == Bash` y antes de la sonda y del stamp, así
que también corre en sesiones ya delegadas, que son las de todo implementer. Reglas del carril:

Corre solo con el argumento `claude-post-tool-use` (Codex no lo pasa; allí PostToolUse dispara
también con exit ≠ 0). Sale sin registrar si el payload trae `"run_in_background":true`: esa llamada
"tiene éxito" al lanzarse, no al terminar. Ruta rápida solo con builtins (`-s` del índice, `case` de
substring). Con match exacto, calcula `tree`, `head` y `worktreeTree` y escribe **una** línea
completa con un solo `printf >>` al final. Un kill a medio cálculo no deja línea parcial, y `plan
update` rechaza con WHY "no run recorded", más un FIX que menciona repos grandes. La registración de
`routing-watch` pasa de `timeout: 10` a `30`. No cuesta nada en la ruta normal (milisegundos); solo
acota un cuelgue.

El test de shims de 0038 D7 pasa a `routing-watch`. Se descartó un hook separado en `PostToolUse`
(0038): suma +1 en cada éxito. También `if` en hooks de gate: el matcher nativo no ve
`bash -c "gh pr create"`, que `gate-trigger` sí cubre.

### D6 — Guard de búsqueda (R29–R31)

**Dónde corre (recomendado).** Corre como carril del plugin tgrep dentro de `guard-destructive.sh`,
en su punto de extensión documentado `# navori:user-section`, que viene después de todas las
reglas destructivas y tiene `$cmd` ya parseado. El plugin inyecta un sub-bloque managed de estilo
shell (marcadores `# navori:managed`), con la misma maquinaria de sub-bloques que ya usa
`injectInto`, extendida a hooks. El sub-bloque tiene cinco líneas:

1. `case` builtin que busca `grep`, `egrep`, `fgrep` o `rg` en `$cmd`; sin match, no hace nada.
2. `( . "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-search-routing.sh" )` en subshell.
3. Código 42 ⇒ `exit 2`, con el remedio ya escrito por el script en stderr.
4. Cualquier otro código, incluido un error de sintaxis (2), deja pasar.

Así R28 no suma ningún hook, el guard es solo Claude (el sub-bloque apunta a
`.claude/hooks/guard-destructive.sh`, no a la copia de Codex) y al deshabilitar tgrep el sub-bloque
sale por `removeSubBlock`. El costo va sobre un área crítica: un fallo en el script no puede
tumbar las reglas destructivas, porque éstas ya decidieron antes y el subshell aísla el error.

**Fallback.** Si el orchestrator rechaza tocar `guard-destructive`, el guard se registra aparte con
`if` por verbo. En ese caso `coexist-settings.ts` identifica hooks por `(command, if)` en
`injectHooks`, `stripTrackedHooks` y el tracking (M1), y R28 queda en +1 en un camino (D5).

**Cambios al script de `7c6930dc^` (M2).** **Remedio.** `tgrep search -n -- PATTERN ROOT`, cubierto por `Bash(tgrep search *)`; nunca
codegraph. **Frescura.** Si `tgrep status` dice `Server: not running`, el remedio usa `tgrep search
-n --no-index -- …`, que es el fallback del wrapper retirado. **Disponibilidad (R31).** Si `tgrep`
no existe o `status` falla, deja pasar con veredicto `fail-open`. `status` solo corre en la rama que
va a bloquear. **Alcance (R30).** Deja pasar pipe, archivo conocido, heredoc, comando > 20k, ROOT
fuera de la raíz del repo (`~/.claude/…`, `/tmp`) y `rg --files`, `--version` o `--help`. Sale la
regla de `git grep`. **Flags.** El remedio lista la equivalencia de `-i -l -w -F` y remite a `tgrep
search --help` para las demás; F0a la verifica.

### D7 — codegraph: cablear, medir, decidir (R32–R35)

**Cableado (R32)** en `navori doctor`: índice presente y fresco (`codegraph status`, flags por
sondear en F0a), agentes con `mcp__codegraph__codegraph_explore` en su `tools` renderizado o en el
allow, y la regla `projectPath` en el bloque inyectado. En runtime, R64 guarda el `projectPath` de
cada llamada y la señal `codegraph-projectpath-mismatch` lo compara con el `cwd`.

**Medición (R33).** Protocolo de `docs/research/search-v2-results.md` §9 con `claude -p` en un
script de investigación fuera de la CLI:

≥ 12 tareas de descubrimiento; tres brazos: textual, codegraph con `maxFiles: 4` y codegraph con
`maxFiles: 12`; métricas de `navori audit`: contexto acumulado, turnos y corrección contra una
referencia.

**Criterio (R34),** pre-registrado en F0a y verificable por la fecha del commit: codegraph conserva
el default solo si algún brazo baja ≥ 15% la mediana de contexto con corrección ≥ la textual. Si
no, `quitar-del-default`. **Veredicto T31/R35:** la medición no superó el umbral; codegraph queda
fuera de los defaults de nuevas instalaciones `navori init --full`, pero sigue como opt-in. No se
migran ni modifican configuraciones existentes: los usuarios que ya lo habilitaron conservan el
bloque y grants actuales, incluido el grant nominal de `scout` (precedente cubierto por
`mcp-capability-wiring.test.ts`). `navori doctor` comunica la política como información separada,
sin warning ni impacto en strict mode; también se expone en JSON. No se cambia la configuración
automáticamente. La evaluación de la matriz informa la decisión, pero no gobierna el runtime ni
los defaults.

### D8 — Agentes (R36–R40)

La doc de sub-agents confirma el despacho hasta tres capas con `Agent` en `tools` y la lista
`Agent(a, b)`; además hay metas locales con `spawnDepth` 2 y 3.

**R36.** `architect.md` agrega `Agent(scout, scribe)`. `rewriteAgentTools` y `mergeFrontmatter`
parten `tools:` por comas: se cambia a un split que respeta paréntesis, con test de ida y vuelta
(m4). Dentro del architect, `plan-gate` y los hooks de `Agent` disparan con `agent_id`: se documenta
que es esperado. **R37.** En Codex o con `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`, la fila lo
registra y `orquestacion.md` pone `scout` antes y `scribe` después. **R38.** Bash da tgrep por
allow; `codegraph_explore` entra por `withAgentMcpTools` cuando el plugin está habilitado. R35
decide su inclusión en nuevos defaults y no revoca el acceso opt-in. **R39.** `scout`
gana `WebFetch, WebSearch`. Garantía: tokens y calidad. Señal: R49. Retiro: 0 llamadas web de
`scout` en 30 días con `general-purpose` web > 0. **R40.** `general-purpose-confirm.sh`, calcado de
`pr-publisher-confirm`: `PreToolUse` `Agent` con `if: Agent(general-purpose)`, `permissionDecision:
"ask"` y la razón "scout cubre lectura e investigación web". Pregunta en todo despacho de
`general-purpose`. Una regla nativa `ask` no lleva razón. Si un `ask` dentro de un subagente no está
documentado, F0a lo sondea.

### D9 — Tokens (R41–R44)

**R41.** Turnos por lanzamiento de `implementer` (mensajes asistente únicos por `message.id` en
`~/.claude/projects/*/*/subagents/*.jsonl` con `agentType: implementer`, solo lectura):

| Ventana | Lanzamientos | Mediana | p90 | p95 | p99 | Máx |
|---|---|---|---|---|---|---|
| desde 2026-09-20 | 396 | 32 | 123 | 159 | 226 | 281 |
| histórico | 585 | 36 | 130 | 178 | 277 | 492 |

**Cortes.** Tope 160: 19 lanzamientos de 396 (4.8%), con el 10.2% del cache read del `implementer`.
Tope 200: 7 (1.8%), con el 4.3%. Son techos brutos. **Qué cuenta como turno.** La doc no dice si
`maxTurns` cuenta mensajes, rondas de herramienta o llamadas paralelas. F0a lo sondea con un agente
`maxTurns: 3` y compara con el conteo por `message.id`. Si difieren, el valor se recalcula en la
unidad del host. **Valor.** 160 (recomendado) o 200: open question. **Disparador de reversión**
(pre-registrado en F0a, no atado al p95): se sube el tope si, en la ventana posterior, más del 25%
de los parciales terminan en re-despacho que vuelve a cortarse, o si un parcial precede a un
`CHANGES_REQUESTED` en más del 10% de las features con parcial.

**R42.** Al tope, el host devuelve la salida "marked as partial" (CC ≥ 2.1.246); su forma en el
`tool_response` de PostToolUse(Agent) se captura en F0a. `subagent-stop-handoff` señala "handoff
PARCIAL de `<subagent_type>`". En hosts previos no hay fallback por `impl_*.json` ausente, que
confundiría un cierre legítimo sin handoff (M6). **Doctrina:** `orquestacion.md` prefiere continuar
con `SendMessage`, porque conserva el estado (calidad > tokens). El redespacho fresco queda para
cuando el handoff parcial describe trabajo restante acotado. R65 cuenta ambos caminos para
compararlos.

**R43.** Líneas base de la instantánea F0b: cache read mediano por sesión y por lanzamiento de
`implementer`, y hooks por Bash, cada uno con su n. Criterio pre-registrado: −10% por lanzamiento
con n ≥ 100 lanzamientos por ventana. Una diferencia menor que la banda de ruido medida entre dos
ventanas base consecutivas no cuenta (m10).

**R44.** Carril de `subagent-stop-handoff` solo en modo Claude, en el hilo principal (sin
`agent_id`) y cuando `tool_input.subagent_type == "publisher"`: lee la cola de 256 KB del `transcript_path` y parsea la **última línea completa** con `usage` (m8);
si input + cache_read + cache_creation superan `harness.compactAdviceTokens`, avisa una vez por
sesión que guarde el resumen y use `/compact` o `/clear`; default: mediana del pico de F0b
redondeada a 25k (hoy 175,000); `0` apaga.

### D10 — Audit como fuente única de medición (I + L)

Cada agregado de rango se calcula una vez en `buildReport` y se publica plano en `rangeMetrics`
(`hooks.perBashCall`, `agent.implementer.turns.p90`, `tool.codegraph_explore.resultBytes.p50`).

**R63.** Agrupa `HookEvent` por `toolUseId` de Bash. **R66.** Toma los ejemplos del transcript,
truncados a 160 caracteres y redactados; nunca van a la instantánea. **R62.** Denominador: `*.jsonl`
del slug del repo **más** los slugs `…--claude-worktrees-*` (m9). La colisión de basenames en
`~/.navori/audits/` se reporta como advertencia. **R71.** Una sesión Codex aporta hooks y
veredictos; lo demás queda `null` con `unavailable: "transcript"`. **R67.** Los ports se prueban
contra fixtures con las cifras de los scripts Python, que se borran al pasar la paridad. **R70.**
F0b entrega solo el marco: `mechanismSection` tabula cualquier `name × verdict` de hooks y eventos
CLI. Cada fase posterior agrega los nombres de su mecanismo y su fixture (m12). **R68–R69 (M5).**
`--snapshot <nombre>` escribe bajo la raíz de audit (`rangeReportDir`), lo que respeta el contrato
de `commands/audit.ts` ("every write lands under the audit root"). El archivo tiene formato propio
`snapshotFormat: 1`, independiente de `AuditReport.schemaVersion`, así que un cambio del reporte no
invalida la línea base. - `--copy-to <ruta>` copia al repo solo con ruta explícita, resuelta desde
el toplevel de git, y rechaza sobrescribir. - Con `--all-repos`, la instantánea no lleva nombres de
repo y `--copy-to` se rechaza si la ruta cae dentro de algún repo. - `--compare` usa `n/a` para
métricas ausentes.

### D11 — Master plan (R52–R60), una fase

**R52.** `status --json` sin `index.json` devuelve el `MasterStatus` vacío que `readMasterStatus` ya
construye (`empty`), con exit 0. **R53.** Se extrae `closeBlockers(state, parts)` de
`runMasterClose`; `status.ts` lo reusa. `allDone = parts.length > 0 && every(hecho)`; `closable =
parts.length > 0 && closeBlockers.length === 0`. **R54.** `runMasterInit` termina con
`writeMasterStatus`; `statusLine` sin parte activa dice `sin parte activa`. **R55.** `advance`,
`close` y `part --accept` llaman `appendCliEvent` con `CLAUDE_CODE_SESSION_ID`; sin él no hay
registro (fail-open). **R56.** Prosa para `sdd.enabled: false` y variantes de confirmación ("sí",
"dale", "continúa"). El frontmatter declara por qué excede el tope de 500. **R58.** Cubre `part …
--approved-by` (`=` o espacio, cualquier orden) y `close` en sus tres formas, invocados vía
`navori`, `npx`, `bunx`, `pnpm exec`/`dlx` o `…/navori`. - La ruta rápida usa `approved-by|navori
master` como tokens, no `master` a secas (m14). - El trigger reusa `gate-trigger`. `advance` no
entra. **R59.** Escenario en un repo git temporal: `status --json` sin índice → `init` → `mode` →
`check`/`advance` → `part --accept` (comando y manual) → `status` → `close`. Un chequeo extrae cada
forma `navori master …` del skill y falla si el escenario no la ejerce. **R60.** `master-plan` sigue
Codex `unsupported`.

## Contracts

```ts
// engines/shared/native-overlap.ts
type Verdict = "complementa" | "reemplazar-por-nativo" | "retirar";
type EngineSupport = "emit" | "native" | "unsupported" | "n/a";
interface OverlapRow {
  unit: { kind: "hook" | "skill" | "agent" | "managed-block" | "plugin" | "flow"; id: string };
  native: { capability: string; url?: string; verifiedAt?: string; ccVersion?: string } | null;
  verdict: Verdict;
  engines: Record<EngineId, EngineSupport>;
  nativeEmission?: { kind: "settings-patch" | "agent-frontmatter" | "none"; detail: string };
  evaluation?: { kind: "codegraph" | "engram"; verdict: string; evidence: string };
  note: string;
}
interface FilteredInventory { plan: HarnessPlan; plugins: LoadedPlugin[] }
```

`removeManagedSectionGuarded(content, id): { content: string } | { kept: "newer" | "modified" }`.
`isRemovableNavoriFile(path, markerId, { requirePristine: true })`.

**B, C y D (0038 § Contracts, sin cambios):**

`acceptance-index`: `<command JSON-escapado>\t<feature>\t<A<n>>\t<dir de estado>`. Línea de
evidencia: `{ ts, feature, id, command, tree, cwd, head, worktreeTree, dirty, sessionId, agentId?
}`, escrita completa en un solo append. `WorkplanSchema.evidence`: unión discriminada entre
`RecordedEvidence { kind: "recorded", command, ranAt, tree, head, worktreeTree, dirty }` y
`UnevidencedAcceptance { kind: "unevidenced", reason: "engine-without-signal" }`. `plan update`
rechazado: exit 1 sin escribir. `doubts?: { file, reason }[]`. Sidecar `review_<feature>.json` con
`category` de enum cerrado. `findings.jsonl`: `{ ts, feature, verdict, reviewHash, category,
severity, score, file }`. Estado de atasco:
`<CLAUDE_PROJECT_DIR>/.navori/state/hooks/bash-outcome-watch/<sid>`, ≤ 50 líneas.

**Audit:**

`AuditReport.schemaVersion: 10`, con `rangeMetrics`, `byAgentType[*].sessions` y la fila
`main-thread`. Evento CLI: `{ tsMs, event: "cli", name, verdict, reason? }`. Instantánea: `{
snapshotFormat: 1, generatedBy, scope: "repo" | "all", range, rangeMetrics }`. CLI: `navori audit
[--all-repos] [--snapshot <nombre>] [--copy-to <ruta>] [--compare <archivo>]`.

**Config y plugins:**

`harness.compactAdviceTokens: number`; `0` apaga. Plugin `hookExtensions: { target:
"guard-destructive", script }`, solo Claude. `HookEntrySchema.if?: string`, solo en el fallback de
D6.

**Master:** `status --json` siempre produce un `MasterStatus` válido. `allDone` y `closable`
implican `parts.length > 0`.

## Failure modes

**Fila `native` cuyo hook sigue registrado:** es imposible por construcción (D1). El test busca en
`settings.json` el script de cada fila `native`. **Bloque o archivo editado a mano, o escrito por
una versión nueva:** se conserva y se reporta (D3, `requirePristine`,
`removeManagedSectionGuarded`). **Sub-bloque del guard roto o `tgrep status` lento:** el subshell
aísla el error y el código ≠ 42 deja pasar. El timeout de `guard-destructive` (10 s) solo se
arriesga en la rama que va a bloquear. Las reglas destructivas ya decidieron antes. **Índice de
tgrep viejo:** con el servidor apagado, el remedio usa `--no-index`, nunca un índice desactualizado.
**Evidencia en Codex o de una llamada en background:** el carril no corre (D5). **Hook matado a
media huella:** no escribe línea; `plan update` rechaza con un FIX explícito.
**`CLAUDE_CODE_SESSION_ID` ausente en Bash:** no hay evento CLI ni estado de atasco; fail-open.
**Marca parcial con otra forma:** R42 no dispara; no hay falso positivo por handoff ausente.
**Ejemplos de R66 con secretos:** se truncan, se redactan y quedan fuera de la instantánea.
**Carry-over de 0038** (índice viejo, worktree reclamado, árbol cambiado, Bash paralelos,
`log-review` omitido): sin cambios.

## Migration

**Repos instalados.** `render --apply`: - retira con backup las unidades `native` y sus
registraciones; - cambia la registración de `model-advisor` y el comando y el timeout de
`routing-watch`; - agrega `PostToolUseFailure` y `general-purpose-confirm`; - con tgrep habilitado,
agrega el sub-bloque del guard en `guard-destructive.sh`. **Goldens.** Cambian `claude.snap` y
`codex.snap` y nace el de `docs/native-overlap.md`. El diff se revisa, no se regenera a ciegas. El
pinned-hash de Codex no cambia. **Datos previos.** Workplans con `cumplido` previo, handoffs sin
`doubts`, reviews sin sidecar y reportes v9 siguen válidos. Las instantáneas no dependen de
`schemaVersion`. **Scripts Python.** Se borran tras la paridad (R67). **Master.** Un `index.json`
sin `STATUS.md` lo obtiene en el siguiente `status`. **Rollback.** Una CLI vieja reinstala lo
retirado. El sub-bloque del guard y su script pueden quedar sin que ella los gestione, y siguen
funcionando. `evidence` se degrada a "sin evidencia".

## Testing strategy

| Riesgo | Req. | Prueba |
|---|---|---|
| Matriz con veredicto sin doc, unidad sin fila o duplicada | R2, R3, R57 | `engines/shared/__tests__/native-overlap.test.ts`: refine sobre todas las filas; cobertura contra roster, plan, managed, plugins y flujos; golden de la doc con URL y fecha |
| Claude sigue emitiendo o Codex deja de emitir | R4 | `render-native-overlap.test.ts` con una fila fixture `native`: ausente del plan y de `settings.json` en Claude (ninguna registración nombra su script), presente en Codex y agents-md; mismo filtro en `global-plugin.ts` |
| Prune que borra contenido del usuario o de una versión nueva | R5 | Mismo archivo: bloque con `version` mayor → se conserva y se reporta; bloque editado (hash distinto) → se conserva; archivo con texto fuera del marcador → se conserva; ruta ya en `pending` → intacta; backup existe; `removal-parity.test.ts` sin vías nuevas |
| Dirección no declarada | R1 | `direction-claude-first.test.ts`: `docs/DIRECTION.md` contiene el criterio "nativo primero" y enlaza `docs/native-overlap.md` |
| Carry-over B, C y D roto por el fold | R6–R22 | Tabla de 0038 § Testing strategy renumerada en `tasks.md` y aplicada a `routing-watch`, más: sesión `#delegated` → registra; `run_in_background` → no registra; sin argumento (Codex) → no registra; kill simulado → sin línea parcial |
| Más hooks por Bash | R28 | `hooks-per-bash.test.ts` sobre fixtures con tgrep habilitado y en coexist, evaluando `if` contra comandos fixture: éxito = base − 1, fallo = base, bloqueado ≤ base − 1. Al cierre, `--compare` sobre `hooks.perBashCall` |
| `rm -f $VAR` bloqueado o `rm -rf $VAR` permitido | R23, R24 | `guard-destructive.test.ts`: `rm -f "$TMPDIR/x"` y `rm --force "$X"` → 0; `rm -f "$X"/*` y `rm -f $HOME/*` → 0 (frontera explícita de la decisión del usuario, m3); `rm -rf "$SCRATCH"`, `rm -r $X`, `rm --recursive $X` → 2; `rm -f /etc/x` → 2 |
| `plan-gate` invisible en audit; aviso repetido | R25, R26 | `hook-audit-instrumentation.test.ts` con `plan-gate`; mismo handoff dos veces → 1 aviso; contenido cambiado → aviso |
| `model-advisor` pierde su recomendación | R27 | `model-advisor.test.ts` en modo `claude-stop`: `effort.level: high` en Opus → 1 aviso; sin campo y con `CLAUDE_EFFORT=high` → 1 aviso; `host-contracts` actualizado |
| Guard que bloquea extracciones, redirige a un índice viejo o rompe `guard-destructive` | R29–R31 | Suite portada de `7c6930dc^` más: ROOT fuera del repo, `rg --files`/`--version` → pasa; `Server: not running` → remedio con `--no-index`; sin binario → `fail-open`; script con error de sintaxis → pasa y la suite destructiva completa sigue verde; sin codegraph en el texto. Fallback: coexist con cuatro handlers `if` → los cuatro sobreviven `injectHooks` |
| Cableado de codegraph con falso positivo | R32 | `codegraph-wiring.test.ts` con agentes con y sin grant y un `projectPath` de otro worktree |
| Medición sesgada o no reproducible | R33–R35 | Artefacto: `docs/research/codegraph-costo-neto.md`, con commit del pre-registro anterior al de los resultados; la fila de R35 exige `evaluation.evidence` apuntando a él (refine) |
| Línea base ausente | R43 | `snapshot.test.ts`: la instantánea F0b contiene las tres métricas de R43 con n; artefacto de F0b en la raíz de audit |
| Architect sin herramientas o con split roto | R36–R39 | `agents-assets.test.ts` (`tools` de `architect` y `scout`); `frontmatter-merge.test.ts`: `Agent(scout, scribe)` ida y vuelta sin reescritura |
| `general-purpose` sin confirmación | R40 | Hook: `general-purpose` → `ask`; `scout` → nada; `claude.snap` con `if` |
| `maxTurns` ausente o filtrado a Codex | R41 | Frontmatter Claude con el valor elegido; agente Codex sin la clave |
| Parcial no señalado o falso parcial | R42 | Fixture del `tool_response` de F0a → aviso; `impl_*.json` ausente sin marca → sin aviso |
| Aviso de compactación ruidoso o roto | R44 | Transcript fixture con la última línea truncada → usa la anterior completa; umbral sobre y bajo; `publisher` sí, otro no; modo Codex → nada; `schema.test.ts`: `harness.compactAdviceTokens` acepta entero ≥ 0 |
| Métricas de audit mal calculadas | R46–R49, R61–R66, R71 | `lib/audit/__tests__/report.test.ts` y `range-metrics.test.ts` con fixtures, incluidos una sesión Codex y un worktree en el denominador de R62 |
| Port que diverge del minero Python | R67 | `routing-parity.test.ts` contra las cifras fijadas de los scripts |
| Instantánea en el lugar equivocado o con datos sensibles | R68, R69 | `snapshot.test.ts`: por defecto bajo la raíz de audit; `--copy-to` existente → error; `--all-repos` + ruta dentro de un repo → error; sin texto de comando ni basename de repo; `--compare` con métrica faltante → `n/a` |
| Mecanismos no contados | R70 | F0b: `mechanismSection` con nombres fixture; cada fase agrega el fixture de su mecanismo |
| Evaluación de engram sin evidencia | R50, R51 | Artefacto: `docs/research/engram-vs-memoria-nativa.md`; su fila pasa el refine de D2 |
| Primer uso roto | R52–R55, R59 | `master-first-use.test.ts` (escenario completo) + cobertura de comandos del skill |
| Aprobación registrada sin confirmación o `ask` espurio | R58 | `master-accept-confirm.test.ts`: `--approved-by=user`, `npx navori master part …`, `navori master close --abandon` → `ask`; `git push origin master` y `master status` → nada |
| Skill sin prosa exigida | R56 | Presencia de la regla `sdd.enabled` y declaración de `maxWords` |
| Codex marcado como soportado | R10, R16, R60 | `control-inventory.test.ts` |

El gate completo (`qualityGate.full`) es obligatorio por fase.

## Verificaciones pendientes

**Consultadas por el architect el 2026-09-30** (F0a las registra fila por fila):

**[hooks](https://code.claude.com/docs/en/hooks).** `if` existe, no lanza el hook sin match y revisa
subcomandos. `PostToolUse` dispara solo en éxito y `PostToolUseFailure` en fallo, con `error` y
`tool_response`. `effort` está listado para `Stop`.
**[sub-agents](https://code.claude.com/docs/en/sub-agents).** `maxTurns` marca la salida como
parcial (CC ≥ 2.1.246). Anidación de hasta tres capas con `Agent` o `Agent(a, b)` en `tools`, y
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`. **[memory](https://code.claude.com/docs/en/memory).** La
memoria automática es por repo, compartida entre worktrees, carga 200 líneas o 25 KB, no entra en
subagentes y es local a la máquina. Las reglas con `paths` cargan solo al leer un archivo que
coincide; por eso R45 quedó retirado.

**UNVERIFIED, en F0a (entre paréntesis, lo que cambia si resulta falso):**

Forma de la marca parcial en el `tool_response` de `Agent` (R42 no dispara). Unidad de conteo de
`maxTurns` (se recalcula el valor de R41). Captura live de `PostToolUseFailure` (si `error` no trae
la salida, se difiere C, R17). `effort` real en un payload de `Stop` (queda el respaldo
`$CLAUDE_EFFORT`). `CLAUDE_CODE_SESSION_ID` en el subproceso Bash (R55 y el atasco no registran).
`Agent(<nombre>)` como `if`, y un `ask` dentro de un subagente (R40 lanza el hook en cada `Agent`).
Flags de `tgrep search` y `tgrep status` (texto del remedio de D6). Flags de `codegraph status`:
`npx @colbymchenry/codegraph@1.6.0 status --help`. Registro de compactación en el transcript (R65).
Memoria de Codex para R50: `[SIN VERIFICAR]`. Filas de `evidence.md` (`/code-review`,
`/security-review`, limpieza de worktrees, `autoMode`, output styles, OTel): quedan `complementa`
hasta F0a.

## NOT in scope

**R45** (reglas con alcance por ruta): retirado en requirements.md. Esas reglas solo cargan al leer
un archivo que coincide, así que un agente que crea un archivo nuevo, o que trabaja después de
`/compact`, no tendría `tipado-fuerte` en contexto. Eso es perder calidad por unos 60 tokens. Los
bloques managed siguen always-on y `.claude/rules/` no entra como raíz del harness. R15 de la 0038
(diferido: ≥ 30 hallazgos de ≥ 10 features); backfill de `findings.jsonl`. Ejecutar criterios desde
la CLI o desde hooks; `--attest`; Stop hook de gate. `if` en hooks de gate; cambios a las reglas de
`guard-destructive` distintos del `rm -f` sobre variable (el carril del guard de búsqueda no cambia
ninguna regla destructiva). Paridad de master-plan, evidencia, atasco o guard en Codex (R60, U2 de
0038). `git grep` en el guard; redirigir a codegraph. Cambiar el default de `gitignoreHarness`.
Veredictos `reemplazar-por-nativo` concretos antes de F0a.

## Open questions (para el orquestador; ninguna bloquea F0a, F0b, F1, F2 ni F9)

1. **R41:** ¿`maxTurns` 160 (p95 reciente) o 200 (conservador)? Se recalcula si F0a muestra otra
   unidad de conteo.
2. **D6:** ¿se acepta el guard como carril del plugin dentro de `guard-destructive` (recomendado:
   0 hooks nuevos, pero toca un área crítica)? ¿O prefieren el fallback con `if`, que deja un
   camino en +1 y choca con R28?
3. **R58:** ¿`master close` cuenta como aprobación equivalente? Supuesto: sí, en sus tres formas.
4. **Pre-registro:** ¿confirma el usuario R34 (≥ 15%), R43 (−10%, n ≥ 100) y el disparador de
   R41?
5. **R44:** default de 175,000 tokens.

## Durable knowledge (destino propuesto; el architect no lo escribe)

**`docs/DIRECTION.md` — `Criterio de admisión por superficie`:** "Claude primero, nativo primero; la
matriz tipada es la fuente" (R1). **Skills `plan-simple` y `plan-advanced`:** el `command` se corre
textual desde la raíz y su exit code codifica lo esperado. **Encabezado de `routing-watch.sh`:**
corregir "PostToolUse no trae identificador de agente" y documentar el carril
`claude-post-tool-use`. **`evidence.md`:** "lo sustituye R16" debe decir R67; la ruta correcta es
`lib/assets/retired-names.ts`. **Skill local `author-agent`:** la ampliación de `scout` (R39) aplica
el criterio de admisión con la señal R49.
