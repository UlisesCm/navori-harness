---
name: ticket-intake
description: Pipeline canónico de 8 fases para procesar un ticket (ID, URL o texto pegado) con gates objetivos. Usar cuando llega texto de un ticket y la tarea no es trivial.
type: reference
---

<!-- candidate: workflow-backend -->

# ticket-intake — pipeline de 8 fases

## Cuándo usar este skill

Cuando llega un ticket (ID, URL o texto pegado) y la tarea no es trivial. Orquesta el ciclo encadenando agentes y skills de navori con gates objetivos: el contexto que pagas con tokens en una fase queda escrito para la siguiente, sin depender de la memoria del modelo.

## Pipeline

Cada fase escribe en `.claude/progress/`; el gate es bloqueante.

| Fase | Quién la cubre | Artefacto / Gate |
|---|---|---|
| 0 · Triage | tú: `mem_search`, `cat current.md`, `git status/log` | Trivial → salta a 5. Si `current.md` no está idle con OTRO ticket, pregunta; nunca dos en paralelo. |
| 1 · Context (opc.) | tú: CLI del tracker (`acli` / `jira` / `gh issue view`) | Si solo hay texto pegado, salta a 2 con él. |
| 2 · AUDIT | agente `ticket-audit` | `audit_<ID>.md`: root cause/approach, archivos, alternativas, preguntas, tasks. **Gate: el usuario lo aprueba.** |
| 3 · EXPLORE (opc.) | 2-3 agentes `explorer` en un solo mensaje | Un `explore_<dim>.md` por dimensión (handler, schema, side-effects, caller, memoria). **Gate: validas que el approach del audit sigue vivo.** |
| 4 · DESIGN (opc.) | skills `new-endpoint` (sobre recurso existente) / `new-resource` (end-to-end) | Solo si hay patrón o lib nueva: presentas 2-3 approaches con tradeoffs y esperas OK. Si no, a 5. |
| 5 · IMPLEMENT | UN agente `implementer` | Lee CLAUDE.md → `audit_<ID>.md` → `explore_*.md` → skill aplicable. Produce `impl_<feature>.md`. **Gate: `{{qualityGate.fast}}` verde en el turno.** |
| 6 · VERIFY | skill `verify-before-done` (la corre el implementer) | `impl_<feature>.md` con "Verify ejecutado en este turno" en exit 0 + smoke del endpoint. Sin evidencia → a 5. |
| 7 · REVIEW | agente `reviewer` + skill `review-diff` | `review_<feature>.md`. Two-stage; Stage 1 falla → `CHANGES_REQUESTED`, vuelve a 5. `APPROVED` → sigue. |
| 8 · PR + CLOSE | skill `pr-create` | PR creado y URL al usuario; luego `mem_save`, entrada en `history.md`, `current.md` a `idle` y `mem_session_summary`. |

## Reglas duras

- **La Fase 2 no se salta en tarea no-trivial** "porque ya entendiste el ticket". El audit es para el implementer (y para ti en 3 días); delégalo a `ticket-audit`.
- **El implementer arranca leyendo `audit_<ID>.md`** o pierdes contexto ya pagado con tokens.
- **El reviewer no aprueba sin Stage 1;** la aprobación NO depende del implementer.
- **No hay PR sin `APPROVED`** ni dos tickets en paralelo sobre el mismo `current.md`.
- **Trivial** = ≤1 archivo, ≤5 líneas, sin lógica.

## Antes de declarar listo

- El ciclo cerró con un PR vía `pr-create` y su URL al usuario; `current.md` en `idle`.
- Hubo `mem_save` de toda decisión no obvia y `mem_session_summary`.
- Si fue no-trivial: existen `audit_<ID>.md` aprobado, `impl_<feature>.md` con verify en exit 0 y `review_<feature>.md` en `APPROVED`.
