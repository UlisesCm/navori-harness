---
name: mongoose
description: Use when touching domain/models or Mongoose ops in controllers — Mongoose patterns in a TS service: safe queries, populate, paginate, soft delete, ObjectId, avoiding N+1.
type: reference
---

# Mongoose — service conventions

## When to use this skill

When the task touches `domain/models` or runs Mongoose operations in the controllers. No repository wrappers: controllers touch the Models directly, so null-guards, ObjectId casts, and `.lean()` live in each method.

In **NestJS** (`@nestjs/mongoose`) the Model is injected: `@InjectModel(Resource.name) private model: Model<ResourceDocument>`; the rest of the patterns apply the same.

## Canonical pattern

```ts
const doc = await Resource.findById(id);
if (!doc) throw new NotFoundError(`Resource ${id} not found`);

const docs = await Resource.find(filter).lean<IResource[]>();  // read-only

const updated = await Resource.findByIdAndUpdate(
  id, { $set: dto }, { returnDocument: 'after', runValidators: true }
);
```

`returnDocument: 'after'` (replaces the deprecated `new: true`) returns the updated doc; `runValidators: true` validates the partial update. Note: `findByIdAndUpdate` does **not** fire `pre('save')` hooks or validate the whole doc — if `save` middleware has logic, use `doc.save()`.

## ObjectId — the most common trap

An `id` from `req.params`/`req.body` is a **string**. `findById` casts it automatically, but aggregations and complex queries require `new Types.ObjectId(id)` (the `new` is mandatory in Mongoose 6+). Validate the format first (`/^[a-f\d]{24}$/i`) or a malformed string throws `CastError`. Compare ObjectId with `.equals()`, never `==`.

## Gotchas that bite

- **Query injection**: raw `Model.find(req.query)` lets operators through (`{ $ne: null }`). Build the filter field by field or `.setOptions({ sanitizeFilter: true })`. And `strictQuery` is `false` by default (Mongoose 7+): a typo'd field is ignored → empty filter returning the **whole** collection.
- **Multi-doc atomicity**: related writes in `connection.transaction(async (session) => {...})`, passing `{ session }` to each op. `bulkWrite` is not a transaction.
- **Indexes**: filters and `.sort()` over unindexed fields = COLLSCAN. Declare `schema.index(...)`, verify with `.explain()`.
- **populate** batches with `$in` (1 query per path, not N); it doesn't filter/sort by the child — for that use `$lookup`. `.lean()` loses `.save()`/virtuals.
- **Soft delete**: with `mongoose-delete`, `find` already excludes `deleted: true`; delete with `doc.delete()` (not `findByIdAndDelete`), restore with `doc.restore()`.

## Hard rules

1. **Mongoose ops never in the route** — always inside a controller method.
2. **Null-guard after `findById`/`findOne`** — `if (!doc) throw new NotFoundError(...)`.
3. **`.lean()` when you don't need to mutate**; compare ObjectId with `.equals()`, never `==`.
4. **Never raw `Model.find(req.query)`** — filter field by field or `sanitizeFilter`.
5. **Respect the repo's soft delete**; related writes in `connection.transaction`.

## Quick table

| Need | How |
|---|---|
| Find by id | `findById(id)` + null-guard → `NotFoundError` |
| Cast string → ObjectId | `new Types.ObjectId(id)` |
| Read-only query | `.find(filter).lean()` |
| Paginate | `.paginate(...)` or `skip().limit()` + `countDocuments` |
| Delete with soft delete | `doc.delete()` (not `findByIdAndDelete`) |
| Update returning the new doc | `findByIdAndUpdate(id, { $set }, { returnDocument: 'after', runValidators: true })` |
| Related writes | `connection.transaction(async (session) => …)` |

## Before declaring done

- Every `findById`/`findOne` has a null-guard → `NotFoundError`; read-only with `.lean()`.
- No filter built from raw `req.query`/`req.body`; ObjectId compared with `.equals()`.
- Deletes respect soft delete; related writes go in a transaction.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's data model (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The models that exist and the relations between them.
     - Indexes that must not be dropped, and the queries that depend on them.
     - The lean/populate convention: where a hydrated doc is required and where it isn't.
     - Operations that MUST run in a transaction.
-->
