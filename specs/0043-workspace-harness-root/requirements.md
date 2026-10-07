# Harness de workspace con arranque desde la raíz — Requirements

## Contexto

En un monorepo, `monorepo.workspaceHarness` solo acepta `minimal | full`, y ninguno sirve cuando el equipo arranca Claude Code siempre desde la raíz (#1143): `minimal` duplica en cada workspace las skills genéricas que ya existen en la raíz, y `full` genera hooks, agentes, settings y `.mcp.json` que Claude Code ignora desde la raíz. La mitad del ticket sobre `status` (drift 0 con render pendiente) ya está resuelta en `main` (`computeRenderPending` en `commands/status.ts`). El usuario aceptó SDD el 2026-10-06. Extiende la spec 0018.

## Alcance y restricciones

- Un solo PR que cierra #1143 completo, dividido en commits atómicos con el gate verde tras cada uno.
- El default sigue siendo `minimal`; no hay migración de configuración (el valor nuevo es aditivo).
- Toda eliminación en el repo del usuario pasa por la reconciliación con marcador existente (`planOrphanRemoval`, spec 0018) y por backup; los archivos creados por el usuario nunca se borran.
- Codex bajo `minimal` queda como hoy (decisión del usuario); Codex solo se recorta bajo `root`.
- Decisiones del usuario (2026-10-06): el formato de nombre para skills que chocan es `<workspace>-<id>`; `root` sube a la raíz las skills de librería y de preset de los workspaces, y en las skills core y de workflow prevalece la raíz.

## Requisitos (EARS)

- **R1** — El sistema SHALL aceptar `root` como valor de `monorepo.workspaceHarness` junto a `minimal` y `full`, con `minimal` como default, y SHALL rechazar cualquier otro valor.
- **R2** — WHEN renderiza un workspace bajo `minimal`, el sistema SHALL omitir cada skill cuyo contenido renderizado sea idéntico byte a byte al de la misma skill renderizada en la raíz, y SHALL conservar las skills cuyo contenido difiera o que solo existan en ese workspace.
- **R3** — WHEN un workspace bajo `minimal` contiene copias generadas por navori de skills idénticas a las de la raíz, el sistema SHALL eliminarlas mediante la reconciliación con marcador y backup, y SHALL conservar y reportar los archivos sin marcador de navori.
- **R4** — WHEN renderiza un workspace bajo `root`, el sistema SHALL escribir para Claude únicamente su `CLAUDE.md`, sin `.claude/` en el workspace.
- **R5** — WHEN renderiza la raíz de un monorepo con workspaces bajo `root`, el sistema SHALL generar en la raíz las skills de librería y de preset propias de esos workspaces, sin modificar el bloque de contexto del proyecto raíz; para las skills core y de workflow SHALL prevalecer la versión de la raíz, sin variantes por workspace.
- **R6** — IF dos workspaces bajo `root` producen la misma skill de librería o de preset con contenido distinto THEN el sistema SHALL generarlas en la raíz con el nombre `<workspace>-<id>` y una descripción que identifique el workspace; WHEN el contenido es idéntico, SHALL generar una sola skill con el id original.
- **R7** — WHEN un workspace pasa a `root` y contiene `.claude/` generado por navori, el sistema SHALL eliminar esos archivos mediante la reconciliación con marcador y backup, y SHALL conservar y reportar los archivos del usuario.
- **R8** — WHEN renderiza un workspace bajo `root` con el engine Codex activo, el sistema SHALL escribir únicamente su `AGENTS.md` en el workspace, reconciliar `.codex/` y `.agents/skills` generados por navori, y generar las skills de librería en `.agents/skills` de la raíz; bajo `minimal` y `full` el comportamiento de Codex SHALL permanecer sin cambios.
- **R9** — WHEN se ejecuta `render` dos veces seguidas en un monorepo bajo `minimal` o `root`, la segunda ejecución SHALL reportar cero cambios, y `navori status` SHALL reportar cero drift y cero render pendiente.
- **R10** — WHEN `navori doctor` o el diagnóstico de harness obsoleto evalúan un workspace bajo `root` o `minimal`, el sistema SHALL tratarlo como harness recortado: no SHALL reportar como faltante lo que el modo omite, y SHALL reportar restos generados por navori que el modo ya no escribe.
- **R11** — WHEN un workspace está configurado como `full`, `navori doctor` SHALL mostrar un aviso informativo de que hooks, agentes, settings y `.mcp.json` del workspace no se usan si la sesión arranca en la raíz, sin cambiar el veredicto de salud.
- **R12** — WHEN genera el `CLAUDE.md` de un workspace bajo `root`, el sistema SHALL indicar que las skills y la configuración viven en la raíz, en español e inglés según el idioma del proyecto.
- **R13** — WHEN un workspace bajo `minimal` o `root` omite skills, los avisos de skills no inyectadas y el índice de skills SHALL seguir siendo correctos para la raíz y para cada workspace.
