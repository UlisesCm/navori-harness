# Spec 0012 — Capa de Solutioning · Tasks

**Estado:** ✅ **board cerrado 2026-08-18** — los 5 batches ejecutados y mergeados en `main`
(`0c01763`, PR #339). Evidencia por batch: skill `solution-design` + `WORKFLOW_SKILLS`
(batches 1-2), `lib/__tests__/solutioning-wiring.test.ts` (batch 3), `evals.md` con los
cuatro escenarios en PASS (batches 0 y 4), entrada en `progress/history.md` (batch 5).

**Board de la spec.** No duplicar en `TaskCreate` (regla del bloque `sdd`).
Requirements: [`requirements.md`](./requirements.md) · Diseño: [`design.md`](./design.md)
· Mecánica y comandos exactos: [`plan.md`](./plan.md).

Estado: `[ ]` pendiente · `[~]` en curso · `[x]` hecho.

---

## Batch 0 — Baseline RED (antes de escribir la skill)

> Método superpowers `writing-skills`: *"no skill without a failing test first"*.
> El baseline documenta las racionalizaciones concretas que la skill debe contrarrestar.

- [x] **T0.1** Baseline Escenario A — procesar BTBS-162 sin la capa, sobre
  bonum-webapp; registrar el plan que produce.
  → `.claude/progress/eval_baseline_A.md`
  **Cubre:** evidencia para R5, R6, R8.
- [x] **T0.2** Extraer del baseline las racionalizaciones observadas (¿heredó la
  propuesta del ticket? ¿buscó el patrón existente? ¿evaluó alternativas?) y
  anotarlas en `evals.md` como criterio GREEN a superar.
  **Cubre:** R5, R6, R8.

## Batch 1 — Skill `solution-design`

- [x] **T1.1** Crear `packages/core/core-assets/skills/solution-design.md` con el
  cuerpo definido en `design.md` (plantilla del artefacto, encargo del challenge,
  semántica del veredicto, 3 vías de ambigüedad, jerarquía de soluciones, anti-loop).
  **Cubre:** R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R18.
- [x] **T1.2** Registrar `"solution-design"` en `WORKFLOW_SKILLS`
  (`packages/cli/src/engines/shared/harness-assets.ts:44`) y bumpear
  `features.coreSkills` 10 → 11 en `packages/cli/package.json`.
  **Cubre:** R1 (la skill existe y se indexa).
  **Evidencia:** `pnpm vitest run src/__tests__/catalog.test.ts src/lib/__tests__/skill-caps.test.ts src/lib/__tests__/core-lean.test.ts` verde.

## Batch 2 — Routing y flujos

- [x] **T2.1** Insertar el sub-bloque R2-architectural en
  `packages/core/core-assets/managed/orquestacion.md` con el wording de `design.md`.
  **Cubre:** R1, R2, R3, R17, R21.
  **Evidencia:** `wc -w` del delta ≤ 120 palabras.
- [x] **T2.2** Reescribir la fase 4 de
  `packages/core/core-assets/skills/ticket-intake.md`: se activa con
  `proceed-differently` o señal R2; artefacto + challenge; gate = veredicto.
  **Cubre:** R4, R12.
- [x] **T2.3** Fortalecer `packages/core/core-assets/skills/spec-bootstrap.md`:
  dimensiones condicionales en el template de `design.md` + prohibición de
  placeholders en `tasks.md` + referencia a `solution-design`.
  **Cubre:** R9, R19, R20.

## Batch 3 — Tests y verificación

- [x] **T3.1** Test de invariantes de contenido de la skill (tokens cortos, nunca
  párrafos): contiene `READY`, `CONCERNS`, `BLOCKED`, `NOT in scope`,
  `already exists`, y las 9 señales.
  **Cubre:** R2, R7, R12, R14, R15.
  **// Covers: R2, R7, R12, R14, R15**
- [x] **T3.2** Test de presupuesto: el delta del bloque `orquestacion` ≤120 palabras.
  **Cubre:** R21. **// Covers: R21**
- [x] **T3.3** Gate completo: `pnpm format:check` (raíz) + `pnpm test` + `pnpm lint`.
  Actualizar los conteos que rompan (catalog; e2e si aplica).
- [x] **T3.4** Render de prueba en repo temporal: la skill se materializa, el índice
  la lista con su trigger, el bloque trae las señales.
  **Cubre:** R1.
- [x] **T3.5** Dogfood: `render --apply` sobre navori-harness, commit
  `chore(self-host)` separado.

## Batch 4 — Evals GREEN (con la capa)

- [x] **T4.1** Escenario A (GREEN): re-correr BTBS-162 con la capa. PASS si el
  veredicto está argumentado contra la alternativa existente (gane React Query o
  gane extender la capa actual); FAIL si hereda la propuesta sin evaluarla.
  **Cubre:** R5, R6, R8.
- [x] **T4.2** Escenario D: "cambia el texto del botón Save por Guardar" → cero
  artefacto de solutioning. **Cubre:** R3. **FAIL si genera artefacto.**
- [x] **T4.3** Escenario E: diseño válido con un concern menor → veredicto
  `CONCERNS` y la implementación arranca. **Cubre:** R13, R15.
- [x] **T4.4** Escenario F: dos interpretaciones con arquitecturas incompatibles →
  `BLOCKED` con los cuatro campos. **Cubre:** R14, R17.
- [x] **T4.5** Registrar los cuatro resultados en `evals.md` (escenario · esperado ·
  observado · PASS/FAIL · ajuste derivado). **GATE H2:** Ulises revisa.

## Batch 5 — Cierre

- [x] **T5.1** PR → `main` vía `commit-pr-pilot`.
- [x] **T5.2** `mem_save` de las decisiones nuevas, entrada en `progress/history.md`,
  `progress/current.md` a idle.

---

## Cobertura `R<n>` → tarea

| R | Tareas |
|---|---|
| R1 | T1.2, T2.1, T3.4 |
| R2 | T2.1, T3.1 |
| R3 | T2.1, T4.2 |
| R4 | T2.2 |
| R5, R6 | T1.1, T0.2, T4.1 |
| R7 | T1.1, T3.1 |
| R8 | T1.1, T4.1 |
| R9 | T1.1, T2.3 |
| R10 | T1.1 |
| R11, R16 | T1.1 |
| R12 | T1.1, T2.2, T3.1 |
| R13 | T1.1, T4.3 |
| R14 | T1.1, T3.1, T4.4 |
| R15 | T1.1, T3.1, T4.3 |
| R17 | T2.1, T4.4 |
| R18 | T1.1 |
| R19, R20 | T2.3 |
| R21 | T2.1, T3.2 |

Sin requirements huérfanos: los 21 tienen ≥1 tarea.
