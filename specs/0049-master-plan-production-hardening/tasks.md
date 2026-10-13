# Endurecimiento de producción del plan maestro — Tasks

**Estado:** M1/T1 completado: revisión combinada de código, pruebas y documentación `APPROVED`, gate full exit `0` y commit `0309c30d58050ba70d15348ba3b72689051af080`. M2 implementado y con revisión sustantiva `APPROVED`; T2 marcado por implementación y revisión, no por cierre del milestone. Commit de M2 pendiente; handoff canónico y recibo full renovados antes de integrar `dev`. La integración quedó comprometida en `6b7ae245`; el recibo de publicación deberá renovarse sobre el resultado integrado antes del envío de E1. M3–M7 pendientes. Sin push ni PR de implementación. Dos entregas (E1, E2) son la organización aceptada, no una promesa de clasificación automática del CLI; el LOC es una estimación, no una medición. Tres PRs previstos en total: scaffold, E1 y E2.

Reglas de ejecución:
- Un workplan por entrega (`0049-master-plan-production-hardening-e1`, `-e2`); `tasks.md` es el tracking canónico.
- Commits atómicos, uno por milestone. Cada prueba nueva lleva `// Covers: R<n>`.
- Cada entrega cierra con el gate completo `bun run check` y un recibo, y la revisa un reviewer fresco. M4 y M7 exigen el gate completo además de sus probes nombrados.
- Los espejos generados se renderizan con el CLI, nunca a mano; cualquier fuente fuera del alcance medido requiere aprobación antes de despachar.
- Sin librerías nuevas. Exclusiones: diagnóstico del runner de Pi (propiedad de la spec 0048), esquema, flags nuevos. El bloqueo histórico del runner no está vigente en M1: las ejecuciones acotadas de agentes concluyeron; no se afirma una corrección global de 0048.
- Los archivos de prueba citados ya existen en la base; los casos de M1 y M2 se añadieron y verificaron, los de M3–M7 siguen planeados.

## E1 — Init, estado derivado, contexto y modo
Estimated LOC: 600

### M1 — Recuperación de init — completado (implementación y revisión)

Evidencia independiente del reviewer en `.navori/state/handoffs/review_0049-master-plan-production-hardening-e1.md`:
- A1: comando exacto indicado abajo, exit `0`; **2 archivos, 52 pruebas aprobadas, 0 fallos**.
- `bun run check:scoped`: exit `0`; checks encadenados aprobados, AST 5 aprobados y 0 fallos.
- `navori gate fast`: exit `0`; AST 5 aprobados y 0 fallos; log `.navori/state/gate/fast-20261012T233351079Z.log`.
- Aprobación limitada al diff de M1, no al envío de E1. Históricamente, la consulta `navori receipt check --feature 0049-master-plan-production-hardening-e1 --include-consumed --json`, previa a editar documentación, devolvió `status:ok`, `fresh:false`, `stale:["gate"]`, `gateKind:scoped`; la revisión combinada y renovación posteriores resolvieron esa limitación para M1.
- Intento de gate full: el host alcanzó su timeout de 120 s, pero el log `.navori/state/gate/full-20261012T233538010Z.log` continuó y reportó 418 archivos aprobados, 8563 pruebas aprobadas y 2 omitidas, además del coverage floor aprobado. Sin evidencia del exit global, no se registra como fallo de pruebas ni como gate full en verde.
- Cierre posterior: reviewer combinado `APPROVED` para código, pruebas y documentación; gate full exit `0`, log `.navori/state/gate/full-20261013T012058930Z.log` (418 archivos, 8563 pruebas aprobadas, 2 omitidas y coverage floor aprobado). Renovación y consulta independiente del recibo: `status:ok`, `fresh:true`, `gateKind:full`, sin uncovered/drift/stale. M1 comprometido en `0309c30d58050ba70d15348ba3b72689051af080`; esta evidencia histórica no certifica el diff posterior de M2 ni el envío de E1.
- **A1** [observable] — un init repetido sobre `masterPlan:true` legacy persistido o tras corte previo al render recrea los artefactos de los engines configurados (`CLAUDE.md` solo con Claude; caso AGENTS.md-only sin exigirlo) y conserva etapa, historial y prosa ·
  `cd packages/cli && bun run test src/lib/master/__tests__/init.test.ts src/commands/__tests__/master-first-use.test.ts` → exit 0, 0 failed
- [x] **T1** (R1, R2) — `runMasterInit` re-ejecuta el render idempotente en cada init validado; sin flags, `force` ni `prune`; también con `harness.masterPlan:true` legacy ya persistido y tras corte abrupto previo al render; los controles de reintento de entregas tras throw o `ok:false` se añadieron en M1 a `init.test.ts` (no existían en la base `7faec48f`) y protegen compatibilidad; lectura cerrada: `packages/cli/src/lib/master/init.ts`, `packages/cli/src/lib/master/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/master-first-use.test.ts` · effect: behavior · test: `packages/cli/src/lib/master/__tests__/init.test.ts`::"masterPlan:true legacy persistido o corte previo al render se repara en el reintento (AGENTS.md-only sin CLAUDE.md; con Claude, CLAUDE.md); init sano repetido conserva etapa, historial y prosa"

### M2 — Estado derivado tras advance — implementación y revisión aprobadas; commit pendiente

Evidencia histórica de implementación de E1/M2 (el handoff del implementer fue sustituido posteriormente por el informe de integración; no equivale a aprobación del reviewer):
- Cambios de M2: `packages/cli/src/lib/master/checks.ts` y `packages/cli/src/lib/master/__tests__/checks.test.ts`; `status.ts` no cambió. M1 permanece en `0309c30d`; integración de `dev` comprometida en `6b7ae245`.
- A2: comando exacto indicado abajo, exit `0`; **2 archivos, 73 pruebas aprobadas, 0 fallos**; ejecución final posterior al formato: inicio 19:48:44, duración 8.75 s.
- `navori gate fast`: exit `0`; formato, duplicación, AST (5 aprobados, 0 fallos), lint y typecheck aprobados; log `.navori/state/gate/fast-20261013T014832116Z.log`. `git diff --check`: exit `0`. Posteriormente se ejecutó el gate full para renovar el recibo.
- Tracking: el primer `navori plan update` de A2 se registró antes del formato. Tras formatear y repetir A2 con exit `0`, la actualización de evidencia fue rechazada: `ERROR: A2 not marked cumplido — no valid evidence`; `WHY: tree changed since the run (uncommitted changes)`. Sin reintentos ni workarounds; queda pendiente resolver el tracking del harness. Es un rechazo de evidencia, no un fallo de las pruebas ejecutables ni evidencia fresca aceptada por el harness.
- Revisión sustantiva independiente `APPROVED` en `.navori/state/handoffs/review_0049-master-plan-production-hardening-e1-m2.md` y `.json`: A2 exacto exit `0`, **2 archivos, 73 pruebas aprobadas, 0 fallos**; `navori gate fast` exit `0`, log `.navori/state/gate/fast-20261013T015447738Z.log`; `bun run check:scoped` y `git diff --check` exit `0`. Aprobación limitada a implementación y tracking de M2, no al envío de E1. En esa ronda no se ejecutó el gate full de M2; se ejecutó posteriormente.
- Históricamente, el recibo scoped quedó `fresh:false`, `stale:["gate"]` y el wrapper rechazó el JSON canónico obsoleto. Posteriormente se renovaron el JSON canónico y el recibo full; esas restricciones quedaron resueltas antes de integrar `dev`. El recibo anterior no certifica el resultado integrado ni autoriza el envío de E1.
- Gate full sobre el árbol integrado y el código de M2: exit `0`, log `.navori/state/gate/full-20261013T024322709Z.log`; 418 archivos, 8569 pruebas aprobadas y 2 omitidas. El conflicto de `progress/current.md` se concilió directamente bajo autorización expresa sin subagentes; se conservó el seguimiento de 0050. Integración en `6b7ae245`, sin cambios en el código revisado de M2.
- T2 se marca por implementación y revisión completadas; commit local de M2 pendiente, seguido del discovery de M3 con salida exacta. M3–M7 siguen pendientes. Sin push ni PR de M2; la revisión final de envío de E1 sigue siendo obligatoria.
- **A2** — `advance` regenera `STATUS` y un fallo parcial informa fase durable y reparación ·
  `cd packages/cli && bun run test src/lib/master/__tests__/checks.test.ts src/lib/master/__tests__/status.test.ts` → exit 0, 0 failed
- [x] **T2** (R3, R4) — `runMasterAdvance` llama al dueño de estado tras la fase durable y, ante fallo de escritura derivada, reporta la fase y la reparación con `navori master status` sin avanzar dos veces; lectura: `packages/cli/src/lib/master/checks.ts`, `packages/cli/src/lib/master/status.ts` · effect: behavior · test: `packages/cli/src/lib/master/__tests__/checks.test.ts`::"advance regenera STATUS; fallo derivado parcial informa fase durable y reparación sin doble avance"

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
