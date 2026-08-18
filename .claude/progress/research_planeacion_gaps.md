# Research — ¿Qué dice hoy el harness de navori sobre planear, dimensionar y decidir alcance?

**Status:** DONE

## Respuesta directa

El harness cubre **enrutar** (qué ruta/agente), **descomponer** (cómo repartir) y **verificar al cerrar** (`verify-before-done`). NO cubre la fase intermedia: **dimensionar una tanda con evidencia antes de comprometerse**. Los 5 puntos que preguntas están 3 "a medias" y 2 "no existe": nada dice "no estimes lo que no abriste", nadie escribe criterio de aceptación fuera de SDD, y el "no-alcance" solo existe como límite de cobertura de agentes read-only, nunca como declaración de un plan.

---

## 1. `managed/orquestacion.md` — enruta y paraleliza; NO verifica suposiciones

Qué cubre:

- `packages/core/core-assets/managed/orquestacion.md:9-12` — tabla de rutas R1/R2/R2-fan/R3. Los criterios de decisión son **cuantitativos y estructurales**: "1–3 files", "4+ files", "2+ non-trivial files", "sub-questions genuinely independent". Nada sobre confianza, riesgo o incertidumbre.
- `:16-21` — "Thresholds that make you STEP UP": regla de 4 archivos, multi-file write, PR rule, long-session rule. Todos son gatillos de **escalar ruta**, no de **validar el supuesto** que sostiene la estimación.
- `:34-41` — "Frugal delegation": pela lo mecánico, un encargo = una unidad, tier por sub-tarea (low/mid/high), one-pass review. Esto **sí** es dimensionamiento, pero de *cuánto agente gastar*, no de *cuánto trabajo real hay*.
- `:39` — "Scope doesn't self-expand mid-run" + `:43-45` "Continuous execution": lo que hay sobre alcance es **anti-expansión durante la ejecución**, no **definición del alcance antes**.

Hueco concreto: el mapeo "N archivos → ruta X" **presupone que ya sabes cuántos archivos toca**. No hay ninguna instrucción que diga cómo obtienes ese número ni que sea sospechoso estimarlo sin haber abierto nada. La palabra "estimate"/"sizing" no aparece en todo `core-assets` fuera de `estimatedItemSize` de FlashList (`presets/react-native-expo/skills/rn-performance.md:13`, falso positivo).

## 2. `managed/sdd.md` — spec sí/no, binario; la tanda de N issues heterogéneos cae en el vacío

- `packages/core/core-assets/managed/sdd.md:3` — gatillo: feature nueva completa, auth/seguridad/permisos, adapters/modelos con datos sensibles, o **alcance > ~2 días**. Y el escape: "UI bugfixes, a new field in a form, isolated refactors, or copy tweaks go straight in".
- `:5` — formato: `requirements.md` (EARS, `R<n>`) + `design.md` + `tasks.md` (batches de 1-3, cada task declara sus `R<n>`, cada `R<n>` ≥1 test con `// Covers: R<n>`).
- `:7` — el tracking vive en `tasks.md`, prohibido duplicarlo en `TaskCreate`.

**Hueco central para tu caso:** la única mención de dimensionamiento temporal es "> ~2 días" (`:3`), sin decir cómo se estima. Y el binario es **spec completa o "go straight in"**: no existe artefacto intermedio para *una tanda de N issues heterogéneos* que juntos son >2 días pero individualmente son "straight in". `tasks.md` (`:5`) asume **una** feature con `R<n>` compartidos — no modela N unidades independientes con criterios de aceptación distintos. El `plan_<scope>.md` del `auditor` (`agents/auditor.md:109`) es lo más cercano a "lista priorizada de N unidades heterogéneas", pero solo lo produce el auditor tras una auditoría sin ticket.

## 3. Skills de workflow — qué cubre cada una y si toca PLANEAR

| Skill | Qué cubre | ¿Toca planear? |
|---|---|---|
| `ticket-intake` (`skills/ticket-intake.md:17-27`) | Pipeline canónico de 8 fases con gates bloqueantes, de triage a PR. | **Sí, pero para UN ticket.** Fase 0 triage decide trivial→R1 (`:19`); fase 2 AUDIT delega a `ticket-audit` con gate "el usuario aprueba" (`:21`); fase 4 DESIGN presenta 2-3 approaches solo si hay patrón/lib nueva (`:23`). Regla dura: no se salta la fase 2 en algo no trivial (`:31`). **No modela una tanda de N tickets** — al contrario, `:34` prohíbe "two tickets in parallel on the same `current.md`". |
| `spec-bootstrap` (`skills/spec-bootstrap.md:11-19`) | Andamiaje SDD: requirements EARS → design → tasks, con trazabilidad `R<n>`↔test. | **Sí, es la única pieza de planeación formal.** Orden obligatorio (`:17-19`), y reglas duras: cero placeholders sin resolver — un hueco es pregunta al usuario, no `<...>` (`:60`); cada `R<n>` acaba en ≥1 task y ≥1 test o no entra a la spec (`:61`). Pero solo aplica a alcance SDD (`:11` excluye bugfixes, UI tweaks, refactors aislados). |
| `verify-before-done` (`skills/verify-before-done.md:13,30-38`) | Ley de hierro: ninguna claim de "done" sin evidencia fresca del comando que la respalda, corrido **este turno**. | **No — es 100 % post-hoc.** El gate se dispara "BEFORE claiming any done/ready/completed/approved" (`:30`). La tabla claim→evidencia (`:44-55`) es toda de cierre. La sección "Rationalization prevention" (`:68-76`) ataca "estoy seguro" **al cerrar**, jamás **al estimar**. |
| `structural-search` (`skills/structural-search.md:9,15`) | Escalera Rung 0-2 (memoria → Grep → ast-grep) para abrir solo el span confirmado en vez de leer archivos enteros. | **Rozándola.** `:9` "Precision tools verify a hypothesis; they don't form it" y `:15` "Use the result as a **scope hypothesis**, never as a source of truth" + `:17` "Confirm every pointer with a cheap search" son lo más cerca que llega el harness a "confirma antes de creer". Pero el objeto es *dónde está el código*, no *cuánto cuesta el trabajo*. Y `:63` empuja al contrario: "If the search consumes ~15% of the context, stop: reduce scope or act on the available evidence". |
| `loop-back-debug` (`skills/loop-back-debug.md:25,41-56,61`) | Si un fix no limpió el síntoma al primer repro, paras de parchar y re-validas la hipótesis. | **No en la fase de planear — es reactiva.** El ciclo entero es post-fix (`:32` "AFTER applying a fix"). Lo interesante es que `:50-56` **sí** ordena "generate 2–3 alternative hypotheses **before touching code**" y "document it before touching code" — el patrón mental que quieres, pero solo se activa **después de un fallo**, nunca preventivamente. `:61` escala al usuario tras 2 intentos fallidos. |

## 4. Agentes — qué produce cada uno en el análisis previo

- **`ticket-audit`** (`agents/ticket-audit.md`) — el analista pre-implementación. Produce `audit_ticket_<ID>.md` con: hipótesis de root cause con `[confidence:0–100]` + `file:line` (`:68-69`), 2-3 approaches con tradeoffs y recomendación (`:71-80`), archivos afectados (`:82-83`), áreas críticas tocadas (`:85-86`), dependencias entre tareas (`:88-89`), preguntas abiertas al usuario (`:91-92`) y plan de descomposición sugerido (`:94-97`).
  **¿Exige verificar suposiciones en el código antes de estimar?** **A medias, y solo sobre afirmaciones, no sobre tamaño.** `:48` "Cite `file:line` in EVERY claim. No line = it's a hunch — mark it 'unverified hypothesis'"; `:49` no inventes endpoints/componentes, lo que no encuentres va a "open question for the user"; `:103` sin `file:line` es hipótesis, no claim; `:105` "If the ticket is ambiguous, list the explicit open questions. Don't assume." Eso disciplina el **diagnóstico**. Pero el output "Suggested decomposition plan" (`:94-97`) y "Affected files" (`:82`) **no heredan esa exigencia**: no hay regla que diga que el plan de descomposición solo puede listar archivos que efectivamente abriste, ni que asigne confianza al *tamaño* de cada unidad (la escala `confidence` de `:69` es exclusiva del root cause de un bug).
- **`auditor`** (`agents/auditor.md`) — auditoría profunda read-only sin ticket. Produce `audit_deep_<scope>.md` (`:88-107`) + `plan_<scope>.md` priorizado: blockers → quick wins → SDD features → cleanup, "Each item with severity, **files to touch, effort**, and originating finding" (`:109`). Ejes obligatorios seguridad+performance (`:51-69`). Regla de 3 antes de proponer extracción, con el criterio explícito "if you can't cite 2 real call-sites, don't propose the abstraction" (`:73-78`). Sin `file:line` es hipótesis (`:116`). El reporte cierra con "Coverage — files read, grepped, **regions NOT audited**" (`:106`).
- **`explorer`** (`agents/explorer.md`) — mapa de un área: estructura, entry points, dependencias entrantes/salientes ("blast radius", `:29`), "Dark areas / TODOs / smells" (`:59`) y "What I did NOT cover (boundary)" (`:62`). Si el scope llega ambiguo devuelve `blocked` en vez de adivinar (`:27`).
- **`researcher`** (`agents/researcher.md`) — una pregunta acotada con evidencia. `:47` "What I did NOT look at (scope boundary)"; `:59` "Each finding cites `file:line`. No cite, no finding"; `:57` "You don't infer without evidence"; `:60` si no hay respuesta en el código → `Status: PARTIAL`.
- **`leader`** (`agents/leader.md`) — playbook de orquestación que encarna el agente principal. Startup: leer CLAUDE.md, `progress/current.md`, identificar scope contra Project rules (`:17-21`). **Brainstorm gate** (`:22-27`): si la tarea introduce patrón nuevo, decisión arquitectónica o lib nueva → presenta 2-3 approaches con tradeoffs y **espera aprobación de UNO** antes del implementer; se salta para bug fix conocido, copy/estilo, ajuste dentro de patrón establecido. Tabla de descomposición por complejidad (`:31-38`). `implementer` en paralelo solo con archivos disjuntos (`:56`). Ejecución continua sin pausar (`:66-74`). `:129` "Launch an `implementer` without having clarified the scope against the Project rules" está en el "What you do NOT do".

## 5. HUECOS (lo importante)

### a) "No estimes/dimensiones un archivo que no abriste" — **NO EXISTE**

No hay ninguna regla de este tipo en ninguna pieza. La familia existente es "no **afirmes** sin `file:line`" (`agents/ticket-audit.md:48,103`; `agents/auditor.md:116`; `agents/researcher.md:59`) y "no **cierres** sin evidencia fresca" (`skills/verify-before-done.md:13`). Ninguna es "no **estimes** sin haber leído".

La contradicción más filosa: `agents/auditor.md:109` **pide** un `effort` por ítem del plan priorizado y **no exige ninguna evidencia** para ese effort — es el único campo del harness que pide un juicio de tamaño y el único que no está gateado. Simétricamente, `managed/orquestacion.md:9-12` enruta por conteo de archivos sin decir de dónde sale el conteo.

### b) Declarar la suposición que hace barata una unidad + qué la refutaría — **NO EXISTE (existe el patrón, en la fase equivocada)**

Grep de `assum` en `core-assets` devuelve solo: "don't assume" defensivos (`agents/ticket-audit.md:105`, `agents/commit-pr-pilot.md:48`, `agents/reviewer.md:38`, `skills/dominio.md:18`) y "assumed fixed" como anti-patrón (`skills/verify-before-done.md:50`). Ninguno pide **declarar** una suposición; todos piden **no tenerla**.

Los dos análogos más cercanos, ambos fuera de la fase de planeación:
- `skills/loop-back-debug.md:50-56` — genera 2-3 hipótesis alternativas y **documenta la elegida antes de tocar código**. Es exactamente la mecánica que buscas, pero se activa solo **después** de que un fix falló.
- `agents/implementer.md:65` — "Mark each deliberate shortcut with a comment naming its **ceiling** and its **upgrade trigger**... A shortcut without a trigger is silent debt". Este **sí** es el patrón "declara el supuesto + qué lo refuta", pero aplica a un atajo **de código**, no a una unidad de plan. Es el mejor precedente estilístico para el bloque nuevo.
- `agents/ticket-audit.md:69` tiene `[confidence:0–100]`, pero solo para el root cause de un bug, y sin pedir "qué evidencia movería este número".

### c) Escribir el criterio de aceptación / evidencia concreta ANTES de codear — **EXISTE A MEDIAS (solo dentro de SDD)**

Grep de `acceptance|criterio de aceptaci|definition of done|success criteri` en todo `core-assets`: **cero resultados**.

- **Dentro de SDD sí existe de facto:** `skills/spec-bootstrap.md:54` — cada task declara `test: <file>::<case>` con `// Covers: R<n>`, y `:61` "Every `R<n>` ends in ≥1 task and ≥1 test... isn't traceable → it doesn't enter the spec". Reforzado en `managed/sdd.md:5` y exigido al implementer en `agents/implementer.md:49`.
- **Fuera de SDD no existe.** El plan que escribe el implementer (`agents/implementer.md:19`) es una lista de acciones de 2-5 min ("Define interface in X", "Implement logic in Y", "Cover with a test") + `Expected files` (`:28`) — **acciones y archivos, nunca un criterio observable de éxito**. Y `verify-before-done` es explícitamente el gate de cierre (`skills/verify-before-done.md:30` "BEFORE claiming any done"), no de apertura: la tabla claim→evidencia (`:44-55`) se llena **después**, no se compromete antes.

Ese es el hueco más limpio: **el harness sabe verificar contra una evidencia, pero nunca obliga a escribir cuál será esa evidencia antes de empezar** salvo que estés en una spec.

### d) Declarar el NO-alcance explícitamente al proponer un plan — **EXISTE A MEDIAS (como cobertura de investigación, no como no-meta del plan)**

Lo que **sí** existe, y siempre en reportes read-only *ya ejecutados*:
- `agents/researcher.md:47` — "## What I did NOT look at (scope boundary)".
- `agents/explorer.md:62` — "## What I did NOT cover (boundary)".
- `agents/auditor.md:106` — "## Coverage — files read, grepped, regions NOT audited".

Lo que **no** existe: ninguna plantilla de **plan o propuesta** tiene sección de no-alcance.
- `agents/ticket-audit.md:56-98` — el formato del audit tiene Summary, hipótesis, approaches, archivos afectados, áreas críticas, dependencias, preguntas abiertas y plan de descomposición. **Sin "fuera de alcance".**
- `skills/spec-bootstrap.md:23-56` — las 3 plantillas (requirements/design/tasks) no tienen sección de no-metas. `design.md` tiene "Discarded trade-offs" (`:41`), que es *alternativas descartadas*, no *lo que no se va a hacer*.
- `agents/auditor.md:109` — el `plan_<scope>.md` prioriza, pero no declara qué queda fuera.

Lo más cercano son reglas de **contención en ejecución**, no de declaración previa: `managed/orquestacion.md:30` "Assign explicit scope before fanning out" (es scope-in, no scope-out), `:39` "Scope doesn't self-expand mid-run", `agents/implementer.md:42` "If you discover your change requires touching something else outside the scope, you stop and report `blocked`", `agents/leader.md:129`.

Nota: `docs/DIRECTION.md:46-63` sí modela no-metas explícitas — pero a nivel **proyecto**, no a nivel **tanda de trabajo**. Es el precedente conceptual que valida el patrón dentro de navori.

### e) Reservar las preguntas al usuario para lo irreversible/caro — **EXISTE A MEDIAS Y FRAGMENTADO (nunca formulado como criterio)**

Hay cuatro reglas dispersas que rozan el tema, ninguna con el criterio "irreversible/caro":

1. `agents/leader.md:22-27` — brainstorm gate: se **pregunta** al usuario ante patrón nuevo / decisión arquitectónica / lib nueva; se **salta** para bug fix conocido, copy/estilo/color, ajuste dentro de patrón establecido, o dependencia clara del audit previo. Es el criterio más cercano, pero el eje es **novedad**, no **reversibilidad ni costo**. (Réplica en `skills/ticket-intake.md:23`.)
2. `agents/implementer.md:69` — "**Don't over-deliberate.** If the *scope* is ambiguous between minimal and complete, ship the reasonable minimum and question it in the same reply ('I did X; it covers Y. Do you need Z? say so') instead of burning reasoning without writing." Esto **es** el punto (e) para lo barato: no bloquees preguntando, entrega y pregunta después. Pero está enterrado en la sección YAGNI del implementer, no en la doctrina de planeación del orquestador.
3. `managed/operaciones-seguras.md:3` — "Before mutating data, schema, or infrastructure... read and propose; don't mutate without the user's explicit opt-in for THIS task" y `:8` "If a destructive mutation is legitimate and necessary: explain what it does and why, and let the user confirm". Esto **sí** es un gate por irreversibilidad — pero exclusivo de datos/infra, nunca extendido a decisiones de alcance.
4. `skills/loop-back-debug.md:61` — escala al usuario tras 2 intentos fallidos; `managed/orquestacion.md:45` — cap de 2 ciclos `CHANGES_REQUESTED` → escala. Son caps por **repetición**, no por costo.

Y hay tensión declarada en la dirección opuesta: `managed/orquestacion.md:43-45` y `agents/leader.md:66-74` prohíben pausar entre nodos ("No 'did 1, continue with 2?'"), y `skills/spec-bootstrap.md:60` convierte cualquier hueco de la spec en pregunta al usuario ("if you don't know a value, it's a question for the user, not a hole") **sin filtrar por costo**. Un bloque nuevo aquí debe reconciliar: `spec-bootstrap:60` dice "pregunta lo que no sepas", `implementer:69` dice "no preguntes lo barato, entrégalo y cuestiónalo".

---

## 6. Solape con `docs/DIRECTION.md` / `CONTRIBUTING.md`

No hay solape de contenido (ninguno de los dos habla de doctrina de planeación de agentes), pero **sí hay restricciones de proceso y de diseño que el bloque nuevo debe respetar**:

1. **Procedimiento.** `CONTRIBUTING.md:4-6` y `docs/DIRECTION.md:110-111`: si la idea contradice un invariante o reabre una no-meta, primero spec en `specs/`. **Un bloque managed nuevo sobre planeación no contradice ningún invariante ni reabre ninguna no-meta** (`DIRECTION.md:46-63`), así que no requiere spec previa por esa vía. Pero `DIRECTION.md:107-108` marca como "requiere discusión" **la forma de los assets managed** (marcadores, `hash`/`version`, zona managed vs zona usuario) — agregar un bloque que respete ese contrato está bien; cambiar el contrato no.
2. **Presupuesto de tokens (la restricción real).** `DIRECTION.md:41-42`: "Optimización de tokens: el harness rendereado se paga en cada sesión → reducir el peso always-on es leverage compuesto (Specs 0005/0006)". Un bloque managed en `CLAUDE.md` es **always-on**: se paga en cada sesión de cada uno de los 15 repos. Si el contenido es un procedimiento consultable en vez de doctrina que siempre debe estar presente, el vehículo correcto puede ser una **skill** (que solo se carga al invocarse), no un bloque managed. Los caps de skill son duros: `packages/cli/src/lib/skill-meta.ts:49-53` — `behavior: 200` palabras, `reference: 500`, con override `maxWords` explícito y "loud, not silent" (`:6-7`).
3. **Prioridad y sesgo anti-superficie.** `DIRECTION.md:55-56`: "Features grandes nuevas cuando el pendiente es endurecer lo existente" es **no-meta**, y la prioridad declarada es **calidad > tokens > velocidad** (`:104`, en la lista de lo que requiere discusión para cambiarse). Un bloque de planeación se justifica como *endurecer lo existente* (tapar huecos de la doctrina actual), no como superficie nueva — conviene enmarcarlo así.
4. **Auto-hospedaje.** `DIRECTION.md:92-94` (invariante 10): el harness se commitea en este repo. El bloque nuevo se aplica a navori mismo desde el primer render.
5. **Quality gate doc-only.** `CONTRIBUTING.md:25-26` y `DIRECTION.md:128`: cambios doc-only (`.md`) solo requieren `pnpm lint` + `pnpm format:check`, sin la suite. Ojo: agregar un asset a `core-assets` **no** es doc-only si toca el manifiesto/inventario del render — ahí sí corre la suite completa.

---

## Lo que NO revisé (frontera de alcance)

- `packages/core/core-assets/presets/**` — solo los grepeé; no auditè si algún preset (backend/frontend/etc.) trae doctrina de planeación propia. Los hits que salieron eran ruido (`estimatedItemSize`, `client:load` "expensive").
- `packages/core/core-assets/lib-skills/**` — skills por dependencia detectada, no doctrina de proceso.
- `specs/000X-*.md` — no leí las specs formales; si alguna (p.ej. 0003 calidad/tokens, 0005/0006 contexto) ya discutió planeación, no lo detecté.
- El engine `codex` y sus adaptadores — asumí paridad de contenido con Claude por el invariante del spine compartido (`DIRECTION.md:82-85`), pero no lo verifiqué.
- `agents/reviewer.md` y `agents/commit-pr-pilot.md` — leídos solo por grep; son fase de cierre, no de planeación.

## Notas / dudas

- **La asimetría estructural del harness**: es rigurosísimo con la evidencia de **cierre** (`verify-before-done` es la skill más larga y con `maxWords: 1000` explícito) y con la evidencia de **diagnóstico** (`file:line` obligatorio en 4 agentes), pero **no pide ninguna evidencia para el compromiso de alcance**, que es justo el momento donde el error sale más caro porque se propaga a todo lo que sigue.
- **Riesgo de duplicación a vigilar** al redactar el bloque nuevo: la tabla de rutas (`orquestacion.md:9-12`) ya decide *quién ejecuta*; el bloque nuevo debe decidir *con qué confianza te comprometes*, sin re-derivar el enrutado. Y `orquestacion.md:12` ya avisa "see the **SDD** block (don't duplicate its criteria)" — el precedente de no re-litigar criterios entre bloques.
- **Riesgo de contradicción a vigilar**: el bloque nuevo empuja a *verificar antes de comprometer*, mientras `orquestacion.md:43-45` empuja a *no pausar una vez aprobado el plan*. No chocan si el bloque se aplica **antes** de que el plan esté aprobado — pero hay que decirlo explícitamente o el agente lo leerá como permiso para pausar a mitad de ejecución.
- **Duda abierta**: si el vehículo debe ser bloque managed (always-on, cuesta tokens en 15 repos) o skill de workflow (`type: workflow`/`reference`, se carga bajo demanda como `ticket-intake` y `spec-bootstrap`, que son exactamente las piezas de proceso análogas). Los dos precedentes de planeación existentes (`ticket-intake`, `spec-bootstrap`) son **skills**, no bloques managed — dato relevante para la decisión.
