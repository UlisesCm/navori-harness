# Codex: resultados equivalentes y perfiles actuales — Tasks

**Estado:** scaffold; todas las tareas y aceptaciones están pendientes. Este documento no representa implementación, suite ejecutada ni evaluación viva. Cada caso futuro debe incluir `// Covers: R<n>`.

**Precondición:** crear y clasificar un workplan independiente por entrega y obtener la aprobación correspondiente. E<n+1> comienza después de que E<n> se integre. Cada milestone ejecuta su criterio y `bun run check:fast` desde la raíz del repo; al cerrar cada entrega se ejecuta `bun run check` desde la raíz. Este scaffold no autoriza iniciar E1. Los paths marcados *futuro* son salidas que deberá crear la tarea indicada.

## E1 — Contrato de resultados y baseline

Estimated LOC: 450

### M1 — Matriz verificable

- **A1** [observable] — Ejecutar `cd packages/cli && bun run test src/engines/shared/__tests__/engine-capabilities.test.ts src/engines/shared/__tests__/codex-parity.test.ts` → exit 0; matriz distingue resultados, versión, superficie y evidencia, reconcilia contradicciones para la misma versión/superficie y conserva diferencias históricas acotadas por versión/contexto.
- **A2** [observable] — Ejecutar `cd packages/cli && bun run test src/engines/shared/__tests__/engine-capabilities.test.ts src/engines/shared/__tests__/codex-parity.test.ts` → exit 0; las cinco garantías tienen owner, mecanismo y estado/evidencia, y la capacidad Codex registra versión y superficie verificadas.

- [ ] **T1** (R1, R2) — Definir contrato común de outcomes y evidencia de capacidades. Casos: `result-contract`, `versioned-evidence-consistency`, `unverified-surface`; suite existente `packages/cli/src/engines/shared/__tests__/engine-capabilities.test.ts`. `effect: behavior`; `test: engine-capabilities.test.ts::versioned-evidence-consistency`.
- [ ] **T2** (R2) — Reconciliar contradicciones de capacidades para la misma versión/superficie y mantener diferencias históricas acotadas por versión/contexto. Casos: `parity-version-and-surface`, `same-version-surface-is-consistent`, `historical-difference-is-version-scoped`, `smoke-scope-is-bounded`; suite existente `packages/cli/src/engines/shared/__tests__/codex-parity.test.ts`. `effect: behavior`; `test: codex-parity.test.ts::same-version-surface-is-consistent`.

## E2 — Evidencia actual y revisión independiente

Estimated LOC: 750

### M2 — Aceptación y review sobre estado actual

- **A3** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/plan/__tests__/evidence.test.ts src/lib/diagnose/__tests__/receipt.test.ts` → exit 0; evidencia faltante, fallida, de otro criterio o de inputs cambiados no pasa y una ejecución pertinente actual sí.
- **A4** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/handoff/__tests__/review-evidence.test.ts src/lib/__tests__/receipt-wiring.test.ts src/lib/plan/__tests__/codex-resume.test.ts` → exit 0; producer-review y review de diff cambiado se rechazan, review independiente actual se admite y resume conserva tarea sin revivir garantías obsoletas. `codex-resume.test.ts` es futuro y lo crea T5.

- [ ] **T3** (R3, R4) — Vincular aceptación con ejecución, criterio, comando e identidad de estado; invalidar ante cambios. Casos: `missing-command-evidence`, `failed-command`, `wrong-criterion`, `changed-inputs`, `current-success`; suites existentes `packages/cli/src/lib/plan/__tests__/evidence.test.ts` y `packages/cli/src/lib/diagnose/__tests__/receipt.test.ts`. `effect: behavior`; `test: evidence.test.ts::changed-inputs`.
- [ ] **T4** (R5) — Exigir revisión distinta al productor y vigente para el diff. Casos: `producer-review-rejected`, `independent-current-review`, `diff-invalidation`; suites existentes `packages/cli/src/lib/handoff/__tests__/review-evidence.test.ts` y `packages/cli/src/lib/__tests__/receipt-wiring.test.ts`. `effect: behavior`; `test: review-evidence.test.ts::independent-current-review`.
- [ ] **T5** (R8) — Reanudar tarea y siguiente paso e invalidar garantías cuyo vínculo no se conserva. Casos: `resume-retains-task`, `resume-invalidates-stale-guarantees`; suite futura `packages/cli/src/lib/plan/__tests__/codex-resume.test.ts`, creada por T5. `effect: behavior`; `test: codex-resume.test.ts::resume-invalidates-stale-guarantees`.

## E3 — Autorización y ruta al principal

Estimated LOC: 600

### M3 — Control de la acción

- **A5** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/__tests__/pr-publisher-confirm.test.ts` → exit 0; falta de autorización, rechazo, replay, diff/destino cambiado y registro del principal sin fuente humana/host aplicable dejan publicación detenida.
- **A6** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/__tests__/codex-approval-route.test.ts` → exit 0; solicitud del subagente vuelve pending, el principal solo tramita autorización humana/host aplicable y no hay bypass ni cambio global/trust. `codex-approval-route.test.ts` es futuro y lo crea T7.

- [ ] **T6** (R6) — Vincular autorización a acción, destino y diff/estado, con consumo no reutilizable. Casos: `action-destination-diff-binding`, `approval-replay`, `explicit-refusal`, `principal-record-without-human-source`; suite existente `packages/cli/src/lib/__tests__/pr-publisher-confirm.test.ts`. `effect: behavior`; `test: pr-publisher-confirm.test.ts::action-destination-diff-binding`.
- [ ] **T7** (R7, R16) — Implementar ruta pending desde subagente al principal y preservar ámbito global/trust. Casos: `subagent-returns-pending`, `principal-mediates-applicable-consent`, `no-bypass`, `no-global-trust-write`; suite futura `packages/cli/src/lib/__tests__/codex-approval-route.test.ts`, creada por T7. `effect: behavior`; `test: codex-approval-route.test.ts::subagent-returns-pending`.

## E4 — Perfiles y evaluación comparativa

Estimated LOC: 1000

### M4 — Resolución y render preservan intención

- **A7** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/assets/__tests__/model-profile.test.ts src/lib/codex/__tests__/model-catalog.test.ts` → exit 0; Opus medium resuelve Sol medium, Sonnet medium Luna high, otros efforts se conservan, pins/override prevalecen y 6.10 supera 6.9.
- **A8** [observable] — Ejecutar `cd packages/cli && bun run test src/commands/__tests__/model-profile-doctor.test.ts src/engines/codex/__tests__/profile-render.test.ts src/lib/codex/__tests__/profile-selection.test.ts` → exit 0; cada rol habilitado tiene provenance, herencia explícita se distingue, configured no equivale a observed y preservación se mantiene. `profile-render.test.ts` y `profile-selection.test.ts` son futuros; los crea T9 y T10.

- [ ] **T8** (R9, R10, R11) — Resolver modelo y effort respetando precedencia y comparación numérica. Casos: `opus-medium-sol-medium`, `sonnet-medium-luna-high`, `other-efforts-preserved`, `model-pin`, `explicit-effort-override`, `6.10-over-6.9`, `listed-future-major`; suites existentes `packages/cli/src/lib/assets/__tests__/model-profile.test.ts` y `packages/cli/src/lib/codex/__tests__/model-catalog.test.ts`. `effect: behavior`; `test: model-profile.test.ts::sonnet-medium-luna-high`.
- [ ] **T9** (R12, R14, R16) — Cubrir todos los roles habilitados y diferenciar intención, render y runtime, preservando ámbito. Casos: `every-enabled-main-core-extra-local`, `explicit-inheritance`, `configured-not-observed`, `user-global-trust-preservation`; suite existente `packages/cli/src/commands/__tests__/model-profile-doctor.test.ts` y futura `packages/cli/src/engines/codex/__tests__/profile-render.test.ts`, creada por T9. `effect: behavior`; `test: profile-render.test.ts::every-enabled-main-core-extra-local`.
- [ ] **T10** (R15, R18) — Representar frescura desconocida/obsoleta y rechazo del host sin sustitución silenciosa. Casos: `valid-but-obsolete-catalog`, `freshness-unknown`, `malformed-catalog`, `offline-catalog`, `unsupported-effort`, `runtime-rejection`; suite existente `packages/cli/src/lib/codex/__tests__/model-catalog.test.ts` y futura `packages/cli/src/lib/codex/__tests__/profile-selection.test.ts`, creada por T10. `effect: behavior`; `test: profile-selection.test.ts::freshness-unknown`.

### M5 — Aplicación por frontera y evaluación final

- **A9** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/plan/__tests__/plan-gate.test.ts src/lib/codex/__tests__/profile-dispatch.test.ts` → exit 0; coteja cada perfil requerido del inventario (principal y cada core, extra y local), modelo/esfuerzo efectivos o pending; ninguno unknown/pending pasa, la actualización aplica a trabajo nuevo y una preparación no admite dos consumidores ni cruce de rol/acción. `profile-dispatch.test.ts` es futuro y lo crea T11.
- **A10** [observable] — La validación determinista `cd packages/cli && bun run test src/lib/codex/__tests__/outcome-evaluation.test.ts` → exit 0 comprueba el formato/criterios, pero no cierra A10. La aceptación requiere además protocolo vivo futuro por engine y escenario, con versión del host, modelo/effort efectivo o unknown, outcomes y evidencia para: (1) bugfix con regresión, (2) feature de dos módulos seguida por review, (3) resume tras cambio de evidencia/diff, (4) aprobación solicitada desde subagente. Mock/validator no prueba comportamiento vivo. Registrar fallas/reintentos y duración/consumo cuando disponibles; evidencia requerida ausente falla. `outcome-evaluation.test.ts` es futuro y lo crea T12.

- [ ] **T11** (R12, R13, R14, R16) — Refrescar perfil antes de cada nuevo dispatch y probar claim exclusivo por identidad de preparación. Casos: `catalog-refresh-next-session-and-dispatch`, `every-enabled-role-effort`, `no-inflight-change`, `host-cannot-apply-pending`, `same-record-two-consumers`, `cross-role-action-rejected`; suite existente `packages/cli/src/lib/plan/__tests__/plan-gate.test.ts` y futura `packages/cli/src/lib/codex/__tests__/profile-dispatch.test.ts`, creada por T11. `effect: behavior`; `test: profile-dispatch.test.ts::same-record-two-consumers`.
- [ ] **T12** (R17) — Crear evaluación acotada y registrar outcomes comparables sin causalidad atribuida al modelo; revalidar R1–R18 mediante A10. Casos vivos: `bug-regression`, `two-module-feature-and-review`, `resume-after-state-change`, `subagent-approval-route`; suite futura `packages/cli/src/lib/codex/__tests__/outcome-evaluation.test.ts`, creada por T12, y protocolo manual descrito en A10. `effect: behavior`; `test: outcome-evaluation.test.ts::required-evidence-per-engine`.
