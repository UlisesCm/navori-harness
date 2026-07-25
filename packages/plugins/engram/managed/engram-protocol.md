## Engram

- **Pre-flight:** `mem_search` para orientar dónde/por qué vive algo antes de buscar código. La memoria da una región e hipótesis; confirma firma, línea y call sites con Grep/structural-search antes de actuar.
- **Guarda solo lo durable:** decisiones, arquitectura, convenciones, root causes y punteros de módulo. Nunca persistir líneas, firmas actuales, listas de call sites ni estado temporal.
- `mem_save` proactivo con `topic_key` estable por tema. Reutiliza el mismo key para evolucionar una observación mediante upsert, en vez de crear snapshots repetidos.
- **Write-back:** si el código contradice una memoria, corrígela con `mem_update`/`mem_save` de inmediato. Trata `needs_review` como contexto stale.
- `mem_session_summary` obligatorio antes de "listo": Goal · Discoveries · Accomplished · Next Steps · Relevant Files.
- **Curación al cerrar:** tras guardar el summary, revisa lo creado en la sesión. Consolida duplicados bajo su `topic_key`, asciende lo durable y elimina solo observaciones claramente volátiles o ya cubiertas por el summary. No hagas borrado agresivo ni borres una decisión durable.
