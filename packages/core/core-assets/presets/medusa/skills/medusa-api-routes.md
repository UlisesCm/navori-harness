---
name: medusa-api-routes
description: Reglas para crear/modificar API routes de Medusa v2 — store, admin, middlewares, validación. Aplica antes de tocar src/api/.
type: reference
---

# Medusa API Routes — convenciones del proyecto

## Cuándo usar este skill

Antes de crear o modificar archivos bajo `src/api/`. El file-based routing de Medusa es estricto: el path del archivo es la ruta HTTP y el nombre del export es el método.

## Estructura

```
src/api/
├── store/<resource>/route.ts         # GET/POST /store/<resource>
├── store/<resource>/[id]/route.ts    # GET/POST/PUT/DELETE /store/<resource>/:id
├── admin/<resource>/route.ts         # GET/POST /admin/<resource>
└── middlewares.ts                    # registro central de middlewares
```

## Reglas duras

1. **Un archivo por path.** No mezclar handlers de rutas distintas en el mismo archivo. El router los descubre por convención.
2. **Exports nombrados (`export const GET = ...`)** para cada método. Nunca `export default`.
3. **Tipar request/response.** `MedusaRequest<TBody, TQuery>` y `MedusaResponse`. Si hay body, declarar el shape con un Zod schema en `middlewares.ts` y aplicarlo via `validateAndTransformBody`.
4. **Listas pasan por `validateAndTransformQuery`.** Filtros, paginación y orden se declaran como Zod schema en `middlewares.ts`, no se parsean a mano en el handler.
5. **Errores con `MedusaError`.** Nunca `throw new Error(...)`; el framework convierte `MedusaError` al código HTTP correcto.
6. **No leer DB directo desde el handler.** Resolver el module/service del container y delegar la query ahí.

## Patrón handler GET listado

```ts
export const GET = async (
  req: MedusaRequest,
  res: MedusaResponse,
) => {
  const service = req.scope.resolve(Modules.MY_MODULE)
  const [items, count] = await service.listAndCountFoo(
    req.filterableFields,
    req.queryConfig,
  )
  res.json({ items, count, offset: req.queryConfig.skip, limit: req.queryConfig.take })
}
```

## Antes de declarar el cambio "listo"

- `pnpm tsc --noEmit` (o el `{{qualityGate.fast}}`) en verde.
- Probada la ruta con cURL o REST client: 200 en happy path + 400/404 en edge cases.
- Si declaraste validación Zod nueva, el middleware está registrado en `middlewares.ts`.
- Si la ruta es admin: protegida por `authenticate("user", ...)` en middlewares.
