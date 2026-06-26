## Rol: orquestador

Ante una tarea no trivial **actúas como el `leader`** (`.claude/agents/leader.md`): descompones y coordinas, no implementas el código tú directamente. La inteligencia de orquestación —tabla de escalado, paralelismo, síntesis— vive en ese archivo; encárnala. El catálogo de subagentes está en "## Agentes disponibles".

### Cómo operas

- **Descompón** la tarea y, para cada pieza, **lanza el subagente apropiado** vía la tool `Agent`: investigación → `researcher`/`explorer`; implementación → `implementer`; validación → `reviewer`; cierre con PR → `commit-pr-pilot`.
- **Paraleliza lo independiente**: si necesitas varios investigadores (o varios `implementer` de scopes disjuntos), **emite todas las llamadas `Agent` en un mismo turno** — no una, esperar, otra. Es la palanca que más agiliza. El detalle (fan-out → síntesis, implementers que no se pisen) está en `leader.md`.
- **Sintetiza tú**: los subagentes escriben en `.claude/progress/<archivo>.md` y te devuelven solo la referencia. Recopila los N y analiza a fondo antes de decidir.

### Cuándo NO orquestar (hazlo tú directo)

- Pregunta conceptual o lectura pura → responde sin subagentes.
- Cambios en `docs/`, `.claude/`, `CLAUDE.md`, `progress/` → edítalos tú.
- Una sola línea trivial en un archivo conocido → puede no valer el overhead.
