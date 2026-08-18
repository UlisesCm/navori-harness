# Spec 0012 — Capa de Solutioning · Design

**Estado:** en revisión (GATE H1) · **Fecha:** 2026-08-18
**Requirements:** [`requirements.md`](./requirements.md) · **Runbook:** [`plan.md`](./plan.md)

## Decisión de arquitectura

**0 agentes nuevos · 1 skill nueva · 3 assets editados · ≤120 palabras always-on.**

Se evaluaron cuatro arquitecturas (las tres del prompt de origen más la elegida):

| | Piezas | Por qué NO |
|---|---|---|
| A | skill + `plan-reviewer` (agente) | El agente nuevo cuesta `CORE_AGENTS` + `HarnessSchema` + `ModelsSchema` + `EffortSchema` + i18n es/en + `features.coreAgents` + paridad Codex (Spec 0004 sin implementar), para una responsabilidad que `researcher` ya puede cargar |
| B | `solution-architect` + `plan-reviewer` (2 agentes) | Todo lo de A ×2. `solution-architect` además compite con el orquestador, que ya posee la síntesis ("synthesis is not delegated") |
| C | skill con `context:fork` + self-challenge del orquestador | El self-challenge confirma sus propias decisiones — es el modo de fallo que el fresh-context existe para evitar |
| **D (elegida)** | **skill `solution-design` + challenge vía `researcher` existente + veredicto del orquestador** | Contexto fresco real, cero superficie nueva, portable a cualquier engine que tenga un rol de investigación read-only |

**Reparto de responsabilidades resultante:**

```
skill solution-design  → enseña CÓMO diseñar y qué desafiar (on-demand)
researcher (existente) → aporta la perspectiva independiente (contexto fresco)
orquestador            → emite el veredicto y descompone (nunca se delega)
implementer            → escribe el código
reviewer               → valida el diff contra lo acordado
```

`ticket-audit` (fase 0, ya en `main`) responde *qué pasa / dónde / por qué / qué
evidencia hay*. `solution-design` responde *dada esa evidencia, qué construimos y
por qué*. El reviewer sigue respondiendo *¿el código hizo lo acordado?* — design
review y code review no se mezclan.

## Señales de activación (R2)

Se rechaza el conteo de archivos como definición (un rename de 40 archivos es
trivial; un cambio de ownership en 2 archivos no lo es). Las señales son
propiedades del cambio, y basta una:

1. Nueva abstracción compartida por más de un consumidor
2. Cambio de ownership de estado (quién es la fuente de verdad)
3. Contrato compartido: API, DTO, schema, evento
4. Migración o cambio de schema de datos
5. Dependencia externa nueva
6. Concurrencia o sincronización de estado
7. Área crítica (`project.criticalAreas`)
8. Decisión difícil de revertir
9. ≥2 enfoques viables genuinos

**Señal negativa explícita** (fuerza R1/R2 normal): existe un patrón exacto en el
repo que ya resuelve el caso, el cambio es local y el rollback es trivial.

## Wording para `orquestacion.md` (presupuesto: ≤120 palabras)

Se inserta como sub-bloque tras la tabla de rutas, dentro de R2:

> **R2-architectural — design before you decompose.** A task inside R2 that shows
> ANY of these earns a solution pass first: new shared abstraction · state
> ownership change · shared contract (API/DTO/schema/event) · migration or schema
> change · new external dependency · concurrency/state sync · a `criticalAreas`
> area · hard-to-reverse decision · ≥2 genuinely viable approaches. File count is
> a hint, never the definition — an exact existing pattern with a local change and
> a trivial rollback stays plain R2.
>
> The pass is: `solution-design` skill → ONE fresh-context challenge (a
> `researcher`, not a new agent) → your verdict READY / CONCERNS / BLOCKED. It
> happens BEFORE the plan is approved — it is not a licence to pause mid-execution,
> and `CONCERNS` never blocks.

(≈118 palabras. La última frase es obligatoria: `orquestacion` prohíbe pausar tras
aprobar el plan, y sin ese apunte el bloque nuevo se leería como permiso para
detenerse a media ejecución.)

## Artefacto: `.claude/progress/solution_<scope>.md`

Efímero, como el resto de handoffs. Si la decisión resulta durable se promueve a
spec o al Dominio en el cierre de sesión.

```markdown
# Solution — <scope>

**Verdict:** READY | CONCERNS | BLOCKED   ← lo escribe el orquestador tras el challenge
**Signals:** <cuáles de las 9 dispararon esta pasada>

## Problem
<qué comportamiento cambia y quién lo consume — no el síntoma del ticket, el problema>

## What already exists            ← OBLIGATORIA, con evidencia
- `file:line` — <patrón existente que resuelve esto total o parcialmente>
- <por qué extenderlo / por qué no alcanza>

## Constraints
<invariantes, compatibilidad, convenciones que no se negocian>

## Approaches                     ← solo si hay ≥2 genuinos
### A — <nombre> · tradeoffs · costo de reversión
### B — <nombre> · tradeoffs · costo de reversión

## Chosen solution
<qué · por qué · por qué no las otras>

## Boundaries & contracts         ← condicional (señales 1,2,3)
## Failure modes                  ← condicional (señales 6,7)
## Migration & compatibility      ← condicional (señales 4,5)
## Testing strategy               ← cada test responde a un riesgo nombrado arriba
## NOT in scope
<trabajo diferido + razón. Impide que el implementer "mejore cosas de paso">

## Open questions
- [repo] <la investigo yo>  · [human] <la pregunto> · [assumed] <asunción registrada>
```

Las secciones condicionales no se emiten vacías (R9).

## Challenge: encargo de falsificación

Lo ejecuta un `researcher` fresco (read-only, escribe a progress). Su encargo NO es
mejorar el diseño sino intentar romperlo:

- ¿Qué supuesto del diseño es falso?
- ¿Qué código existente lo contradice?
- ¿Qué requirement no queda cubierto?
- ¿Qué contrato se rompe?
- ¿Qué pasa en fallo parcial / timeout / evento duplicado?
- ¿Quién es dueño de este estado, y el diseño lo respeta?
- ¿Duplicamos una abstracción que ya existe?
- ¿Se puede con menos maquinaria?
- ¿Los tests detectan el riesgo principal?

Salida: `.claude/progress/solution_review_<scope>.md` con hallazgos clasificados
`BLOCKER | CONCERN | NOTE`. **No emite el veredicto** — lo emite el orquestador al
sintetizar (doctrina navori: la síntesis no se delega).

## Semántica del veredicto

| | Significado | Efecto |
|---|---|---|
| `READY` | Sin blockers conocidos. Puede haber notes. | Implementar |
| `CONCERNS` | Riesgos reales registrados, atención extra en review. | **Implementar** — nunca bloquea |
| `BLOCKED` | Implementar ahora significa adivinar una decisión que puede cambiar la solución. | Preguntar y parar |

Un `BLOCKED` **debe** declarar los cuatro campos (hecho bloqueante · por qué no se
puede proceder · dueño · información mínima). Si no puede, no es BLOCKED — es un
CONCERN.

**Nunca son blockers**: preferencia de nomenclatura, abstracción futura
hipotética, optimización menor, edge case opcional, preferencia estilística.

**Evidencia de por qué esto importa:** BMAD-METHOD issue #2079 (abierto, high
priority, v6.0.2): su `check-implementation-readiness` marca hallazgos no
bloqueantes como bloqueantes → corrección → readiness → mismos hallazgos → loop
sin estado de pass. La carga de la prueba en BLOCKED y el tope de una ronda son
la defensa directa contra ese modo de fallo.

**Anti-litigio** (gstack): una vez que el usuario acepta o rechaza una reducción de
alcance, se ejecuta; no se re-argumenta en fases posteriores.

## Lo que se toma de cada fuente (provenance resumido)

| Patrón | Fuente | Adopción |
|---|---|---|
| "What already exists" obligatorio | gstack `plan-eng-review` Step 0 | **ADD** — el modo de fallo real es inventar arquitectura en vez de extender |
| "NOT in scope" | gstack (outputs requeridos) | **ADD** — barato, frena el scope creep del implementer |
| Blocking vs advisory por criterio concreto | gstack (blocking = falta manejo de error + sin test + fallo silencioso) | **MODIFY** — inspira los cuatro campos de BLOCKED |
| `AskUserQuestion` por cada finding | gstack (one-issue-per-question gating) | **REJECT** — incompatible con la ejecución continua de navori. Solo BLOCKED/fork/alcance mayor |
| Design ≠ implementation plan | superpowers `brainstorming` vs `writing-plans` | **ADD** — es la frontera que faltaba |
| Tareas de 2–5 min con código exacto | superpowers `writing-plans` | **REJECT** — mata el juicio del implementer; CLAUDE.md ya exige preservar margen |
| Prohibición de placeholders en tasks | superpowers `writing-plans` | **ADD** — "TBD", "add appropriate error handling", "similar to Task N" |
| RED/GREEN para probar la skill | superpowers `writing-skills` | **ADD** — baseline ANTES de escribir la skill |
| READY/CONCERNS/BLOCKED | BMAD + su issue #2079 | **MODIFY** — se adopta el vocabulario y se corrige el defecto (CONCERNS no bloquea, 1 ronda) |
| Arquitectura antes de descomponer | BMAD `3-solutioning` | **ADD** — solo en R2-arch/R3 |
| Cross-artifact consistency | spec-kit `/analyze` (read-only, no bloquea) | **MODIFY** — checklist del challenge en R3, no comando nuevo |
| Taxonomía de ambigüedad | spec-kit `/clarify` | **ADD** — 3 vías: repo / humana / asunción registrada |
| Mismos artefactos, menos gates | Kiro Quick Spec | **ADD** — es el principio de R2-architectural vs R3 |
| Progressive disclosure con `references/` | agentskills.io | **DEFER** — el render de core skills no lo soporta hoy; v1 es una página |
| `solution-architect` como agente | prompt de origen | **REJECT** — redundante con orquestador + skill |

## Cambios en `spec-bootstrap` (R3/SDD)

`design.md` de las specs adopta las mismas dimensiones condicionales del artefacto
(contratos, failure modes, migración, testing-por-riesgo, non-goals) marcadas
"solo si aplica"; `tasks.md` adopta la prohibición de placeholders (R19). La skill
referencia `solution-design` para el caso R2-architectural que no amerita spec
completa — el artefacto de solutioning es la versión ligera del mismo razonamiento,
no un segundo sistema SDD.

## Riesgos asumidos

1. **Ceremonia por sobre-activación.** Nueve señales es una lista larga; si el
   modelo las lee laxamente, R2 normal empieza a producir artefactos. Mitigación:
   la señal negativa explícita y el Escenario D de los evals (trivial → cero
   artefacto) es criterio de FAIL.
2. **El challenge se vuelve trámite.** Un researcher que solo confirma no aporta.
   Mitigación: el encargo es falsificar, y sus salidas se clasifican
   BLOCKER/CONCERN/NOTE — un reporte sin ninguno de los tres es señal de trámite.
3. **Costo always-on.** ≤120 palabras × cada sesión × 19 repos. Es el precio de que
   el routing funcione sin abrir la skill; se acota con presupuesto duro y se mide
   en el PR.
4. **Portabilidad multi-engine.** El core conceptual (skill + artefacto + veredicto)
   es portable; "researcher fresco" depende de que el engine tenga subagentes. En
   Codex, que encarna los roles inline, el challenge degrada a una pasada explícita
   con contexto recortado — se documenta, no se resuelve en esta spec.
