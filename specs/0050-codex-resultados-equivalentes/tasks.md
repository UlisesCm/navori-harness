# Codex: resultados equivalentes y perfiles actuales — Tasks

**Estado:** E1/M1, E2/M2 y E3/T7 están integrados. E4/M4 (T8–T10) se envió como entrega parcial en PR #1320; no completó las obligaciones originales de E3/E4. E4/M5 es una enmienda documental; E4/M6–M7 sigue pendiente con T6, T11 y T12. El usuario autorizó preparar un checkpoint de PR borrador a `main`, sujeto a una revisión E4 independiente del diff completo y su receipt antes de publicar. Esa autorización cambia el momento de exponer el trabajo: no completa la entrega, no marca A9/A10/A13 como cumplidos y no autoriza merge. Cada caso debe incluir `// Covers: R<n>`.

**Precondición:** crear y clasificar un workplan independiente por entrega y obtener la aprobación correspondiente. E<n+1> comienza después de que E<n> se integre. Cada milestone ejecuta su criterio y `bun run check:fast` desde la raíz del repo; al cerrar cada entrega se ejecuta `bun run check` desde la raíz. El PR final de E4 requiere workplan clasificado/aprobado, revisión independiente y gate de envío. Los paths marcados *futuro* son salidas que deberá crear la tarea indicada.

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

- **A6** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/__tests__/codex-approval-route.test.ts` → exit 0; solicitud del subagente vuelve pending, el principal solo tramita autorización humana/host aplicable y no hay bypass ni cambio global/trust. `codex-approval-route.test.ts` es futuro y lo crea T7.

**Registro parcial E3:** A5 pasó 22/22 y A6 pasó 34/34; `check:fast` pasó y la compatibilidad Pi/hook/golden pasó 60/60. La revisión Pass 1 registró `PASS1_OK`, sin hallazgos. T7 entrega la ruta pending al principal; T6 y el cierre completo de E3 siguen pendientes. Las pruebas de hook y CLI verifican solicitud acotada, relay al principal, claim de mediación exclusiva, resumen pending de solo lectura para consumidores duplicados, rechazo ante cambio de checkout/HEAD/base/contenido, validación de campos y limpieza bajo deadline. No acreditan consentimiento humano positivo ni consumo de grant de un solo uso. La identidad/provenance del caller no autentica al principal; la base remota permanece sin verificar. La evidencia histórica del host se limita a la superficie de hooks de comandos CLI 0.162.1 investigada; app-server/UI y otros engines no fueron verificados allí. El cierre final de E4 debe probar el origen de aprobación admitido y el efecto nativo fijo en su superficie de producción.

**T6 pendiente con procedencia E3:** su requisito y casos originales se trasladan sin
redefinirlos a E4/M6. T7 permanece integrado; su ruta pending no cierra T6.
- [x] **T7** (R7, R16; ruta pending entregada, Pass 1 `PASS1_OK`) — Implementar ruta pending desde subagente al principal y preservar ámbito global/trust. Casos: `subagent-returns-pending`, `principal-mediates-applicable-consent`, `no-bypass`, `no-global-trust-write`; suite `packages/cli/src/lib/__tests__/codex-approval-route.test.ts`. La mediación entregada no acredita consentimiento humano/host aplicable ni completa T6. `effect: behavior`; `test: codex-approval-route.test.ts::subagent-returns-pending`.

## E4 — Perfiles y evaluación comparativa

Estimated LOC: 1000

### M4 — Resolución y render preservan intención

**Registro M4:** T8–T10 implementados y enviados como entrega parcial en PR #1320. A7 pasó 33 pruebas en 2 archivos; A8 pasó 18
pruebas en 3 archivos; `bun run check:fast` terminó con exit 0 y el bundle midió
1473.4 KB frente al límite de 1500 KB. El alcance verificado es resolución/proyección,
render y diagnóstico deterministas. No verifica selección ni aplicación runtime en Codex.
La revisión y gate de envío corresponden al historial de integración; no se inventan aquí
conteos adicionales. Este registro no verifica selección ni aplicación runtime en Codex.

- **A7** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/assets/__tests__/model-profile.test.ts src/lib/codex/__tests__/model-catalog.test.ts` → exit 0; Opus medium resuelve Sol medium, Sonnet medium Luna high, otros efforts se conservan, pins/override prevalecen y 6.10 supera 6.9.
- **A8** [observable] — Ejecutar `cd packages/cli && bun run test src/commands/__tests__/model-profile-doctor.test.ts src/engines/codex/__tests__/profile-render.test.ts src/lib/codex/__tests__/profile-selection.test.ts` → exit 0; cada rol habilitado tiene provenance, herencia explícita se distingue, configured no equivale a observed y preservación se mantiene.

- [x] **T8** (R9, R10, R11) — Resolver modelo y effort respetando precedencia y comparación numérica. Casos: `opus-medium-sol-medium`, `sonnet-medium-luna-high`, `other-efforts-preserved`, `model-pin`, `explicit-effort-override`, `6.10-over-6.9`, `listed-future-major`; suites `packages/cli/src/lib/assets/__tests__/model-profile.test.ts` y `packages/cli/src/lib/codex/__tests__/model-catalog.test.ts`. A7 pasó 33 pruebas en 2 archivos. `effect: behavior`; `test: model-profile.test.ts::sonnet-medium-luna-high`.
- [x] **T9** (R12, R14, R16) — Cubrir los roles habilitados y diferenciar intención, render y runtime, preservando ámbito. Casos: `every-enabled-main-core-extra-local`, `explicit-inheritance`, `configured-not-observed`, `user-global-trust-preservation`; suites `packages/cli/src/commands/__tests__/model-profile-doctor.test.ts` y `packages/cli/src/engines/codex/__tests__/profile-render.test.ts`. A8 cubre las suites de T9/T10: 18 pruebas en 3 archivos. `effect: behavior`; `test: profile-render.test.ts::every-enabled-main-core-extra-local`.
- [x] **T10** (R15, R18) — Representar frescura desconocida/obsoleta y rechazo del host sin sustitución silenciosa. Casos: `valid-but-obsolete-catalog`, `freshness-unknown`, `malformed-catalog`, `offline-catalog`, `unsupported-effort`, `runtime-rejection`; suites `packages/cli/src/lib/codex/__tests__/model-catalog.test.ts` y `packages/cli/src/lib/codex/__tests__/profile-selection.test.ts`. A8 cubre la suite futura de selección; 18 pruebas en 3 archivos en total. `effect: behavior`; `test: profile-selection.test.ts::freshness-unknown`.

El alcance integrado de M4 es la metadata y configuración renderizada para futuros contextos.
Su registro no observa dispatch ni perfiles efectivos por rol, y ningún test unitario/mocked
cierra A9 o A10. La reproducción nativa corregida acredita solamente que el contexto Codex de
inicio seleccionó `gpt-6.1-sol` y effort `medium` en 1.127 s el 2026-10-14 UTC; no hubo turno
ni aprobación. El timeout anterior de 25 s fue un mismatch del ID de initialize del cliente y
nunca envió `thread/start`. Esto no prueba inferencia, perfiles de subagentes, aprobación,
retención efímera ni aceptación viva. T6/E3 permanece pendiente.

### M5 — Enmienda documental

- **A11** [observable] — Ejecutar `navori spec check 0050-codex-resultados-equivalentes --json` → exit 0; la spec conserva requisitos y trazabilidad consistentes tras la enmienda. El comando fuente equivalente en este checkout es `bun packages/cli/src/index.ts spec check 0050-codex-resultados-equivalentes --json`.
- **A12** [observable] — Ejecutar `bun run check:links` → exit 0; los enlaces Markdown de la spec y la dirección apuntan a destinos existentes.

Registro de M5 sobre este diff: A11, ejecutado con la CLI fuente, pasó con exit 0 y sin
findings; la spec conserva cuatro entregas E1–E4 y siete milestones. A12, `bun run
check:links`, pasó con exit 0: 210 enlaces relativos en 427 archivos resuelven. El `bun run
check:fast` fresco pasó con exit 0 (formato 676 archivos, duplicación 684 archivos/19
clones/0.19%, AST 5/5, lint y typecheck). Estos resultados no acreditan T6, A5/A6, T11/T12
ni A9/A10.

### M6 — Control autenticado de la acción (T6; procedencia: E3)

- A6 es el criterio original de E3/M3, definido arriba. Su resultado histórico no demuestra
  consentimiento positivo ni cierra T6. El PR final vuelve a ejecutar A6 junto con A5, sin
  cambiar comandos, garantías ni identidad; tampoco redefine T7.

**Registro de corrección M6:** La ronda acotada corrigió tres hallazgos reproducidos
red-before-green: bootstrap/control de fuente, origen child→parent obligatorio y validación
del resultado nativo. La fuente positiva sigue indisponible: el predicado sin inputs falla
cerrado en el comando, runner nativo directo, controlador, launcher y efecto privado. No se
afirma aislamiento de fuente humana ni publicación positiva implementados. Las reproducciones
finales y pruebas deterministas pasaron; la evidencia fresca incluye `bun run check:fast`
(formato 684 archivos; duplicación 692 archivos, 19 clones, 436 líneas/0.19%; AST 5/5;
oxlint y tsc exit 0), `navori gate fast` exit 0, A5 22/22, A6 serial 38/38, suite enfocada
87/87 y `bun run check:size` exit 0 (1494.3 KB/1500 KB, 5.7 KB de margen). `git diff
--check` pasó con exit 0. La suite positiva de protocolo/efecto y disponibilidad es
determinista con módulos mockeados; no hubo bootstrap, UI ni efecto live. A6/A5 verdes no
cierran sus criterios vivos. T6, T11 y T12 permanecen sin marcar; A15 se difiere al owner de
observación M7 y A9/A10/A13 no se ejecutaron. Revisión independiente, gate completo y
receipt nativo fresco siguen pendientes.

- **A5** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/__tests__/pr-publisher-confirm.test.ts` → exit 0; falta de autorización, rechazo, replay, diff/destino cambiado y registro del principal sin fuente humana/host aplicable dejan publicación detenida.

- [ ] **T6** (R6; transferido de E3, sin cambiar su identidad) — Vincular autorización a acción, destino y diff/estado, con consumo no reutilizable. Casos: `action-destination-diff-binding`, `approval-replay`, `explicit-refusal`, `principal-record-without-human-source`; suite existente `packages/cli/src/lib/__tests__/pr-publisher-confirm.test.ts`. Debe demostrar el controlador browser parent humano admitido y el efecto nativo fijo en producción; no se acepta bypass directo/headless, forged o por browser-tool. `effect: behavior`; `test: pr-publisher-confirm.test.ts::action-destination-diff-binding`.

### M7 — Perfiles efectivos y evaluación viva (T11, T12; procedencia: E4/M5)

- **A9** [observable, T11] — Ejecutar exactamente `cd packages/cli && bun run test src/lib/plan/__tests__/plan-gate.test.ts src/lib/codex/__tests__/profile-dispatch.test.ts && cd ../.. && bun packages/cli/src/index.ts codex profile probe --live --cwd .` → exit 0 únicamente con evidencia nativa actual para principal y todos los roles requeridos, dispatch baseline, refresh en el siguiente dispatch y cleanup comprobado; cualquier admisión, identidad, perfil o cierre no verificable mantiene `pending` y T11 abierta. Este consumer enfocado no sustituye ni debilita R1–R18; la validación de outcomes que antes estaba acoplada al compuesto A9 se conserva en A10/T12.
- **A10** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/codex/__tests__/outcome-evaluation.test.ts && cd ../.. && bun packages/cli/src/index.ts codex evaluation validate --records .navori/state/handoffs/0050-live-evaluation.json --cwd .` → el prefijo determinista debe pasar; el comando compuesto permanece pendiente hasta que el consumer de producción acepte los ocho outcomes vivos autenticados. Requiere protocolo por engine y escenario, con versión del host, modelo/effort efectivo o unknown, outcomes y evidencia para: (1) bugfix con regresión, (2) feature de dos módulos seguida por review, (3) resume tras cambio de evidencia/diff, (4) aprobación solicitada desde subagente. Mock/validator no prueba comportamiento vivo. Registrar fallas/reintentos y duración/consumo cuando disponibles; evidencia requerida ausente falla. `outcome-evaluation.test.ts` es futuro y lo crea T12.

**Registro parcial M7 anterior a la corrección de separación:** La implementación acotada añadió consulta/inventario de perfiles, preparación metadata-only con claim exclusivo, observaciones de candidatos nativos y un evaluador diagnóstico. No hay dispatch activo de hijos ni ocho ejecuciones vivas autenticadas; preparar metadata no aplica un perfil. Esa ronda registró A9 89/89, A10 5/5, A15 47/47, A16 19/19 y tamaño de bundle 1,506,801 bytes. El A16/codec y el smoke aislado de Node 24.20.0/Bun 1.4.2 son evidencia histórica; no se volvieron a ejecutar en la corrección. Ver `evaluation.md` para límites y evidencia histórica.

**Registro de corrección de separación de aceptación:** Se retiraron los acoplamientos específicos por spec de los owners genéricos de evidencia/receipt y el veto universal de opt-in de perfiles. La preparación de perfiles y los diagnósticos continúan metadata-only/pending; no se añadió dispatch nativo ni ruta de éxito. Los comandos A9 y A10 compuestos exactos están declarados arriba y ambos terminaron con exit 1 porque el consumer de producción rechazó la ausencia de evidencia nativa actual. Sus prefijos deterministas pasaron, respectivamente, 88/88 y 4/4. A13 también rechazó los registros nativos ausentes (exit 1). A15 pasó 47/47; cinco suites afectadas pasaron 175/175; `navori gate fast` pasó con exit 0. El bundle midió 1,505,727 bytes (1,470.4365234375 KiB), límite 1,536,000 bytes, margen 30,273 bytes; no se reejecutó A16 ni el smoke. T6, T11 y T12 permanecen sin marcar; aceptación viva A9/A10/A13, revisión final y receipt de envío siguen pendientes. La corrección técnica acotada no convierte el resultado original en SPEC_OK ni autoriza publicación.

- **A15** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/codex/__tests__/native-integration.test.ts src/lib/codex/__tests__/approval-controller.test.ts src/lib/codex/__tests__/host-observation.test.ts` → exit 0; contratos nativos/controlador y uniones de candidatos core/extra/local, rol/pair/parent/activity incorrectos o ausentes, llamadas ambiguas/reencaminadas y claims de observación del caller. No certifica fuente ni aprobación viva.
- **A16** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/__tests__/bundle-render-data.test.ts` → exit 0; codec de release para los dos renderers nombrados conserva dominio raw UTF-8/CRLF/escapes, fases reales input/minifier/legal/map, integridad, renderer/settings completos del mismo modo y orden de expresiones/coerciones/errores de `String.raw`.
- **A17** [observable] — Ejecutar `cd packages/cli && bun run test src/lib/codex/__tests__/profile-dispatch.test.ts src/commands/__tests__/codex-profile.test.ts src/lib/codex/__tests__/host-observation.test.ts` → exit 0; wire nativo conserva entrada opaca y rol, claim por llamada no se regenera al cambiar UUID/rol/acción, intentos malformados se consumen, query tiene deadline total y cleanup del proceso propio, se verifican IDs/conflictos y fallas del supervisor. Son fixtures deterministas; no certifican hook nativo efectivo.

**Registro precursor B2/R13:** El hook de proyecto opt-in agrega una fila estable `Agent/spawn_agent` PreToolUse y un modo fijo de `model-advisor` que emite el rewrite nativo `hookSpecificOutput` con `permissionDecision: allow` y `updatedInput`; ese allow implementa el protocolo de reescritura, no un grant humano de T6/`PermissionRequest`. La preparación consume un claim exclusivo `wx` por checkout canónico/sesión/call, ligado a inputs actuales, catálogo y par deseado; errores o pérdida de salida tras el consumo quedan inciertos. La consulta tiene deadline interno de 8 s, el supervisor 11 s y el hook nativo conserva 15 s. A17 pasó 33/33, A15 51/51; los prefijos A9/A10 pasaron 91/91 y 4/4, pero ambos comandos compuestos terminaron exit 1 porque el consumer rechazó registros native-auth ausentes. A13 también rechazó esa ausencia (exit 1). `navori gate fast` pasó; el bundle midió 1,510,082 bytes (1,474.689453125 KiB), con límite 1,536,000 bytes y margen 25,918 bytes. Los límites nativos importan: hooks concurrentes no serializan ni garantizan precedencia; otro deny gana y otra reescritura/configuración de rol puede sustituir el par. Timeout/crash/skip/untrusted/invalid hook externo puede fallar abierto con argumentos originales. Metadata, envelope manual y evento parseado no certifican aplicación efectiva sin una observación nativa propia que confirme el par realmente usado. No se activó/renderizó/confió el hook, ni se ejecutó turno de hijo o efecto. T6/T11/T12 y aceptación viva siguen pendientes; este precursor no completa T11/A9.

**Corrección acotada del supervisor B2:** La shell ahora captura la salida del supervisor antes de reenviarla: si el proceso falta, falla, recibe señal o devuelve output parcial con error y la shell sigue activa, se emite un único deny nativo; un deny válido ya emitido se reenvía una sola vez. El opt-out solo acepta un objeto JSON plano no nulo, no arreglo y sin claves propias; arreglos, primitivas y JSON inválido se niegan. Se corrigió el comentario del header para distinguir lifecycle advisory del modo fijo de rewrite/deny. A17 pasó 45/45 y A15 51/51; `navori gate fast` pasó con exit 0; build/size midieron 1,510,082 bytes (1,474.689453125 KiB), límite 1,536,000 bytes, margen 25,918 bytes. El preview normal de CLI fuente y dist mostró tres deltas: los dos mirrors `model-advisor` autorizados y un mirror Pi de hash/serialización de helpers. Ese preview precedió la alineación normal descrita abajo; no significa que el Pi se use para cambiar su helper fuente.

**Registro de alineación de target y mirrors:** `navori.config.json` cambió únicamente `branchBase` y `prTarget` de `dev` a `main`; los demás campos, incluidos engines/model/effort/opt-in/trust, se conservaron. El renderer normal de Node dist actualizó las salidas generadas dentro del alcance aprobado; los seis perfiles reviewer/publisher de Claude/Codex/Pi ahora usan `origin/main`, `--target main` y, en publishers, `--base main`. Los dos mirrors `model-advisor` tienen el bloque fijo alineado. La primera revisión scoped señaló solo drift de `.pi/extensions/navori.ts`; una segunda pasada normal Node dist lo alineó, y el diff final de Pi contra HEAD quedó vacío. El preview final reporta 0 pendientes. `A17` se mantuvo 45/45; `navori gate fast` y `bun run check:scoped` pasaron con exit 0; `index.js` quedó en 1,510,082 bytes (1,474.689453125 KiB), 25,918 bytes bajo el límite. Este cambio cierra solo la configuración y la alineación generada: review fresca pendiente, sin gate completo/receipt/PR y con T6/T11/T12 y los criterios vivos sin marcar. No se activó trust ni se ejecutó turno/efecto nativo.

**Preflight fijo de perfiles, sin admisión viva:** El nuevo `codex profile probe --cwd` permite solo seleccionar checkout; quema un intento `wx` por checkout/escenario antes de cualquier proceso y nunca reintenta ese escenario ante fallo. La query verifica configuración nativa cargada y catálogo/resolución actuales, con límites explícitos de 180 s, 12 roles, 2 MiB/2048 frames compartidos, y cero retry; no se declara límite duro de tokens/costo. Si falta una restricción nativa verificada, rechaza antes de thread/turn. La ejecución real de preflight observó configuración confinada y salida de procesos reconocida, pero cero turnos; los siete nombres de rol de la fixture tenían par no soportado/no renderizado y permanecieron pending. Esto no acredita selección efectiva ni all-role dispatch. El comando sobre el checkout actual salió con exit 1 por opt-in ausente y cero procesos/turnos. A17/A15 pasaron 52/52 cada una, fast y scoped con exit 0, render con cero pendientes y bundle 1,514,590 bytes (1,479.091796875 KiB), margen 21,410 bytes. T6/T11/T12 y aceptación viva siguen pendientes; no hay full gate, receipt ni publicación.

- [ ] **T11** (R12, R13, R14, R16; transferido de E4/M5, sin cambiar su identidad) — Refrescar perfil antes de cada nuevo dispatch y probar claim exclusivo por identidad de preparación. Casos: `catalog-refresh-next-session-and-dispatch`, `every-enabled-role-effort`, `no-inflight-change`, `host-cannot-apply-pending`, `same-record-two-consumers`, `cross-role-action-rejected`; suites `packages/cli/src/lib/plan/__tests__/plan-gate.test.ts` y `packages/cli/src/lib/codex/__tests__/profile-dispatch.test.ts`. La segunda contiene cobertura determinista del precursor; no cierra aplicación efectiva por rol. `effect: behavior`; `test: profile-dispatch.test.ts::same-record-two-consumers`.
- [ ] **T12** (R17; transferido de E4/M5, sin cambiar su identidad) — Crear evaluación acotada y registrar outcomes comparables sin causalidad atribuida al modelo; revalidar R1–R18 mediante A10. Casos vivos: `bug-regression`, `two-module-feature-and-review`, `resume-after-state-change`, `subagent-approval-route`; suite existente `packages/cli/src/lib/codex/__tests__/outcome-evaluation.test.ts` y protocolo descrito en A10. La suite determinista no sustituye las ocho ejecuciones autenticadas. `effect: behavior`; `test: outcome-evaluation.test.ts::required-evidence-per-engine`.

La revisión técnica de la corrección debe confirmar la restauración de los owners genéricos y la exactitud de los comandos de aceptación compuestos. El checkpoint borrador autorizado requiere una revisión E4 independiente del diff completo y un receipt correspondiente. La revisión de entrega debe conservar SPEC_MISS mientras falten T6/T11/T12 y los criterios vivos A9/A10/A13; no hay base para marcar esas tareas, declarar readiness final ni hacer merge.

# Enmienda M7 — estado T11/A9

Esta enmienda documenta la entrega parcial autorizada de T11/A9 y mantiene separados los
trabajos T6 y T12. No cambia R1–R18 ni marca E4 cerrada.

| Criterio | Estado | Evidencia actual |
|---|---|---|
| A18 — contrato determinista, supervisor, lifecycle, fixture MCP vacío y goldens | Cumplido (root) | Comando exacto: `cd packages/cli && bun run test src/lib/codex/__tests__/native-integration.test.ts src/lib/codex/__tests__/host-observation.test.ts src/commands/__tests__/codex-profile.test.ts && bun run test:golden`. Renovado después del guard: 137 pruebas + 5 goldens, sesión root `51893`, exit 0 y registrado por CLI source. |
| A19 — procedencia nativa versionada | Cumplido | Comando exacto: `cd packages/cli && bun run test src/lib/handoff/__tests__/actor-provenance.test.ts` → root registró 9/9 antes de la extensión lectora; acepta headers 0.162.1 y 0.163.0 con invariantes intactas. |
| A9 — dispatch nativo all-role más refresh y cleanup verificados | Pendiente | Comando exacto: `cd packages/cli && bun run test src/lib/plan/__tests__/plan-gate.test.ts src/lib/codex/__tests__/profile-dispatch.test.ts && cd ../.. && bun packages/cli/src/index.ts codex profile probe --live --cwd .`. Prefijo más reciente 121/121; el turno live produjo identidad `04c77226a2d6878732cbd7e6e48af08119956987aac0ff9c94856308f3225bc3` pending `native-profile-selection-or-hook-call-unverified`, un request del principal, cero children, refresh pendiente y cleanup no verificado. |
| A20 — lector de binding review/edit con versiones nativas verificadas | Cumplido (root) | Comando exacto: `cd packages/cli && bun run test src/lib/handoff/__tests__/review-edit-binding.test.ts src/lib/handoff/__tests__/actor-provenance.test.ts && bun run test:golden` → 47/47 pruebas y 5/5 goldens, exit 0; root run sesión `13800`. La focal del implementer fue 47/47 y golden Codex 1/1. |
| A21 — removal-parity | Cumplido (root) | Ejecución `69571`: suite removal-parity 29/29, exit 0, 8.45s; el resultado se registró mediante el CLI original compatible. No acredita la aceptación nativa A9/T11. |

El artefacto `.navori/state/handoffs/t11-model-metadata-no-turn-result.json` es un diagnóstico
separado de A21: observa en Codex 0.162.1 `gpt-6.1-sol`, `multiAgentVersion: v2` y
`toolMode: code_mode_only`, con cero notificaciones de thread/turn y salida nativa reconocida.
No satisface el requisito esperado V1 `close_agent`, ni prueba selección por rol o A9.

**T11 permanece pendiente** hasta que una ejecución A9 propia, con baseline, refresh,
cobertura exacta de todos los roles actuales, selección/hook nativos y cleanup verificados,
termine sin pendientes. El reporte del modelo `blocked/tool_unavailable` no acredita causa
ni disponibilidad. La autorización vigente deja una ejecución con turnos de hasta 180 s;
la ejecución A9 ya consumió un turno y no se repetirá el mismo estado por un cambio de hash
documental. T6, T12, A10 y A13 siguen pendientes; no se declara cierre de E4.

La extensión del lector tiene aprobación de alcance; A20 está registrada por root y la
revisión independiente sigue pendiente. El full run `44919` terminó por SIGINT propio, exit 130, con fallas
anteriores conservadas; no se considera aprobado. El barrido de inventario `97331` falló
en 55 ms (esperaba 18 rutas, encontró 19 por un extra
`packages/cli/src/lib/codex/native-integration.ts`). Root completó A21 removal-parity 29/29
después de ese diagnóstico; no se afirma que la ruta adicional se retirara o excluyera. No
marcar shipping-ready, gate completo ni review aprobada por la focal del implementer o el auditor.

### Estado del checkpoint parcial autorizado

El usuario autorizó activar el lector original y preparar un checkpoint parcial dirigido a
`main`, sin cerrar T11/A9. El lector exacto 0.162.1/0.163.0 se activó en el checkout
original; build/preview/apply, validación de shell/diff y fast gate pasaron. La aplicación
actualizó solo el mirror `.codex/hooks/role-guard.sh`, con 90 archivos sin cambios ni archivos
Pi escritos, y preservó las reglas 0054 y los tres archivos sucios preexistentes. No hubo
revisión nativa.

El full gate que pasó exit 0 cubrió 436 archivos, 9,227 pruebas aprobadas, 2 omitidas,
0 fallidas, cinco AST checks y piso de cobertura en 154 módulos (statements 84.37%, branches
79.1%, functions 89.37%, lines 85.91%). Esa corrida precede al guard de refresh y es
histórica; el full fresco del árbol actual y la review independiente siguen pendientes.
A18 se renovó después del guard (137 pruebas + 5 goldens, sesión root `51893`, exit 0 y
registrado); A19, A20 y A21 también constan cumplidas. El gate completo no sustituye la
revisión independiente, receipt, commit o PR.

La suite `role-guard.test.ts` particionó en 17 casos independientes el caso monolítico de
18 payloads y dos comparaciones TypeScript. Conserva los 18 payloads y las dos comparaciones,
añade un positivo de mismo destino antes de revocar el índice, usa el hook real fuera de
temp y mantiene Bash/Zsh, la remoción del mismo índice físico, los otros 25 casos y el límite
de 15 s. Los 19 payloads cruzan ambos shells: 38 invocaciones son un conteo estructural de
fuente, no una medición nueva. El comando A22 fue `cd packages/cli && bun run test src/lib/__tests__/role-guard.test.ts src/lib/handoff/__tests__/review-edit-binding.test.ts`.
Productor A22: 80/80 en dos archivos, ejecución `88165`, 120.35 s. Root A22: 80/80 en dos
archivos, ejecución `68929`, 166.40 s; source CLI registró A22 cumplida (`updated: true`).
Esto verifica la partición de pruebas, no A9/T11.

El full reviewer `full-20261016T230611569Z.log` queda como rojo histórico: 9,226 aprobadas,
1 fallida y 2 omitidas; el fallo fue timeout del caso agrupado de roles a 25,816 ms. El origen
de ese tiempo excedido es desconocido; la instrumentación de diagnóstico no demuestra si
fue introducido o preexistente. El nuevo resultado A22 no convierte ese full en verde. Fresh
full, review independiente y receipt de fase 1 siguen pendientes antes del borrador de PR
por publisher. El usuario difirió la orquestación del issue #1314; este checkpoint parcial
no la incorpora. T11/A9, T6, T12, A10, A13 y E4 siguen pendientes.

El guard vigente de refresh compara `liveProfileSnapshot.identity` inmediatamente antes del
refresh. Si el target cambió tras baseline, devuelve `target-profile-inputs-changed` antes de
iniciar otro turno; la prueba verifica `principalTurnRequests=1`, un único `turn/start` y
cleanup reconocido. El caso cambiado, el paralelo pendiente y el positivo baseline+refresh
pasaron juntos 3/3; el focal cambió de rojo a verde 1/1 sin alterar límites.

T11/A9 permanece pendiente. El host mostró metadata V2 `code_mode_only`, mientras el
escenario actual requiere V1 `close_agent`. El default de unload de 60 s hace que ocho
cierres secuenciales requieran al menos 480 s, por encima de los 180 s autorizados; V2
mantiene por defecto tres hijos residentes y la eviction revisada no ofrece evidencia de
cierre aceptable. `Completed`, `NotLoaded`, archive o salida de proceso no son sustitutos.
La unión de un hijo efímero exacto con su hook es unknown, no imposible demostrado. No hay
implementación de aceptación V2 viable ni cambio aprobado de contrato/presupuesto. Una
ejecución de inferencia de hasta 180 s permanece sin usar; no se hacen probes nuevos en esta
enmienda. T6, T12, A10, A13 y E4 siguen pendientes.
