---
name: new-resource
description: Create an end-to-end resource in an Express + Mongoose backend (Model + Zod schema + controller + routes + mount). Use when adding a new domain (model + endpoints) end to end.
type: reference
---

# new-resource — end-to-end resource

## When to use this skill

When you need to create a new domain (Model + endpoints) end to end. To add an endpoint to a resource that ALREADY exists, use `new-endpoint`.

Before coding, decide: sub-domain (lives under an existing domain → sub-folders within each layer) or top-level (no sub-folder)? Side-effects (email, jobs, queues)? Document them in the plan.

## Steps (strict order)

The order is strict: each step depends on the previous one. Skipping one leaves the route unmounted or the controller without validation.

1. **Model + Interface** — in the Models directory, create `<Resource>.ts`. Exported `I<Resource>` interface extending `mongoose.Document`, exported enums, indexes on frequently-queried fields, `timestamps: true`, default export of the Model. Schema conventions and soft delete: skill `mongoose`.
2. **Zod schema** — in the schemas directory, create `<resource>.schema.ts` with the `body`/`params`/`query` schemas and their DTOs (`z.infer`). Reuse the Model's enums. Validation conventions: skill `zod-validation`.
3. **Controller** — in the controllers directory, create `<Resource>Controller.ts`: a class with one method per HTTP verb (`Create`/`GetAll`/`GetById`/`Update`/`Delete`), signature `(req, res): Promise<void>`. Validation already happened → type with `as <Dto>`. Direct Mongoose ops OK; no trivial Service. `ApiResponse`/`ApiError` contract: skill `express-routes`.
4. **Routes** — in the routes directory, create `<resource>Routes.ts`: instantiate the controller once at the top, chain `validate(schema, target)` before `asyncHandler(...)`. Helpers: skills `zod-validation` and `express-routes`.
5. **Mount** — in the root router, import and mount: `router.use('/resource', resourceRoutes)`. Without this step the route doesn't respond; respect the neighbors' order.
6. **Verify** — see "Before declaring done".

Tests (recommended): unit for the Model (`required`, enum defaults) and integration for the route (400 without a field, 200 with valid payload) with the repo's runner.

## Hard rules

- **Strict order Model → Schema → Controller → Routes → Mount → Verify.** A resource without mount doesn't respond; a controller without schema doesn't validate.
- **Validation ALWAYS with Zod + middleware** `validate`, never inline in the controller (skill `zod-validation`).
- **Responses with `SuccessResponse`, errors with `throw new <X>Error`** — never raw `res.status(...).json(...)` (skill `express-routes`).
- **No trivial Service** that just wraps a `Model.find`: straight from controller to Model.
- **No invented Repository** — the preset doesn't use the repository pattern; don't introduce `IRepository` unless explicitly asked.
- **Index on frequently-queried fields** in the Mongoose schema.
- **Don't mix domains** — a sub-resource outside its sub-folder breaks the convention.

## Before declaring done

- `{{qualityGate.fast}}` green.
- The resource ended up mounted in the root router (step 5) and answers the smoke test (golden path creates, edge without field gives 400).
- All validation goes through the `validate` middleware; the controller doesn't validate inline.
- Responses use `SuccessResponse` and errors `throw new <X>Error`.
- If the domain has side-effects (email, jobs, queues), they ended up in the plan.
