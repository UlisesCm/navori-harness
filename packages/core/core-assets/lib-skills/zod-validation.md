---
name: zod-validation
description: Use when creating schemas or touching input validation of body/query/params — input validation with Zod in Express: per-resource schemas, generic validate middleware, inferred DTOs.
type: reference
---

# Zod Validation — the canonical pattern

One schema per resource (`<resource>.schema.ts`), validated by a generic middleware that replaces `req[target]` with the parsed and typed value. The DTO comes from `z.infer`.

## When to use this skill

When creating a schema, adding validation to an endpoint, inferring a DTO, or touching input from body/query/params.

## The pattern

The middleware lives in `helpers/validate.ts`: it parses `req[target]` against the schema, and on failure throws `BadRequestError(\`${path}: ${first.message}\`)` with the first issue. On success, it reassigns `req[target] = parsed`. Schema and DTO:

```ts
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ObjectId');

export const createResourceSchema = z.object({
  owner: objectId,
  resourceType: z.nativeEnum(ResourceTypeEnum),
  page: z.coerce.number().int().positive().default(1)
});
export const updateResourceSchema = createResourceSchema.partial();
export type CreateResourceDto = z.infer<typeof createResourceSchema>;
```

In the route: `router.post('/', validate(createResourceSchema, 'body'), ...)`. In the controller the cast `req.body as CreateResourceDto` is safe because the middleware already parsed it.

## Gotchas that bite

- **A bare ObjectId** (`z.string()`) lets `"abc"` through; Mongoose throws a CastError 500 instead of a clean 400. Always use the `objectId` helper.
- **Query strings are always strings.** Without `z.coerce`, `z.number()` rejects them. Use `z.coerce.number()` / `z.coerce.date()`. **Footgun:** `z.coerce.number()` uses `Number()`, so `""`/`" "`/`null` → `0` (an empty `?page=` passes as `0`). If it matters, set explicit bounds or `z.string().regex(...).transform(Number)`.
- **Unknown keys are silently dropped:** `z.object({...})` *strips*, so a typo in the body (`{ ammount }`) is lost with no error. On mutation endpoints use `z.strictObject({...})` to catch it.
- **Version:** this skill assumes Zod v3. In **v4**: `z.nativeEnum`→`z.enum`, `z.string().datetime()`→`z.iso.datetime()`, and `{ message }`→`{ error }` in the error options.

## Hard rules

1. All validation in the schema, never inline in the controller.
2. The schema lives in `<resource>.schema.ts`, never in the routes.
3. DTO always with `z.infer` — don't maintain two parallel types.
4. No `z.any()`: it equals `any`, forbidden in new code.
5. A single validator per endpoint — don't mix Joi + Zod (when migrating Joi→Zod, migrate the whole endpoint).
6. ObjectId with the `objectId` helper; query/params with `z.coerce`.

## Quick table

| Need to validate | Helper |
|---|---|
| ObjectId | `objectId` (regex `/^[a-f\d]{24}$/i`) |
| Non-empty string | `z.string().trim().min(1)` |
| Number from query | `z.coerce.number().int().positive()` |
| Date | `z.coerce.date()` or `z.string().datetime()` |
| TS enum / literal | `z.nativeEnum(MyEnum)` / `z.enum(['a','b'])` |
| Partial update | `createSchema.partial()` |
| Cross-field validation | `.refine((d) => ..., { message, path })` |

## Before declaring done

- The schema lives in `<resource>.schema.ts` and the DTO comes from `z.infer`.
- The endpoint uses `validate(schema, target)`; no inline validation in the controller.
- ObjectId fields with the `objectId` helper; query fields with `z.coerce`.
- `{{qualityGate.fast}}` green.
