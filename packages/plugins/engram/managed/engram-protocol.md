## Engram

- **Arranque de sesión (primer paso, obligatorio):** llama `mem_context` al inicio de CADA sesión para recuperar decisiones y trabajo previo — no esperes a que el usuario lo pida. En hosts que NO cargan la memoria con hook de arranque (p.ej. Codex), esta llamada explícita ES el arranque de la memoria; no la omitas.
- **Pre-flight:** `mem_search` con keywords de la tarea antes de buscar código — da una región e hipótesis; confirma firma, línea y call sites con Grep/structural-search antes de actuar.
- **Guarda solo lo durable:** decisiones, arquitectura, convenciones, root causes y punteros de módulo. Nunca persistir líneas, firmas actuales, listas de call sites ni estado temporal.
- `mem_save` proactivo con `topic_key` estable por tema. Reutiliza el mismo key para evolucionar una observación vía upsert, no crear snapshots repetidos.
- **Write-back:** si el código contradice una memoria, corrígela con `mem_update`/`mem_save` de inmediato. Trata `needs_review` como contexto stale.
- `mem_session_summary` obligatorio antes de "listo": Goal · Discoveries · Accomplished · Next Steps · Relevant Files.
- **Curación al cerrar:** tras el summary, revisa lo creado en la sesión. Consolida duplicados bajo su `topic_key`, asciende lo durable y elimina solo observaciones volátiles o ya cubiertas por el summary. Nunca borrado agresivo ni borrar una decisión durable.
