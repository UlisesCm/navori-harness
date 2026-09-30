# Aprendizajes del curso de harness engineering — Evidence

## Procedencia y límites

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

## Lo que navori ya cubre (no se reabre)

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

## Brechas confirmadas

| Id | Brecha | Evidencia en el código |
|---|---|---|
| G | `plan update --progress A<n>=cumplido` lo autodeclara el agente; el `command` de `A<n>` no se ejecuta | `packages/cli/src/commands/plan.ts` — arg `progress`; `ProgressStatusSchema` sin evidencia asociada |
| S | No hay detección de atasco (mismo fallo repetido) en ningún hook | `packages/core/core-assets/hooks/` — sin estado de fallos repetidos en `.navori/state/hooks/` |
| V | El handoff del implementer no tiene campo de dudas; el reviewer no sabe dónde el implementer duda | `packages/cli/src/lib/handoff/schema.ts` — `ImplHandoff` (`verification`, `markdownRequests`, `rootCause`, `blockers`, `acceptance`) |
| P | Los hallazgos del reviewer viven en Markdown libre y se sobrescriben por feature; no hay historia minable | 17 `review_*.md` locales, solo 2 con `CHANGES_REQUESTED`; formato en `reviewer.md` § Verdict format |
| U | El reporte de rango cuenta agentes por corrida, no por sesión, y omite los declarados sin uso; nada marca candidatos a retiro | `audit/report.ts` — `totals.byAgentType` |

## Documentación oficial por mecanismo

### Gating de estado (G)

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

### Detección de atasco (S)

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

### Reviewer con contexto limpio (V)

- **Claude Code**: un subagente no-fork arranca con su system prompt, el prompt de delegación,
  todos los niveles de CLAUDE.md (salvo `omitClaudeMd: true`, v2.1.271+), git status y skills
  precargadas; no hereda la conversación. Fork (`/subtask`) sí la hereda. Fuente:
  `code.claude.com/docs/en/sub-agents` (resumen de WebFetch, no verbatim) y `.../memory`.
- **Codex**: `.codex/agents/*.toml` son capas de configuración; los docs no dicen si se hereda
  la historia. **ISSUE-ONLY** (`openai/codex#20077`): en MultiAgentV2, omitir `fork_turns`
  equivale a fork con historia completa; `fork_turns:"none"` da historia limpia.
- **Implicación**: en Claude Code, el reviewer ya arranca limpio; lo que ve del implementer es
  lo que el handoff le pasa. En Codex la limpieza no está garantizada por docs.

### Promoción de hallazgos a reglas (P)

- Ningún host documenta un flujo automático "hallazgo repetido → regla". Claude Code recomienda
  convertir lo que un review atrapa en CLAUDE.md, o en hook si debe cumplirse siempre
  (`code.claude.com/docs/en/memory`). Codex `.rules` (`prefix_rule`) es **EXPERIMENTAL** y solo
  a nivel de comando.
- **Implicación**: navori tendría que ser dueño de ese paso; y hoy no hay datos para minar.

### Peso del contexto siempre presente (U)

- **Claude Code**: CLAUDE.md meta <200 líneas por archivo, carga completa hasta 4 MiB. Memoria
  automática: primeras 200 líneas o 25KB de `MEMORY.md`. Listado de skills: 1% de la ventana,
  1,536 caracteres por entrada; con desborde, las menos usadas pierden la descripción primero.
  `disable-model-invocation` cuesta cero contexto. El contexto que agregan los hooks se añade al
  final y no invalida el caché; tras compactar, se resume.
- **Codex**: `project_doc_max_bytes` 32 KiB combinado por defecto; listado de skills 2% de la
  ventana u 8,000 caracteres; `skills.max_context_tokens` tope 10,000.

## Contradicciones del curso con la documentación oficial

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
