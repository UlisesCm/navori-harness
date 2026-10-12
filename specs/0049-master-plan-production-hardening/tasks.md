# Endurecimiento de producción del plan maestro — Tasks

**Estado:** scaffold de spec únicamente; nada está implementado y ninguna tarea está marcada. Dos entregas (E1, E2) son la organización aceptada, no una promesa de clasificación automática del CLI; el LOC es una estimación, no una medición. Tres PRs en total: este scaffold, E1 y E2.

Reglas de ejecución:
- Un workplan por entrega (`0049-master-plan-production-hardening-e1`, `-e2`); `tasks.md` es el tracking canónico.
- Commits atómicos, uno por milestone. Cada prueba nueva lleva `// Covers: R<n>`.
- Cada entrega cierra con el gate completo `bun run check` y un recibo, y la revisa un reviewer fresco. M4 y M7 exigen el gate completo además de sus probes nombrados.
- Los espejos generados se renderizan con el CLI, nunca a mano; cualquier fuente fuera del alcance medido requiere aprobación antes de despachar.
- Sin librerías nuevas. Exclusiones: diagnóstico del runner de Pi (prerrequisito bloqueado, propiedad de la spec 0048), esquema, flags nuevos.
- Los archivos de prueba citados ya existen en la base; los casos nombrados son planeados.

## E1 — Init, estado derivado, contexto y modo
Estimated LOC: 600

### M1 — Recuperación de init
- **A1** [observable] — un init repetido sobre `masterPlan:true` legacy persistido o tras corte previo al render recrea los artefactos de los engines configurados (`CLAUDE.md` solo con Claude; caso AGENTS.md-only sin exigirlo) y conserva etapa, historial y prosa ·
  `cd packages/cli && bun run test src/lib/master/__tests__/init.test.ts src/commands/__tests__/master-first-use.test.ts` → exit 0, 0 failed
- [ ] **T1** (R1, R2) — `runMasterInit` re-ejecuta el render idempotente en cada init validado; sin flags, `force` ni `prune`; también con `harness.masterPlan:true` legacy ya persistido y tras corte abrupto previo al render; los reintentos de entregas existentes en `init.test.ts` son controles de compatibilidad; lectura cerrada: `packages/cli/src/lib/master/init.ts`, `packages/cli/src/lib/master/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/master-first-use.test.ts` · effect: behavior · test: `packages/cli/src/lib/master/__tests__/init.test.ts`::"masterPlan:true legacy persistido o corte previo al render se repara en el reintento (AGENTS.md-only sin CLAUDE.md; con Claude, CLAUDE.md); init sano repetido conserva etapa, historial y prosa"

### M2 — Estado derivado tras advance
- **A2** — `advance` regenera `STATUS` y un fallo parcial informa fase durable y reparación ·
  `cd packages/cli && bun run test src/lib/master/__tests__/checks.test.ts src/lib/master/__tests__/status.test.ts` → exit 0, 0 failed
- [ ] **T2** (R3, R4) — `runMasterAdvance` llama al dueño de estado tras la fase durable y, ante fallo de escritura derivada, reporta la fase y la reparación con `navori master status` sin avanzar dos veces; lectura: `packages/cli/src/lib/master/checks.ts`, `packages/cli/src/lib/master/status.ts` · effect: behavior · test: `packages/cli/src/lib/master/__tests__/checks.test.ts`::"advance regenera STATUS; fallo derivado parcial informa fase durable y reparación sin doble avance"

### M3 — Cableado de architectContext en el skill
- **A3** — el skill canónico consume `architectContext` y el espejo renderizado coincide ·
  `cd packages/cli && bun run test src/lib/master/__tests__/workflow-compatibility.test.ts src/lib/master/__tests__/status.test.ts src/engines/claude/__tests__/master-plan-render.test.ts` → exit 0, 0 failed
- [ ] **T3** (R5) — texto de `packages/core/core-assets/skills/master-plan.md` consume `architectContext` sin cambiar su contrato JSON; espejos vía `navori render --apply`, nunca a mano · effect: docs · test: `packages/cli/src/lib/master/__tests__/workflow-compatibility.test.ts`::"el skill canónico consume architectContext"

### M4 — Modo automático en etapas posteriores
- **A4** — el skill conserva `en-curso` automático en etapas ≥ 2 y prohíbe invocar `navori master mode`; el rechazo existente del CLI sigue intacto; gate completo en verde ·
  `cd packages/cli && bun run test src/lib/master/__tests__/workflow-compatibility.test.ts src/lib/master/__tests__/status.test.ts src/engines/claude/__tests__/master-plan-render.test.ts` → exit 0, 0 failed; luego `bun run check` → exit 0
- [ ] **T4** (R6) — M4 es solo de redacción: el texto de `packages/core/core-assets/skills/master-plan.md` (hoy «registra `en-curso` sin preguntar») debe decir que `en-curso` se hereda de `init` en etapas ≥ 2 y no invocar `navori master mode`; sin comportamiento nuevo (ya lo fijan `runMasterInit` en `packages/cli/src/lib/master/init.ts` y `setMasterMode` en `packages/cli/src/commands/master.ts`); comparte archivo y prueba con T3; compatibilidad: rechazo CLI existente de `mode` desde etapa 2 (`packages/cli/src/lib/master/__tests__/init.test.ts`, bloque `navori master mode`) · effect: docs · test: `packages/cli/src/lib/master/__tests__/workflow-compatibility.test.ts`::"el skill indica en-curso heredado en etapas >= 2 y no invoca navori master mode (aserciones de texto); el CLI sigue rechazando mode desde la etapa 2"

## E2 — Validación estricta, evidencia y ruteo
Estimated LOC: 700

### M5 — Requisitos estrictos en formato nuevo
- **A5** [observable] — `spec check` falla sin `requirements.md` o con `R<n>` no declarado, y el legacy pasa ·
  `cd packages/cli && bun run test src/lib/spec src/commands/__tests__/spec.test.ts` → exit 0, 0 failed
- [ ] **T5** (R7, R8, R9, R10) — `checkSpec` falla en formato nuevo por requirements ausente/ilegible o `R<n>` sin declarar; el legacy no cambia; la documentación no promete cobertura semántica; lectura: `packages/cli/src/lib/spec/check.ts`, `packages/cli/src/lib/spec/__tests__/check.test.ts` · effect: behavior · test: `packages/cli/src/lib/spec/__tests__/check.test.ts`::"formato nuevo: requirements ausente o ilegible y R no declarado fallan; legacy compatible"

### M6 — Evidencia huérfana frente a antigua
- **A6** — una parte con evidencia huérfana bloquea `closable` y `close` igual; un ancestro antiguo avisa con antigüedad ·
  `cd packages/cli && bun run test src/lib/master/__tests__/part.test.ts src/lib/master/__tests__/status.test.ts src/lib/master/__tests__/close.test.ts` → exit 0, 0 failed
- [ ] **T6** (R11, R12, R13) — la autoridad de `status.ts` (`evidenceAge`) bloquea huérfanos en partes sin disposición, no bloquea ancestros antiguos (muestra antigüedad y ofrece revalidar) y respeta aprobaciones manuales y exenciones descartadas/diferidas · effect: behavior · test: `packages/cli/src/lib/master/__tests__/status.test.ts`::"huérfana bloquea closable y close; ancestro antiguo avisa; manual y descartada intactas"

### M7 — Ruteo de workflow y smoke integrado
- **A7** [observable] — el skill distingue legacy de entregas y el smoke aislado recorre el ciclo completo; gate completo en verde ·
  `cd packages/cli && bun run test src/lib/master src/lib/spec src/commands/__tests__/master-first-use.test.ts src/commands/__tests__/master-delivery.test.ts src/commands/__tests__/spec.test.ts` → exit 0, 0 failed; luego `bun run check` → exit 0
- [ ] **T7** (R14, R15) — rama compacta legacy/entregas en el skill canónico tras el estado, usando solo comandos `navori master delivery-*` verificados en `commands/master.ts`; smoke de CLI aislado: primera etapa, cierre, segunda etapa, conversión y ciclo de entregas; espejos vía CLI · effect: behavior · test: `packages/cli/src/commands/__tests__/master-delivery.test.ts`::"smoke integrado: primera etapa, cierre, segunda etapa, conversión y entregas"

## Cobertura R↔tarea

| R | Tarea |
|---|---|
| R1, R2 | T1 |
| R3, R4 | T2 |
| R5 | T3 |
| R6 | T4 |
| R7, R8, R9, R10 | T5 |
| R11, R12, R13 | T6 |
| R14, R15 | T7 |
