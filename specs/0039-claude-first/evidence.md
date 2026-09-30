# Claude first — Evidence

**Parte 1** es la auditoría del 2026-09-30. **Parte 2** es la investigación del curso de harness
engineering, movida sin cambios desde el borrador de la spec 0038 (base `cb32c6c5`); sus ids de
brecha G/S/V/P/U corresponden aquí a los grupos B/C/D/D/I.

## Parte 1 — Auditoría del 2026-09-30

Registro durable de lo medido para esta spec. Los transcripts y los logs de audit rotan; este
archivo conserva las cifras y cómo se obtuvieron.

## Fuente y método

- **Logs:** 127 logs de `~/.navori/audits/` (2026-09-20 → 2026-09-30).
  - Engines: 101 sesiones Claude y 26 Codex.
  - Cobertura: 127 de 171 sesiones del periodo (74%).
- **Transcripts:** los de `~/.claude/projects/`, incluidos 1,104 transcripts de subagente.
  - Tokens: se deduplican por `message.id`.
- **Mineros:** `scripts/py/mine-activation.py` y `scripts/py/mine-search-routing.py`, más un minero
  ad hoc de herramientas, tokens y hooks.
  - El ad hoc no se versiona; lo sustituye R16.
- **Informe publicado:** https://claude.ai/artifact/5Y1my3d3D9xZDF3jgXF9Lh
  - Informe anterior, del 2026-09-11: https://claude.ai/artifact/NuBL8JZVT3azahT9QcdcwA

## Mecanismo contra doctrina

| Área | Antes | 2026-09-30 | Qué cambió |
|---|---|---|---|
| Delegación sobre oportunidades | 24% (26/107) | 95% (872/915) | guardas de despacho y escalera inyectada en 128/127 arranques |
| Ruteo de búsqueda (wrapper + nativo) | 40.7% | 0.1% (4/6,100) | `#803` retiró el guard |
| Vía v2 (tgrep + codegraph) | — | 3.2% (208/6,475) | umbral D19 de la spec 0026: 25% |

Salvedad del 95%: `mine-activation.py` cuenta como oportunidad todo turno en que se usó el agente.
Dato independiente de esa heurística: el hilo principal hace 216 de 4,383 `Edit`/`Write` (4.9%) y
88 de 5,085 `Read`.

## Hooks (disparos, tiempo sumado, resultado)

- **`model-advisor`:** 44,380 disparos, 1,409 s, 100% `skip`.
  - Matcher `PreToolUse(.*)`.
- **`guard-destructive`:** 109 bloqueos.
  - 80 de `rm`: al menos 46 son `rm -rf` sobre una variable del scratchpad.
  - 22 reescrituras de archivos managed y 4 `--no-verify`.
  - Falso positivo reproducido: `rm -f "$TMPDIR/check.log"` sale con `exit 2`. Causa: `rm_kill`
    acepta una opción corta con `f` sola.
- **`subagent-stop-handoff`:** 423 veredictos `repeat`.
  - 283 son el mismo aviso sobre `.codex/progress/impl_0035-t13.md`.
- **Sin registro en el log de audit:** solo `plan-gate`, que no incluye el partial de audit.
  `stop-verify-reminder` y los dos hooks de master-plan sí registran; no aparecieron porque sus
  flags (`verifyOnStop`, `masterPlan`) están apagados.

## Qué ya mide `navori audit` y qué no

Contrastado con `navori audit --days 10 --json` (0.11.0) sobre este repo: 92 sesiones.

**Ya existe:**
- tokens por sesión del hilo principal (`orchestrator.tokens`);
- `totals.byAgentType` con `count` y tokens por tipo de agente;
- `totals.skills` con invocadas, heredadas y ceros;
- `mcpCalls`, `hookEvents`, `toolCounts`, `toolErrors` y `repeatedCommands` por sesión;
- señales por sesión y de rango: `unused-skills`, `unused-agents`, `startup-overhead`,
  `tool-mix`, `hook-misfire` y otras.

**Faltó y se midió a mano** (grupo L):
- un agregado entre repos;
- la cobertura del periodo;
- los hooks agregados por rango (disparos, veredictos, tiempo, hooks por Bash);
- el tamaño de resultado por herramienta;
- los turnos por lanzamiento, el pico de contexto y las compactaciones;
- los bloqueos por regla con ejemplos;
- el ruteo de búsqueda y la activación, que solo existen en `scripts/py/`;
- las sesiones Codex;
- las instantáneas y la comparación entre periodos.

Los logs anteriores al 2026-09-20 ya no estaban en disco, así que la comparación contra el informe
del 2026-09-11 tuvo que usar cifras publicadas en lugar de re-correr el mismo minero.

## Master plan (auditoría de solo lectura, 2026-09-30)

- **Veredicto:** usable con huecos. El CLI y los hooks funcionan de punta a punta en un repo
  desechable (`navori` 0.11.0).
- **Trazabilidad de la spec 0034:** R1–R63 tienen código y `// Covers:`. Las R de comportamiento
  del skill solo se prueban por presencia de texto; la verificación de comportamiento es
  `specs/0034-master-plan/evals.md`.
- **Primer uso:** `master status --json` sin `index.json` imprime texto y sale con 1. El skill no
  prevé ese caso.
- **Cierre ofrecido de más:** `allDone` es `every()` sobre cero partes, así que sale verdadero en
  la fase `context`, y `master close` lo rechaza después.
- **Enlaces y línea de estado:** `INDEX.md` enlaza un `STATUS.md` que no existe hasta el primer
  `status`, y la línea de estado dice `parte activa ninguna "ninguna"`.
- **Audit:** los comandos que cambian estado (`advance`, `close`, `part --accept`) no dejan
  registro.
- **Aprobación del usuario:** la regla de aprobación (R62 de la 0034) vive solo en la prosa del
  skill; el hook solo pide confirmación.
- **Solapamiento con capacidades nativas:** plan mode (fases con aceptación explícita), lista de
  tareas y fan-out de tres `architect` en un turno. Lo propio de navori es el seguimiento
  `P<n>.A<m>` y los registros de cierre.
- **Codex:** sin empezar. Los hooks están `unsupported` (#1088) y la rama
  `docs/spec-0038-master-plan-codex` no tiene commits propios.

## Tokens

| Origen | Contexto (tokens) | Lanzamientos | Turnos por lanzamiento | Contexto al primer turno (mediana) |
|---|---|---|---|---|
| Hilo principal | 1,729 M | 93 sesiones | mediana 76, p90 211 | 56,978 |
| `implementer` | 2,084 M | 326 | 53.8 | 21,636 |
| `reviewer` | 340 M | 331 | 17.8 | 23,000 |
| `auditor` | 153 M | 104 | 22.7 | 26,325 |
| `publisher` | 127 M | 193 | 20.4 | 19,703 |
| `architect` | 121 M | 17 | 47.9 | 16,250 |

**Totales:**
- Contexto: 4.73 mil millones de tokens, 97% servidos como cache read.
- Salida: 7.2 M, de los que el hilo principal produce el 85%.

**Hilo principal:**
- Pico de contexto por sesión: mediana 175,805 tokens, p90 403,354.
- Solo 2 compactaciones en 93 sesiones.

**Resultados de herramienta en subagentes:**
- Total: 88 MB.
- 734 resultados mayores de 20 KB suman el 24% de los bytes.

**Arranque del hilo principal (esta sesión, 54,303 tokens):**
- Sale de navori: `CLAUDE.md` del proyecto (15.8 KB), `CLAUDE.md` global (5.4 KB), contexto
  inyectado por `SessionStart` (8.4 KB) y listados de skills y agentes.
- Estimado: 10–12 mil tokens son de navori. El resto es del host.

## Búsqueda: tamaño de lo que entra al contexto

| Herramienta | Llamadas | Resultado (mediana) | p90 |
|---|---|---|---|
| `grep -r` / `rg` por shell | 2,958 | 0.8 KB | 4.6 KB |
| `tgrep search` | 35 | 1.3 KB | 3.9 KB |
| `Read` | 5,031 | 3.8 KB | 16.8 KB |
| `codegraph_explore` | 146 | 23.2 KB | 26.5 KB |

- **tgrep:** tamaño comparable a `grep`. Su ventaja medible es la velocidad y que no pasa por la
  batería de hooks de Bash; en tokens es neutro.
- **codegraph:** cada llamada mete unos 6,500 tokens casi fijos, lo que sugiere que topa con
  `maxFiles`, y ese bloque se relee en cada turno siguiente. El ahorro neto nunca se midió: el
  benchmark §9 de `docs/research/search-v2-results.md` quedó NOT RUN.
- **Quién llama a codegraph:** `scout` 62, `implementer` 42, `auditor` 22, `reviewer` 9,
  `architect` 2, hilo principal 9.

## Investigación web por agente

| Agente | Llamadas `WebFetch`/`WebSearch` | Lanzamientos |
|---|---|---|
| `auditor` | 705 | 108 |
| `general-purpose` | 343 | 16 |
| `claude-code-guide` | 85 | 8 |
| `architect` | 10 | 19 |
| `scout` | 0 | 47 |

`scout` no tiene `WebFetch` ni `WebSearch` en su frontmatter. Por eso la investigación web cae en
`general-purpose`, que no tiene doctrina de navori, trae todas las herramientas y corre en el
modelo de la sesión.

## Capacidades nativas de Claude Code a verificar

Fuente: inventario de un subagente `claude-code-guide` el 2026-09-30. **Ninguna fila está
verificada todavía** contra la documentación oficial en el sentido de R3. La tarea T1 las verifica
una por una, y hasta entonces ninguna justifica un retiro.

| Capacidad nativa | Unidad de navori que toca | URL a verificar |
|---|---|---|
| `model` y `effort` en el frontmatter del agente | `model-advisor` | https://code.claude.com/docs/en/sub-agents |
| `maxTurns` en el frontmatter del agente | R13 | https://code.claude.com/docs/en/sub-agents |
| `skills` precargadas en el agente | herencia de skills en subagentes | https://code.claude.com/docs/en/sub-agents |
| `background` en el agente | `subagent-no-background` | https://code.claude.com/docs/en/sub-agents |
| Evento `SubagentStop` | `subagent-stop-handoff` (hoy en `PostToolUse(Agent)`) | https://code.claude.com/docs/en/hooks |
| Condición `if` en hooks | matchers amplios | https://code.claude.com/docs/en/hooks |
| `.claude/rules/` con `paths` | bloques always-on como `tipado-fuerte` | https://code.claude.com/docs/en/memory |
| Memoria automática (`MEMORY.md`) | plugin `engram` | https://code.claude.com/docs/en/memory |
| `/code-review` y `REVIEW.md` | skill `review-diff` | https://code.claude.com/docs/en/code-review |
| `/security-review` | skill `security-invariants` | https://code.claude.com/docs/en/code-review |
| Limpieza de worktrees | `worktree-reclaim` | https://code.claude.com/docs/en/worktrees |
| `autoMode.soft_deny` / `hard_deny` | `guard-destructive` | https://code.claude.com/docs/en/auto-mode-config |
| Output styles | bloque de concisión y formato | https://code.claude.com/docs/en/output-styles |
| Métricas OTel con `query_source` | `navori audit --collect` | https://code.claude.com/docs/en/monitoring-usage |
| Despacho de subagentes desde un subagente (profundidad máxima) | flujo del `architect` (R25–R26) | https://code.claude.com/docs/en/sub-agents |

## Parte 2 — Curso de harness engineering y documentación oficial

### Procedencia y límites

Investigación del 2026-09-30 sobre `cb32c6c5b309d0a9fe71584aa3748fcb5db03843` (`main`).
Tres fuentes, contrastadas entre sí:

1. **Curso** `walkinglabs/learn-harness-engineering` (clon superficial en scratch): 14 lecciones,
   skill `harness-creator`, `tools/audit-harness.sh`, proyectos 01-08.
2. **Código de navori** en la base indicada.
3. **Documentación oficial**: `code.claude.com/docs/en/*` (Claude Code) y
   `developers.openai.com/codex/*`, que hoy redirige a `learn.chatgpt.com/docs/*` (Codex).
   Dos hechos de Codex provienen solo de issues de `openai/codex`; se marcan **ISSUE-ONLY**.

Las cifras del curso para L02, L07, L10, L11 ("3x") y L12 el propio curso las declara
ilustrativas; no se usan como evidencia. Las únicas mediciones que cita son Lulla et al.
(AGENTS.md: −28.6% runtime, −16.6% tokens de salida; sin medir corrección), ETH Zurich
(archivos de contexto: sin mejora general de éxito, >20% más costo de inferencia), LangChain
Terminal Bench 2.0 y las tablas de costo de Anthropic.

### Lo que navori ya cubre (no se reabre)

| Idea del curso | Dónde vive en navori | Nota |
|---|---|---|
| Archivo de entrada como router (L04) | `CLAUDE.md` + `.claude/context/` + skills on-demand | — |
| Handoff entre sesiones (L05) | `progress/current.md`, hook `session-start-context.sh` | — |
| Definition of Done ejecutable (L01, L09) | skill `verify-before-done`, `qualityGate` en `navori.config.json` | Más estricta que el curso (atribución de fallas) |
| Worker separado del checker (L09, L13) | agentes `implementer` / `reviewer`, receipt de contenido | — |
| Criterio de aceptación con comando (L08) | `packages/cli/src/lib/plan/schema.ts` — `AcceptanceCriterionSchema` (`command`, `expected`) | El comando existe; nadie lo ejecuta (ver brecha G) |
| Escalamiento tras rechazos | `packages/cli/src/lib/plan/gate.ts` — `recordAndCountRejections`, `evaluateEscalation` | ≥2 `CHANGES_REQUESTED` escalan de nivel |
| Presupuesto de `AGENTS.md` en Codex | `packages/cli/src/engines/codex/build-config-toml.ts` — `DEFAULT_PROJECT_DOC_MAX_BYTES`; aviso en `i18n.ts` | navori sube `project_doc_max_bytes` según el tamaño planeado |
| Presupuesto del listado de skills | `packages/cli/src/lib/assets/skill-meta.ts` — `SKILL_LISTING_CHAR_CAP = 1536` + `skill-caps.test.ts` | Coincide con el doc oficial de Claude Code |
| Tope de prosa por agente | frontmatter `maxWords` + `agents-assets.test.ts` ("declares maxWords and stays under it") | Aplicado en tests |
| Uso de skills en un rango de sesiones | `packages/cli/src/lib/audit/report.ts` — `tallySkills`, `skillRangeSection` (`navori audit --days N`) | Incluye skills declaradas con cero uso; no cubre agentes |

### Brechas confirmadas

| Id | Brecha | Evidencia en el código |
|---|---|---|
| G | `plan update --progress A<n>=cumplido` lo autodeclara el agente; el `command` de `A<n>` no se ejecuta | `packages/cli/src/commands/plan.ts` — arg `progress`; `ProgressStatusSchema` sin evidencia asociada |
| S | No hay detección de atasco (mismo fallo repetido) en ningún hook | `packages/core/core-assets/hooks/` — sin estado de fallos repetidos en `.navori/state/hooks/` |
| V | El handoff del implementer no tiene campo de dudas; el reviewer no sabe dónde el implementer duda | `packages/cli/src/lib/handoff/schema.ts` — `ImplHandoff` (`verification`, `markdownRequests`, `rootCause`, `blockers`, `acceptance`) |
| P | Los hallazgos del reviewer viven en Markdown libre y se sobrescriben por feature; no hay historia minable | 17 `review_*.md` locales, solo 2 con `CHANGES_REQUESTED`; formato en `reviewer.md` § Verdict format |
| U | El reporte de rango cuenta agentes por corrida, no por sesión, y omite los declarados sin uso; nada marca candidatos a retiro | `audit/report.ts` — `totals.byAgentType` |

### Documentación oficial por mecanismo

#### Gating de estado (G)

- **Claude Code**: PreToolUse `permissionDecision` `allow|deny|ask|defer`; exit 2 bloquea en
  PreToolUse, en PostToolUse solo da feedback. Stop/SubagentStop con `decision:"block"` +
  `reason` impiden detenerse, con tope de 8 continuaciones seguidas
  (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). Fuente: `code.claude.com/docs/en/hooks`.
- **Codex**: PreToolUse `permissionDecision:"deny"` o exit 2 bloquean; `ask` no está soportado
  (el hook se marca fallido y la herramienta procede); un timeout del hook no bloquea. Stop con
  `decision:"block"` continúa el turno usando `reason` como prompt; sin tope documentado
  (UNVERIFIED). "Treat tool hooks as a useful guardrail, not a complete enforcement boundary."
  Fuente: `learn.chatgpt.com/docs/hooks`.
- **Implicación**: ningún host ofrece "correr la verificación y cambiar el estado" como
  primitiva. El lugar natural es la CLI (`navori plan update`), que ya es el único escritor del
  workplan — no un hook.

#### Detección de atasco (S)

- **Claude Code**: PostToolUse recibe `tool_input`, `tool_response` (Bash: `stdout`, `stderr`,
  `interrupted`, `isImage`) y **no** trae campo de exit code. PostToolUseFailure trae `error`
  con el código dentro del string (`"Exit code 1\n…"`). `additionalContext` tope 10,000
  caracteres sin forma de subirlo. Todo hook recibe `session_id` y `transcript_path`; el estado
  entre llamadas es responsabilidad del hook. Fuente: `code.claude.com/docs/en/hooks`.
- **Codex**: PostToolUse también dispara en Bash con exit ≠ 0; `decision:"block"` **reemplaza**
  el resultado de la herramienta por el feedback. Presupuesto de contexto de hooks ~2,500 tokens.
  Los hooks de subagentes reciben el `session_id` del padre. Campo explícito de exit code:
  UNVERIFIED. Fuente: `learn.chatgpt.com/docs/hooks`.
- **Implicación**: en Claude Code la señal confiable es PostToolUseFailure; en Codex, PostToolUse
  con bloqueo cambia lo que ve el modelo, así que el aviso debe ser aditivo y nunca bloquear.

#### Reviewer con contexto limpio (V)

- **Claude Code**: un subagente no-fork arranca con su system prompt, el prompt de delegación,
  todos los niveles de CLAUDE.md (salvo `omitClaudeMd: true`, v2.1.271+), git status y skills
  precargadas; no hereda la conversación. Fork (`/subtask`) sí la hereda. Fuente:
  `code.claude.com/docs/en/sub-agents` (resumen de WebFetch, no verbatim) y `.../memory`.
- **Codex**: `.codex/agents/*.toml` son capas de configuración; los docs no dicen si se hereda
  la historia. **ISSUE-ONLY** (`openai/codex#20077`): en MultiAgentV2, omitir `fork_turns`
  equivale a fork con historia completa; `fork_turns:"none"` da historia limpia.
- **Implicación**: en Claude Code, el reviewer ya arranca limpio; lo que ve del implementer es
  lo que el handoff le pasa. En Codex la limpieza no está garantizada por docs.

#### Promoción de hallazgos a reglas (P)

- Ningún host documenta un flujo automático "hallazgo repetido → regla". Claude Code recomienda
  convertir lo que un review atrapa en CLAUDE.md, o en hook si debe cumplirse siempre
  (`code.claude.com/docs/en/memory`). Codex `.rules` (`prefix_rule`) es **EXPERIMENTAL** y solo
  a nivel de comando.
- **Implicación**: navori tendría que ser dueño de ese paso; y hoy no hay datos para minar.

#### Peso del contexto siempre presente (U)

- **Claude Code**: CLAUDE.md meta <200 líneas por archivo, carga completa hasta 4 MiB. Memoria
  automática: primeras 200 líneas o 25KB de `MEMORY.md`. Listado de skills: 1% de la ventana,
  1,536 caracteres por entrada; con desborde, las menos usadas pierden la descripción primero.
  `disable-model-invocation` cuesta cero contexto. El contexto que agregan los hooks se añade al
  final y no invalida el caché; tras compactar, se resume.
- **Codex**: `project_doc_max_bytes` 32 KiB combinado por defecto; listado de skills 2% de la
  ventana u 8,000 caracteres; `skills.max_context_tokens` tope 10,000.

### Contradicciones del curso con la documentación oficial

1. "~150 caracteres por entrada de skill": falso hoy. Claude Code usa 1,536; Codex no tiene tope
   por entrada.
2. "Los subagentes arrancan solo con el prompt": inexacto en Claude Code (cargan CLAUDE.md y git
   status). En Codex el default podría ser fork completo (ISSUE-ONLY).
3. "El contexto inyectado por hooks cada turno rompe el caché": contradicho para Claude Code; el
   costo real es de tokens por turno.
4. "Los hooks de Codex son experimentales": desactualizado; están habilitados por defecto.
5. "Stop hook hasta que el gate pase": en Claude Code tiene tope de 8 continuaciones.
6. "Context anxiety" no es un concepto de ninguno de los dos hosts; el más cercano es "context
   rot" en el doc de subagentes de Codex.
