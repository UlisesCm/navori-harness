---
name: mongoose
description: Patrones de Mongoose en un servicio TS — queries seguras, populate, paginate, soft delete, ObjectId, evitar N+1. Aplica al tocar domain/models u ops de Mongoose en controllers.
type: reference
---

# Mongoose — convenciones del servicio

## Cuándo usar este skill

Cuando la tarea toca `domain/models` o ejecuta operaciones de Mongoose en los controllers. Sin repository wrappers: los controllers tocan los Models directo, así que null-guards, casts de ObjectId y `.lean()` viven en cada controller method.

En **NestJS** (`@nestjs/mongoose`) el Model se inyecta: `@InjectModel(Resource.name) private model: Model<ResourceDocument>`; el resto de patrones aplican igual.

## Patrón canónico

```ts
const doc = await Resource.findById(id);
if (!doc) throw new NotFoundError(`Resource ${id} not found`);

const docs = await Resource.find(filter).lean<IResource[]>();  // read-only

const updated = await Resource.findByIdAndUpdate(
  id, { $set: dto }, { returnDocument: 'after', runValidators: true }
);
```

`returnDocument: 'after'` (reemplaza el deprecado `new: true`) devuelve el doc actualizado; `runValidators: true` valida el update parcial. Ojo: `findByIdAndUpdate` **no** dispara hooks `pre('save')` ni valida el doc completo — si hay lógica en middleware `save`, usa `doc.save()`.

## ObjectId — la trampa más común

Un `id` de `req.params`/`req.body` es **string**. `findById` lo castea solo, pero aggregations y queries complejas requieren `new Types.ObjectId(id)` (el `new` es obligatorio en Mongoose 6+). Valida el formato antes (`/^[a-f\d]{24}$/i`) o un string mal-formado lanza `CastError`. Compara ObjectId con `.equals()`, nunca `==`.

## Gotchas que muerden

- **Query injection**: `Model.find(req.query)` crudo deja pasar operadores (`{ $ne: null }`). Arma el filtro campo por campo o `.setOptions({ sanitizeFilter: true })`. Y `strictQuery` es `false` por default (Mongoose 7+): un campo con typo se ignora → filtro vacío que devuelve **toda** la colección.
- **Atomicidad multi-doc**: escrituras relacionadas en `connection.transaction(async (session) => {...})`, pasando `{ session }` a cada op. `bulkWrite` no es transacción.
- **Índices**: filtros y `.sort()` sobre campos sin índice = COLLSCAN. Declara `schema.index(...)`, verifica con `.explain()`.
- **populate** batchea con `$in` (1 query por path, no N); no filtra/ordena por el child — ahí `$lookup`. `.lean()` pierde `.save()`/virtuals.
- **Soft delete**: con `mongoose-delete`, `find` ya excluye `deleted: true`; borra con `doc.delete()` (no `findByIdAndDelete`), restaura con `doc.restore()`.

## Reglas duras

1. **Ops de Mongoose nunca en la ruta** — siempre dentro de un controller method.
2. **Null-guard tras `findById`/`findOne`** — `if (!doc) throw new NotFoundError(...)`.
3. **`.lean()` cuando no necesitas mutar**; comparar ObjectId con `.equals()`, nunca `==`.
4. **Nunca `Model.find(req.query)` crudo** — filtro campo por campo o `sanitizeFilter`.
5. **Respeta el soft delete del repo**; escrituras relacionadas en `connection.transaction`.

## Tabla rápida

| Necesito | Cómo |
|---|---|
| Buscar por id | `findById(id)` + null-guard → `NotFoundError` |
| Cast string → ObjectId | `new Types.ObjectId(id)` |
| Query read-only | `.find(filter).lean()` |
| Paginar | `.paginate(...)` o `skip().limit()` + `countDocuments` |
| Borrar con soft delete | `doc.delete()` (no `findByIdAndDelete`) |
| Update devolviendo el nuevo | `findByIdAndUpdate(id, { $set }, { returnDocument: 'after', runValidators: true })` |
| Escrituras relacionadas | `connection.transaction(async (session) => …)` |

## Antes de declarar listo

- Cada `findById`/`findOne` tiene null-guard → `NotFoundError`; read-only con `.lean()`.
- Ningún filtro arma con `req.query`/`req.body` crudo; ObjectId comparado con `.equals()`.
- Borrados respetan soft delete; escrituras relacionadas van en transacción.
- `{{qualityGate.fast}}` en verde.
