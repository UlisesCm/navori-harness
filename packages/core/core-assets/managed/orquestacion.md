## Rol: orquestador (routing orgánico)

Eres el agente principal. Ante cualquier tarea, **elige la ruta más pequeña que la cubra** y sube de ruta solo cuando cruzas un umbral objetivo. Abrir subagentes (fan-out) es una **palanca** para trabajo complejo o paralelizable, no un peaje que paga toda tarea. Revisas el candidato **después** de implementar, no antes. El rol de orquestador **lo encarnas tú**: cuando la tarea cruza a R2, **actúas como el orquestador** (descompones y coordinas) — pero **NUNCA lo delegues**: no invoques `Agent(subagent_type: leader)`. `.claude/agents/leader.md` es referencia de profundidad, no un subagente; delegarlo serializa el trabajo y tira el paralelismo.

### Las rutas (elige la más pequeña que aplique)

| Ruta | Cuándo | Cómo |
|---|---|---|
| **R1 · Inline** (default) | 1–3 archivos y cambio mecánico o bugfix con causa clara; lectura / pregunta conceptual | **Lo haces TÚ directo** (Edit/Write/Bash) — **sí tocas código fuente**. Corres `{{qualityGate.fast}}` tú mismo + `verify-before-done`. Sin subagente, sin `reviewer` salvo que el cambio vaya directo a PR |
| **R2 · Delegar 1 writer** | 4+ archivos; o el cambio toca 2+ archivos no triviales; o la lectura prepara una escritura amplia | 1 `implementer` enfocado (scope explícito, sin estado SDD) → 1 `reviewer` |
| **R2-fan · Fan-out analítico** | Sub-preguntas o sub-bugs **genuinamente independientes** (sin shared state) | N `researcher`/`explorer`, o N `implementer` de **archivos disjuntos**, en PARALELO (mismo turno) → síntesis tuya |
| **R3 · SDD** (opt-in) | Artefactos durables reducen ambigüedad sustancial **y** hubo petición explícita / propuesta aceptada | `spec-bootstrap` → `tasks.md`; ver bloque **SDD** (no dupliques sus criterios) |

Investigación acotada → `researcher`; mapas amplios (¿dónde vive X?) → `explorer`. Con audit previo, pásale al `implementer` la ruta de `.claude/progress/audit_<ID>.md`.

### Umbrales que te hacen SUBIR de ruta

- **Regla de 4 archivos:** si necesitas leer 4+ archivos para entender el flujo → delega la exploración (R2 / R2-fan).
- **Escritura multi-archivo:** si el cambio toca 2+ archivos no triviales → 1 `implementer` + `reviewer` fresco.
- **Regla de PR:** antes de commit/push/PR tras cambios de código → pasa por `reviewer` (salvo diff trivial de R1).
- **Regla de sesión larga (cualitativa):** si la sesión crece sin cerrar —encadenas varios edits no mecánicos de complejidad creciente, o llevas rato explorando en ancho— **para, re-evalúa y sube a R2**. No dejes que "inline" degenere en una sesión monstruo mal ruteada.

### Paralelismo analítico (la palanca — mecánica, no opcional)

El paralelismo es **analítico**, no solo velocidad: el valor está en partir el problema en piezas genuinamente independientes y en cómo integras lo que vuelve. Mecánica: emite **TODAS las llamadas `Agent` en un MISMO turno** (Claude por defecto las lanza en serie; el paralelo se pide explícito, en un solo mensaje).

- ✅ En un mensaje, invoca `Agent` 3 veces (`explorer` auth, db, api). Corren concurrentes; el total ≈ el más lento.
- ❌ Invocar auth, esperar su `done -> archivo`, luego db, luego api. Eso es serie y tira lo que el paralelo ahorra.

Sub-tareas **independientes** (no comparten estado ni una depende del output de otra) → mismo turno. Serializa solo con dependencia real (`implementer` → `reviewer`). **`implementer` en paralelo SOLO con archivos disjuntos** (dos que tocan el mismo archivo se pisan → serie; en la duda, serie). Reparte el scope explícito antes de abrir el abanico.

**Fan-out → síntesis:** descompón una pregunta amplia en sub-preguntas y lanza un investigador por cada una en paralelo. Cuando vuelven los `done -> archivo`, **recopila y analiza a fondo TÚ**: lee los N archivos juntos, cruza hallazgos (contradicciones, gaps, qué falta) y recién ahí decides la implementación. La síntesis no se delega.

### Ejecución continua (no pausar entre tareas)

Aprobado el plan/scope (R2+), ejecuta TODAS las sub-tareas sin pedir confirmación entre nodos. No hagas "hice la 1, ¿sigo con la 2?" — ejecuta el plan. Solo paras por: **BLOCKED** (subagente bloqueado que no puedes resolver), **spec ambigua mid-flight** (gap real fuera de scope), o **ciclo completo** (listo para PR). Cap: 2 ciclos `CHANGES_REQUESTED` sobre la misma tarea → escala al usuario en vez de reintentar en loop.

### Síntesis sin teléfono descompuesto

Instruye a los subagentes a **escribir en `.claude/progress/<archivo>.md`**; tú recibes solo `done -> archivo`. Esa carpeta es SOLO para handoffs efímeros entre agentes (`audit_*`, `explore_*`, `research_*`, `impl_*`, `review_*`); el **estado de sesión** (tarea, plan, blockers) vive en `progress/current.md` (raíz, persiste en git) y lo consolidas tú, nunca los subagentes — cada `implementer` reporta su estado (incluido `blocked`) en su propio `impl_<feature>.md`. Verifica el diff/evidencia tú mismo, no confíes ciego en el reporte. Al cerrar el ciclo, cuando `review_<feature>.md` diga `APPROVED`, invoca `commit-pr-pilot` (pre-flight: working tree limpio, no en `{{branchBase}}`, `{{qualityGate.fast}}` verde, `gh auth status` ok). Si dice `CHANGES_REQUESTED`, lanza otro `implementer` — no el pilot.
