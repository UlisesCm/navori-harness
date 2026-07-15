---
name: mongo-aggregations
description: Aggregation pipelines de Mongoose — $lookup, $unwind, $match, $project, $group, $facet. Castear ObjectId con new Types.ObjectId, evitar leaks de campos. Aplica al hacer joins entre colecciones o estadísticas.
type: reference
---

# Mongo Aggregations — patterns del repo

Aggregation pipelines para joins, agregaciones y listados paginados con count en una sola query.

## Cuándo usar este skill

Usa aggregation en vez de `find + populate` cuando filtras/ordenas/agrupas por un campo de la colección child (populate no lo hace: batchea con `$in` pero no filtra server-side). Para CRUD simple, `find()` directo basta.

## El patrón

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

## Gotchas que muerden

- **ObjectId en `$match`**: Mongoose NO castea ObjectIds en aggregation. Un string no matchea y falla silencioso. Usa `new Types.ObjectId(id)` (o string directo si el schema declara el campo como `String`).
- **`$unwind` sin `preserveNullAndEmptyArrays`** pierde los docs sin match (INNER en vez de LEFT join).
- **`from` es el nombre real de la colección** (lowercase plural, p. ej. `related`), no el Model (`Related`). Si dudas: `db.getCollectionNames()`.
- **Soft-delete NO se aplica solo.** El pipeline ignora `mongoose-delete` y todo middleware/filtro del schema: `find` esconde los borrados, `aggregate` los **devuelve** → leak. Agrega `{ deleted: { $ne: true } }` en el primer `$match`.
- **`$lookup` sin índice en `foreignField` = COLLSCAN por doc de entrada.** Asegúrate de que el `foreignField` esté indexado, o el join es O(n·m).
- **`$group`/`$sort` grandes revientan a los 100 MB/stage** ("Exceeded memory limit") → `.option({ allowDiskUse: true })`. `$match`/`$sort` solo usan índice al inicio; ponlos arriba.

## Reglas duras

1. `$match` primero (antes del `$lookup`), lo más arriba posible; incluye `{ deleted: { $ne: true } }` si el modelo usa soft-delete (el pipeline no lo aplica solo).
2. `new Types.ObjectId(id)` en `$match` cuando el campo es ObjectId (string directo si el schema es `String`).
3. `$unwind` con `preserveNullAndEmptyArrays` cuando esperas left-join.
4. `aggregate<T>(...)` siempre tipado — Mongoose no tipa el output; sin esto es `any[]`.
5. `$project` sin mezclar `1` y `0` (salvo `_id`); úsalo para ocultar campos sensibles.
6. `foreignField` indexado; `allowDiskUse` para `$group`/`$sort` grandes.

## Tabla rápida

| Stage | Para qué |
|---|---|
| `$match` | WHERE — lo más temprano posible (usa índice solo al inicio) |
| `$lookup` | JOIN (`from` = colección real, lowercase plural; `foreignField` indexado) |
| `$unwind` | Aplanar el array del lookup (`preserveNullAndEmptyArrays` = left-join) |
| `$project` | SELECT / renombrar / ocultar sensibles |
| `$group` / `$facet` | agregados (`$sum/$avg/$push`) / docs + count en una query |

## Antes de declarar listo

- `$match` temprano con `new Types.ObjectId(id)` y `{ deleted: { $ne: true } }` si aplica soft-delete.
- Resultado tipado con `aggregate<T>(...)`; `$project` oculta sensibles y no mezcla `1`/`0`.
- `{{qualityGate.fast}}` en verde.
