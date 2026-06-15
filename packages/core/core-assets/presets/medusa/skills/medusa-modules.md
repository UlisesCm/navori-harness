---
name: medusa-modules
description: Reglas para crear/modificar módulos de Medusa v2 — entidades, services, workflows. Aplica antes de tocar src/modules/.
---

# Medusa Modules — convenciones del proyecto

## Cuándo usar este skill

Antes de crear o modificar cualquier archivo bajo `src/modules/`. Los módulos en Medusa v2 son el contrato entre dominio y resto del backend; tocar uno sin respetar el shape rompe inyección de dependencias.

## Estructura mínima de un módulo

```
src/modules/<module-name>/
├── index.ts          # default export del Module
├── service.ts        # extends MedusaService
├── models/           # entities con DML (entity model)
│   └── <entity>.ts
└── migrations/       # generadas con `npx medusa db:generate`
```

## Reglas duras

1. **Nunca editar migraciones generadas a mano.** Si cambia el modelo, regenerá con `npx medusa db:generate <ModuleName>`. La excepción son data migrations explícitas — esas sí se escriben, pero en archivo aparte.
2. **El service extiende `MedusaService<{ Entity: typeof Entity, ... }>`.** No reimplementar CRUD — los métodos `list/create/update/delete` salen del factory automáticamente.
3. **Entidades con DML (`model.define(...)`)**, no con decoradores de MikroORM directos. DML es la API pública v2 estable; los decoradores son internos y pueden cambiar.
4. **Resolver del module via container key.** Inyectar con `container.resolve(Modules.<NAME>)` o el key string del manifest, nunca importar el service directo desde otro módulo (rompe el aislamiento del DI).
5. **Workflows en `src/workflows/`, no en el módulo.** El módulo expone primitivas; los workflows orquestan múltiples módulos.

## Tabla rápida

| Necesito | Archivo |
|---|---|
| Definir entidad nueva | `src/modules/<m>/models/<entity>.ts` con `model.define` |
| Exponer query | extender el service con método nuevo |
| Cambiar shape de tabla | editar el modelo → `npx medusa db:generate <m>` |
| Llamar otro módulo | resolver del container, NO importar |
| Lógica multi-módulo | `src/workflows/<workflow>.ts` con `createWorkflow` |

## Antes de declarar el cambio "listo"

- `pnpm tsc --noEmit` (o el `{{qualityGate.fast}}` del proyecto) en verde.
- Si tocaste un modelo: la migración nueva está commited.
- Si tocaste el service: arrancá el server y probá la ruta o método que consume el cambio.
