---
name: medusa-modules
description: Rules for creating/modifying Medusa v2 modules — entities, services, workflows. Use when creating or modifying files under src/modules/.
type: reference
---

# Medusa Modules — project conventions

## When to use this skill

Before creating or modifying any file under `src/modules/`. Modules in Medusa v2 are the contract between the domain and the rest of the backend; touching one without respecting the shape breaks dependency injection.

## Minimal structure of a module

```
src/modules/<module-name>/
├── index.ts          # default export of the Module
├── service.ts        # extends MedusaService
├── models/           # entities with DML (entity model)
│   └── <entity>.ts
└── migrations/       # generated with `npx medusa db:generate`
```

## Hard rules

1. **Never edit generated migrations by hand.** If the model changes, regenerate with `npx medusa db:generate <ModuleName>`. The exception is explicit data migrations — those are written, but in a separate file.
2. **The service extends `MedusaService<{ Entity: typeof Entity, ... }>`.** Don't reimplement CRUD — the `list/create/update/delete` methods come from the factory automatically.
3. **Entities with DML (`model.define(...)`)**, not with MikroORM decorators directly. DML is the stable v2 public API; the decorators are internal and can change.
4. **Resolve the module via container key.** Inject with `container.resolve(Modules.<NAME>)` or the manifest's key string, never import the service directly from another module (breaks DI isolation).
5. **Workflows in `src/workflows/`, not in the module.** The module exposes primitives; workflows orchestrate multiple modules.

## Quick table

| I need | File |
|---|---|
| Define a new entity | `src/modules/<m>/models/<entity>.ts` with `model.define` |
| Expose a query | extend the service with a new method |
| Change table shape | edit the model → `npx medusa db:generate <m>` |
| Call another module | resolve from the container, NOT import |
| Multi-module logic | `src/workflows/<workflow>.ts` with `createWorkflow` |

## Before declaring the change "done"

- `pnpm tsc --noEmit` (or the project's `{{qualityGate.fast}}`) green.
- If you touched a model: the new migration is committed.
- If you touched the service: start the server and test the route or method that consumes the change.
