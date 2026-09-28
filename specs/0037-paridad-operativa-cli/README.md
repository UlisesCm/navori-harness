# Spec 0037 — Paridad operativa Claude / Codex CLI

**Estado: spec completa; T1–T2 aprobados y completos, 17 tareas pendientes.** Fecha: 2026-09-28.

## Contenido

- [Requisitos](requirements.md): **23 requisitos EARS**, incluyendo lo que ya funciona y debe preservarse.
- [Diseño](design.md): extensión de piezas existentes, decisiones, contratos, seguridad y migración.
- [Tareas](tasks.md): **19 tareas en 8 lotes**; T1–T2 completas y 17 pendientes, con dependencias y trazabilidad R→T→V.
- [Validación](validation.md): **23 pruebas/casos y 9 escenarios live**, especificados, no ejecutados.
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
heredados. Plan-gate Codex sigue advisory; #1082/#1084 son antecedentes integrados, no trabajo para
repetir. Los errores de scanner conservan la política deliberada de Claude, sin contarlos como scans
aprobados. No hay nueva capa always-on, modelo impuesto ni orchestrator spawnable.

## Autorización y límites

La autorización histórica para redactar la spec incluyó una excepción puntual del preflight circular
de handoff para **architect/auditor durante esa redacción**. No cambió la regla vigente ni fabricó
un handoff; la corrección permanente está planificada en T4/R15, no implementada. Después, el usuario
autorizó iniciar el Lote A (T1–T2) tras sincronizar `main`. T1 y T2 fueron aprobados en revisión
fresca; esta autorización no se extiende a otros lotes.

T1 registró el baseline y T2 implementó diagnóstico read-only de doctor. No se autorizan aquí campañas
live/pagadas, instalaciones, cambios de trust, push ni PR; campañas live requieren autorización
separada de consumo y aislamiento. No se presentan como equivalencia demostrada resultados pendientes.

## Verificación T1/T2 y estado histórico del gate

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
- La revisión fresca combinada de T1/T2 fue **APPROVED** (`SPEC_OK`, `QUALITY_OK`); el gate completo
  pasó y el receipt reportó `status: ok`, `fresh: true`, sin `uncovered` ni `drift` para el publish
  set revisado. Estas actualizaciones administrativas cambian README/tasks, por lo que ese receipt
  anterior ya no es fresco para el contenido posterior; renovar revisión y firma antes de
  publicar/cerrar. El receipt de contenido no certifica paridad runtime ni trust efectivo.
- Solo como antecedente, el intento de redacción de la spec del 2026-09-28 reportó varios checks
  documentales verdes, `semgrep:check` detenido por `ca-certs: empty trust anchors` y receipt no
  disponible tras un fetch fallido por DNS. Ese gate parcial y ese fallo no describen el checkout
  ni las verificaciones de T1; no se desactivó TLS para forzarlo.

El baseline de T1 está documentado en [baseline.md](baseline.md) sobre HEAD `13106729`, que incluye
#1084. Véanse la [revisión fresca de T1](../../.codex/progress/review_spec0037_t1.md) y el receipt
`.codex/progress/receipt.txt`; las campañas live y las tareas posteriores siguen pendientes.
No se movió ni sobrescribió el checkpoint de Spec0036 perteneciente a otra sesión.
