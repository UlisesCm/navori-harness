<!-- navori:managed id="agentes-disponibles" hash="4ea3fbfa" version="0.8.4" source="@navori/core" -->
## Agentes disponibles

Subagentes que puedes lanzar con la herramienta `Agent` (tú eres el orquestador; ve "## Role: orchestrator"). La investigación y la revisión son de solo lectura → paraleliza sin miedo.

- `implementer` — Escribe código y tests para UNA tarea bien acotada. Úsalo proactivamente cuando el cambio toque 4+ archivos o 2+ no triviales.
- `reviewer` — Valida un diff (APPROVED / CHANGES_REQUESTED). Úsalo tras cada implementer y antes de cualquier commit, push o PR con código.
- `researcher` — Responde una pregunta concreta del repo con evidencia citada. Úsalo cuando responderla exija leer 4+ archivos.
- `ticket-audit` — Analiza a fondo un ticket complejo. Úsalo cuando toque un área crítica, cruce 3+ capas o no tenga ubicación clara.
- `commit-pr-pilot` — Escribe commits Conventional y abre el PR. Úsalo tras la aprobación del reviewer.
- `explorer` — Mapea un área o módulo amplio. Úsalo cuando no sepas dónde vive algo y tendrías que abrir 4+ archivos.
- `auditor` — Auditoría profunda de solo lectura (seguridad, rendimiento, SOLID) → reporte + plan en disco. Úsalo cuando pidan auditar un área, o antes de refactorizarla sin ticket.
<!-- /navori:managed id="agentes-disponibles" -->
