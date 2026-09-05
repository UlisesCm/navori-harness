---
name: zod-validation
description: Use when creating schemas or touching input validation of body/query/params — input validation with Zod at the API boundary: per-resource schemas, generic validate middleware, inferred DTOs.
type: reference
---

<!-- navori:managed id="zod-validation" hash="088df5ee" version="0.7.2" source="@navori/core" -->
# Zod Validation — the canonical pattern

One schema per resource (`<resource>.schema.ts`), a generic validate middleware, and the DTO from `z.infer`.

## When to use this skill

When creating a schema, adding validation to an endpoint, inferring a DTO, or touching body/query/params input.

**Check the installed major** (`package.json`): snippets are **Zod 4**, with the v3 form annotated inline where they differ.

## The pattern

The middleware (Express here) parses `req[target]`, throws `BadRequestError` from the first issue, or reassigns `req[target] = parsed`:

```ts
export const createResourceSchema = z.object({
  owner: z.uuid(),                        // v3: z.string().uuid()
  resourceType: z.enum(ResourceTypeEnum), // v3: z.nativeEnum(ResourceTypeEnum)
  page: z.coerce.number().int().positive().default(1)
});
export const updateResourceSchema = createResourceSchema.partial();
export type CreateResourceDto = z.infer<typeof createResourceSchema>;
```

Route: `router.post('/', validate(createResourceSchema, 'body'), ...)`. The controller's `req.body as CreateResourceDto` cast is safe: already parsed.

`safeParse` failure → readable 4xx (v4):

```ts
const parsed = schema.safeParse(req.body);
if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
```

`z.prettifyError(e)` → readable string; `z.treeifyError(e)` → input-shaped object for per-field errors; `e.issues` → raw array (both majors). **v3 has neither:** `e.format()` / `e.flatten()`.

## Gotchas that bite

- **A bare id** (`z.string()`) lets `"abc"` through and the layer below breaks on it — a driver cast error becomes a 500 instead of a clean 400. Validate the id's *shape*: `z.uuid()`, `z.cuid()`, `z.coerce.number().int()` (serial) or `.regex(...)`. *Mongo:* `z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ObjectId')` — see the `mongoose` skill.
- **Query strings are always strings.** Without `z.coerce`, `z.number()` rejects them. **Footgun:** `z.coerce.number()` uses `Number()`, so `""`/`" "`/`null` → `0` (an empty `?page=` passes as `0`); set explicit bounds or `z.string().regex(...).transform(Number)`.
- **Unknown keys are silently dropped:** `z.object({...})` *strips*, so a typo in the body (`{ ammount }`) is lost with no error. On mutation endpoints use `z.strictObject({...})`.

## Hard rules

1. All validation in the schema, never inline in the controller.
2. The schema lives in `<resource>.schema.ts`, never in the routes.
3. DTO always with `z.infer` — don't maintain two parallel types.
4. No `z.any()`: it equals `any`, forbidden in new code.
5. One validator per endpoint — no Joi + Zod mix; migrate the whole endpoint.
6. Ids validated by shape, never a bare `z.string()`; query/params with `z.coerce`.

## Quick table

`v4 · v3` where they differ.

| Need to validate | Helper |
|---|---|
| Id | shape-specific, never `z.string()`: `z.uuid()` · `z.string().uuid()` |
| Non-empty string | `z.string().trim().min(1)` |
| Number from query | `z.coerce.number().int().positive()` |
| Date | `z.coerce.date()`, `z.iso.datetime()` · `z.string().datetime()` |
| TS enum / literal | `z.enum(MyEnum)` · `z.nativeEnum(MyEnum)`; `z.enum(['a','b'])` |
| Partial update | `createSchema.partial()` |
| Cross-field validation | `.refine((d) => ..., { error, path })` · `{ message, path }` |
| Error → 4xx body | `z.prettifyError(e)` · `e.format()` |

## Before declaring done

- Schema in `<resource>.schema.ts`, DTO from `z.infer`, endpoint wired with `validate(schema, target)` — no inline validation in the controller.
- Ids validated by shape, not a bare `z.string()`; query fields with `z.coerce`.
- APIs match the installed major — no `z.nativeEnum` on v4, no `z.prettifyError` on v3.
- `cd packages/cli && pnpm lint` green.
<!-- /navori:managed id="zod-validation" -->
