## Spec Driven Development (SDD)

Arranca de un spec (no de código) para alcance real: feature nueva completa, cambios en auth/seguridad/permisos, adapters o modelos con datos sensibles, o scope > ~2 días. Bugfixes de UI, un campo nuevo en un form, refactors aislados o ajustes de copy van directo.

**Estructura:** `{{sdd.specsDir}}/<feature>/{requirements.md, design.md, tasks.md}` — requisitos EARS con id `R<n>`, diseño con decisiones y trade-offs, y tasks en lotes de 1-3 que declaran los `R<n>` que cubren. Cada `R<n>` se cubre con ≥1 test que lo referencia (`// Covers: R<n>`); sin trazabilidad completa la feature no está done.

**Tracking en el spec, no en el harness:** con `tasks.md`, ese es el tablero — NO uses `TaskCreate` para esas tasks (duplicarlo produce drift entre el spec y la TaskList); ignorar su reminder en sesiones SDD es lo esperado.

Scaffolding del spec —plantillas EARS, reglas de trazabilidad `R<n>↔test` y flujo con agentes (`leader`→`implementer`→`reviewer`)— con la skill `spec-bootstrap`.
