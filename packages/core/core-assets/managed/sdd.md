## Spec Driven Development (SDD)

Para trabajo de alcance real —una feature nueva completa, cambios en auth/seguridad/permisos, adapters o modelos con datos sensibles, o scope > ~2 días— el trabajo arranca de un spec, no de código. Bugfixes de UI, un campo nuevo en un form existente, refactors aislados o ajustes de copy NO usan SDD: se trabajan directo.

**Estructura:** `{{sdd.specsDir}}/<feature>/{requirements.md, design.md, tasks.md}`.
- `requirements.md` — qué debe hacer, en formato EARS (ver abajo), cada requisito con id `R<n>`.
- `design.md` — cómo: arquitectura, componentes afectados, decisiones y trade-offs.
- `tasks.md` — ejecución en lotes chicos (1-3 tasks); cada task declara los `R<n>` que cubre.

**EARS (Easy Approach to Requirements Syntax)** — siempre `DEBE`/`NO DEBE`, una acción por requisito, id `R<n>`:
- Ubicuo: `El sistema DEBE <X>.`
- Evento: `CUANDO <Y>, el sistema DEBE <X>.`
- Estado: `MIENTRAS <Y>, el sistema DEBE <X>.`
- Opcional: `DONDE <Y>, el sistema DEBE <X>.`
- No deseado: `SI <Y> ENTONCES el sistema DEBE <X>.`

**Trazabilidad obligatoria (`R<n>` ↔ test):** cada `R<n>` se cubre con ≥1 test, y cada test SDD referencia sus requisitos con un comentario `// Covers: R<n>, R<m>` arriba del caso. Sin trazabilidad completa la feature no está done. Habilita verificación inversa (test → requisito) al refactorizar.

**El tracking vive en el spec, no en el harness:** cuando existe `tasks.md`, ese es el tablero. NO uses `TaskCreate` para esas tasks — duplicar el seguimiento en la TaskList produce drift entre el spec y las tasks. Ignorar el reminder de `TaskCreate` en sesiones SDD es lo esperado.

**Flujo con agentes:** el `leader` descompone `tasks.md` en lotes; el `implementer` ejecuta un lote y escribe los tests trazables a `R<n>`; el `reviewer` aprueba/rechaza verificando la trazabilidad `R<n>↔test` como gate, no como sugerencia. Cada agente escribe su resultado a disco y devuelve solo la referencia (regla anti-teléfono-descompuesto).
