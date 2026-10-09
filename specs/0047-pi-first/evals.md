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

## E2 M3 (T5, T6): evidencia y cierre en Pi

Feature `0047-pi-first-e2`. Solo se registran resultados ejecutados, tomados del handoff de implementación.

### Ejecutado

- A3 (`first-class-evidence.test.ts`, `first-class-receipts.test.ts`): ronda 2: exit 0; 2 archivos / 12 tests pasan (ronda 1: 10 tests).
- Respaldado por test (ronda 2): abort/timeout rechazan sin `exit_code` y no registran evidencia; el fingerprint coincide con `fingerprintTree`.
- Regresión pi + plan + lib/plan: exit 0; 23 archivos / 258 tests pasan.
- `bun run check:fast`: exit 0.

### Hallazgo del probe de contrato de éxito (Pi 1.1.0)

- El `outputSchema` del bash builtin expone `structuredContent.exit_code`; es la señal terminal de éxito.
- Un exit distinto de cero produce `isError`.
- Abort y timeout lanzan error sin `exit_code`, por lo que no cuentan como evidencia.
- El builtin se identifica por `sourceInfo` `builtin:bash`; una herramienta reemplazada no se acepta como evidencia.
- El observador (`isVerifiedBashSuccess` en `extension-source.ts`) falla cerrado: solo registra con `builtin:bash` y `exit_code` 0.
- T6: la sesión Pi se detecta por `PI_SESSION_ID` más `engines` con `pi`, y exige `evidenceRequired` en `plan update`.

### No ejecutado

- Cierre en una sesión Pi viva.
- Gate completo (`bun check`): no ejecutado; lo corre el reviewer a continuación.

### Límites conocidos

- El procedimiento de fingerprint es una tercera copia (`evidence.ts`, `bash-outcome.sh`, extensión).
- Los criterios ligados a la entrega (delivery-bound) no se registran desde Pi.
- Pi < 1.1.0 falla cerrado en runtime (sin `structuredContent`/`getAllTools` no hay evidencia); la tabla de capabilities no se tocó, así que no se bloquea por versión.
