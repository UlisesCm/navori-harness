---
name: turbo-workspaces
description: Cómo navegar y operar un monorepo Turborepo + pnpm — correr tareas scopeadas, agregar deps al workspace correcto, compartir código sin acoplar. Aplica antes de tocar turbo.json, pnpm-workspace.yaml o mover deps.
type: reference
---

# Turborepo + pnpm — operación del monorepo

## Cuándo usar este skill

Antes de: correr tareas de build/test/lint, agregar o mover una dependencia, crear un workspace nuevo, o editar `turbo.json` / `pnpm-workspace.yaml`. En un monorepo, "dónde" vive un cambio importa tanto como "qué" cambia.

## Correr tareas (siempre scopeadas)

```bash
# Una tarea en UN workspace (por nombre de paquete o por ruta)
pnpm turbo run build --filter=@scope/backend
pnpm turbo run test --filter=./apps/storefront

# Un workspace y todo lo que depende de él (aguas abajo)
pnpm turbo run build --filter=@scope/backend...

# Solo lo afectado por tu diff vs una base
pnpm turbo run test --filter='...[origin/main]'
```

Regla: no corras el pipeline entero (`turbo run build`) si solo tocaste un app. Turbo cachea, pero el ruido de logs y el tiempo de arranque sí cuestan. Deja el run global para CI.

## Agregar dependencias (al workspace correcto)

```bash
# Dep de un app concreto — NO en la raíz
pnpm add zod --filter @scope/backend

# Dep de tooling del monorepo (turbo, changesets, prettier) — esa sí va en la raíz
pnpm add -Dw turbo
```

- Una lib de producto (`stripe`, `@tanstack/react-query`, …) va en el `package.json` del app que la importa. Si aparece en la raíz, el harness de ese app no la "ve" y su skill no se materializa donde corresponde.
- Consumir un workspace hermano se declara explícito: `"@scope/ui": "workspace:*"` en el `package.json` del consumidor. Nunca por `import '../../ui/src/...'`.

## Compartir código sin acoplar

- Código usado por ≥2 apps → extráelo a un `packages/*` con su propio `package.json` y su preset (`navori scan` lo detecta como workspace nuevo).
- Tipos/utilidades cross-app también van en un `packages/*`, no en `apps/*`. Un app nunca es dependencia de otro app.

## turbo.json — lo esencial

- Cada `task` declara sus `dependsOn` (`^build` = build de las deps primero) y sus `outputs` (para cachear). Un output mal declarado = cache que no invalida o que no cachea.
- Antes de editar el pipeline, verifica el efecto con `pnpm turbo run <task> --dry-run` (lista qué correría y desde qué caché) antes de correrlo de verdad.
