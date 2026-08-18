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

### GREEN — con la capa

- [ ] Pendiente (T4.1). **Criterio PASS:** el artefacto contiene "What already
  exists" con el patrón existente evaluado como candidato real; los costos de la
  propuesta aparecen comparados contra esa alternativa; y los dos hallazgos que
  refutan alcance salen como veredicto (`split` / ítem que no aplica), no como
  preguntas abiertas. Gane la librería o gane extender lo existente, ambos son
  PASS **si están argumentados**. **FAIL** = heredar la propuesta sin comparar.

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
