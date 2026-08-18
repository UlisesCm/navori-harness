# Spec 0012 — Evals de presión (RED / GREEN)

Método: superpowers `writing-skills` — *"NO SKILL WITHOUT A FAILING TEST FIRST"*.
Se observa el comportamiento SIN la capa (RED), se escribe la skill contra los
fallos observados, y se re-corre el mismo escenario CON la capa (GREEN).

---

## Escenario A — false architecture need · BTBS-162

**Setup:** agente de desarrollo, repo bonum-webapp (React + TS, store propio y
`useFetchAndLoad` como capa de fetching), ticket BTBS-162 *"[ALTO] Introducir
React Query (caché + deduplicación) para lecturas clave"*, que trae hallazgos
correctos y una "Mejora propuesta" ya decidida.

### RED — baseline sin la capa (2026-08-18)

Artefacto completo: `.claude/progress/eval_baseline_A.md` (sonnet, 48 tool uses).

**Lo que hizo bien** (importa registrarlo: el fallo no es incompetencia técnica):
- Verificó los números del ticket y corrigió uno: el "4→1" son round-trips, no
  invocaciones — fusionar los 2 endpoints sería cambio de backend.
- Detectó que la pieza que el ticket nombra no encaja: la función se invoca
  imperativamente desde 13 sitios y varios usan su valor de retorno, así que el
  hook declarativo no aplica; propuso la variante imperativa de la misma librería.
- Encontró **código muerto** con evidencia dura (comparó contra el `dist/` ya
  compilado): uno de los ítems del ticket apunta a un archivo que el bundler nunca
  incluye.
- Encontró que el hallazgo "2 llamadas simultáneas" no es lo que el ticket dice
  (son dos instancias hermanas montadas por el sistema de pestañas), y que la lista
  de cambios propuestos **no lo resuelve**.
- Riesgos reales no pedidos: invalidación tras mutación, el estado de carga deja
  de ser fuente de verdad, ausencia de tests.

**Los tres fallos (esto es el RED):**

| # | Fallo observado | Evidencia en el baseline |
|---|---|---|
| **F1** | **Nunca cuestionó la premisa.** El paso 0 del plan es instalar la librería que el ticket nombra. La alternativa "resolver el dedupe en la capa que ya existe, sin dependencia nueva" nunca se formuló ni se descartó. | §0.1 "pnpm add @tanstack/react-query" como primer paso; el patrón existente aparece solo como *"compatible como queryFn"* — el rol que el ticket ya le asignaba |
| **F2** | **Costos documentados, nunca puestos en balanza.** Enumeró tres costos reales de la propuesta y los aceptó como peaje en vez de usarlos como argumento comparativo. | Riesgo 5 (el estado de carga deja de ser fuente de verdad), riesgo 3 (invalidación sin resolver), §0.4 (el AbortController de los servicios no se conecta al signal de la librería) |
| **F3** | **Hallazgos que refutan el alcance archivados como notas.** Dos descubrimientos cambiaban qué debe hacerse y terminaron en "preguntas abiertas", no en un veredicto de alcance. | Código muerto → "condicionado a lo que se decida"; hallazgo no cubierto → "queda sin resolver, lo dejo como pregunta abierta"; un ítem toca 8 sitios y no 3, sin revisar el tamaño declarado |

**Diagnóstico:** el agente optimizó *cómo implementar bien lo que el ticket pide*.
Nadie le pidió decidir *qué hay que construir*. Sin esa pregunta, un ticket con
diagnóstico correcto y solución equivocada produce una implementación impecable
de la solución equivocada — y el trabajo bien hecho lo disimula.

### GREEN — con la capa (2026-08-18) · **PASS**

Misma variable aislada: mismo ticket, mismo repo, mismo modelo (sonnet). Lo único
que cambia es que este agente leyó `solution-design`.
Artefactos: `.claude/progress/solution_BTBS-162.md` (415 líneas) +
`solution_review_BTBS-162.md` (challenge, 132 líneas).

**Veredicto emitido:** `CONCERNS` — correcto: hubo hallazgos serios y aun así la
implementación puede arrancar. No degeneró en BLOCKED (el modo de fallo BMAD).

| Fallo RED | ¿Superado? | Evidencia en el GREEN |
|---|---|---|
| **F1** premisa no cuestionada | **Sí** | "What already exists" descubrió que **`@reduxjs/toolkit@^1.8.1` ya está instalado y ships RTK Query** — *"a caching layer is available with zero new dependency, already wired to the existing store"*. El baseline nunca lo mencionó: su paso 0 era instalar otra librería. Además encontró un **ADR previo en el repo** (`useSessionHydration.ts:29-31`: *"no new thunk, no RTK Query"*) — una decisión del equipo sobre este mismo tema que el ticket ignora |
| **F2** costos sin balanza | **Sí** | Formuló el approach A (caché a mano, cero dependencia) y lo descartó con argumento — "reinventa invalidación/staleTime/retry por cada uno de los 4 endpoints… no escala sin repetir el patrón 4 veces". Y rechazó la forma literal del ticket porque migrar los ~11 lectores del store sería "una migración de ownership no pedida" |
| **F3** hallazgos como notas | **Sí** | Los hallazgos **cambiaron el alcance**: se cae `getMyCoacheesById` (dead code confirmado) y **entra** un puente para `refreshUser()`, que es lo que de verdad arregla el síntoma que el ticket cita. En el baseline ambos eran "preguntas abiertas" |

**El challenge hizo trabajo real, no trámite.** El researcher en contexto fresco
encontró un BLOCKER: el diseñador había invertido cuál de dos archivos homónimos
compila el bundler. Lo verificó leyendo `DEFAULT_EXTENSIONS` del Vite instalado y
grepeando el `dist/` real, y el diseño se corrigió antes de existir una línea de
código. Aplicó además otros 3 concerns (inventario de lectores subcontado 6→11;
un failure mode escrito para 1 call site cuando había 6; una lectura movida de
hook idiomático a puente por compartir contexto).

**Decisión de fondo resultante:** patrón puente/fachada — la caché va *por dentro*
de la capa que ya existe, preservando firma y el `dispatch` al store, con cero
cambios en 13 call sites y ~11 consumidores. Exactamente
`existing pattern > small extension > new abstraction`.

**Costo:** 158k tokens (GREEN) vs 104k (RED) — **+52%** para una tarea catalogada
`[ALTO]` que toca 25+ call sites en 15+ archivos. El sobrecosto se paga una vez en
diseño y evita reescribir una migración de ownership no pedida.

---

## Escenario D — overplanning

**Setup:** "cambia el texto del botón Save por Guardar".
- [ ] **Esperado:** R1 inline, cero artefacto de solutioning. **FAIL** si genera
  `solution_*.md` o abre la skill.

## Escenario E — perfeccionismo del reviewer

**Setup:** diseño válido con un concern menor sembrado (un edge case opcional
sin cubrir).
- [ ] **Esperado:** veredicto `CONCERNS`, registrado, y la implementación arranca.
  **FAIL** si emite `BLOCKED` (es el modo de fallo de BMAD #2079).

## Escenario F — blocker real

**Setup:** ticket con dos interpretaciones que llevan a arquitecturas
incompatibles (¿el estado se comparte entre dos apps o se duplica?).
- [ ] **Esperado:** `BLOCKED` con los cuatro campos (hecho bloqueante · por qué no
  se puede proceder · dueño · información mínima) y pregunta dirigida al usuario.
  **FAIL** si adivina e implementa.
