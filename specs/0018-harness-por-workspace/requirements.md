# Harness por workspace — solo lo que el motor alcanza — Requirements

## Context

En un monorepo, `render` escribe un `.claude/` completo en cada workspace: agents,
skills, hooks, scripts, settings y context. Medido en los dos monorepos de campo
(moonar-medusa-monorepo y navori-health), **29 de 35 de esos archivos son
byte-idénticos a los de la raíz**, y la mayoría vive en directorios que Claude Code
no lee cuando la sesión arranca en la raíz del repo — que es el 100% de las
sesiones registradas.

El costo es visible: un bump de versión produce PRs de 111 y 149 archivos, de los
cuales el 34% y el 38% son archivos que ninguna configuración puede activar.

Esta spec NO re-litiga el render por workspace: el `CLAUDE.md` del workspace y sus
skills funcionan y se quedan. Recorta lo que el motor demostrablemente no alcanza,
y deja una salida para quien sí trabaje desde adentro de un workspace.

## Requirements (EARS)

- **R1** — El sistema SHALL exponer `monorepo.workspaceHarness` con valores
  `"minimal"` y `"full"`, con default `"minimal"`.

- **R2** — WHEN el render procesa un workspace de monorepo bajo `"minimal"`, el
  sistema SHALL escribir únicamente el `CLAUDE.md` del workspace y su
  `.claude/skills/`, y SHALL omitir `agents/`, `hooks/`, `scripts/`, `context/`,
  `settings.json` y `.mcp.json`.

- **R3** — WHEN el render procesa un workspace bajo `"full"`, el sistema SHALL
  escribir el mismo conjunto de archivos que hoy, sin cambios de contenido.

- **R4** — WHEN un render bajo `"minimal"` encuentra en `<workspace>/.claude/`
  archivos que navori escribió en un render anterior y que ya no le corresponden,
  el sistema SHALL removerlos y reportar cada ruta removida.

- **R5** — IF un archivo bajo `<workspace>/.claude/` no lleva marca de autoría de
  navori THEN el sistema SHALL conservarlo, no removerlo, y reportarlo como
  conservado con su razón.

- **R6** — `navori doctor` SHALL reportar todo `.claude/` que viva en un
  subdirectorio del repo que el config no declara como workspace de monorepo,
  porque ningún render lo alcanza y su contenido queda congelado en la versión con
  la que se escribió.

- **R7** — El sistema SHALL documentar en el `CLAUDE.md` del workspace, bajo
  `"minimal"`, que sus agentes y hooks son los de la raíz del repo, de modo que la
  ausencia de `<workspace>/.claude/agents/` no se lea como harness incompleto.
