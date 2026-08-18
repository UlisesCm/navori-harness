# Spec 0012 — Capa de Solutioning · Plan de implementación

> **Estado:** plan aprobado en diseño, pendiente de ejecutar.
> **Fecha:** 2026-08-18 · **Branch de trabajo:** `feat/0012-solutioning-plan` (base `main`)
> **Prerequisito ya cumplido:** PR #332 (fase 0: veredicto de ticket en `ticket-audit` +
> bloque `intake-tickets`) está mergeado en `main` (`2417d78`).

Este documento es un runbook: cualquier agente puede ejecutarlo fase por fase sin
contexto previo. Cada tarea declara OBJETIVO, PASOS (con comandos exactos), VERIFICA
(criterio observable) y SI FALLA (acción). Las decisiones ya tomadas NO se re-litigan
aquí — están en §1 con su justificación; cambiarlas requiere volver con Ulises.

---

## §1 · Decisiones ya tomadas (no re-litigar)

Salen del dictamen de fuentes verificadas el 2026-08-18 (gstack `plan-eng-review`,
obra/superpowers `brainstorming`+`writing-plans`, BMAD issue #2079, spec-kit
`analyze`, Kiro Quick Spec, agentskills.io best practices — todas existentes y
leídas en sus piezas clave).

| # | Decisión | Justificación corta |
|---|---|---|
| D1 | **Cero agentes nuevos.** Ni `solution-architect` ni `plan-reviewer`. | El orquestador ya posee síntesis y decisión ("synthesis is not delegated"); un agente nuevo cuesta `HarnessSchema` + `ModelsSchema` + `EffortSchema` + i18n + catálogo + paridad Codex (Spec 0004 sin implementar). |
| D2 | **El challenge del diseño lo ejecuta un `researcher` existente** con encargo de falsificación; el veredicto lo emite el orquestador; el usuario solo gatea `BLOCKED` y forks irreversibles. | Los researchers ya son read-only, escriben a progress y se paralelizan. Principio fresh-context sin superficie nueva. |
| D3 | **Semántica READY / CONCERNS / BLOCKED** con carga de la prueba en BLOCKED (blocking fact + por qué no se puede proceder + owner + info mínima). **CONCERNS nunca bloquea.** | Evidencia empírica del fallo contrario: BMAD issue #2079 (abierto, high priority) — gate que marca hallazgos no-bloqueantes como bloqueantes → loop sin estado de pass. |
| D4 | **Anti-loop:** 1 sola ronda de challenge; decisión de alcance aceptada/rechazada no se re-argumenta. | Regla de gstack: "Once the user accepts or rejects a scope reduction recommendation, commit fully. Do not re-argue." |
| D5 | **"What already exists" es paso obligatorio con evidencia** (Grep/codegraph) dentro de la skill, no un gate con pregunta al humano. | El modo de fallo real es "agent invents architecture" en vez de extender lo que existe. gstack lo resuelve con AskUserQuestion por umbral; eso contradice la ejecución continua de navori. |
| D6 | **Rechazada la granularidad 2–5 min con código exacto** (superpowers `writing-plans`). Se adopta solo: task = unidad testeable + prohibición de placeholders ("TBD", "add appropriate error handling"). | Los planes con código exacto envejecen mal, inflan tokens y matan el juicio del implementer. CLAUDE.md ya dice "el plan debe preservar margen". |
| D7 | **Skill de una página en v1.** `references/` NO en esta iteración (el render de core skills no lo soporta hoy; extenderlo es feature aparte). | agentskills.io: "Would the agent get this wrong without this instruction? If no, cut it." |
| D8 | **El word cap NO es inamovible** (decisión de Ulises 2026-08-18): se respeta por default, pero si el contenido tiene valor real se sube con `maxWords` explícito — el mecanismo "loud" que ya existe. Nunca se recorta sustancia para caber. | El cap disciplina tokens; el valor manda. Precedentes: `ticket-intake` a 600. |
| D9 | **Adaptive rigor anclado al routing existente**: lo único nuevo es la señal **R2-architectural** dentro de R2. No se crea una escalera de niveles paralela. | Kiro Quick Spec: mismos artefactos, menos gates cuando el terreno es conocido. |
| D10 | **Clarificación de 3 vías**: ambigüedad resoluble-en-repo → investigar; humana/producto → preguntar; no-bloqueante → asunción conservadora **registrada**. | Taxonomía de spec-kit `/clarify`, barata y compatible con ejecución continua. |
| D11 | **Architecture before decomposition** solo en R2-architectural/R3: el audit *esboza* la descomposición, la fina espera al diseño. | BMAD: las decisiones de arquitectura (contrato, ownership, boundary) cambian las fronteras de las tareas. |
| D12 | Cross-artifact consistency (spec-kit `analyze`) como **checklist del challenge en R3**, no como comando/pieza nueva. No bloquea (spec-kit tampoco bloquea). | navori ya tiene el gate duro de trazabilidad `R<n>`↔test. |

**Arquitectura resultante:** `0 agentes nuevos · 1 skill nueva (solution-design) ·
3 assets editados (orquestacion, ticket-intake, spec-bootstrap) · ~6-8 líneas de
routing`.

---

## §2 · Reglas globales para el agente ejecutor

1. **Source of truth**: TODO cambio va en `packages/core/core-assets/` y
   `packages/cli/src/`. NUNCA editar `.claude/` ni `CLAUDE.md` del repo directamente
   — son outputs renderizados (el dogfood se regenera en F4-T3).
2. **Gate de calidad** (correr completo antes de declarar cualquier fase terminada):
   ```bash
   cd "/Users/ulisescm/Documents/Dev - Docs/navori-harness" && pnpm format:check
   cd packages/cli && pnpm test && pnpm lint
   ```
   Si `format:check` falla: `pnpm format` (desde la raíz) y re-verificar.
3. **Idioma**: assets del core y código en inglés; este plan, commits y PR en español MX.
4. **Un commit atómico por tarea terminada** (Conventional, español MX).
5. **Gates humanos** (parar y esperar a Ulises): fin de F2 (aprueba la spec) y
   fin de F5 (aprueba resultado de evals). Nada más pausa el flujo.
6. **Presupuesto de contexto**: no releer archivos ya leídos en la misma fase; los
   apéndices A y B de este plan contienen la mecánica y el contenido de referencia
   para no redescubrirlos.

### Matriz de modelo/effort por fase

Principio: **barato por default, caro solo donde la decisión es irreversible o el
texto ES el producto**. La síntesis y las decisiones nunca se degradan; la lectura
y la mecánica nunca suben a opus/high.

| Fase · tarea | Ejecutor | Modelo | Effort | Por qué |
|---|---|---|---|---|
| F1 research residual | subagente `researcher` ×2 en paralelo | sonnet | medium | Lectura y extracción de mecanismos; sin decisión |
| F2 spec (requirements + tasks) | orquestador inline | sesión (opus) | medium | Scaffolding sobre decisiones ya tomadas en §1 |
| F2 spec (design.md) | orquestador inline | sesión (opus) | high | Aquí viven las decisiones finas (routing, wording del veredicto) |
| F2 challenge de la spec | subagente `researcher` fresco | opus | high | Falsificación de la decisión — calidad crítica, contexto fresco |
| F3-T1 (cuerpo de la skill) | orquestador inline | sesión (opus) | high | El texto de la skill ES el producto |
| F3-T2/T3/T4 (ediciones acotadas de assets) | orquestador inline o 1 `implementer` | sonnet | medium | Ediciones con criterio pero acotadas por el design |
| F3-T5 (registries, conteos, tests mecánicos) | inline | — (comandos) | low | Mecánico puro: greps, bumps de números |
| F4 validación + render dogfood | inline | — (comandos) | low | Correr comandos y leer salidas |
| F5 evals (ejecutar escenarios) | sesión normal sobre repo objetivo | sesión | según escenario | El escenario debe correr como correría en la vida real |
| F5 evals (juzgar resultados) | orquestador | sesión (opus) | high | El juicio de "¿cambió el comportamiento?" es el entregable |
| F6 PR | `commit-pr-pilot` | (config del repo) | — | Flujo estándar |

---

## §3 · F1 — Research residual (puntual, NO exhaustivo)

La investigación gruesa ya está hecha (dictamen §1). Quedan 2 lecturas puntuales
que alimentan la redacción de la skill. **Presupuesto: 2 subagentes en paralelo,
un turno.** La regla de saturación aplica: si lo hallado no cambia ninguna decisión
de §1, se registra y se sigue — no se abre más investigación.

**EJECUTADO 2026-08-18 — resultados incorporados a `design.md`.** Ajuste sobre lo
planeado: se hizo inline con `WebFetch` en vez de delegarlo a `researcher`, porque
ese agente NO tiene `WebFetch` en su toolset (`Read, Glob, Grep, Bash, Write`) —
dos fetches directos cuestan menos que spawnar agentes con tools de más.

- **R1a** — gstack `plan-eng-review`, secciones de review.
  La ruta del plan daba 404; el archivo real es
  `plan-eng-review/sections/review-sections.md.tmpl` (localizado con
  `gh api repos/garrytan/gstack/contents/plan-eng-review`).
  Repo @ `c86e6472eb7f` (2026-08-17). Hallazgos: 4 secciones obligatorias
  (Architecture · Code Quality · Tests · Performance) que no se saltan ni con cero
  findings ("No issues found" explícito); outputs obligatorios **NOT in scope** y
  **What already exists**; criterio blocking concreto = falta de manejo de error
  + sin cobertura de test + fallo silencioso (lo advisory es arquitectura y
  organización); y **one-issue-per-question gating** — un `AskUserQuestion` por
  hallazgo, *"an issue with an 'obvious fix' is still an issue and still needs
  explicit user approval"*. Este último se **rechaza** (D-gate: incompatible con
  ejecución continua); los otros tres se adoptan.
- **R1b** — superpowers `writing-skills`. Hallazgo que **corrigió el plan**:
  RED (correr escenarios SIN la skill, documentando las racionalizaciones
  textuales) → GREEN (skill mínima que ataca esos fallos) → REFACTOR (contrar las
  racionalizaciones nuevas). Regla central: *"NO SKILL WITHOUT A FAILING TEST
  FIRST"*. Consecuencia: el baseline se movió de F5 a F2 (ver §7).

**VERIFICA:** hallazgos reflejados en `design.md` (tabla de provenance) y en §7.

---

## §4 · F2 — Spec SDD

Crear `specs/0012-solutioning/{requirements.md, design.md, tasks.md}` con la skill
`spec-bootstrap` como forma (EARS, `R<n>`, trazabilidad).

### Requirements mínimos a cubrir (borrador para partir)

- **R1** WHEN una tarea presenta ≥1 señal architectural (ver R3), THE SYSTEM SHALL
  producir `solution_<scope>.md` antes de descomponer en tareas de implementación.
- **R2** WHEN existe `solution_<scope>.md`, THE SYSTEM SHALL someterlo a UNA ronda
  de challenge por un researcher fresco con encargo de falsificación, y el
  orquestador SHALL emitir veredicto READY / CONCERNS / BLOCKED.
- **R3** THE SYSTEM SHALL activar solutioning solo ante señales objetivas: nueva
  abstracción compartida · cambio de ownership de estado · contrato compartido
  (API/DTO/schema/evento) · migración o cambio de schema · dependencia externa
  nueva · concurrencia/sincronización de estado · área crítica
  (`project.criticalAreas`) · decisión difícil de revertir · ≥2 approaches viables
  genuinos. El conteo de archivos es señal secundaria, nunca definición.
- **R4** WHEN el veredicto es CONCERNS, THE SYSTEM SHALL registrar los concerns en
  el artefacto y **proceder a implementar** (nunca bloquear).
- **R5** WHEN el veredicto es BLOCKED, cada blocker SHALL declarar: blocking fact,
  por qué no se puede proceder sin adivinar, owner de la resolución, información
  mínima necesaria. Sin esos 4 campos, no es BLOCKED.
- **R6** El paso "what already exists" SHALL producir evidencia (`file:line` o
  salida de comando) de los patrones existentes evaluados antes de proponer
  arquitectura nueva.
- **R7** `solution_<scope>.md` SHALL contener sección "NOT in scope".
- **R8** WHEN la tarea es R1/R2 sin señales de R3, THE SYSTEM SHALL NOT producir
  artefacto de solutioning (cero ceremonia — criterio de éxito D del origen).
- **R9** tasks.md derivadas de un diseño SHALL nombrar comportamiento observable y
  evidencia esperada, y SHALL NOT contener placeholders ("TBD", "add appropriate
  error handling", "similar to Task N").

### design.md — debe decidir exactamente esto (y nada más)

1. **Wording final de las señales R2-architectural** para `orquestacion.md` —
   presupuesto duro: ≤8 líneas / ≤120 palabras añadidas al bloque.
2. **Estructura de `solution_<scope>.md`** (una plantilla, secciones condicionales
   por señal — no por "nivel" abstracto): Problem · What already exists (evidencia)
   · Constraints · Approaches (solo si ≥2 genuinos) · Chosen solution (qué/por qué/
   por qué no las otras) · Boundaries & contracts (condicional) · Failure modes
   (condicional) · Migration (condicional) · Testing strategy (los tests responden
   a riesgos, no a cobertura) · NOT in scope · Open questions (3 vías de D10).
3. **Encargo-template del challenge** (las preguntas falsificadoras: ¿qué supuesto
   está mal? ¿qué código existente lo contradice? ¿qué requirement no cubre? ¿qué
   contrato rompe? ¿qué pasa en partial failure? ¿duplicamos una abstracción
   existente? ¿se puede con menos maquinaria? — de gstack §29 + spec-kit analyze).
4. **Integración con `ticket-intake` fase 4** y con el veredicto de fase 2
   (`proceed-differently` → solutioning obligatorio si además hay señal R3).
5. **Qué se agrega a `spec-bootstrap`/design.md** (secciones condicionales +
   anti-placeholder en tasks) sin duplicar la skill nueva.

**GATE H1 (humano):** Ulises aprueba la spec antes de tocar código.
**SI FALLA** (Ulises pide cambios): una ronda de edición; los cambios de decisión
estructural (D1-D12) requieren actualizar §1 de este plan.

---

## §5 · F3 — Implementación

Orden estricto (T1 primero: el resto referencia su contenido).

### T1 — Skill `solution-design`

**OBJETIVO:** crear `packages/core/core-assets/skills/solution-design.md`.
**PASOS:**
1. Escribir el asset con frontmatter:
   ```yaml
   ---
   name: solution-design
   description: Use when a task shows an architectural signal (new shared abstraction, ownership change, shared contract, migration, concurrency, critical area) — design the solution and challenge it BEFORE decomposing into tasks.
   type: reference
   maxWords: <lo que el contenido pida — ver D8; empezar apuntando a ≤600>
   ---
   ```
2. Cuerpo según design.md de F2 (plantilla de artefacto + encargo del challenge +
   semántica R/C/B + 3 vías de clarificación + anti-loop D4). Consultar Apéndice B.
3. Registrar el id en `WORKFLOW_SKILLS`:
   `packages/cli/src/engines/shared/harness-assets.ts:44` (array
   `["ticket-intake", "pr-create", "spec-bootstrap", "dominio"]` → añadir
   `"solution-design"`).
4. Bump del catálogo: `packages/cli/package.json` campo `features.coreSkills`
   (hoy `10` → `11`).

**VERIFICA:**
```bash
cd packages/cli && pnpm vitest run src/__tests__/catalog.test.ts src/lib/__tests__/skill-caps.test.ts src/lib/__tests__/core-lean.test.ts
```
Los tres en verde. `skill-caps` valida type+cap+trigger de la description;
`core-lean` valida que el asset no nombre stacks (denylist en
`packages/cli/src/lib/__tests__/core-lean.test.ts:28-58` — no escribir "redux",
"mantine", "express", etc. en la skill).
**SI FALLA** cap: subir `maxWords` con justificación en el commit (D8) — NUNCA
recortar sustancia para caber. Si falla core-lean: reformular el ejemplo sin
nombre de stack.

### T2 — Routing en `orquestacion.md`

**OBJETIVO:** las señales R2-architectural visibles always-on.
**PASOS:**
1. Editar `packages/core/core-assets/managed/orquestacion.md`: en la tabla de rutas
   (fila R2) o inmediatamente después, añadir el sub-bloque de señales con el
   wording de design.md. **Presupuesto: ≤8 líneas / ≤120 palabras.**
2. Cuidado con la contradicción conocida: `orquestacion.md` prohíbe pausar tras
   aprobar el plan ("Continuous execution"). El texto nuevo debe decir explícito
   que el solutioning ocurre **antes** de la aprobación del plan — nunca leerse
   como permiso para pausar a media ejecución.
3. El hash del bloque cambia → los repos renderizados verán drift de versión en
   `doctor` hasta el próximo `render --apply`. Es lo esperado; no tocar nada más.

**VERIFICA:** `git diff --stat packages/core/core-assets/managed/orquestacion.md`
muestra el delta acotado; `wc -w` del bloque añadido ≤120.
**SI FALLA** el presupuesto: mover detalle a la skill (que es on-demand) y dejar
en el bloque solo el trigger.

### T3 — `ticket-intake.md` fase 4

**OBJETIVO:** la fase 4 (DESIGN) deja de ser una línea y apunta a la skill.
**PASOS:**
1. Editar `packages/core/core-assets/skills/ticket-intake.md`, fila de fase 4:
   activarla cuando el veredicto de fase 2 sea `proceed-differently` O haya señal
   R3; artefacto `solution_<scope>.md` + challenge; gate = veredicto R/C/B.
2. Contar palabras del cuerpo (el cap actual es `maxWords: 600`; medir con
   `python3 -c "raw=open('...').read(); print(len(raw.split('---',2)[2].split()))"`).
   Si excede: subir maxWords (D8).

**VERIFICA:** `pnpm vitest run src/lib/__tests__/skill-caps.test.ts` verde.

### T4 — `spec-bootstrap.md`

**OBJETIVO:** design.md de las specs cubre las dimensiones condicionales; tasks
sin placeholders.
**PASOS:**
1. Editar `packages/core/core-assets/skills/spec-bootstrap.md`: al template de
   design agregar las secciones condicionales (contracts, failure modes, migration,
   testing-por-riesgo, non-goals) marcadas "solo si aplica — no generar secciones
   vacías"; al template de tasks agregar la regla anti-placeholder (R9).
2. Referenciar la skill `solution-design` para el caso R2-architectural que NO
   amerita spec completa (la spec es R3; el artefacto de solutioning es su versión
   ligera).
3. Medir cap igual que T3.

**VERIFICA:** skill-caps verde; el template no duplica la plantilla completa de la
skill nueva (una referencia, no una copia).

### T5 — Tests y conteos

**OBJETIVO:** suite verde con la skill nueva registrada.
**PASOS:**
1. Correr la suite completa: `cd packages/cli && pnpm test`.
2. Fallos esperados y su fix:
   - `catalog.test.ts` — cuenta `core-assets/skills/*.md` vs `features.coreSkills`
     (ya cubierto en T1 paso 4).
   - `cli.e2e.test.ts` — NO debe fallar (no hay bloque managed nuevo); si falla
     por skills renderizadas, leer la aserción y actualizar el conteo/lista.
   - Cualquier snapshot de índice de skills: el índice se construye dinámico de
     `WORKFLOW_SKILLS` + `readSkillTrigger`, no debería haber snapshot; si lo hay,
     regenerarlo leyendo el diff primero.
3. Añadir 1 test de contenido (invariantes semánticas, no párrafos completos) en
   `packages/cli/src/lib/__tests__/skills-assets.test.ts` o archivo nuevo:
   la skill `solution-design` contiene los fragmentos "READY", "CONCERNS",
   "BLOCKED", "NOT in scope", "already exists" — el estilo de test frágil por
   párrafo está prohibido (usar `toContain` de tokens cortos).

**VERIFICA:** `pnpm test` completo verde + `pnpm lint` + `pnpm format:check` (raíz).

### T6 — Commits

Uno por tarea: `feat(skills): solution-design — diseña y desafía la solución antes de descomponer (#0012)` ·
`feat(orquestacion): señales R2-architectural (#0012)` · `feat(intake): fase 4 apunta a solution-design (#0012)` ·
`feat(sdd): design template con dimensiones condicionales y tasks sin placeholders (#0012)`.

---

## §6 · F4 — Validación y dogfood

- **T1:** gate completo (§2.2) — verde.
- **T2:** render de prueba en repo temporal:
  ```bash
  SP=$(mktemp -d) && cd "$SP" && git init -q . && cat > navori.config.json <<'EOF'
  {"name":"solutioning-demo","version":"0.6.0","engines":["claude"],"preset":"custom","language":"es","branchBase":"main","commits":"conventional-es","qualityGate":{"fast":"pnpm test","full":"pnpm test"}}
  EOF
  node "/Users/ulisescm/Documents/Dev - Docs/navori-harness/packages/cli/dist/index.js" render --apply
  ```
  **VERIFICA:** existe `.claude/skills/solution-design/SKILL.md`; `CLAUDE.md`
  contiene la fila `- \`solution-design\` — navori (workflow) · Use when a task
  shows an architectural signal…` y el bloque `orquestacion` trae las señales.
- **T3:** dogfood self-host: `node packages/cli/dist/index.js render --apply` en
  el propio navori-harness, commit separado `chore(self-host): re-renderiza el
  harness con solution-design (#0012)` (convención del repo).
- **SI FALLA** cualquier punto: volver a la tarea de F3 correspondiente; no
  parchear el output renderizado a mano (regla §2.1).

---

## §7 · F5 — Evals de presión (manuales)

> **CORRECCIÓN DE MÉTODO (2026-08-18, tras leer superpowers `writing-skills`):**
> el baseline RED va **ANTES** de escribir la skill, no después — *"NO SKILL
> WITHOUT A FAILING TEST FIRST"*. El baseline documenta las racionalizaciones
> concretas que la skill debe contrarrestar; escribirla primero y validarla después
> produce una skill que responde a fallos imaginados. El Escenario A se corre en
> F2 (tarea T0.1 de `tasks.md`); los GREEN quedan aquí.

Método superpowers/agentskills: RED = comportamiento SIN la capa; GREEN = con ella;
REFACTOR = contrar los rationalizations nuevos que aparezcan. Un escenario por
sesión limpia. Registrar cada resultado en `specs/0012-solutioning/evals.md`
(escenario · esperado · observado · veredicto PASS/FAIL · ajuste derivado).

| Esc. | Setup | Esperado con la capa |
|---|---|---|
| **A — false architecture need** | En bonum-webapp, procesar BTBS-162 ("Introducir React Query") con `ticket-intake` completo | El audit/solutioning evalúa la propuesta contra **extender la capa existente** (`useFetchAndLoad`/Redux) con evidencia "what already exists", y el veredicto se emite con alternativas — NO adopta React Query solo porque el ticket lo dice. Cualquiera de los dos caminos es PASS **si** está argumentado contra la alternativa; heredar la propuesta sin evaluarla es FAIL. |
| **D — overplanning** | "Cambia el texto del botón Save por Guardar" en cualquier repo con el harness | R1 inline; CERO artefacto de solutioning. Si genera `solution_*.md` es FAIL. |
| **E — concern no bloquea** | Diseño válido con un concern menor sembrado (p.ej. un edge case opcional sin cubrir) | Veredicto CONCERNS, registrado, y la implementación ARRANCA. BLOCKED aquí es FAIL (el modo de fallo BMAD #2079). |
| **F — blocker real** | Ticket con dos interpretaciones que llevan a arquitecturas incompatibles (p.ej. ¿el estado se comparte entre apps o se duplica?) | BLOCKED con los 4 campos de R5 y pregunta dirigida a Ulises. Adivinar e implementar es FAIL. |

**GATE H2 (humano):** Ulises revisa `evals.md`. FAIL en A o D = ajustar la skill
(una ronda) y re-correr solo el escenario fallido. FAIL persistente = volver a F2.

---

## §8 · F6 — PR, cierre y rollout

1. PR de la branch → `main` vía `commit-pr-pilot` (título:
   `feat(solutioning): capa de diseño de solución con challenge fresco (spec 0012)`).
   El cuerpo enlaza esta spec y resume D1-D12.
2. Post-merge (sesión aparte, decisión de Ulises): release + rollout a los repos
   registrados (per-repo, NUNCA `--all`). Nota heredada del rollout pendiente:
   los repos con `socket.io-client` necesitan `navori update` además de `render`
   (migración `socketio` → `socketio-client`, PR #330).
3. Cierre estándar: `mem_save` de decisiones, entrada en `progress/history.md`,
   `progress/current.md` a idle, `mem_session_summary`.

---

## Apéndice A · Mecánica navori verificada (2026-08-18)

| Qué | Dónde exactamente |
|---|---|
| Registro de workflow skills | `packages/cli/src/engines/shared/harness-assets.ts:44` — `WORKFLOW_SKILLS` |
| Conteo del catálogo | `packages/cli/package.json` → `features.coreSkills` (hoy 10); lo valida `packages/cli/src/__tests__/catalog.test.ts:54-56` contando `core-assets/skills/*.md` |
| Word caps | `packages/cli/src/lib/skill-meta.ts:49-56` — behavior 200 / reference 500 / tool 300 palabras; override `maxWords` en frontmatter; lo valida `skill-caps.test.ts` **sobre el cuerpo managed** (split de `parseAsset`, desde PR #328/#332) |
| Trigger obligatorio en description | `skill-meta.ts:105` `TRIGGER_RE` — la description debe contener "Use when…" o equivalente |
| Core-lean (sin stacks en el core) | `packages/cli/src/lib/__tests__/core-lean.test.ts:28-58` — denylist (redux, mantine, express, vite, expo, …) |
| Bloques managed core | `packages/cli/src/lib/render-plan.ts:54-119` — `CORE_MANAGED_ASSETS`; el orden del array ES el orden canónico; append al final = cero reorden en repos renderizados; el e2e asserta la lista en `cli.e2e.test.ts:686-699` |
| user-section en assets | sentinel `<!-- navori:user-section -->` (`packages/cli/src/engines/claude/parse-asset.ts:22`) — lo que va después NO cuenta para el cap y se escribe solo en el primer render |
| Índice de skills | dinámico — `buildSkillRows` (`packages/cli/src/engines/shared/skills-index.ts`) lee `WORKFLOW_SKILLS` + `readSkillTrigger`; no hay snapshot que actualizar |
| Gate de calidad | `pnpm format:check` (raíz) · `cd packages/cli && pnpm test && pnpm lint` |
| Agentes (NO tocar en esta spec — referencia por D1) | `harness-assets.ts:20` `CORE_AGENTS` + `schema.ts:108/119/148` (Harness/Models/Effort) + i18n `agentsIndex.when` + `features.coreAgents` |

## Apéndice B · Material de referencia para redactar la skill (provenance)

- **Preguntas del challenge** (gstack `plan-eng-review` + spec-kit `analyze`):
  ¿qué supuesto es falso? · ¿qué código existente contradice el diseño? · ¿qué
  requirement quedó sin cubrir? · ¿qué contrato se rompe? · ¿qué pasa en partial
  failure / timeout / duplicado? · ¿quién es dueño de este estado? · ¿duplicamos
  una abstracción que ya existe? · ¿se puede con menos maquinaria? · ¿las tareas
  corresponden al diseño? · ¿los tests detectan el riesgo principal?
- **Lo que el challenger NO puede usar para bloquear** (gstack + BMAD #2079):
  preferencia de naming, abstracción futura posible, optimización menor, edge case
  opcional, preferencia estilística de arquitectura.
- **Jerarquía de soluciones** (prompt v1 §15, confirmada por superpowers YAGNI):
  `existing pattern > small extension > new abstraction > new subsystem`, salvo
  evidencia contraria.
- **Severidades del challenge** (spec-kit): CRITICAL solo para lo que cambia la
  decisión; el reporte cabe en una tabla; read-only estricto.
- **Formato del artefacto**: `.claude/progress/solution_<scope>.md` (efímero;
  si la decisión es durable se promueve a spec/Dominio al cierre).
- **Fuentes** (verificadas 2026-08-18): github.com/garrytan/gstack ·
  github.com/obra/superpowers · github.com/bmad-code-org/BMAD-METHOD/issues/2079 ·
  github.com/github/spec-kit · kiro.dev/docs/specs/quick-spec · agentskills.io.
