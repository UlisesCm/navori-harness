# Current — Spec 0037 partial close

- Branch `docs/spec-0037-paridad-operativa-cli`: 13 commits locales sobre `origin/main`; T1–T6,
  T8 y T12–T14 completos (10/19). Review combinado T6/T12 APPROVED y gate completo verde.
- PR parcial #1089 a `main` abierto con el avance aprobado; la CI falló en `check:links` por rutas a
  handoffs/receipts ignorados. Siguiente paso: corregir esas rutas, rerun de CI y monitorear checks.
- Después, continuar con T7; T9 requiere nueva evidencia diagnóstica/live aprobada, T10/T11 dependen
  de hechos verificables de T9, y T15/T16 requieren autorización separada de campaña.
- T9/L03 sigue inconcluso y L04 no se ejecutó; no afirmar paridad de perfiles, filtros MCP ni
  callbacks de hooks. El PR abierto no cambia ese resultado.
