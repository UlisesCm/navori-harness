# Evals — 0047-pi-first (E1 M1, T15)

Solo se registran resultados ejecutados. Lo no ejecutado se marca "no ejecutado".

## Bootstrap Pi-only (`engines: ["pi"]`)

| Momento | Resultado | Origen |
| --- | --- | --- |
| Antes | Dry-run sin destinos `AGENTS.md`/`CLAUDE.md` (gap G1 de [requirements.md](requirements.md)). | Cita de G1; no se re-ejecutó contra el código previo en este ciclo. |
| Después | El dry-run de `renderPiEngine` en un directorio vacío lista `.pi/navori.json`, `.pi/extensions/navori.ts`, `.pi/agents/{implementer,reviewer,scout}.md` y `AGENTS.md`. | Ejecutado (script ad hoc con bun). |
| Después | El render real escribe `AGENTS.md` de 14680 bytes con un bloque gestionado `navori-agents`, con secciones "Session startup", "Session closeout", "Workflow" y "Available skills" (sin rutas), y skills en `.agents/skills/<id>/SKILL.md`. | Ejecutado. |
| Después | No se crean `CLAUDE.md`, `.claude/` ni `.codex`; el cuerpo no contiene las cadenas `.claude/skills` ni `CLAUDE.md`. | Ejecutado. |

## Planning y close

- Ejecutado: el contexto emitido incluye "Session startup", "Session closeout" y el texto de Workflow análisis -> plan -> implementación.
- No ejecutado: efecto conductual sobre un modelo Pi vivo.

## Límites observados

- El encabezado de `AGENTS.md` dice "Read by Cursor, Codex, Gemini and Copilot" (prosa genérica; no nombra a Pi).
- El cuerpo es de 14.7 KB siempre cargado; el costo en tokens no se midió.
- El bloque de orquestación se omite para Pi (depende del Agent tool de Claude).

## Tests

- `first-class-context.test.ts`: 6 tests pasan.
- A1 (`first-class-roles`, `first-class-approvals`, `first-class-context`): 18 tests pasan.

## No ejecutado: comparación RED/GREEN en vivo

La comparación aislada con el mismo modelo, proyecto y tarea que exige la sección de evals de [design.md](design.md) no se ejecutó. Requiere una sesión Pi real (>= 1.1.0) con un modelo fijo, un proyecto Pi-only sin contexto (RED) y otro con el contexto renderizado (GREEN), y la misma tarea de bootstrap/planning/close en ambos. Queda como smoke manual del usuario.
