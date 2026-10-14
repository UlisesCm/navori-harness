# Codex: resultados equivalentes y perfiles actuales — Tasks

**Estado:** E1/M1 y E2/M2 implementados; E2 aprobado con gate completo verificado. E3 pendiente. E4/M4 T8–T10 implementado con A7/A8 y `check:fast` verificados; revisión independiente y gate completo de envío pendientes. M5 T11/A9 y T12/A10 siguen pendientes. La evaluación comparativa viva y el cierre de E4/spec siguen pendientes. Cada caso debe incluir `// Covers: R<n>`.

**Precondición:** crear y clasificar un workplan independiente por entrega y obtener la aprobación correspondiente. E<n+1> comienza después de que E<n> se integre. Cada milestone ejecuta su criterio y `bun run check:fast` desde la raíz del repo; al cerrar cada entrega se ejecuta `bun run check` desde la raíz. Para E3–E4, esta precondición sigue vigente. Los paths marcados *futuro* son salidas que deberá crear la tarea indicada.

## E1 — Contrato de resultados y baseline — implementado

Estimated LOC: 450

### M1 — Matriz verificable

- **A1** [observable] — Ejecutar `cd packages/cli && bun run test src/engines/shared/__tests__/engine-capabilities.test.ts src/engines/shared/__tests__/codex-parity.test.ts` → exit 0; matriz distingue resultados, versión, superficie y evidencia, reconcilia contradicciones para la misma versión/superficie y conserva diferencias históricas acotadas por versión/contexto.
- **A2** [observable] — Ejecutar `cd packages/cli && bun run test src/engines/shared/__tests__/engine-capabilities.test.ts src/engines/shared/__tests__/codex-parity.test.ts` → exit 0; las cinco garantías tienen owner, mecanismo y estado/evidencia, y la capacidad Codex registra versión y superficie verificadas.

Verificación ejecutada: A1 y A2 pasaron con 52 pruebas cada una. `bun run check:fast` terminó con exit 0 (formatter, duplicación, AST checks, lint y typecheck). La identidad de grabación observada por el host Bash no fue confirmada; el progreso del workplan sigue pendiente.

- [x] **T1** (R1, R2) — Definir contrato común de outcomes y evidencia de capacidades. Casos: `result-contract`, `versioned-evidence-consistency`, `unverified-surface`; suite existente `packages/cli/src/engines/shared/__tests__/engine-capabilities.test.ts`. `effect: behavior`; `test: engine-capabilities.test.ts::versioned-evidence-consistency`.
- [x] **T2** (R2) — Reconciliar contradicciones de capacidades para la misma versión/superficie y mantener diferencias históricas acotadas por versión/contexto. Casos: `parity-version-and-surface`, `same-version-surface-is-consistent`, `historical-difference-is-version-scoped`, `smoke-scope-is-bounded`; suite existente `packages/cli/src/engines/shared/__tests__/codex-parity.test.ts`. `effect: behavior`; `test: codex-parity.test.ts::same-version-surface-is-consistent`.

## E2 — Evidencia actual y revisión independiente — implementado, aprobado; gate completo verificado

Estimated LOC: 750

### M2 — Aceptación y review sobre estado actual

- **A3** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/plan/__tests__/evidence.test.ts src/lib/diagnose/__tests__/receipt.test.ts` → exit 0; evidencia faltante, fallida, de otro criterio o de inputs cambiados no pasa y una ejecución pertinente actual sí.
- **A4** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/handoff/__tests__/review-evidence.test.ts src/lib/__tests__/receipt-wiring.test.ts src/lib/plan/__tests__/codex-resume.test.ts` → exit 0; producer-review y review de diff cambiado se rechazan, review independiente actual se admite y resume conserva tarea sin revivir garantías obsoletas. `codex-resume.test.ts` es futuro y lo crea T5.

**Registro de aceptación E2:** A3 pasó 83/83 y A4 pasó 34/34. La regresión de deadline pasó 5/5; las fixtures legacy pasaron 76/76; las suites de prosa, 232/232; y los golden tests, 5/5. Revisión independiente: `APPROVED`. Gate completo: 420 archivos; 8610 pruebas aprobadas, 2 omitidas y 0 fallidas; coverage floor verde. Las atestaciones nativas del producer y del scribe, y el ciclo independiente `begin`/`seal`, fueron aceptados por la CLI fuente dentro del host acotado de esta sesión. Los comandos A3/A4 se ejecutaron y sus resultados se verificaron; los hooks legacy cargados no aportaron señal automática de workplan, por lo que no se afirma registro automático de aceptación. Esto no acredita equivalencia general entre modelos; la evaluación comparativa viva de E4 sigue pendiente.

- [x] **T3** (R3, R4) — Vincular aceptación con ejecución, criterio, comando e identidad de estado; invalidar ante cambios. Casos: `missing-command-evidence`, `failed-command`, `wrong-criterion`, `changed-inputs`, `current-success`; suites existentes `packages/cli/src/lib/plan/__tests__/evidence.test.ts` y `packages/cli/src/lib/diagnose/__tests__/receipt.test.ts`. `effect: behavior`; `test: evidence.test.ts::changed-inputs`.
- [x] **T4** (R5) — Exigir revisión distinta al productor y vigente para el diff. Casos: `producer-review-rejected`, `independent-current-review`, `diff-invalidation`; suites existentes `packages/cli/src/lib/handoff/__tests__/review-evidence.test.ts` y `packages/cli/src/lib/__tests__/receipt-wiring.test.ts`. `effect: behavior`; `test: review-evidence.test.ts::independent-current-review`.
- [x] **T5** (R8) — Reanudar tarea y siguiente paso e invalidar garantías cuyo vínculo no se conserva. Casos: `resume-retains-task`, `resume-invalidates-stale-guarantees`; suite futura `packages/cli/src/lib/plan/__tests__/codex-resume.test.ts`, creada por T5. `effect: behavior`; `test: codex-resume.test.ts::resume-invalidates-stale-guarantees`.

## E3 — Autorización y ruta al principal

Estimated LOC: 600

### M3 — Control de la acción

- **A5** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/__tests__/pr-publisher-confirm.test.ts` → exit 0; falta de autorización, rechazo, replay, diff/destino cambiado y registro del principal sin fuente humana/host aplicable dejan publicación detenida.
- **A6** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/__tests__/codex-approval-route.test.ts` → exit 0; solicitud del subagente vuelve pending, el principal solo tramita autorización humana/host aplicable y no hay bypass ni cambio global/trust. `codex-approval-route.test.ts` es futuro y lo crea T7.

**Registro parcial E3:** A5 pasó 22/22 y A6 pasó 34/34; `check:fast` pasó y la compatibilidad Pi/hook/golden pasó 60/60. La revisión Pass 1 registró `PASS1_OK`, sin hallazgos; falta revisión final y gate completo del árbol de envío. T7 entrega la ruta pending al principal; T6 y el cierre completo de E3 siguen pendientes. Las pruebas de hook y CLI verifican solicitud acotada, relay al principal, claim de mediación exclusiva, resumen pending de solo lectura para consumidores duplicados, rechazo ante cambio de checkout/HEAD/base/contenido, validación de campos y limpieza bajo deadline. No acreditan consentimiento humano positivo ni consumo de grant de un solo uso. La identidad/provenance del caller no autentica al principal; la base remota permanece sin verificar. La evidencia del host se limita a la superficie de hooks de comandos CLI 0.162.1 investigada; app-server/UI y otros engines no fueron verificados. La aceptación automática final quedó pendiente por cambio del árbol desde la ejecución y será revalidada sobre el fingerprint de revisión. E4 permanece pendiente.

- [ ] **T6** (R6) — Vincular autorización a acción, destino y diff/estado, con consumo no reutilizable. Casos: `action-destination-diff-binding`, `approval-replay`, `explicit-refusal`, `principal-record-without-human-source`; suite existente `packages/cli/src/lib/__tests__/pr-publisher-confirm.test.ts`. `effect: behavior`; `test: pr-publisher-confirm.test.ts::action-destination-diff-binding`.
- [x] **T7** (R7, R16; ruta pending entregada, Pass 1 `PASS1_OK`) — Implementar ruta pending desde subagente al principal y preservar ámbito global/trust. Casos: `subagent-returns-pending`, `principal-mediates-applicable-consent`, `no-bypass`, `no-global-trust-write`; suite `packages/cli/src/lib/__tests__/codex-approval-route.test.ts`. La mediación entregada no acredita consentimiento humano/host aplicable ni completa T6. `effect: behavior`; `test: codex-approval-route.test.ts::subagent-returns-pending`.

## E4 — Perfiles y evaluación comparativa

Estimated LOC: 1000

### M4 — Resolución y render preservan intención

**Registro M4:** T8–T10 implementados. A7 pasó 33 pruebas en 2 archivos; A8 pasó 18
pruebas en 3 archivos; `bun run check:fast` terminó con exit 0 y el bundle midió
1473.4 KB frente al límite de 1500 KB. El alcance verificado es resolución/proyección,
render y diagnóstico deterministas. No verifica selección ni aplicación runtime en Codex.
Revisión independiente y gate completo de envío pendientes.

- **A7** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/assets/__tests__/model-profile.test.ts src/lib/codex/__tests__/model-catalog.test.ts` → exit 0; Opus medium resuelve Sol medium, Sonnet medium Luna high, otros efforts se conservan, pins/override prevalecen y 6.10 supera 6.9.
- **A8** [observable] — Ejecutar `cd packages/cli && bun run test src/commands/__tests__/model-profile-doctor.test.ts src/engines/codex/__tests__/profile-render.test.ts src/lib/codex/__tests__/profile-selection.test.ts` → exit 0; cada rol habilitado tiene provenance, herencia explícita se distingue, configured no equivale a observed y preservación se mantiene.

- [x] **T8** (R9, R10, R11) — Resolver modelo y effort respetando precedencia y comparación numérica. Casos: `opus-medium-sol-medium`, `sonnet-medium-luna-high`, `other-efforts-preserved`, `model-pin`, `explicit-effort-override`, `6.10-over-6.9`, `listed-future-major`; suites `packages/cli/src/lib/assets/__tests__/model-profile.test.ts` y `packages/cli/src/lib/codex/__tests__/model-catalog.test.ts`. A7 pasó 33 pruebas en 2 archivos. `effect: behavior`; `test: model-profile.test.ts::sonnet-medium-luna-high`.
- [x] **T9** (R12, R14, R16) — Cubrir los roles habilitados y diferenciar intención, render y runtime, preservando ámbito. Casos: `every-enabled-main-core-extra-local`, `explicit-inheritance`, `configured-not-observed`, `user-global-trust-preservation`; suites `packages/cli/src/commands/__tests__/model-profile-doctor.test.ts` y `packages/cli/src/engines/codex/__tests__/profile-render.test.ts`. A8 cubre las suites de T9/T10: 18 pruebas en 3 archivos. `effect: behavior`; `test: profile-render.test.ts::every-enabled-main-core-extra-local`.
- [x] **T10** (R15, R18) — Representar frescura desconocida/obsoleta y rechazo del host sin sustitución silenciosa. Casos: `valid-but-obsolete-catalog`, `freshness-unknown`, `malformed-catalog`, `offline-catalog`, `unsupported-effort`, `runtime-rejection`; suites `packages/cli/src/lib/codex/__tests__/model-catalog.test.ts` y `packages/cli/src/lib/codex/__tests__/profile-selection.test.ts`. A8 cubre la suite futura de selección; 18 pruebas en 3 archivos en total. `effect: behavior`; `test: profile-selection.test.ts::freshness-unknown`.

El alcance de M4 es la metadata y configuración renderizada para futuros contextos. Startup,
dispatch, selección/aplicación runtime y perfiles efectivos del host no se observaron;
ningún test unitario/mocked cierra A9 o A10. T6/E3 permanece pendiente.

### M5 — Aplicación por frontera y evaluación final

- **A9** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/plan/__tests__/plan-gate.test.ts src/lib/codex/__tests__/profile-dispatch.test.ts` → exit 0; coteja cada perfil requerido del inventario (principal y cada core, extra y local), modelo/esfuerzo efectivos o pending; ninguno unknown/pending pasa, la actualización aplica a trabajo nuevo y una preparación no admite dos consumidores ni cruce de rol/acción. `profile-dispatch.test.ts` es futuro y lo crea T11.
- **A10** [observable] — La validación determinista `cd packages/cli && bun run test src/lib/codex/__tests__/outcome-evaluation.test.ts` → exit 0 comprueba el formato/criterios, pero no cierra A10. La aceptación requiere además protocolo vivo futuro por engine y escenario, con versión del host, modelo/effort efectivo o unknown, outcomes y evidencia para: (1) bugfix con regresión, (2) feature de dos módulos seguida por review, (3) resume tras cambio de evidencia/diff, (4) aprobación solicitada desde subagente. Mock/validator no prueba comportamiento vivo. Registrar fallas/reintentos y duración/consumo cuando disponibles; evidencia requerida ausente falla. `outcome-evaluation.test.ts` es futuro y lo crea T12.

- [ ] **T11** (R12, R13, R14, R16) — Refrescar perfil antes de cada nuevo dispatch y probar claim exclusivo por identidad de preparación. Casos: `catalog-refresh-next-session-and-dispatch`, `every-enabled-role-effort`, `no-inflight-change`, `host-cannot-apply-pending`, `same-record-two-consumers`, `cross-role-action-rejected`; suite existente `packages/cli/src/lib/plan/__tests__/plan-gate.test.ts` y futura `packages/cli/src/lib/codex/__tests__/profile-dispatch.test.ts`, creada por T11. `effect: behavior`; `test: profile-dispatch.test.ts::same-record-two-consumers`.
- [ ] **T12** (R17) — Crear evaluación acotada y registrar outcomes comparables sin causalidad atribuida al modelo; revalidar R1–R18 mediante A10. Casos vivos: `bug-regression`, `two-module-feature-and-review`, `resume-after-state-change`, `subagent-approval-route`; suite futura `packages/cli/src/lib/codex/__tests__/outcome-evaluation.test.ts`, creada por T12, y protocolo manual descrito en A10. `effect: behavior`; `test: outcome-evaluation.test.ts::required-evidence-per-engine`.
