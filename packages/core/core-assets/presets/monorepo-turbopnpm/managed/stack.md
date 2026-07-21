## Stack — Monorepo (Turborepo + pnpm)

Este directorio es la **raíz de un monorepo**: orquesta, no aloja producto. El código real vive en los workspaces (`apps/*`, `packages/*`), y **cada workspace tiene su propio harness** (su `CLAUDE.md` + `.claude/`) con el preset de su stack. El mapa de workspaces vivos está en el bloque "## Monorepo — raíz".

Regla de oro: **enruta el trabajo al workspace dueño**. Un cambio de producto se hace desde el `CLAUDE.md` de su app, no desde aquí. La raíz solo se toca para lo transversal: `turbo.json`, `pnpm-workspace.yaml`, tsconfig/eslint base, scripts de CI, deps compartidas.

- **Tareas scopeadas, no globales.** Corre por workspace con el filtro de Turbo: `pnpm turbo run <task> --filter=<workspace>` (o `--filter=./apps/<x>`). Evita correr el pipeline entero cuando solo tocaste un app.
- **No cruces imports entre workspaces por ruta relativa** (`../../otro-app`). Consume un hermano por su nombre de paquete con el protocolo `workspace:*`; si no es un paquete publicable, probablemente el código debería vivir en un `packages/*` compartido.
- **La dep va en el `package.json` del workspace que la usa**, no en la raíz. Deps en la raíz son solo tooling del monorepo (turbo, changesets, linters compartidos).

Antes de tocar `turbo.json`, `pnpm-workspace.yaml` o mover deps entre workspaces, aplica el skill `turbo-workspaces`.
