# Harness por workspace — solo lo que el motor alcanza — Design

## La evidencia

Medido el 2026-09-09 sobre los dos monorepos de campo, con navori 0.8.0 recién
renderizado en ambos.

### Qué alcanza Claude Code desde la raíz del repo

| Pieza del workspace | ¿Se alcanza? | Evidencia |
|---|---|---|
| `CLAUDE.md` | **sí** | los `CLAUDE.md` anidados se cargan al tocar archivos del directorio |
| `.claude/skills/` | **sí**, en carga diferida | doc oficial de Skills: *"Skills in a `.claude/skills/` directory below where you started don't load at startup. They load the first time Claude reads or edits a file in that subdirectory"* |
| `.claude/agents/` | **no** | doc oficial de Subagents: *"discovered by walking **up** from the current working directory"* — hacia arriba, nunca hacia abajo |
| `.claude/settings.json` | **no** | la tabla de precedencia de Settings no lista niveles anidados; y arrancar en un subdirectorio lee el archivo de la raíz del repo |
| `.claude/hooks/`, `.claude/scripts/` | **no** | todo hook se registra como `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/<x>.sh"` (`build-settings.ts:111,140,159,183,208,220,231,256,269,289`), y `$CLAUDE_PROJECT_DIR` resuelve a la raíz |
| `.claude/context/` | **no** | ningún `CLAUDE.md` ni asset lo referencia |
| `.mcp.json` | **no** | registro por proyecto, leído en la raíz |

La fila de hooks tiene además prueba en disco, que es la que cierra el caso: el
hook `managed-drift-watch` escribe `.claude/.managed-drift-stamp` en cada
PostToolUse. En los dos repos existe **un solo stamp, el de la raíz**. Ningún
workspace tiene uno, después de meses de uso.

### Cuánto pesa

| | moonar (111 archivos) | navori-health (149) |
|---|---|---|
| workspace `agents/` | 16 | 24 |
| workspace `hooks/` + `scripts/` | 18 | 27 |
| workspace `settings.json` + `context/` | 4 | 6 |
| **inalcanzable** | **38 (34%)** | **57 (38%)** |

> **Recuento corregido durante la implementación.** La tabla de arriba olvidó
> `scripts/` y `.mcp.json`, que la tabla de evidencia sí lista como
> inalcanzables: el total real es **48 (43%)** en moonar y **72 (48%)** en
> navori-health. El recorte es casi la mitad de cada PR de bump, no un tercio.
> De esos, `render` borra 40 en moonar (los de `scripts/` quedan para el
> usuario, ver Decisions).

Y 29 de los 35 archivos de cada workspace son byte-idénticos a los de la raíz
ignorando el stamp de versión, así que ni siquiera aportan contenido propio.

### Por qué el escenario que justificaba la copia no ocurre

`specs/0001-monorepo-render-per-workspace.md`, open question #3, eligió
conscientemente *"render full `.claude/` por app (más simple, mayor footprint)"*.
La premisa era que alguien trabajaría desde adentro del workspace.

Revisados los 25 directorios de proyecto de `~/.claude/projects` y el `cwd` de cada
transcript: **cero sesiones desde un workspace** en los dos monorepos. El único
`cwd` en subdirectorio de todo el parque es `navori-harness/packages/cli`, un
directorio que no tiene harness propio — y esa sesión funcionó igual.

## Approach

Recortar el render del workspace a lo que el motor alcanza, con una salida para
quien sí trabaje desde adentro.

`monorepo.workspaceHarness: "minimal" | "full"`, default `"minimal"`:

- **`minimal`** — el workspace recibe `CLAUDE.md` + `.claude/skills/`. Nada más.
- **`full`** — el comportamiento actual, byte por byte.

**Por qué un flag y no un recorte a secas.** Lo inalcanzable lo es *desde la raíz*.
Quien haga `cd apps/api && claude` sí activa esos archivos, y navori es un producto
con más usuarios que este parque. Un flag cuesta un campo de schema; equivocarse
sin él cuesta romperle el harness a alguien sin decírselo.

**Por qué el default es `minimal` y no `full`.** El default tiene que describir el
caso medido, no el hipotético. Y la asimetría del error apunta al mismo lado: bajo
`minimal`, quien trabaje desde un workspace sigue teniendo agentes, hooks y
settings — los de la raíz, que el descubrimiento hacia arriba encuentra. No pierde
capacidad, pierde la posibilidad de *override por workspace*, que hoy nadie usa
(los 5 workspaces del parque declaran `qualityGate: null`). Bajo `full` como
default, todos siguen pagando el 34-38% para siempre.

**Lo que NO se toca:** el `CLAUDE.md` del workspace y sus skills. Ambos funcionan,
y la carga diferida de skills es justo el comportamiento correcto para un
monorepo — tocas `apps/mobile/...` y aparece `tamagui`. Recortar ahí sería quitar
la única parte del modelo que sí está entregando valor.

## Components

- `packages/cli/src/lib/schema.ts:89` — `MonorepoSchema` gana
  `workspaceHarness: z.enum(["minimal","full"]).default("minimal")` — cubre R1.
- `packages/cli/scripts/gen-schemas.mjs` — el JSON Schema publicado se regenera
  desde el zod; `schema-publish.test.ts` falla si queda atrás — cubre R1.
- `packages/cli/src/engines/claude/index.ts:384` — `renderClaudeEngine` gana la
  opción `harnessScope`; bajo `"minimal"` se saltan el plan de `agents/`,
  `hooks/`, `scripts/`, `context/`, `planSettings` y `planMcpRegistration` —
  cubre R2 y R3.
- `packages/cli/src/commands/render.ts:347,411` — los dos call sites de workspace
  pasan `harnessScope` desde el config; el render de raíz nunca lo pasa — cubre R2.
- `packages/cli/src/lib/removable.ts` — `planOrphanRemoval` gana el caso "archivo
  de workspace fuera del alcance de `minimal`", reusando la marca de autoría que
  ya distingue lo de navori de lo del usuario — cubre R4 y R5.
- `packages/cli/src/lib/health.ts` — `scanOrphanedEngineOutputs` gana la detección
  de un `.claude/` en un subdirectorio no declarado como workspace — cubre R6.
- `packages/core/core-assets/managed/contexto-monorepo.md` — bajo `minimal`, el
  bloque dice que agentes y hooks son los de la raíz — cubre R7.

## Decisions

- **Reusar `planOrphanRemoval` en vez de un borrador nuevo.** El caso "navori ya
  no es dueño de este archivo, bórralo si lo escribió él y consérvalo si no" ya
  existe para engines retirados (`--prune`, #312/#521), con su marca de autoría y
  su reporte de conservados. Un segundo mecanismo para la misma pregunta es un
  segundo mecanismo que se desincroniza.
- **El recorte borra, no deja huérfanos.** Un `apps/api/.claude/agents/` que deja
  de renderizarse pero se queda en disco es peor que el estado actual: sigue
  ocupando el repo y ahora además nadie lo actualiza — exactamente el huérfano que
  R6 va a reportar en `packages/cli/.claude/`. Por eso R4 borra en el mismo render.
- **`scripts/` NO entra al borrado — corregido durante la implementación.** El
  design decía "el recorte borra, no deja huérfanos", y para `scripts/` no se
  puede cumplir: un script de plugin es el ÚNICO archivo que navori genera sin
  prueba de autoría. Hooks, agents y skills llevan marcador `navori:managed`;
  `scriptAssets` es `{ src, dest, exec }`, sin id. El test de autoría solo puede
  responder "foreign", así que el render conservaría los mismos 4 archivos por
  workspace en cada corrida, sin poder borrarlos nunca — un aviso que nadie
  puede limpiar, que es ruido, no señal.

  Dos salidas se evaluaron y se descartaron. Aceptar la línea en prosa
  `# Generated by @navori/plugin-…` apoya una decisión DESTRUCTIVA en una
  convención que nada obliga, con dos fallos silenciosos: un plugin que la omita
  queda indeleteable, y un archivo del usuario que la copie se vuelve borrable.
  Comparar bytes renderizados cae en lo que este mismo design prohíbe dos
  bullets más arriba: un segundo mecanismo para la misma pregunta.

  La causa raíz es que `scriptAssets` no tiene `managedId` — y por eso el prune
  de engines deshabilitados también deja sus scripts para siempre, un hueco que
  **precede a esta spec**. Arreglarlo ahí hace que el mecanismo único existente
  los cubra. Hasta entonces: `render` deja de escribirlos (R2 se cumple),
  `doctor` reporta los que quedaron (R6) y la limpieza de una vez es del
  usuario, porque navori no borra lo que no puede probar que escribió.

  Medido tras el cambio en moonar: 40 borrados, **0 conservados** — el render
  queda en reposo en vez de avisar para siempre.

- **`context/` entra al recorte aunque no sea inalcanzable "por el motor".** Nadie
  lo referencia desde ningún `CLAUDE.md`; su inalcanzabilidad es por ausencia de
  lector, no por resolución de rutas. El efecto es el mismo.
- **`workspaceHarness` vive en `monorepo`, no en cada workspace.** Es una decisión
  sobre cómo se trabaja el repo, no sobre qué es cada app. Un repo donde a veces
  entras a un workspace lo hace para todos.

## Migration

Un repo ya renderizado con navori < esta versión tiene los archivos en disco y,
en repos donde el harness se versiona, commiteados.

1. Al primer `render` tras el upgrade, `workspaceHarness` resuelve a `"minimal"`
   por el default del schema — sin editar el config.
2. El render escribe `CLAUDE.md` + skills, y el plan de remoción borra lo que
   navori había escrito fuera de ese alcance, reportando cada ruta.
3. Un archivo que el usuario haya puesto ahí a mano se conserva y se reporta (R5).

El primer PR de rollout por repo será grande **en borrados** — ~38 archivos en
moonar, ~57 en navori-health — y todos los siguientes serán ~34-38% más chicos.
Ese PR es el punto donde conviene leer el reporte de conservados: es la única
señal de que algo en esos directorios no era de navori.

Quien quiera el comportamiento anterior declara `"workspaceHarness": "full"` antes
de renderizar.

## Testing strategy

Cada test responde a un riesgo nombrado arriba, no a una cuota.

- **El recorte recorta lo correcto** (R2): render de un monorepo con dos
  workspaces bajo `minimal` → existen `CLAUDE.md` y `.claude/skills/`; NO existen
  `agents/`, `hooks/`, `scripts/`, `context/`, `settings.json`, `.mcp.json`.
- **`full` no cambió nada** (R3): el snapshot dorado de un monorepo bajo `full`
  es idéntico al de hoy. Es el test que protege al usuario que sí entra al
  workspace.
- **El borrado respeta lo ajeno** (R4, R5): un `apps/api/.claude/agents/mio.md`
  sin marca de navori sobrevive al render y sale en el reporte de conservados,
  mientras el `reviewer.md` que navori escribió desaparece.
- **Idempotencia** (R2): dos renders seguidos bajo `minimal` → el segundo no
  reporta cambios ni borrados.
- **doctor caza el huérfano** (R6): un `.claude/` en un directorio no declarado
  como workspace se reporta. Caso real de regresión: `packages/cli/.claude/` en
  este mismo repo, congelado en 0.6.5 desde el 2026-09-02.

## NOT in scope

- **Mover las skills del workspace a la raíz.** Se consideró y se descartó con
  dato: la carga diferida ya las entrega. No hay problema que resolver.
- **Re-litigar el `CLAUDE.md` por workspace.** Funciona, y es lo que hace que el
  preset por app (`medusa`, `nextjs`, `nestjs`) llegue al agente.
- **Override de `qualityGate` por workspace.** El mecanismo existe y nadie lo usa;
  que esté sin configurar es una decisión de cada repo, no un defecto de navori.
- **Borrar el huérfano de `packages/cli/.claude/`.** R6 lo *reporta*; borrarlo es
  un commit aparte en este repo, no trabajo de esta spec.
