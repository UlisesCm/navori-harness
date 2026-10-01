# Current — Spec 0039 Claude first (18/44 mergeadas o en PR normal)

- Abiertos: #1138 (T8, PR normal), #1139 (T18–T20, **draft**: no mergear hasta T21) y T36 (#1148, maxTurns 160 en Claude implementer).
- Siguiente paso: F3 lote 2 (T21 hook de evidencia con `fingerprintTree`, T22 prosa) en la rama de
  #1139; luego T9 (instantánea base con `navori audit --snapshot`).
- Bloqueado: T2 (sondas live) espera autorización explícita del usuario; de T2 dependen T23, T24, T37
  y la corrección de R36 (`Agent(a, b)` se ignora dentro de un subagente) y R42 (`async_launched`).
- Pendiente sin abrir: T40, T42, F5a, F5b, F6, F7, T25–T27, cierre T44.

## Pi — setup del repo listo para publicación

- PR #1146 mergeado. El setup del repo está en `fix/pi-render-bun`;
  workplan `.navori/state/handoffs/workplan_pi_render_bun.json`.
- Pi habilitado y recursos `.pi/` generados con el CLI compilado; corregidas la validación bajo
  Bun y la serialización del chequeo de versiones ante minificación.
- `bun check` verde: 339 archivos de pruebas, 6572 aprobadas y 1 omitida. Regresión del SDK real
  confirma registro de `navori_subagent` desde el render del CLI compilado.
- Revisión: reviewer independiente, APPROVED sin CRÍTICO/ALTO.
- Siguiente paso: publicar el PR contra `main` y revisar CI. Smoke manual OAuth: `docs/pi.md`;
  no se probó la cuenta ni se tocaron credenciales o configuración global.
- El contexto independiente de Spec 0039 arriba se conserva; no se avanza ni se cierra aquí.
