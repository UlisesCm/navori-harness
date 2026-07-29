---
name: mongo-aggregations
description: Mongoose aggregation pipelines — $lookup, $unwind, $match, $project, $group, $facet. Cast ObjectId with new Types.ObjectId, avoid field leaks. Use when doing joins across collections or statistics.
type: reference
---

# Mongo Aggregations — repo patterns

Aggregation pipelines for joins, aggregations and paginated listings with count in a single query.

## When to use this skill

Use aggregation instead of `find + populate` when you filter/sort/group by a child-collection field (populate batches with `$in` but doesn't filter server-side). For simple CRUD, plain `find()` suffices.

## The pattern

```ts
const pipeline = [
  { $match: { owner: new Types.ObjectId(ownerId), status: 'pending' } },
  { $lookup: { from: 'related', localField: 'related', foreignField: '_id', as: 'related' } },
  { $unwind: { path: '$related', preserveNullAndEmptyArrays: true } },
  { $project: { status: 1, 'related.email': 1, createdAt: 1 } },
  { $facet: {
      docs: [{ $skip: (page - 1) * limit }, { $limit: limit }],
      meta: [{ $count: 'total' }]
  } }
];
const [result] = await Model.aggregate<ResultType>(pipeline);
```

## Gotchas that bite

- **ObjectId in `$match`**: Mongoose does NOT cast ObjectIds in aggregation. A string won't match and fails silently. Use `new Types.ObjectId(id)` (or a raw string if the schema declares the field as `String`).
- **`$unwind` without `preserveNullAndEmptyArrays`** drops docs with no match (INNER instead of LEFT join).
- **`from` is the real collection name** (lowercase plural, e.g. `related`), not the Model (`Related`). If in doubt: `db.getCollectionNames()`.
- **Soft-delete does NOT apply on its own.** The pipeline ignores `mongoose-delete` and every schema middleware/filter: `find` hides deleted docs, `aggregate` **returns** them → leak. Add `{ deleted: { $ne: true } }` in the first `$match`.
- **`$lookup` without an index on `foreignField` = COLLSCAN per input doc.** Make sure `foreignField` is indexed, or the join is O(n·m).
- **Large `$group`/`$sort` blow up at 100 MB/stage** ("Exceeded memory limit") → `.option({ allowDiskUse: true })`. `$match`/`$sort` only use an index at the start; put them at the top.

## Hard rules

1. `$match` first (before the `$lookup`), as high as possible; include `{ deleted: { $ne: true } }` if the model uses soft-delete.
2. `new Types.ObjectId(id)` in `$match` when the field is an ObjectId (raw string if the schema is `String`).
3. `$unwind` with `preserveNullAndEmptyArrays` when you expect a left-join.
4. `aggregate<T>(...)` always typed — Mongoose doesn't type the output; without this it's `any[]`.
5. `$project` without mixing `1` and `0` (except `_id`); use it to hide sensitive fields.
6. `foreignField` indexed; `allowDiskUse` for large `$group`/`$sort`.

## Quick table

| Stage | For what |
|---|---|
| `$match` | WHERE — as early as possible (uses an index only at the start) |
| `$lookup` | JOIN (`from` = real collection, lowercase plural; `foreignField` indexed) |
| `$unwind` | Flatten the lookup array (`preserveNullAndEmptyArrays` = left-join) |
| `$project` | SELECT / rename / hide sensitive |
| `$group` / `$facet` | aggregates (`$sum/$avg/$push`) / docs + count in one query |

## Before declaring done

- `$match` early with `new Types.ObjectId(id)` and `{ deleted: { $ne: true } }` if soft-delete applies.
- Result typed with `aggregate<T>(...)`; `$project` hides sensitive fields and doesn't mix `1`/`0`.
- `{{qualityGate.fast}}` green.
