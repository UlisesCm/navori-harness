---
name: mongo-aggregations
description: Aggregation pipelines de Mongoose — $lookup, $unwind, $match, $project, $group, $facet. Castear ObjectId con new Types.ObjectId, evitar leaks de campos. Aplica al hacer joins entre colecciones o estadísticas.
type: reference
---

# Mongo Aggregations — patterns del repo

Aggregation pipelines para joins, agregaciones y listados paginados con count en una sola query.

## Cuándo usar este skill

Usa aggregation en vez de `find + populate` cuando filtras por un campo de la colección child (populate no filtra), agregas/cuentas/agrupas (populate no agrega), o la performance importa (populate hace N queries; aggregation, 1). Para CRUD simple, `find()` directo basta.

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

- **ObjectId en `$match`**: Mongoose NO castea ObjectIds en aggregation. Un string no matchea y falla silencioso. Usa `new Types.ObjectId(id)` (el `new` es obligatorio en Mongoose 6+). Excepción: si el schema declara el campo como `String`, va string directo — revisa el schema antes de decidir.
- **`$unwind` sin `preserveNullAndEmptyArrays`** pierde los docs sin match (INNER en vez de LEFT join).
- **`from` es el nombre real de la colección** (lowercase plural, p. ej. `related`), no el Model (`Related`). Si dudas: `db.getCollectionNames()`.

## Reglas duras

1. `$match` antes del primer `$lookup` — filtra primero, no proceses toda la colección.
2. `new Types.ObjectId(id)` en `$match` cuando el campo es ObjectId (string directo si el schema es `String`).
3. `$unwind` con `preserveNullAndEmptyArrays` cuando esperas left-join.
4. `aggregate<T>(...)` siempre tipado — Mongoose no tipa el output; sin esto es `any[]`.
5. `$project` sin mezclar `1` y `0` (salvo `_id`) — Mongo rechaza el pipeline. Úsalo para ocultar campos sensibles.
6. Filtra en `$match`, no en JS — traer todo y filtrar en código desperdicia tráfico y memoria.

## Tabla rápida

| Stage | Para qué |
|---|---|
| `$match` | WHERE — lo más temprano posible |
| `$lookup` | JOIN (`from` = colección real, lowercase plural) |
| `$unwind` | Aplanar el array del lookup a doc individual |
| `$project` | SELECT / renombrar / ocultar sensibles |
| `$group` | `$sum:1` count, `$sum/$avg/$min/$max`, `$push`, `$addToSet` |
| `$facet` | docs + count en una query (paginación) |
| `$sort` / `$skip` / `$limit` | Orden y paginación |

## Antes de declarar listo

- El `$match` por ObjectId usa `new Types.ObjectId(id)` (o string si el schema declara `String`).
- Hay un `$match` antes del primer `$lookup`.
- `$unwind` usa `preserveNullAndEmptyArrays` si esperas left-join.
- El resultado está tipado con `aggregate<T>(...)`.
- `$project` oculta campos sensibles y no mezcla `1`/`0`.
- `{{qualityGate.fast}}` en verde.
