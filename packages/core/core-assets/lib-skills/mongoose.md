---
name: mongoose
description: Patrones de Mongoose en un servicio TS — queries seguras, populate, paginate, soft delete, ObjectId, evitar N+1. Aplica al tocar domain/models u ops de Mongoose en controllers.
type: reference
---

# Mongoose — convenciones del servicio

## Cuándo usar este skill

Cuando la tarea toca `domain/models` o ejecuta operaciones de Mongoose en los controllers. Mongoose 6+ sobre MongoDB. El repo no usa repository wrappers: los controllers tocan los Models directo, así que null-guards, casts de ObjectId y `.lean()` viven en cada controller method.

En **NestJS** (`@nestjs/mongoose`) el Model no se importa directo: se inyecta con `@InjectModel(Resource.name) private resourceModel: Model<ResourceDocument>` en el constructor del service. El resto de patrones (`.lean()`, `new Types.ObjectId`, null-guards, soft delete) aplican igual.

## Patrón canónico

```ts
const doc = await Resource.findById(id);
if (!doc) throw new NotFoundError(`Resource ${id} not found`);

const docs = await Resource.find(filter).lean<IResource[]>();  // read-only

const updated = await Resource.findByIdAndUpdate(
  id, { $set: dto }, { new: true, runValidators: true }
);
```

`{ new: true }` devuelve el doc actualizado, no el viejo; `{ runValidators: true }` valida updates parciales.

## ObjectId — la trampa más común

Un `id` de `req.params`/`req.body` es **string**. `findById` lo castea solo, pero aggregations y queries complejas requieren cast explícito con `new`:

```ts
import { Types } from 'mongoose';
const _id = new Types.ObjectId(id);  // Mongoose 6+ exige `new`
```

Valida el formato en el schema (`z.string().regex(/^[a-f\d]{24}$/i, ...)`); si no, un string mal-formado lanza `CastError`. Compara ObjectId con `.equals()`, no con `==`.

## Gotchas que muerden

- **N+1**: `populate` ejecuta queries extra. En paginate sobre datasets grandes usa `$lookup` en vez de `populate`.
- **`.lean()`**: el resultado no tiene `.save()`, `.delete()` ni virtuals. Si necesitas mutar, no lo uses.
- **Soft delete**: con `mongoose-delete`, `find` ya excluye `deleted: true`; borra con `doc.delete()` (no `findByIdAndDelete`) y restaura con `doc.restore()`.

## Reglas duras

1. **Ops de Mongoose nunca en la ruta** — siempre dentro de un controller method.
2. **Null-guard tras `findById`/`findOne`** — `if (!doc) throw new NotFoundError(...)`. Nada de `if (doc) {...}` silencioso.
3. **`.lean()` cuando no necesitas mutar** — evita el overhead de documentos Mongoose.
4. **Comparar ObjectId con `.equals()`** / `.toString()`, nunca `==`.
5. **Respeta el soft delete del repo** — no hard delete en modelos con `mongoose-delete`.

## Tabla rápida

| Necesito | Cómo |
|---|---|
| Buscar por id | `findById(id)` + null-guard → `NotFoundError` |
| Cast string → ObjectId | `new Types.ObjectId(id)` |
| Query read-only | `.find(filter).lean()` |
| Cargar relaciones | `.populate({ path, model })` (cuidado N+1) |
| Paginar | plugin `.paginate(...)` o `skip().limit()` + `countDocuments` |
| Borrar con soft delete | `doc.delete()` (no `findByIdAndDelete`) |
| Update devolviendo el nuevo doc | `findByIdAndUpdate(id, { $set }, { new: true, runValidators: true })` |
| Muchas escrituras | `bulkWrite([...])` |

## Antes de declarar listo

- Toda op de Mongoose vive en un controller method, no en la ruta.
- Cada `findById`/`findOne` tiene su null-guard que lanza `NotFoundError`.
- Las queries read-only usan `.lean()`; los ObjectId se comparan con `.equals()`.
- Los borrados respetan el soft delete del modelo cuando aplica.
- `{{qualityGate.fast}}` en verde.
