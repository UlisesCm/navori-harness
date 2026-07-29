---
name: new-endpoint
description: Add a new endpoint to an existing Express + Mongoose resource (Zod schema + controller method + route). Use when you need to add an endpoint without creating a new Model.
type: reference
---

# new-endpoint — add an endpoint to an existing resource

## When to use this skill

When you need to add an endpoint to a resource whose Model, controller and base route already exist. To create a resource from scratch (Model + controller + routes), use `new-resource`.

Prerequisites: the controller, the Model + interface and the `<resource>Routes.ts` (with its `router.route('/')`) already exist.

## Steps (strict order)

1. **Zod schema** — in the resource's `<resource>.schema.ts`, add the input schema (`body`/`params`/`query`) and its DTO (`z.infer`). If the file already exists, add it right there and export it: do NOT create parallel files. Conventions: skill `zod-validation`.
2. **`validate` middleware** — if it's the first time it's used in the service, create the helper in the helpers directory (defined by the `zod-validation` skill). Check first that it doesn't exist; if it exists with a different signature, align to it or ask the user.
3. **Method in the Controller** — add the method to the existing class: signature `(req, res): Promise<void>`, already-validated input → type with `as <Dto>`, direct Mongoose ops OK, response with `SuccessResponse`, errors with `throw new <X>Error`, `Logger` instead of `console.log`, JSDoc with HTTP verb + route + return. `ApiResponse`/`ApiError` contract: skill `express-routes`.
4. **Route** — add the route in `<resource>Routes.ts` with `validate(schema, target)` before `asyncHandler(...)`. Specific routes before generic ones (`/foo/bar` before `/foo/:id`); casing consistent with the neighbors. Helpers: skills `zod-validation` and `express-routes`.
5. **Verify** — see "Before declaring done".

Tests (optional): not for trivial CRUD; DO required if the endpoint carries non-trivial conditional logic or complex aggregations. Integration with the repo's runner (400 on invalid ObjectId, 404 on no results).

## Hard rules

- **Inline validation in the controller, no** — use Zod + `validate` middleware (skill `zod-validation`).
- **Responses with `SuccessResponse`, errors with `throw new <X>Error`** — never raw `res.status(...).json(...)` (skill `express-routes`).
- **Don't pass the whole `req` untyped** body/params/query — the Zod middleware types it, you use `as <Dto>`.
- **The controller is instantiated once** at the top of the routes file — no `new XController()` inside the route method.
- **Don't forget `asyncHandler`** — without it, async errors get lost or crash the server.

## Before declaring done

- `{{qualityGate.fast}}` green.
- The endpoint answers the smoke test: golden path OK + edge case (invalid ObjectId) returns 400 with a clear message.
- The new schema ended up in the resource's schema file, not a parallel one.
- The route uses `validate(...)` before `asyncHandler(...)` and the controller doesn't validate inline.
- If the endpoint carries non-trivial logic or aggregations, you left an integration test.
