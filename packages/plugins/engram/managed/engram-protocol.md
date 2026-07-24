## Engram

- `mem_save` proactivo tras decisión / bug-fix-con-root-cause / convención / discovery / preferencia confirmada.
- `mem_search` al inicio si el primer mensaje referencia el proyecto. Verificar en código que lo recordado siga existiendo antes de afirmarlo.
- Lo recordado es una foto de cuando se guardó, no un hecho vigente. Si el sistema expone vigencia (`active` / `needs_review`), trata `needs_review` como contexto stale: avisa al usuario y verifícalo contra el código actual antes de apoyarte en eso.
- `mem_session_summary` obligatorio antes de "listo": Goal · Discoveries · Accomplished · Next Steps · Relevant Files.
