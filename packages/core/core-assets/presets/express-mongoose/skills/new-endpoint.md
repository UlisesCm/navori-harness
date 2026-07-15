---
name: new-endpoint
description: Sumar un endpoint nuevo a un recurso Express + Mongoose que ya existe (schema Zod + método del controller + ruta). Usar cuando hay que agregar un endpoint sin crear un Model nuevo.
type: reference
---

# new-endpoint — sumar un endpoint a un recurso existente

## Cuándo usar este skill

Cuando hay que agregar un endpoint a un recurso cuyo Model, controller y ruta base ya existen. Para crear un recurso desde cero (Model + controller + rutas), usa `new-resource`.

Pre-requisitos: el controller, el Model + interface y el `<resource>Routes.ts` (con su `router.route('/')`) ya existen.

## Pasos (orden estricto)

1. **Schema Zod** — en el `<resource>.schema.ts` del recurso, agrega el schema del input (`body`/`params`/`query`) y su DTO (`z.infer`). Si el archivo ya existe, agrégalo ahí mismo y expórtalo: NO crees archivos paralelos. Convenciones: skill `zod-validation`.
2. **Middleware `validate`** — si es la primera vez que se usa en el service, crea el helper en el directorio de helpers (lo define la skill `zod-validation`). Verifica antes que no exista; si existe con otra firma, alinéate o consulta al usuario.
3. **Método en el Controller** — agrega el método al class existente: firma `(req, res): Promise<void>`, input ya validado → tipa con `as <Dto>`, Mongoose ops directas OK, response con `SuccessResponse`, errores con `throw new <X>Error`, `Logger` en vez de `console.log`, JSDoc con verbo HTTP + ruta + retorno. Contrato `ApiResponse`/`ApiError`: skill `express-routes`.
4. **Route** — agrega la ruta en `<resource>Routes.ts` con `validate(schema, target)` antes de `asyncHandler(...)`. Rutas específicas antes que genéricas (`/foo/bar` antes de `/foo/:id`); casing consistente con los vecinos. Helpers: skills `zod-validation` y `express-routes`.
5. **Verify** — ver "Antes de declarar listo".

Tests (opcional): no para CRUD trivial; SÍ obligatorio si el endpoint trae lógica condicional no trivial o aggregations complejas. Integración con el runner del repo (400 con ObjectId inválido, 404 sin resultados).

## Reglas duras

- **Validación inline en el controller, no** — usa Zod + middleware `validate` (skill `zod-validation`).
- **Respuestas con `SuccessResponse`, errores con `throw new <X>Error`** — nunca `res.status(...).json(...)` crudo (skill `express-routes`).
- **No pases el `req` entero sin tipar** body/params/query — el middleware Zod tipa, tú usas `as <Dto>`.
- **El controller se instancia una sola vez** al top del archivo de routes — sin `new XController()` dentro del método de ruta.
- **No te olvides de `asyncHandler`** — sin él, los errores async se pierden o crashean el server.

## Antes de declarar listo

- `{{qualityGate.fast}}` en verde.
- El endpoint responde al smoke: golden path OK + edge case (ObjectId inválido) devuelve 400 con mensaje claro.
- El schema nuevo quedó en el archivo de schema del recurso, no en uno paralelo.
- La ruta usa `validate(...)` antes de `asyncHandler(...)` y el controller no valida inline.
- Si el endpoint trae lógica no trivial o aggregations, dejaste un test de integración.
