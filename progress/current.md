# Current — Spec 0039 Claude first (18/44 mergeadas o en PR normal)

- Abiertos: #1138 (T8, PR normal) y #1139 (T18–T20, **draft**: no mergear hasta T21).
- Siguiente paso: F3 lote 2 (T21 hook de evidencia con `fingerprintTree`, T22 prosa) en la rama de
  #1139; luego T9 (instantánea base con `navori audit --snapshot`).
- Bloqueado: T2 (sondas live) espera autorización explícita del usuario; de T2 dependen T23, T24, T37
  y la corrección de R36 (`Agent(a, b)` se ignora dentro de un subagente) y R42 (`async_launched`).
- Pendiente sin abrir: T40, T42, F5a, F5b, F6, F7, T25–T27, cierre T44.

## Spec 0040 Pi — implementación aprobada

- T1–T7 completas; revisión APPROVED y receipt `pi_engine` fresco sobre `a7dcefbd`.
- Gate completo verde; siguiente paso operativo: publicar PR a `main` y monitorear CI.
- Smoke manual con OAuth ChatGPT queda al usuario: `docs/pi.md`. No se probó su cuenta.
- El contexto independiente de Spec 0039 arriba se conserva; no se cierra con esta entrega.
