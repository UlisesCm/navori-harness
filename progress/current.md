# Sesión actual

Doctrina de slices verticales en navori (4 PRs, uno a la vez; el usuario revisa diff y resumen antes de cada siguiente). PR 1 abierto: #1483 (`feat/spec-una-pagina` → dev, HEAD 825c8b270), spec.md de una página + `navori spec check`.

## Siguiente paso

PR 2 desde dev tras el merge de #1483: bloque SDD gestionado (`core-assets/managed/sdd.md`) en ≤8 líneas, sin EARS, trazabilidad ni cadena obligatoria orchestrator→implementer→reviewer, y fila 3 de `managed/planificacion.md` (hoy cita `tasks.md` y `spec: <spec> E<n> M<n>`; una spec.md se despacha con `workplan: <feature>` nivel 3). Proponerlo antes de codear.

Después: PR 3 (master-plan: partes de una sola capa fallan, A1 manual en qa + A2 E2E obligatorios, D<n> provisionales, quitar "cero supuestos"; `master/check-part.ts` debe leer spec.md y dejar de exigir Libraries con versión, Pattern e Interfaces; skill por debajo de 2,752 palabras), PR 4 (agentes implementer/reviewer/publisher y presets que citan tasks.md/Covers), validación con `navori render --apply` sobre jey en una rama y tabla antes/después de palabras. Issue #1482 (gate falla rápido con node_modules desalineado) va justo después.

Pendiente de otra sesión: #1361/T9 (rama fix/1361-pi-event-correlation) espera abrir su PR con `.navori/state/1361-events-open-pr.sh`; T10, T11, A5, M6–M7 siguen abiertos.
