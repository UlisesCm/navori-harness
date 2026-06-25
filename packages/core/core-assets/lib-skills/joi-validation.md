---
name: joi-validation
description: Validación de input con Joi (@hapi/joi) en Express — schemas por recurso, middleware validate genérico, DTOs explícitos. Aplica al crear schemas o tocar input validation de body/query/params.
type: reference
---

# Joi Validation — el patrón canónico

Un schema por recurso (`<resource>.schema.ts`), validado por un middleware genérico que reemplaza `req[target]` con el valor convertido. Como Joi no infiere tipos, el DTO es una `interface` explícita junto al schema.

## Cuándo usar este skill

Al crear un schema, agregar validación a un endpoint, definir un DTO, o tocar input de body/query/params.

## El patrón

El middleware vive en `helpers/validate.ts`: corre `schema.validate(req[target], { abortEarly: true, convert: true })`, y al fallar lanza `BadRequestError(\`${detail.path.join('.')}: ${detail.message}\`)` con el primer issue. En éxito, reasigna `req[target] = value` (el valor ya convertido). Schema y DTO:

```ts
const objectId = Joi.string().pattern(/^[a-f\d]{24}$/i).message('Invalid ObjectId');

export const createResourceSchema = Joi.object({
  owner: objectId.required(),
  resourceType: Joi.string().valid(...Object.values(ResourceTypeEnum)).required(),
  page: Joi.number().integer().positive().default(1),
});
export const updateResourceSchema = createResourceSchema.fork(
  Object.keys(createResourceSchema.describe().keys),
  (s) => s.optional(),
);

export interface CreateResourceDto {
  owner: string;
  resourceType: ResourceTypeEnum;
  page: number;
}
```

En la route: `router.post('/', validate(createResourceSchema, 'body'), ...)`. En el controller el cast `req.body as CreateResourceDto` es seguro porque el middleware ya validó y convirtió.

## Gotchas que muerden

- **ObjectId pelado** (`Joi.string()`) deja pasar `"abc"`; Mongoose lanza CastError 500 en vez de 400 limpio. Usa siempre el helper `objectId`.
- **`convert: true` es obligatorio** para query/params: las query strings llegan como string y Joi sin `convert` rechaza `Joi.number()`. Con `convert` las castea a number/date/boolean.
- **`abortEarly`**: con `false` juntas todos los errores; con `true` (default recomendado aquí) cortas en el primero — sé consistente con lo que el middleware reporta.

## Reglas duras

1. Toda validación en el schema, nunca inline en el controller.
2. El schema vive en `<resource>.schema.ts`, nunca en las routes.
3. DTO como `interface` explícita al lado del schema — mantenlos en sync (Joi no infiere tipos).
4. Nada de `Joi.any()`: equivale a `any`, prohibido en código nuevo.
5. Un solo validador por endpoint — no mezcles Joi + Zod (al migrar entre ambos, migra el endpoint completo).
6. ObjectId con el helper `objectId`; query/params siempre con `convert: true`.

## Tabla rápida

| Necesito validar | Helper |
|---|---|
| ObjectId | `objectId` (pattern `/^[a-f\d]{24}$/i`) |
| String no vacío | `Joi.string().trim().min(1)` |
| Number desde query | `Joi.number().integer().positive()` (+ `convert: true`) |
| Date | `Joi.date()` (+ `convert: true`) |
| Enum TS / literal | `Joi.string().valid(...Object.values(MyEnum))` |
| Update parcial | `schema.fork(keys, (s) => s.optional())` |
| Validación cruzada | `.custom((v, helpers) => ...)` o `Joi.object().and('a', 'b')` |

## Antes de declarar listo

- El schema vive en `<resource>.schema.ts` y el DTO es una `interface` explícita.
- El endpoint usa `validate(schema, target)`; sin validación inline en el controller.
- Campos ObjectId con el helper `objectId`; el middleware corre con `convert: true`.
- `{{qualityGate.fast}}` en verde.
