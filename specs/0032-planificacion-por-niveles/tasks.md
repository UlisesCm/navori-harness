# Planificación por niveles — Tasks

Lotes en orden: el validador primero (no depende de ningún contrato), después el flag y los
contratos que lo usan, al final el encendido en este repo.

## Lote 1 — Validador

- [ ] **T1** (R12, R13, R14) — Parser y reglas del `workplan` en `packages/cli/src/lib/plan/`:
  lee el encabezado de nivel y las secciones de `design.md` "Contracts", y devuelve la lista de
  fallas de R13 (sección faltante por nivel, `A<n>` sin comando o sin salida esperada, ids
  repetidos o no consecutivos, archivo inexistente sin `(nuevo)`, `[NEEDS CLARIFICATION]` abierto,
  `solution_<scope>.md` inexistente en nivel 2). Lista vacía para un plan válido · test:
  `packages/cli/src/lib/plan/__tests__/check.test.ts` con un fixture válido por nivel y uno
  inválido por regla, con `// Covers: R12, R13, R14`.
- [ ] **T2** (R12, R13, R14) — Comando `navori plan check <archivo>` en
  `packages/cli/src/commands/plan.ts`, registrado en `subCommands` de `packages/cli/src/index.ts`:
  imprime cada falla y sale con código 1, o sale con 0 si no hay fallas · test:
  `packages/cli/src/commands/__tests__/plan.test.ts` (código de salida y mensajes sobre fixtures
  en disco) con `// Covers: R12, R13, R14`.

## Lote 2 — Flag y bloque de orquestación

- [ ] **T3** (R23) — Flag `harness.planTiers` (default `false`) en
  `packages/cli/src/lib/config/schema.ts`, con el render de `managed/orquestacion.md` condicionado
  a él · test: `packages/cli/src/lib/config/__tests__/schema.test.ts` (default y parseo) y snapshot
  golden del bloque con el flag en `false` idéntico al actual, con `// Covers: R23`.
- [ ] **T4** (R1, R2, R3, R4, R5, R6, R15) — Sección de niveles en
  `packages/core/core-assets/managed/orquestacion.md`, visible solo con el flag en `true`: la
  tabla de cuatro niveles con su señal, la línea de nivel al usuario, subir sí y bajar no en área
  crítica, nivel 0 sin artefacto, nivel 3 sin `workplan`, y `navori plan check` en verde antes de
  pedir aprobación. Debe caber en `check:doc-budgets` · test:
  `packages/cli/src/__tests__/plan-tiers-contracts.test.ts` (render con flag `true` contiene cada
  regla) con `// Covers: R1, R2, R3, R4, R5, R6, R15`.

## Lote 3 — Contratos de agentes

- [ ] **T5** (R7, R8, R9, R10, R11, R16, R19, R20, R21) — `orchestrator.md` y `resolve-ticket.md`:
  plantilla del `workplan` por nivel, actualización de Progreso y Decisiones por sub-tarea,
  `progress/current.md` apuntando al `workplan`, consulta al usuario ante un desvío de alcance,
  encargo al `implementer` con path y `A<n>`, orden `architect` → challenge → veredicto →
  `workplan` con el flag de `architect` encendido y `solution-design` inline con el flag apagado;
  `workplan_<feature>.md` en la lista de handoffs de `.claude/progress/`. `architect.md` aclara
  que su salida alimenta el nivel 2 y que no escribe el plan · test:
  `packages/cli/src/__tests__/plan-tiers-contracts.test.ts` con `// Covers: R7, R8, R9, R10, R11,
  R16, R19, R20, R21`.
- [ ] **T6** (R17, R18) — `implementer.md` reporta la clave `acceptance` (comando, código de
  salida, extracto por `A<n>`) cuando el encargo trae criterios; `reviewer.md` emite
  `CHANGES_REQUESTED` ante un `A<n>` sin evidencia o un archivo fuera de alcance sin entrada en
  Decisiones · test: `packages/cli/src/lib/__tests__/agents-assets.test.ts` (contrato de handoff
  de ambos) con `// Covers: R17, R18`.

## Lote 4 — Encendido en este repo

- [ ] **T7** (R22, R24) — `navori.config.json` con `harness.planTiers: true` y
  `harness.architect: true`; re-render del harness (`navori render --apply`) y goldens
  actualizados. La declaración de admisión del `architect` ya está en `design.md`, "Admisión del
  architect" · test: `bun run check:render` en verde y
  `packages/cli/src/__tests__/plan-tiers-contracts.test.ts` verifica que el config de este repo
  enciende ambos flags, con `// Covers: R22, R24`.
