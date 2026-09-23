# El scribe es dueño del Markdown — Design

## Approach

Tres piezas, en este orden de dependencia:

1. **Contrato de handoff en JSON.** El `implementer` deja su evidencia en
   `.claude/progress/impl_<feature>.json`. Es un archivo, no su respuesta final, para que la
   evidencia no pase por el contexto del orquestador ni se reescriba de memoria (la regla
   anti-teléfono-descompuesto de `orchestrator.md`, sección de paths fijos por agente). El scribe lo
   lee directo del disco.
2. **Guarda mecánica.** Un hook `PreToolUse` global que bloquea la escritura de `.md`/`.mdx` cuando
   `agent_type` es `implementer`, con `exit 2` y el motivo en stderr — el mismo idioma de
   `guard-destructive.sh`, que Claude Code evalúa antes de las reglas de permiso. La prosa del
   contrato sola no basta: el problema de #985 es precisamente un contrato que el agente sigue por
   inercia.
3. **Reencadenado del orquestador.** `implementer` → `scribe` → `reviewer`. El scribe escribe en el
   worktree del implementer y commitea aparte; el reviewer juzga el diff completo.

Descartado: **respuesta final como payload** (el orquestador la reenviaría en el prompt del scribe,
reescribiéndola y pagándola en su propio contexto). **Hook en el frontmatter de `implementer.md`**:
Claude Code lo soporta (hooks por agente, activos solo mientras corre el subagente), pero el render
de navori no reconoce la clave `hooks:` en frontmatter de agentes hoy (`frontmatter-merge.ts`,
`fmkeys`). Soportarla es un cambio de render en un área crítica que no hace falta: el hook global con
filtro por `agent_type` sigue el patrón exacto de `guard-destructive.sh`.

Hechos verificados contra https://code.claude.com/docs/en/hooks.md (2026-09-23):
- `agent_type` llega en la entrada de todo hook que se dispara dentro de un subagente, con el nombre
  del subagente.
- Un hook de `PreToolUse` que sale con `exit 2` bloquea la llamada y su stderr llega al modelo.
- El hook de handoff corre en el `PostToolUse(Agent|Task)` del hilo padre, no dentro del subagente,
  así que ahí no hay `agent_type`. La identidad sale de `tool_input.subagent_type`, que es el
  parámetro con el que el orquestador despachó al agente. El comentario de
  `subagent-stop-handoff.sh` que dice que la identidad no está al alcance es anterior a esto y T1 lo
  corrige; T1 captura primero un payload real del evento para confirmar el campo antes de depender
  de él.

## Admisión (spec 0031, R7)

Ampliar al `scribe` es ampliar el trabajo de un agente existente, así que pasa R1–R3 de la spec
0031 antes de encenderse. La declaración — covers R12:

- **Garantía que reclama.** Dos, con la de tokens como principal:
  - *Tokens netos*: el implementer deja de mantener Markdown durante toda su corrida (plan con
    checkboxes, reporte reescrito tras cada rebase, prosa entregable) y el reporte de handoff corre
    en el tier barato. Tiene que cubrir el arranque en frío de cada despacho del scribe (~25k tokens
    según la enmienda de 0027), que se cuenta completo.
  - *Calidad*: la prosa entregable la escribe un agente cuyo único trabajo es escribir, en un tier
    que el orquestador fija por despacho (sonnet), a partir de un pedido con intención y evidencia.
- **Señal.** Tokens totales de subagente por ciclo completo (implementer + scribe + reviewer), del
  `usage` que el orquestador ve en cada notificación, en 3 ciclos reales con el flag encendido,
  contra ciclos de tamaño comparable sin el flag. Referencia de hoy, sin flag: implementers de
  268k–295k tokens en cambios medianos (#894 fase 1, lote 1 de esta spec). Calidad: hallazgos del
  reviewer sobre prosa entregable en esos mismos ciclos.
- **Costo contra producto.** Un despacho extra por ciclo (el scribe), con su arranque en frío,
  contra el Markdown que el implementer deja de escribir y mantener.
- **Criterio de retiro con plazo.** Si a los 14 días del merge los 3 ciclos medidos no muestran
  ahorro neto de tokens ni menos hallazgos sobre prosa, el flag queda en `false`, la tabla de 0031
  registra el resultado y #993 sigue con esa evidencia (R14). El código gateado se retira en ese
  ticket.

**Apagado por default.** Sigue el espíritu de R4 de 0031 aunque el scribe no sea agente nuevo:
`harness.scribeOwnsMarkdown` en `false` deja el harness exactamente como estaba — R13.

## Components

- `packages/core/core-assets/hooks/implementer-no-markdown.sh` (nuevo) — lee `agent_type`,
  `tool_name` y `tool_input` del stdin; bloquea `Write|Edit|NotebookEdit` sobre
  `*.md`/`*.mdx` y las formas de `Bash` de R4 — covers R3, R4.
- `packages/cli/src/engines/claude/build-settings.ts` — registra el hook en `PreToolUse` con matcher
  `Bash|Edit|Write|NotebookEdit` (el mismo conjunto que
  `COVERED_TOOLS` en `managed-drift-watch.sh`, que `hook-matcher-wiring.test.ts` hace cumplir), siempre
  activo — covers R3, R4.
- `packages/core/core-assets/hooks/subagent-stop-handoff.sh` — lee `tool_input.subagent_type`; valida
  `impl_<feature>.json` al volver el implementer y `impl_<feature>.md` al volver el scribe — covers R10.
- `packages/core/core-assets/agents/implementer.md` — quita toda instrucción de escribir `.md`,
  declara la prohibición y el contrato JSON con `markdownRequests` — covers R1, R2.
- `packages/core/core-assets/agents/scribe.md` — el scribe pasa de serializador a **autor del
  Markdown**: render del handoff sin agregar afirmaciones (R5), y redacción de la prosa de cada
  `markdownRequests` a partir de su `intent` y `evidence`, leyendo el repo para ser exacto pero sin
  tomar decisiones de diseño que el pedido no traiga (R7). Retira "not yet wired", la regla "you do
  not investigate" y la exclusión de documentación de usuario — covers R5, R6, R7.
- `packages/core/core-assets/agents/orchestrator.md` y `packages/core/core-assets/managed/orquestacion.md`
  — encadenado, elección de modelo por despacho, tabla de archivos de `.claude/progress/`, y la
  excepción del implementer (`done -> .claude/progress/impl_<feature>.json`) en la plantilla de cierre
  compartida — covers R8, R9.
- `packages/core/core-assets/skills/resolve-ticket.md` y `packages/core/core-assets/skills/verify-before-done.md`
  — hoy dicen que el implementer produce `impl_<feature>.md`; pasan al `.json` + scribe — covers R9.
- `specs/0027-scribe-agent/design.md` — enmienda con la medición — covers R11.
- `packages/cli/src/lib/schema.ts` (`HarnessSchema`) — `scribeOwnsMarkdown: z.boolean().default(false)`
  — covers R13.
- Prosa condicional con `<!-- navori:if scribeOwnsMarkdown -->` / `<!-- navori:if-not ... -->`
  (`conditionOrchestration` en `render-plan.ts`, que ya resuelve claves de `harness`). Si hoy solo se
  aplica al bloque de orquestación, se extiende a los assets de agentes y skills que toca esta spec —
  covers R13.
- `build-settings.ts` — registra `implementer-no-markdown.sh` solo con el flag en `true` — covers R13.
- `specs/0031-admision-de-agentes/design.md` — la fila de `scribe` en la tabla del roster apunta a
  esta spec y, al cerrar T7, registra el resultado — covers R14.

## Decisions

- **Alcance literal: ningún `.md`, incluida la prosa entregable.** Decisión de Ulises (2026-09-23),
  tomada viendo el costo: desde el 2026-09-01 los implementers editaron `.md` entregable ~520 veces
  (165 core-assets no-agentes, 74 prosa de agentes, 136 specs, ~143 docs/README/CONTRIBUTING). Todo
  eso pasa al scribe.
- **Modelo por despacho, no por config.** `models.scribe` queda en su default barato para los
  handoffs; el orquestador pasa `model: sonnet` a la herramienta `Agent` cuando algún
  `markdownRequests` toca el diff entregable. Un solo tier caro para todo pagaría sonnet por
  serializar reportes — R8.
- **Salida generada no cuenta como escritura.** `navori render --apply` y `bun run gen:schemas`
  escriben `.md` (agentes renderizados, espejos) como salida de un generador sobre fuente que ya
  escribió el scribe. La guarda de R4 bloquea redirección, `tee` e in-place edits, no la ejecución de
  un generador. Si el implementer necesita cambiar el contenido, lo pide en `markdownRequests`.
- **Validación de JSON sin dependencia nueva.** El hook valida con `node` (ya requerido por
  navori) y degrada a no-bloqueante si falta, igual que `subagent-stop-handoff.sh` hoy. No se agrega
  un subcomando `navori handoff validate`: el contrato son las claves de R2, y el scribe es el
  consumidor que bloquea (R6).
- **El reviewer revisa una vez, al final.** Sigue vigente R9 de 0027: un solo review sobre el diff
  completo, después del último cambio de Markdown.

## Contracts

`impl_<feature>.json`:

```json
{
  "feature": "894-fase1",
  "status": "DONE",
  "worktree": "/abs/path/.claude/worktrees/agent-x",
  "branch": "refactor/894-lib-fase1",
  "commits": ["f70d53ef…"],
  "filesTouched": ["packages/cli/src/lib/assets/doc-budgets.ts"],
  "rootCause": "one line, optional",
  "verification": { "command": "bun check", "exitCode": 0, "summary": "254 files / 4639 tests" },
  "markdownRequests": [
    {
      "path": "CONTRIBUTING.md",
      "intent": "update the moved path in the release section",
      "evidence": "doc-budgets.ts moved to lib/assets/ in f70d53ef"
    }
  ],
  "blockers": []
}
```

`markdownRequests[].intent` dice qué cambiar y por qué; nunca trae el texto final ya redactado (eso
sería el implementer escribiendo Markdown por otra vía).

## Failure modes

- **Evasión deliberada de la guarda**: R4 cubre las formas de escritura que un agente usa por inercia.
  `python3 -c`, `node -e`, `dd`, `rsync` o `git apply` pasan. Es la misma postura de
  `guard-destructive.sh` ("NOT a sandbox against a deliberate adversary"): el contrato de R1 es la
  regla, la guarda atrapa el desliz.
- **Payload ausente o inválido**: el hook de handoff lo marca al volver el implementer (R10); el
  scribe devuelve `BLOCKED` sin fabricar el artefacto (R6); el orquestador no lanza al reviewer.
- **Main avanza entre implementer y scribe**: el scribe escribe sobre el branch del implementer; la
  sincronización con `origin/main` sigue siendo del orquestador antes del reviewer, como hoy.
- **Otros engines (Codex, Cursor, Copilot)**: no hay `agent_type` ni `PreToolUse` equivalente; la
  regla llega solo como prosa del contrato. Es la misma asimetría que `guard-destructive.sh`.

## Testing strategy

- Guarda: casos de bloqueo para cada tool y cada forma de `Bash` de R4; casos allow para `.md` desde el
  hilo principal, desde `scribe`, y para `.json`/`.ts` desde `implementer` — el riesgo es un falso
  positivo que bloquee al scribe, o uno negativo que deje pasar `sed -i`.
- Registro: `hook-matcher-wiring.test.ts` cubre el matcher nuevo.
- Handoff: fixtures de JSON válido, sin clave, sin parsear; `.md` del scribe sin `Status:`.
- Contratos de prosa: aserciones sobre `implementer.md` (ninguna instrucción de escribir `.md`),
  `scribe.md` (sin "not yet wired") y el orquestador (cadena y elección de modelo).

## NOT in scope

- Aplicar la regla a `auditor`, `scout` o `reviewer`: #985 la pide para el implementer. Se evalúa
  aparte con la medición de R11.
- Soporte de `hooks:` en el frontmatter de agentes en el render de navori.
- Guardas equivalentes en engines sin hooks.
