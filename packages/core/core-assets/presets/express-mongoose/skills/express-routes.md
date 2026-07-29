---
name: express-routes
description: Express routing pattern in a TS service — mandatory asyncHandler, ApiResponse for data, ApiError for errors, validate before the handler, mount under a single prefix. Use when touching presentation/routes or presentation/controllers.
type: reference
---

# Express Routes — service conventions

## When to use this skill

Before creating or modifying files in `presentation/routes` or `presentation/controllers`, or wiring an endpoint. Express 4+. Skipping `asyncHandler` + `validate` + delegation to the controller is the most common source of lost async errors and logic leaked into routing.

## Canonical pattern

```ts
const router = express.Router();
const controller = new ResourceController();

router.route('/')
  .post(
    validate(createResourceSchema, 'body'),
    asyncHandler((req, res) => controller.Create(req, res))
  )
  .get(
    validate(listResourcesQuerySchema, 'query'),
    asyncHandler((req, res) => controller.GetAll(req, res))
  );

export default router;
```

Then it's mounted in `routes/index.ts` under your repo's single prefix (`<API_PREFIX>`): `router.use('/<resource>', resourceRoutes)`. Group sub-domains into a commented section and respect the existing order.

## Repo contracts (don't reinvent them)

- **`asyncHandler`** — wraps the async handler and forwards the `Promise.reject` to `next(err)`, which reaches the global error middleware in `app.ts`. Without it, async errors crash or get lost.
- **`validate(schema, target)`** — validates the input (`'body'`/`'query'`/`'params'`) before touching the controller.
- **`ApiResponse`** — the single HTTP output channel. `new SuccessResponse(msg, data).send(res)`, `new CreatedResponse(...)` (201), `new NotFoundResponse(...)` (404).
- **`ApiError`** — the single error channel: `throw new NotFoundError(...)` / `BadRequestError` / `ForbiddenError`. The global middleware translates them; never handle them by hand.

If any of them doesn't exist in your repo, define the analogous contract before using it.

## Gotchas that bite

- Instantiate the controller **once** at the top of the file, never inside the handler.
- Specific routes before generic ones: `/foo/bar` before `/foo/:id`.
- `app.ts` already defines reserved routes (`/healthcheck`, `/json/*`, `/favicon.ico`); don't touch them.

## Hard rules

1. **`asyncHandler` ALWAYS** wrapping the handler. Without it, async errors get lost.
2. **`validate(schema, target)` BEFORE** the `asyncHandler` when the endpoint parses input. One `validate` per target.
3. **All output via `ApiResponse`**, all errors via `ApiError`. No `res.json`, `res.send`, `res.status(...).json(...)` nor `try/catch` that sends the error response.
4. **Zero logic in the route** — the route only wires; the logic lives in the controller method.
5. **Consistent path** with the neighbors (if they use `GetByX`, don't invent `get-by-x`) and no leading slash that duplicates the prefix.

## Quick table

| I need | How |
|---|---|
| Catch async errors | Wrap the handler in `asyncHandler` |
| Validate input | `validate(schema, 'body'\|'query'\|'params')` before `asyncHandler` |
| Return data | `new SuccessResponse(msg, data).send(res)` |
| Throw a domain error | `throw new NotFoundError(...)` / `BadRequestError` |
| Mount the resource | `router.use('/<resource>', xRoutes)` in `routes/index.ts` |
| Business logic | Controller method, never in the route |

## Before declaring done

- Every async handler is wrapped in `asyncHandler`; no manual `try/catch` sends the error.
- All output goes through `ApiResponse`; no direct `res.json`/`res.send`.
- The route only wires; the logic lives in the controller.
- `{{qualityGate.fast}}` green.
