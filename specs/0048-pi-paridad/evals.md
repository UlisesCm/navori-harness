# Evals — 0048-pi-paridad (M12, T19)

**Propósito (R17).** Verificar con un modelo en vivo un ciclo Pi-only completo —instalación, plan aprobado,
implementación, documentación, revisión, commit con gate, PR confirmado y cierre con evidencia— y registrar el
resultado RED/GREEN del contexto always-on.

Solo se registran resultados ejecutados. Lo no ejecutado queda vacío hasta que el usuario lo ejecute.
Solo el smoke en vivo prueba el renderizado del diálogo TUI y el cumplimiento del modelo; el e2e sin
credenciales no lo prueba.

Guion del smoke: [docs/pi.md](../../docs/pi.md#manual-smoke).

## Tabla 1 — RED/GREEN

| Escenario | Contexto (RED sin Navori / GREEN con Navori) | Mismo proyecto/tarea/modelo | Resultado | Resultados adversos conservados | Notas |
| --- | --- | --- | --- | --- | --- |
| Arranque | | | | | |
| Planificación | | | | | |
| Cierre | | | | | |

## Tabla 2 — Ciclo en vivo

| Paso | Estado | Evidencia |
| --- | --- | --- |
| `pi --version` ≥ 1.1.0 | | |
| Pi `/login` (`openai-codex`) | | |
| `/model` | | |
| `navori render --apply` | | |
| Plan aprobado (`navori plan update <feature> --decision approved`) | | |
| Implementación (`implementer` vía `navori_subagent`) | | |
| Documentación (`scribe`) | | |
| Revisión (`reviewer`) | | |
| Commit y push por el gate | | |
| PR confirmado en el diálogo TUI (cuerpo mostrado) | | |
| Cierre (`navori plan update <feature> --progress A<n>=cumplido`) | | |
