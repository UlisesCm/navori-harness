---
name: zod-validation
description: Validación de input con Zod en Express — schemas por recurso, middleware validate genérico, DTOs inferidos. Aplica al crear schemas o tocar input validation de body/query/params.
type: reference
---

# Zod Validation — el patrón canónico

Un schema por recurso (`<resource>.schema.ts`), validado por un middleware genérico que reemplaza `req[target]` con el valor parseado y tipado. El DTO sale de `z.infer`.

## Cuándo usar este skill

Al crear un schema, agregar validación a un endpoint, inferir un DTO, o tocar input de body/query/params.

## El patrón

El middleware vive en `helpers/validate.ts`: parsea `req[target]` contra el schema, y al fallar lanza `BadRequestError(\`${path}: ${first.message}\`)` con el primer issue. En éxito, reasigna `req[target] = parsed`. Schema y DTO:

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

En la route: `router.post('/', validate(createResourceSchema, 'body'), ...)`. En el controller el cast `req.body as CreateResourceDto` es seguro porque el middleware ya parseó.

## Gotchas que muerden

- **ObjectId pelado** (`z.string()`) deja pasar `"abc"`; Mongoose lanza CastError 500 en vez de 400 limpio. Usa siempre el helper `objectId`.
- **Query strings siempre son string.** Sin `z.coerce`, `z.number()` las rechaza. Usa `z.coerce.number()` / `z.coerce.date()`.

## Reglas duras

1. Toda validación en el schema, nunca inline en el controller.
2. El schema vive en `<resource>.schema.ts`, nunca en las routes.
3. DTO siempre con `z.infer` — no mantengas dos tipos en paralelo.
4. Nada de `z.any()`: equivale a `any`, prohibido en código nuevo.
5. Un solo validador por endpoint — no mezcles Joi + Zod (al migrar Joi→Zod, migra el endpoint completo).
6. ObjectId con el helper `objectId`; query/params con `z.coerce`.

## Tabla rápida

| Necesito validar | Helper |
|---|---|
| ObjectId | `objectId` (regex `/^[a-f\d]{24}$/i`) |
| String no vacío | `z.string().trim().min(1)` |
| Number desde query | `z.coerce.number().int().positive()` |
| Date | `z.coerce.date()` o `z.string().datetime()` |
| Enum TS / literal | `z.nativeEnum(MyEnum)` / `z.enum(['a','b'])` |
| Update parcial | `createSchema.partial()` |
| Validación cruzada | `.refine((d) => ..., { message, path })` |

## Antes de declarar listo

- El schema vive en `<resource>.schema.ts` y el DTO sale de `z.infer`.
- El endpoint usa `validate(schema, target)`; sin validación inline en el controller.
- Campos ObjectId con el helper `objectId`; campos de query con `z.coerce`.
- `{{qualityGate.fast}}` en verde.
