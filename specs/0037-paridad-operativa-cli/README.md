# Spec 0037 — Paridad operativa Claude / Codex CLI

**Estado: avance parcial; 10 de 19 tareas aprobadas y completas (T1–T6, T8, T12–T14), 9 pendientes.** Fecha: 2026-09-28.

## Contenido

- [Requisitos](requirements.md): **23 requisitos EARS**, incluyendo lo que ya funciona y debe preservarse.
- [Diseño](design.md): extensión de piezas existentes, decisiones, contratos, seguridad y migración.
- [Tareas](tasks.md): **19 tareas en 8 lotes**; diez completas y 9 pendientes, con dependencias y trazabilidad R→T→V.
- [Validación](validation.md): **23 pruebas/casos y 9 escenarios live** especificados; T9/L03 se
  intentó y quedó inconcluso, L04 no se ejecutó y los demás escenarios live siguen pendientes.
- [Evidencia](evidence.md): auditoría, fortalezas, brechas y documentación oficial.
- [Baseline T1](baseline.md): snapshot versionado de procedencia y dependencias; no certifica
  receipt, trust, gate completo ni comportamiento live.
- [Revisión](review.md): challenge independiente y resolución de sus hallazgos.

## Resultado del diseño

Architect redactó y un auditor en contexto fresco desafió el diseño una vez: **0 BLOCKER,
3 CONCERN, 1 NOTE**. El veredicto del orchestrator es **CONCERNS**: lotes definidos y riesgos
acotados, sin certificar equivalencia runtime. Se incorporaron correcciones al contrato de
telemetría de scanners, herencia de herramientas y preservación de restricciones MCP.

La traducción de permisos por rol no se habilita para casos sin evidencia de que preserve filtros
heredados. Claude plan-gate sigue enforced por hook; Codex plan-gate sigue advisory, sin promesa de
deny selectivo. #1082/#1084 son antecedentes integrados, no trabajo para repetir; conserva los
criterios de reapertura documentados. Los errores de scanner conservan la política deliberada de
Claude, sin contarlos como scans aprobados. No hay nueva capa always-on, modelo impuesto ni
orchestrator spawnable.

## Autorización y límites

La autorización histórica para redactar la spec incluyó una excepción puntual del preflight circular
de handoff para **architect/auditor durante esa redacción**. No cambió la regla vigente ni fabricó
un handoff. T4 implementa y revisa la corrección de flujo: el primer productor no requiere un
handoff inexistente; scribe/reviewer lo consumen solo tras un check exitoso. La precondición de
planificación del implementer sigue independiente y obligatoria; no cambió el validador ni se afirma
comportamiento runtime. Después, el usuario autorizó el Lote A (T1–T2) tras sincronizar `main`; T8 y
T13 también se completaron con autorizaciones puntuales y revisión fresca. Esto no autoriza las otras
tareas.

T1 registró el baseline y T2 implementó diagnóstico read-only de doctor. T5 y T14 tienen commits
locales revisados (`a3f05d2a` y `c9ebc10b`); la revisión combinada fue **APPROVED** y el gate completo
pasó (299 archivos de tests, 5,447 tests aprobados y 1 omitido). Esto acredita las pruebas y el diff
revisado, no paridad live ni trust efectivo. La única campaña live autorizada hasta ahora fue T9/L03-L04;
su resultado es inconcluso y está descrito en [live-t9.md](live-t9.md). No se autorizan otras campañas
live/pagadas, instalaciones, cambios de trust, push ni PR; no se presentan resultados pendientes como
equivalencia demostrada.

## Verificación T1–T3 y estado histórico del gate

- El checkout de T1 está en `HEAD=origin/main=131067295be01fa7b5410acea403b9702bae339c`, tras un
  `git fetch origin main --quiet` exitoso; `HEAD..origin/main` contiene cero commits. Este estado
  reemplaza la observación de base relativa del intento de redacción, no la actualidad futura de
  `main`.
- Las suites objetivo T1 pasaron: 7 archivos, 94 tests; `bun lint`/oxlint exit 0. Comando y hashes
  exactos: [baseline.md](baseline.md), evidencia V01/V03/V14/V18.
- T2 distingue procedencia del CLI/entrypoint y evidencia por engine/ubicación, sin alterar el
  inventario JSON existente ni inferir ejecución a partir de registro/trust. Sus 27 pruebas enfocadas
  cubrieron procedencias, mismatches de registro, plugins ausentes y estados operativos. Lint y
  typecheck pasaron; no se ejecutaron controles live. Véase la
  [revisión fresca T2](../../.codex/progress/review_spec0037_t2_rereview.md).
- La revisión fresca de T1 fue **APPROVED** (`SPEC_OK`, `QUALITY_OK`) y el gate completo del repo
  terminó con exit 0. El receipt `.codex/progress/receipt.txt` reportó `status: ok`, `fresh: true`,
  sin `uncovered` ni `drift`, con target `main` en `13106729`. El reviewer aclara que Semgrep/jscpd
  reportaron cero archivos TS cambiados, no un escaneo de estos Markdown.
- La revisión fresca combinada de T1/T2/T4 fue **APPROVED** (`SPEC_OK`, `QUALITY_OK`); el gate
  completo pasó y el receipt reportó `status: ok`, `fresh: true`, sin `uncovered` ni `drift` para el
  publish set revisado. Este cierre administrativo modifica README/tasks después de esa firma, por
  lo que el receipt ya no es fresco para el contenido actual; renovar revisión y firma antes de
  publicar/cerrar. Un receipt de contenido no certifica paridad runtime ni trust efectivo.
- T3 fue **APPROVED** en revisión fresca y pasó el gate completo. Claude conserva plan-gate enforced
  por hook y Codex se mantiene advisory; no hubo campaña live y permanecen los criterios de
  reapertura #1082. La firma era fresca para el publish set revisado, pero este cierre de README/tasks
  la vuelve obsoleta; renovar antes de publicar/cerrar.
- Solo como antecedente, el intento de redacción de la spec del 2026-09-28 reportó varios checks
  documentales verdes, `semgrep:check` detenido por `ca-certs: empty trust anchors` y receipt no
  disponible tras un fetch fallido por DNS. Ese gate parcial y ese fallo no describen el checkout
  ni las verificaciones de T1; no se desactivó TLS para forzarlo.

El baseline de T1 está documentado en [baseline.md](baseline.md) sobre HEAD `13106729`, que incluye
#1084. Véanse la [revisión fresca de T1](../../.codex/progress/review_spec0037_t1.md) y el receipt
`.codex/progress/receipt.txt`. T3 fue aprobado en la [revisión fresca](../../.codex/progress/review_spec0037_t3_rereview.md);
las campañas live restantes y las 11 tareas pendientes permanecen sin completar.

T5 comparte el registro de scripts de plugins entre engines y materializa gates traducibles de
Semgrep/jscpd en Codex con pruebas de fixtures; no afirma cobertura universal de comandos ni trust
efectivo. T14 amplía pruebas de render/discovery de skills compartidas y políticas de invocación,
sin sumar otra capa always-on. La revisión combinada T5/T14 fue **APPROVED** con gate completo;
véase [review_spec0037_t5.md](../../.navori/state/handoffs/review_spec0037_t5.md).

T8 materializó `.codex/orchestrator.md` como referencia managed opcional desde el playbook compartido,
sin crear un perfil de agente ni sumar su contenido al contexto always-on salvo que se abra la
referencia. En el fixture medido, el contexto always-on cambió de 24,084 a 24,110 bytes; la referencia
mide 18,492 bytes y el contexto compuesto al abrirla mide 42,602 bytes. Son tamaños de render del
fixture, no mediciones de tokens, latencia o costo.

T13 añade a `doctor --json` ejes read-only para tgrep, CodeGraph y Engram: CLI/MCP, estado de índice
y frescura/resultado, y lectura/escritura. Los 35 tests dirigidos y el gate completo revisado no son
campañas runtime: el resultado de búsqueda, la invocación MCP y las operaciones Engram siguen sin
verificarse en vivo; L02/L08 permanecen pendientes. Doctor no instala herramientas, inicia
servidores, reindexa ni escribe memoria. La revisión combinada T8/T13 fue **APPROVED** y el receipt
`.codex/progress/receipt.txt` reportó `status: ok`, `fresh: true` en HEAD `785367f6` (commits
`785367f6` T8 y `a88a7781` T13; gate completo: 298 archivos, 5,436 tests aprobados). Este receipt
acredita el diff revisado, no campañas live ni trust efectivo.
En la campaña T9, L03 (selección de perfil y MCP) se intentó en un fixture desechable con
autenticación existente y stub local, pero quedó inconcluso: un error de infraestructura terminó el
proceso con exit 0 y no hubo observaciones útiles de selección efectiva de perfil o filtros MCP.
L04 no se ejecutó; por tanto, no hay evidencia sobre callbacks de hooks. T9 permanece pendiente y no
demuestra paridad de perfiles, filtros MCP o routing/guards. Véanse [los resultados redactados](live-t9.md);
la campaña no cambió trust/configuración global, instaló componentes ni publicó.

No se movió ni sobrescribió el checkpoint de Spec0036 perteneciente a otra sesión.

T6 mejora la fidelidad de los resultados de Semgrep/jscpd, capturando el estado original antes de
cleanup y distinguiendo errores/omisiones de una validación exitosa. T12 agrega procedencia del
modelo/effort al diagnóstico JSON y reutiliza el resolver existente de Codex sin cambiar defaults;
`effectiveObserved` no afirma una observación del host. La revisión combinada T6/T12 fue **APPROVED**
y el gate completo pasó (300 archivos de tests, 5,498 aprobados, 1 omitido). Los commits locales son
`75f1130b` (T6) y `0eec446e` (T12). El avance de la spec es parcial; no se afirma cierre ni
publicación del PR.
