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

## Escenario D — overplanning (2026-08-18) · **PASS**

**Setup:** "cambia el texto del botón Save por Guardar", con el bloque de ruteo y
la skill disponibles.

**Observado:** ruteó a **R1 inline** y respondió **No** al artefacto, enumerando
las nueve señales como ausentes y citando la cláusula de exclusión de la propia
skill (*"NOT for a change following an exact existing pattern with local blast
radius and trivial rollback"*). Plan: localizar el string, editar, gate rápido,
commit atómico — sin `implementer` ni `reviewer`.

**Costo: 2 tool uses, 12 segundos.** Es el dato que importa: la capa no se activa
sola ni cobra peaje en lo trivial. Compárese con los 70 tool uses del Escenario A,
donde sí había decisión que tomar.

## Escenarios E y F (2026-08-18) — resultados invertidos

**Ambos escenarios midieron algo distinto de lo que pretendían.** Se registra tal
cual: un eval que se re-interpreta para que dé el resultado buscado no vale nada.

### E — "concern menor no bloquea" → salió **BLOCKED**

**Setup:** ticket real de backlog — *"doctor debería avisar cuando un repo lleva
mucho tiempo sin re-renderizar; guardar la fecha del último render y avisar a los
60 días"*. La intención era sembrar una decisión clara con un edge case menor.

**Observado:** `BLOCKED`, y correctamente argumentado. Descubrió que la mitad del
problema **ya tiene señal exacta y en vivo** (`scanManagedDrift` compara la versión
del marcador contra la del CLI, `health.ts:354-379`), y que el remedio propuesto es
un proxy débil que además no cierra el gap de descubribilidad que el ticket
describe. Identificó un fork de producto real: A (fecha literal por repo) · B
(`doctor --all`, reusando el patrón probado de `render --all`) · C (B ahora, A
después) — y B **no cubre** "nadie tocó este repo aunque esté en 0 drift", que es
otra lectura legítima del título.

Los cuatro campos de BLOCKED están, y se auto-chequea contra el perfeccionismo:
*"This isn't manufactured caution on a MEDIO ticket: it's a real fork that static
code reading can't resolve on its own."*

**Veredicto del eval: el escenario estaba mal diseñado, no la capa.** El ticket
nombraba un *mecanismo* ("guardar la fecha") en vez de un *comportamiento*, que es
justo la ambigüedad que la capa debe detectar. Lo que sí quedó probado: `BLOCKED`
se emite con carga de la prueba completa.

**Hallazgo colateral verificado → [issue #340](https://github.com/UlisesCm/navori-harness/issues/340):**
`render --all` aborta el batch entero ante un config corrupto, porque
`readConfigOrExit` hace `process.exit(1)` dentro de un `try/catch` que no puede
atraparlo. Afecta el rollout a los 21 repos del registry.

### F — "blocker real" → salió **READY**

**Setup:** ticket real — *"un repo debería poder pertenecer a varios workspaces;
cambiar `workspace` a una lista"*. La intención era forzar un fork arquitectónico
(precedencia al mergear defaults de N workspaces).

**Observado:** `READY`, porque "What already exists" encontró que la
multi-pertenencia **ya existe** en la capa de registry (`dominio.ts:274-294`,
`resolveWorkspacesForCwd`, con el comentario explícito *"a repo can belong to more
than one workspace"*). No había fork arquitectónico que resolver: solo faltaba
pluralizar el campo del config y propagarlo a 5 consumidores.

El fork que yo esperaba (precedencia de merge) **no se barrió**: lo nombró *"the
actual design decision the ticket glosses over"*, lo especificó como algoritmo
explícito (escalares first-wins, `engines` unión, plugins first-wins por id) y lo
declaró decisión de producto visible — *"list your workspaces in priority order"*,
documentada en el schema y el help. Es la tercera vía de la regla de ambigüedad:
asunción conservadora **registrada**, no una pregunta innecesaria al usuario.

**El challenge encontró dos BLOCKER en el propio artefacto**: la especificación de
precedencia era autocontradictoria (el orden de spread quedaba invertido respecto
a la regla enunciada) y la lógica de `workspace link` no se había rediseñado para
una lista. Ambos corregidos con evidencia, ninguno escalado al usuario — porque
eran defectos del diseño, no decisiones de producto. Esa distinción es exactamente
la que evita el loop de BMAD #2079.

**Veredicto del eval: el escenario no era bifurcado**, porque el repo ya tenía la
mitad de la respuesta. Lo que sí quedó probado: `what already exists` cambia el
veredicto cuando la evidencia lo justifica, en lugar de fabricar arquitectura.

---

## Cobertura de veredictos

Aunque los escenarios no midieron lo planeado, los tres veredictos quedaron
ejercitados sobre casos reales:

| Veredicto | Dónde | Señal |
|---|---|---|
| `CONCERNS` | Escenario A (BTBS-162) | riesgos registrados, implementación arranca |
| `BLOCKED` | Escenario E | fork de producto, 4 campos, auto-chequeo anti-perfeccionismo |
| `READY` | Escenario F | la evidencia disolvió el fork esperado |
| *(sin artefacto)* | Escenario D | trivial → R1 inline, 2 tool uses |

**Costo observado:** A 158k tokens · E 176k · F 148k · D 47k. Las tres pasadas de
diseño rondan 150-175k; la trivial, 47k con 2 tool uses. El gradiente es el
esperado — se paga donde hay una decisión que tomar.
