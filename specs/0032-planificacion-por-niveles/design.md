# Planificación por niveles — Design

## Approach

El plan se formaliza como **un artefacto con contrato más un validador determinista**, no como un
agente nuevo. El orquestador sigue siendo dueño del plan; lo que cambia es que ese plan queda en
un JSON con esquema fijo, criterios ejecutables y un estado que se actualiza durante la ejecución,
y que un comando del CLI rechaza el plan que no cumple el formato.

El plan es el default y saltarlo exige una exención que el código verifica; el control lo da un
gate en el despacho, no la prosa.

Cuatro niveles, decididos por `navori plan classify` (R1) sobre las señales de "Señales y pesos":

| Nivel | Señal | Artefacto | Quién | Requisito para despachar |
|---|---|---|---|---|
| 0 · directo | complejidad ≤ 3, ≤ 1 archivo no trivial, sin piso de R3 (R4) | ninguno | orquestador | exención de `classify` |
| 1 · plan simple | default salvo nivel 0/2/3 (R4) | workplan JSON + render (R13) | orquestador | workplan con `plan check` |
| 2 · plan avanzado | complejidad ≥ 8 o piso de R3 (R3, R5) | solution + challenge + workplan (R13, R14) | `architect` diseña, orquestador planea | solution + challenge + elección del usuario + workplan |
| 3 · SDD | el usuario aceptó una spec (R5) | `specs/<feature>/tasks.md` | orquestador | `tasks.md` |

Los niveles 1 y 2 comparten el mismo esquema JSON y el mismo validador; el nivel 2 solo exige más
secciones. Así hay un formato y un parser, no dos.

**Descartados:**

- **Agente planificador dedicado.** Un subagente no ve la conversación, y el orquestador tendría
  que resumirle la intención del usuario: el teléfono descompuesto que la doctrina evita. No pasa
  la prueba de la spec 0031: el plan es un paso en serie (no hay velocidad), agrega un arranque en
  frío sin sacar nada voluminoso del contexto principal (no hay tokens), y la verificación en
  contexto fresco ya la da el `auditor` en el challenge (la calidad no es nueva). ECC tiene un
  `planner`, pero su propio `/plan` corre inline por default.
- **`A<n>` → test obligatorio.** Es SDD sin nombre. gentle-ai quitó su matriz estricta escenario →
  test por el costo en ceremonia.
- **Scribe para el workplan.** El arranque en frío de un subagente (~25k tokens) supera lo que
  produce (~2k), la misma razón que retiró T2–T4 de la spec 0027; el render determinista (R11) lo
  sustituye.

**Adoptado:**

- **Gate duro por hook.** Se adopta. La evidencia de este repo es que los avisos no cambian la
  conducta y los bloqueos sí (Context). El gate va en el despacho del implementer, no en
  Edit/Write, porque ahí se decide el trabajo; `PreToolUse` intercepta la herramienta `Agent` y ve
  su `subagent_type` (<https://code.claude.com/docs/en/hooks>). En Codex navori solo registra
  `PreToolUse` (`engines/codex/compat.ts:113`); donde no se pueda interceptar el despacho, aplica
  R17.

## Señales y pesos

Pesos iniciales, a calibrar con el usuario en T0:

| Señal | Cómo se obtiene | Peso |
|---|---|---|
| Archivos no triviales (`source-classify`) | medido sobre Archivos | 1 → 0 · 2–3 → +2 · 4–7 → +3 · 8+ → +4 |
| Directorios raíz distintos tocados | medido | 2 → +1 · 3+ → +2 |
| Bug sin causa raíz confirmada | declarado | +2 |
| Área crítica (`project.criticalPaths` o declarada) | medido o declarado | piso 2 |
| Dinero, credenciales o PII | declarado | piso 2 |
| Dos o más repos | declarado | piso 2 |
| Dependencia externa nueva | medido (manifiestos) o declarado | piso 2 |
| Contrato compartido (API, DTO, schema, evento) | declarado | piso 2 |
| Migración de datos o de esquema | declarado | piso 2 |

Derivación: con piso → nivel ≥ 2; si no, ≤ 3 y ≤ 1 archivo no trivial → 0; ≥ 8 → 2; resto → 1.
"Declarado" significa que lo escribe el orquestador en el JSON y el reviewer lo verifica después
contra el diff (R21).

## Components

- `packages/core/core-assets/managed/orquestacion.md` — sección nueva de niveles de
  planificación, contiene solo la tabla de niveles y la regla del gate, condicionada a
  `harness.planTiers` — cubre R1, R4, R5, R6, R16, R22, R30.
- `packages/core/core-assets/agents/orchestrator.md` — presentación del nivel al usuario, orden
  `architect` → challenge → elección del usuario → veredicto → workplan, rehacer el plan cuando
  `classify` sube el nivel, y la entrada `workplan_<feature>.json`/`.md` en la lista de handoffs de
  `.claude/progress/` — cubre R6, R7, R18, R19, R23, R24.
- `packages/core/core-assets/skills/resolve-ticket.md` — las fases que despachan al implementer y
  al `architect` referencian el workplan y el flujo de nivel 2 — cubre R20, R23, R24.
- `packages/core/core-assets/agents/implementer.md` — lee los `A<n>` asignados y reporta
  `acceptance` en `impl_<feature>.json` — cubre R20.
- `packages/core/core-assets/agents/reviewer.md` — verifica `acceptance`, el alcance contra el
  workplan y corre `classify` sobre el diff real — cubre R21.
- `packages/core/core-assets/agents/architect.md` — no escribe el workplan ni descompone en
  tareas, explora al menos tres peldaños y recomienda por encaje con el proyecto, y en nivel 3
  produce el `design.md` de la spec — cubre R25, R26, R28.
- `packages/core/core-assets/skills/solution-design.md` — deriva los criterios de decisión de las
  reglas del proyecto antes de listar opciones y verifica contra `origin/main` lo que el diseño da
  por existente — cubre R27.
- `packages/core/core-assets/skills/spec-bootstrap.md` — referencia al architect para el
  `design.md` de nivel 3 — cubre R28.
- `packages/core/core-assets/skills/plan-simple.md` — procedimiento de nivel 1 (antes en el
  bloque de orquestación) — cubre R10, R13, R22.
- `packages/core/core-assets/skills/plan-advanced.md` — procedimiento de nivel 2 — cubre R10,
  R14, R22.
- `packages/cli/src/commands/plan.ts` — comando `plan` con subcomandos `classify`, `render`,
  `update` y `check`, registrado en `subCommands` de `packages/cli/src/index.ts` — cubre R1, R11,
  R12, R15.
- `packages/cli/src/lib/plan/signals.ts` — pesos y umbrales de "Señales y pesos", único módulo
  que los define — cubre R2.
- `packages/cli/src/lib/plan/schema.ts` (zod) — esquema del workplan y `project.criticalPaths` —
  cubre R9, R10.
- `packages/cli/src/lib/plan/classify.ts` — calcula complejidad y nivel reusando
  `source-classify` — cubre R1, R3, R4, R5.
- `packages/cli/src/lib/plan/render.ts` — genera el `.md` desde el JSON de forma determinista —
  cubre R11.
- Hook `PreToolUse` sobre la herramienta `Agent` (Claude Code), con su test — cubre R16, R17,
  R19.
- `packages/cli/src/lib/config/schema.ts` — flag `harness.planTiers` (default `false`), el campo
  `project.criticalPaths` y el retiro de la clave `harness.architect` — cubre R9, R30, R33.
- `packages/cli/src/lib/config/config.ts` — mensaje de migración de la clave retirada
  `harness.architect` — cubre R33.
- `packages/cli/src/lib/config/recommended.ts` — default de core para el architect (`opus`,
  `effort: xhigh`) — cubre R34.
- `render-plan.ts` / `HARNESS_DEFAULTS` — se quita `architect` de los defaults del harness —
  cubre R33.
- `packages/core/core-assets/managed/orquestacion.md` y los assets con `navori:if architect` /
  `navori:if-not architect` — se eliminan esas ramas condicionales; el agente `architect` se
  renderiza siempre — cubre R33.
- `navori doctor` — reporta cuando el engine no permite interceptar el despacho — cubre R17.
- `navori.config.json` — `harness.planTiers: true` — cubre R31. El architect ya viene siempre
  habilitado con `opus`/`xhigh` por default (R34), sin flag que apagarlo.
- Este `design.md`, sección "Admisión del architect" — cubre R29, R35.

## Decisions

- **Nombre `workplan_<feature>.json`/`.md`, no `plan_<scope>.md`** — el segundo ya es el plan
  priorizado del encargo de área del `auditor` (`auditor.md`, "Communication with the
  orchestrator"). Reusarlo mezclaría dos contratos en un nombre.
- **El workplan vive en `.claude/progress/`** — es un handoff entre orquestador, `implementer` y
  `reviewer`, igual que `impl_*` y `review_*`, y ese directorio está en `.gitignore`. Lo que
  persiste del ciclo sigue siendo la entrada de `progress/history.md`; `progress/current.md` solo
  apunta al workplan activo (R12) para no duplicar estado.
- **Criterio = comando + salida esperada** — tomado del ExecPlan de Codex. Un criterio sin comando
  no se puede verificar; por eso R15 lo rechaza en vez de advertirlo.
- **Validador reusable en el CLI** — `navori plan check` corre igual en cualquier engine y el
  `reviewer` lo puede re-ejecutar. Sigue el precedente de `navori receipt`, que ya es la pieza
  determinista del ciclo. Además, el gate por hook (R16) intercepta el despacho del `implementer`
  en Claude Code; donde no se pueda interceptar, R17 degrada a la verificación del `reviewer`
  (R21).
- **El nivel lo deciden señales y el usuario solo puede subirlo** (R7) — si el nivel dependiera
  del juicio del orquestador, volvería el problema de origen. Bajar el nivel cuando hay un piso de
  R3 se niega porque ese piso existe precisamente para no saltarse el diseño.
- **Nivel 0 = complejidad ≤ 3 y ≤ 1 archivo no trivial** (R4) — reemplaza el criterio anterior de
  "un archivo" porque ahora `classify` (R1) da un número verificable con `source-classify`, no una
  cuenta de archivos a mano.
- **El `architect` diseña y el orquestador planea** (R23, R25) — el contrato del `architect` ya
  prohíbe descomponer y dar veredicto. Mantenerlo así deja al challenge entre el diseño y las
  tareas; si el `architect` planeara, nadie cuestionaría el diseño antes de convertirlo en trabajo.
- **Flag `harness.planTiers` default `false`** (R30) — mismo rollout que `scribeOwnsMarkdown`
  (spec 0030): cambia el bloque always-on de todos los repos renderizados, así que entra apagado y
  se enciende aquí primero.

## Contracts

**Esquema JSON del workplan** (fuente que valida `lib/plan/schema.ts`; `navori plan render`
genera el Markdown de forma determinista — R11):

```json
{
  "feature": "string",
  "level": "0 | 1 | 2 | 3",
  "classification": { "score": "number", "level": "0 | 1 | 2 | 3", "signals": ["string"] },
  "objective": "string",
  "acceptance": [{ "id": "A1", "description": "string", "command": "string", "expected": "string" }],
  "outOfScope": ["string"],
  "files": [{ "path": "string", "new": "boolean" }],
  "progress": { "A1": "pendiente | cumplido | bloqueado" },
  "decisions": [{ "text": "string", "date": "string" }],
  "solution": { "path": "string", "verdict": "READY | CONCERNS | BLOCKED" },
  "phases": [{ "name": "string", "acceptance": ["A1"] }],
  "risks": [{ "risk": "string", "rollback": "string" }]
}
```

`solution`, `phases` y `risks` solo aplican a nivel 2 (R14). El Markdown que ve el usuario es
siempre la salida de `plan render` (R11); ningún agente lo escribe a mano.

**Clave `acceptance` en `impl_<feature>.json`** (opcional para el hook de handoff; obligatoria por
contrato cuando el encargo trae `A<n>` — R20):

```json
"acceptance": [
  { "id": "A1", "command": "bun test …", "exitCode": 0, "excerpt": "12 pass, 0 fail" }
]
```

No se agrega a las claves requeridas de `subagent-stop-handoff.sh`: una tarea de nivel 0 no la
lleva, y el hook no sabe el nivel.

## Failure modes

- **Plan desactualizado.** El orquestador olvida actualizar Progreso. Mitigación: el `reviewer`
  lee el workplan y lo contrasta con `acceptance`; un `A<n>` marcado `cumplido` sin evidencia es
  hallazgo.
- **Criterios triviales.** Un `A<n>` como `` `true` → `exit 0` `` pasa el validador. El validador
  garantiza forma, no pertinencia; la pertinencia la juzga el usuario al aprobar y el `reviewer` al
  revisar.
- **Presupuestos de palabras medidos.** `orquestacion.md` 1007/1060, `solution-design.md`
  1069/1090, `architect.md` 385/400, `reviewer.md` 2133/2200 (`check:doc-budgets`). Regla:
  `orquestacion.md` reemplaza prosa en vez de sumar — el procedimiento de cada nivel va a las
  skills nuevas (`plan-simple`, `plan-advanced`); subir `maxWords` solo se autoriza en
  `architect.md`, con su razón documentada ahí.

## Testing strategy

- Señales y clasificación (`lib/plan/signals.ts`, `classify.ts`): fixtures de las 10 tareas de T0
  con su nivel esperado, y un fixture por piso de R3.
- Esquema y render (`lib/plan/schema.ts`, `render.ts`): un fixture válido por nivel; snapshot del
  render con la misma entrada dos veces para probar el mismo-bytes de R11.
- Validador (`lib/plan/check`, expuesto por `commands/plan.ts`): código de salida y mensajes sobre
  fixtures en disco, un fixture inválido por cada regla de R15.
- Comando (`commands/plan.ts`): subcomandos `classify`, `render`, `update` y `check` en
  `subCommands` (R1, R11, R12, R15).
- Gate (`plan-gate.test.ts`): niega el despacho sin workplan válido, deja pasar con plan válido o
  con exención de nivel 0, exige los artefactos del nivel siguiente tras dos rechazos (R16, R17,
  R19).
- Render del bloque: con `harness.planTiers` en `false` el bloque de orquestación queda byte a
  byte igual que antes (snapshot golden); en `true` incluye solo la tabla de niveles y la regla
  del gate (R22, R30).
- Contratos de agentes y skills: los tests de assets existentes (`agents-assets.test.ts` y los de
  skills) cubren que `implementer`, `reviewer`, `orchestrator`, `architect`, `solution-design`,
  `plan-simple` y `plan-advanced` mencionan lo que R20, R21 y R23–R28 exigen.

## Admisión del architect (spec 0031 R3)

- **Garantía:** calidad. Diseño en un tier que el orquestador no se fija (`opus`/`high`) y en
  contexto aislado, verificado después por un `auditor` fresco.
- **Señal:** en los ciclos de nivel 2, cuántos `solution_<scope>.md` del `architect` terminan en
  veredicto READY o CONCERNS frente a BLOCKED, y cuántos hallazgos del `reviewer` de esos ciclos
  apuntan a un defecto de diseño.
- **Garantía y costo:** un arranque en frío y una corrida `opus`/`high` por tarea de nivel 2, que
  son las menos frecuentes. Produce el `solution_<scope>.md` que hoy escribe el orquestador en su
  propio contexto. Se agrega `effort` `xhigh` en este repo (costo sin cifra oficial; se mide en
  las primeras 3–5 corridas).
- **Retiro:** este criterio reemplaza el criterio 2 de la spec 0026, que mediría un agente
  distinto del que esta spec deja. A los 60 días del release que incluya esta spec: 0 ciclos de
  architect → evaluar `RETIRED_AGENTS`; si en los ciclos de nivel 2 la proporción de challenges
  con BLOCKER no baja frente a los 9 `solution_*.md` hechos por el orquestador, se abre un issue
  para rediseñar el architect o retirarlo por `RETIRED_AGENTS`; ya no existe un flag para
  apagarlo.
- **Excepción a la spec 0031 R4 (R35):** habilitar el architect siempre, sin flag, es una
  excepción decidida por el usuario, con esta razón: "El costo queda acotado: el architect solo
  corre en tareas de nivel 2 y 3, y ese nivel lo decide `classify`, no el modelo. La señal y el
  criterio de retiro de R29 siguen vigentes."

## NOT in scope

- **Soporte en engines sin CLI de navori disponible.** `navori plan check` requiere el binario,
  igual que `navori receipt`.

## Evidencia

Investigación del 2026-09-23 sobre cómo otros harness formalizan la planificación:

| Fuente | Qué se toma | Qué se descarta |
|---|---|---|
| Codex ExecPlan — <https://developers.openai.com/cookbook/articles/codex_exec_plans> | criterio = comando + salida esperada; plan vivo con Progress y Decision Log | plan autocontenido de varias páginas |
| spec-kit — <https://github.com/github/spec-kit> (`templates/commands/analyze.md`) | validar el plan antes de codear; marcador `[NEEDS CLARIFICATION]` | constitución y checklists |
| ECC — <https://github.com/affaan-m/everything-claude-code> (`agents/planner.md`, `commands/plan.md`, commit `bf70150e`) | sección "NOT Building"; `Validate` por tarea | agente planner (su `/plan` corre inline) |
| gentle-ai — <https://github.com/Gentleman-Programming/gentle-ai> (PR #4644, commit `62ce74b7`) | un solo archivo vivo por feature; sin artefacto para lo pequeño | aprobación implícita; verificación no bloqueante |
| Claude Code — <https://code.claude.com/docs/en/best-practices>, <https://code.claude.com/docs/en/permission-modes> | saltar el plan en cambios mínimos | plan mode como gate (depende del engine) |
| Kiro — <https://kiro.dev/docs/specs/> | nivel ligero frente a spec completa | — |
| #691 (`dc0ca995`) y los 219 eventos | el umbral de la escalera anterior estaba en siete lugares que no coincidían; los avisos no cambiaron la conducta | — |
| <https://code.claude.com/docs/en/memory> | "context, not enforced configuration" | — |
| <https://code.claude.com/docs/en/hooks> | `PreToolUse` sobre la herramienta `Agent` | — |
| <https://code.claude.com/docs/en/best-practices> | Stop hook anulado tras 8 bloqueos: por eso el gate no va en Stop | — |
| gentle-ai `docs/intended-usage.md:54,120-124` | mismos umbrales 4+/2+ como prosa | no hay evidencia de que allá se cumplan |
| spec 0027 | costo del scribe (~25k tokens de arranque frío contra ~2k producidos) | — |
