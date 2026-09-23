# Planificación por niveles — Design

## Approach

El plan se formaliza como **un artefacto con contrato más un validador determinista**, no como un
agente nuevo. El orquestador sigue siendo dueño del plan; lo que cambia es que ese plan queda en
un archivo con secciones fijas, criterios ejecutables y un estado que se actualiza durante la
ejecución, y que un comando del CLI rechaza el plan que no cumple el formato.

Cuatro niveles, decididos por señales que ya existen en la tabla de `managed/orquestacion.md`:

| Nivel | Señal | Artefacto | Quién |
|---|---|---|---|
| 0 · directo | un archivo, ninguna fila de la tabla | ninguno | orquestador |
| 1 · plan simple | no es 0, sin fila arquitectónica | `workplan_<feature>.md` (R8) | orquestador |
| 2 · plan avanzado | fila arquitectónica | `solution_<scope>.md` + challenge + `workplan` (R8, R9) | `architect` diseña, orquestador planea |
| 3 · SDD | umbral del bloque SDD, aceptado | `specs/<feature>/tasks.md` | orquestador |

Los niveles 1 y 2 comparten archivo y validador; el nivel 2 solo exige más secciones. Así hay un
formato y un parser, no dos.

**Descartados:**

- **Agente planificador dedicado.** Un subagente no ve la conversación, y el orquestador tendría
  que resumirle la intención del usuario: el teléfono descompuesto que la doctrina evita. No pasa
  la prueba de la spec 0031: el plan es un paso en serie (no hay velocidad), agrega un arranque en
  frío sin sacar nada voluminoso del contexto principal (no hay tokens), y la verificación en
  contexto fresco ya la da el `auditor` en el challenge (la calidad no es nueva). ECC tiene un
  `planner`, pero su propio `/plan` corre inline por default.
- **Gate duro por hook** (tipo plan mode de Claude Code o `plan-canvas` de ECC). Es el único
  enforcement real, pero depende de un hook de Claude Code (rompe la paridad multi-engine) y toca
  hooks, que es área crítica. Se pospone hasta que la señal de R10/R18 muestre planes saltados.
- **`A<n>` → test obligatorio.** Es SDD sin nombre. gentle-ai quitó su matriz estricta escenario →
  test por el costo en ceremonia.

## Components

- `packages/core/core-assets/managed/orquestacion.md` — sección nueva de niveles de planificación
  dentro de "How much analysis does this task deserve", condicionada a `harness.planTiers` —
  cubre R1–R6, R15, R23.
- `packages/core/core-assets/agents/orchestrator.md` — cómo escribir y mantener el `workplan`,
  la plantilla, la regla de desvíos, el orden `architect` → challenge → veredicto → `workplan`, y
  la entrada `workplan_<feature>.md` en la lista de handoffs de `.claude/progress/` — cubre R7–R11,
  R16, R19–R21.
- `packages/core/core-assets/skills/resolve-ticket.md` — la fase 3 (Design) y la fase 4 leen y
  referencian el `workplan` — cubre R16, R19, R20.
- `packages/core/core-assets/agents/implementer.md` — lee los `A<n>` asignados y reporta
  `acceptance` en `impl_<feature>.json` — cubre R17.
- `packages/core/core-assets/agents/reviewer.md` — verifica `acceptance` y el alcance contra el
  `workplan` — cubre R18.
- `packages/core/core-assets/agents/architect.md` — aclara que su salida alimenta el plan de nivel 2
  y que no lo escribe — cubre R21.
- `packages/cli/src/commands/plan.ts` — comando `plan` con subcomando `check`, registrado en
  `subCommands` de `packages/cli/src/index.ts` — cubre R12–R14.
- `packages/cli/src/lib/plan/` — parser y reglas del `workplan`, sin dependencia del comando para
  poder probarlos solos — cubre R12, R13.
- `packages/cli/src/lib/config/schema.ts` — flag `harness.planTiers` (default `false`) — cubre R23.
- `navori.config.json` — `harness.planTiers: true` y `harness.architect: true` — cubre R24.
- Este `design.md`, sección "Admisión del architect" — cubre R22.

## Decisions

- **Nombre `workplan_<feature>.md`, no `plan_<scope>.md`** — el segundo ya es el plan priorizado
  del encargo de área del `auditor` (`auditor.md`, "Communication with the orchestrator"). Reusarlo
  mezclaría dos contratos en un nombre.
- **El `workplan` vive en `.claude/progress/`** — es un handoff entre orquestador, `implementer` y
  `reviewer`, igual que `impl_*` y `review_*`, y ese directorio está en `.gitignore`. Lo que
  persiste del ciclo sigue siendo la entrada de `progress/history.md`; `progress/current.md` solo
  apunta al `workplan` activo (R10) para no duplicar estado.
- **Criterio = comando + salida esperada** — tomado del ExecPlan de Codex. Un criterio sin comando
  no se puede verificar; por eso R13 lo rechaza en vez de advertirlo.
- **Validador en el CLI, no en un hook** — `navori plan check` corre igual en cualquier engine y
  el `reviewer` lo puede re-ejecutar. Sigue el precedente de `navori receipt`, que ya es la pieza
  determinista del ciclo. La disciplina de correrlo (R15) queda en el contrato del orquestador; el
  `reviewer` la verifica de hecho porque R18 depende del `workplan`.
- **El nivel lo deciden señales y el usuario solo puede subirlo** (R3, R4) — si el nivel
  dependiera del juicio del orquestador, volvería el problema de origen. Bajar el nivel en área
  crítica se niega porque esa fila existe precisamente para no saltarse el diseño.
- **Nivel 0 = un archivo** — "cabe en una frase" (la guía de Claude Code) no es verificable; "un
  archivo y ninguna fila de la tabla" sí lo es, con `git diff --stat` al final.
- **El `architect` diseña y el orquestador planea** (R19, R21) — el contrato del `architect` ya
  prohíbe descomponer y dar veredicto. Mantenerlo así deja al challenge entre el diseño y las
  tareas; si el `architect` planeara, nadie cuestionaría el diseño antes de convertirlo en trabajo.
- **Flag `harness.planTiers` default `false`** — mismo rollout que `scribeOwnsMarkdown` (spec
  0030): cambia el bloque always-on de todos los repos renderizados, así que entra apagado y se
  enciende aquí primero.

## Contracts

**Formato del `workplan`** (lo que parsea `navori plan check`):

```md
# <feature> — Workplan

**Nivel:** 1

## Objetivo
Una línea con el resultado observable.

## Criterios de aceptación
- **A1** — descripción · `bun test packages/cli/src/lib/plan/check.test.ts` → `0 fail`
- **A2** — descripción · `node packages/cli/dist/index.js plan check x.md` → `exit 1`

## Fuera de alcance
- elemento

## Archivos
- `packages/cli/src/lib/plan/check.ts` (nuevo)
- `packages/cli/src/index.ts`

## Progreso
- A1 — pendiente
- A2 — pendiente

## Decisiones
- (vacío hasta el primer desvío)
```

Nivel 2 agrega `## Solución` (path a `solution_<scope>.md` + veredicto), `## Fases` (lotes con sus
`A<n>`) y `## Riesgos y rollback`. El marcador de archivo nuevo es el sufijo literal `(nuevo)`.

**Clave `acceptance` en `impl_<feature>.json`** (opcional para el hook de handoff; obligatoria por
contrato cuando el encargo trae `A<n>`):

```json
"acceptance": [
  { "id": "A1", "command": "bun test …", "exitCode": 0, "excerpt": "12 pass, 0 fail" }
]
```

No se agrega a las claves requeridas de `subagent-stop-handoff.sh`: una tarea de nivel 0 no la
lleva, y el hook no sabe el nivel.

## Failure modes

- **Plan desactualizado.** El orquestador olvida actualizar Progreso. Mitigación: el `reviewer`
  lee el `workplan` y lo contrasta con `acceptance`; un `A<n>` marcado `cumplido` sin evidencia es
  hallazgo.
- **Criterios triviales.** Un `A<n>` como `` `true` → `exit 0` `` pasa el validador. El validador
  garantiza forma, no pertinencia; la pertinencia la juzga el usuario al aprobar y el `reviewer` al
  revisar.
- **Presupuesto de documentos.** `check:doc-budgets` limita el tamaño de los bloques managed. La
  sección nueva en `orquestacion.md` debe caber; si no cabe, la plantilla vive en
  `orchestrator.md` y el bloque solo enlaza.

## Testing strategy

- Parser y reglas (`lib/plan`): un fixture válido por nivel y uno inválido por cada regla de R13,
  para que cada falla se pruebe aislada.
- Comando (`commands/plan.ts`): código de salida y mensajes sobre fixtures en disco (R12–R14).
- Render: con `harness.planTiers` en `false` el bloque de orquestación queda byte a byte igual que
  antes (snapshot golden), y en `true` incluye la sección de niveles (R23).
- Contratos de agentes: los tests de assets existentes (`agents-assets.test.ts`) cubren que
  `implementer`, `reviewer`, `orchestrator` y `architect` mencionan lo que R16–R21 exigen.

## Admisión del architect (spec 0031 R3)

- **Garantía:** calidad. Diseño en un tier que el orquestador no se fija (`opus`/`high`) y en
  contexto aislado, verificado después por un `auditor` fresco.
- **Señal:** en los ciclos de nivel 2, cuántos `solution_<scope>.md` del `architect` terminan en
  veredicto READY o CONCERNS frente a BLOCKED, y cuántos hallazgos del `reviewer` de esos ciclos
  apuntan a un defecto de diseño.
- **Costo:** un arranque en frío y una corrida `opus`/`high` por tarea de nivel 2, que son las
  menos frecuentes. Produce el `solution_<scope>.md` que hoy escribe el orquestador en su propio
  contexto.
- **Retiro:** el criterio 2 de la spec 0026 ya vigente: 60 días sin ciclos → evaluar `architect`
  para `RETIRED_AGENTS`. Si en ese plazo la señal no muestra diferencia frente a la pasada del
  orquestador, `harness.architect` vuelve a `false` en este repo.

## NOT in scope

- **Gate duro por hook o firma.** Se reconsidera si, tras un mes con `planTiers` encendido, hay
  ciclos de nivel 1 o 2 despachados sin `workplan` en verde.
- **Actualización automática de Progreso.** La escribe el orquestador; automatizarla desde
  `impl_*.json` es una mejora posterior con su propio ticket.
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
