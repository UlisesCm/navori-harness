# Planificación por niveles — Tasks

Lotes en orden: calibrar pesos con datos reales, luego el núcleo sin flag, después el flag con el
gate y el bloque de orquestación (incluido el retiro de `harness.architect`), el contenido de
agentes y skills, y al final encender y medir en este repo.

## Lote 0 — Calibración

- [ ] **T0** (R2, R3, R4, R5) — Calibrar pesos con el usuario sobre 10 tareas reales (5 de Bonum,
  5 de navori) antes de fijar `signals.ts` · test: fixtures de esas 10 tareas con su nivel
  esperado en `lib/plan/__tests__/classify.test.ts`, con `// Covers: R2, R3, R4, R5`.

## Lote 1 — Núcleo (sin flag)

- [ ] **T1** (R10, R13, R14) — Esquema zod del workplan en `lib/plan/schema.ts` · test:
  `schema.test.ts`, con `// Covers: R10, R13, R14`.
- [ ] **T2** (R1, R2, R3, R4, R5, R9) — `signals.ts` + `classify.ts` reusando `source-classify`;
  campo `project.criticalPaths` · test: `classify.test.ts`, con `// Covers: R1, R2, R3, R4, R5,
  R9`.
- [ ] **T3** (R11, R12) — `render.ts` determinista y `update` · test: `render.test.ts` (snapshot,
  mismos bytes dos veces), con `// Covers: R11, R12`.
- [ ] **T4** (R15) — `check` (reglas del R13 original + esquema + nivel declarado menor que el
  calculado) · test: `check.test.ts`, un fixture inválido por regla, con `// Covers: R15`.
- [ ] **T5** (R1, R11, R12, R15) — `commands/plan.ts` con `classify|render|update|check` en
  `subCommands` · test: `commands/__tests__/plan.test.ts`, con `// Covers: R1, R11, R12, R15`.

## Lote 2 — Flag, gate y bloque

- [ ] **T6** (R30) — `harness.planTiers` en `schema.ts` y golden del bloque en `false` idéntico ·
  test: snapshot golden, con `// Covers: R30`.
- [ ] **T6b** (R33, R34, R35) — Retiro de la clave `harness.architect`: sale del esquema
  (`lib/config/schema.ts`), entra en la lista de claves retiradas con su mensaje de migración
  (`lib/config/config.ts`), se eliminan las ramas `navori:if architect` / `navori:if-not
  architect` de los assets de core, y el default de core queda en modelo `opus` y `effort:
  xhigh` (`lib/config/recommended.ts`) · test: el config con `harness.architect` produce el aviso
  de clave retirada; el render de core no contiene `navori:if architect`; golden de Claude y
  Codex con `architect` presente, con `// Covers: R33, R34, R35`.
- [ ] **T7** (R16, R17, R19) — Hook `PreToolUse` sobre `Agent` (Claude) con conteo de rechazos;
  aviso de `doctor` cuando el engine no lo soporta · test: `plan-gate.test.ts` (niega sin
  workplan, deja pasar con plan válido o exención, exige nivel siguiente tras dos rechazos), con
  `// Covers: R16, R17, R19`.
- [ ] **T8** (R6, R7, R8, R18, R22) — Tabla de niveles y regla del gate en `orquestacion.md`
  dentro del presupuesto · test: `plan-tiers-contracts.test.ts`, con `// Covers: R6, R7, R8, R18,
  R22`.

## Lote 3 — Contenido y agentes

- [ ] **T9** (R22, R10, R12, R13, R14, R36, R37) — Skills `plan-simple` y `plan-advanced` · test:
  tests de assets de skills, con `// Covers: R22, R10, R12, R13, R14, R36, R37`.
- [ ] **T10** (R20, R21) — Implementer (`acceptance`) y reviewer (evidencia, alcance, `classify`
  sobre el diff) · test: `agents-assets.test.ts`, con `// Covers: R20, R21`.
- [ ] **T11** (R23, R24, R25, R26, R27, R28, R36, R37) — Architect, `solution-design`,
  `spec-bootstrap`, `orchestrator.md`, `resolve-ticket.md` · test:
  `plan-tiers-contracts.test.ts`, con `// Covers: R23, R24, R25, R26, R27, R28, R36, R37`.

## Lote 4 — Encendido y medición

- [ ] **T12** (R29, R31) — `navori.config.json` con `planTiers` (el default de core ya cubre el
  architect, sin `harness.architect` ni `effort.architect` en este repo); re-render; goldens ·
  test: `check:render` y el config verificado en `plan-tiers-contracts.test.ts`, con `// Covers:
  R29, R31`.
- [ ] **T13** (R32) — El minero reporta niveles, clasificaciones erróneas y escalamientos por
  repo, llamando a `classify` · test: test del minero con un fixture por métrica, con `// Covers:
  R32`.
