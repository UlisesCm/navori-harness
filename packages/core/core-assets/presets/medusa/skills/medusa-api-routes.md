---
name: medusa-api-routes
description: Rules for creating/modifying Medusa v2 API routes — store, admin, middlewares, validation. Use when creating or modifying files under src/api/.
type: reference
---

# Medusa API Routes — project conventions

## When to use this skill

Before creating or modifying files under `src/api/`. Medusa's file-based routing is strict: the file path is the HTTP route and the export name is the method.

## Structure

```
src/api/
├── store/<resource>/route.ts         # GET/POST /store/<resource>
├── store/<resource>/[id]/route.ts    # GET/POST/PUT/DELETE /store/<resource>/:id
├── admin/<resource>/route.ts         # GET/POST /admin/<resource>
└── middlewares.ts                    # central middleware registry
```

## Hard rules

1. **One file per path.** Don't mix handlers from different routes in the same file. The router discovers them by convention.
2. **Named exports (`export const GET = ...`)** for each method. Never `export default`.
3. **Type request/response.** `MedusaRequest<TBody, TQuery>` and `MedusaResponse`. If there's a body, declare the shape with a Zod schema in `middlewares.ts` and apply it via `validateAndTransformBody`.
4. **Lists go through `validateAndTransformQuery`.** Filters, pagination and ordering are declared as a Zod schema in `middlewares.ts`, not parsed by hand in the handler.
5. **Errors with `MedusaError`.** Never `throw new Error(...)`; the framework converts `MedusaError` to the correct HTTP code.
6. **Don't read the DB directly from the handler.** Resolve the module/service from the container and delegate the query there.

## GET-listing handler pattern

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

## Before declaring the change "done"

- `pnpm tsc --noEmit` (or the `{{qualityGate.fast}}`) green.
- Route tested with cURL or a REST client: 200 on happy path + 400/404 on edge cases.
- If you declared new Zod validation, the middleware is registered in `middlewares.ts`.
- If the route is admin: protected by `authenticate("user", ...)` in middlewares.
