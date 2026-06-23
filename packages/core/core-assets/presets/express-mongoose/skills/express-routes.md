---
name: express-routes
description: Patrón de rutas Express en un servicio TS — asyncHandler obligatorio, ApiResponse para data, ApiError para errores, validate antes del handler, mount bajo un prefix único. Aplica al tocar presentation/routes o presentation/controllers.
type: reference
---

# Express Routes — convenciones del servicio

## Cuándo usar este skill

Antes de crear o modificar archivos en `presentation/routes` o `presentation/controllers`, o cablear un endpoint. Express 4+. Saltarte `asyncHandler` + `validate` + delegación al controller es la fuente más común de errores async perdidos y de lógica fugada al routing.

## Patrón canónico

```ts
const router = express.Router();
const controller = new ResourceController();

router.route('/')
  .post(
    validate(createResourceSchema, 'body'),
    asyncHandler((req, res) => controller.Create(req, res))
  )
  .get(
    validate(listResourcesQuerySchema, 'query'),
    asyncHandler((req, res) => controller.GetAll(req, res))
  );

export default router;
```

Luego se monta en `routes/index.ts` bajo el prefix único de tu repo (`<API_PREFIX>`): `router.use('/<resource>', resourceRoutes)`. Agrupa sub-dominios en una sección comentada y respeta el orden existente.

## Contratos del repo (no los reinventes)

- **`asyncHandler`** — envuelve el handler async y reenvía el `Promise.reject` a `next(err)`, que llega al error middleware global de `app.ts`. Sin él, los errores async crashean o se pierden.
- **`validate(schema, target)`** — valida el input (`'body'`/`'query'`/`'params'`) antes de tocar el controller.
- **`ApiResponse`** — único canal de salida HTTP. `new SuccessResponse(msg, data).send(res)`, `new CreatedResponse(...)` (201), `new NotFoundResponse(...)` (404).
- **`ApiError`** — único canal de error: `throw new NotFoundError(...)` / `BadRequestError` / `ForbiddenError`. El middleware global los traduce; nunca los manejes a mano.

Si alguno no existe en tu repo, define el contrato análogo antes de usarlo.

## Gotchas que muerden

- Instancia el controller **una vez** al top del archivo, nunca dentro del handler.
- Rutas específicas antes que genéricas: `/foo/bar` antes de `/foo/:id`.
- `app.ts` ya define rutas reservadas (`/healthcheck`, `/json/*`, `/favicon.ico`); no las toques.

## Reglas duras

1. **`asyncHandler` SIEMPRE** envolviendo el handler. Sin él, los errores async se pierden.
2. **`validate(schema, target)` ANTES** del `asyncHandler` cuando el endpoint parsea input. Un `validate` por target.
3. **Toda salida por `ApiResponse`**, todo error por `ApiError`. Nada de `res.json`, `res.send`, `res.status(...).json(...)` ni `try/catch` que mande la respuesta de error.
4. **Cero lógica en la ruta** — la ruta solo cablea; la lógica vive en el controller method.
5. **Path consistente** con los vecinos (si usan `GetByX`, no inventes `get-by-x`) y sin leading slash que duplique el prefix.

## Tabla rápida

| Necesito | Cómo |
|---|---|
| Capturar errores async | Envolver el handler en `asyncHandler` |
| Validar input | `validate(schema, 'body'\|'query'\|'params')` antes de `asyncHandler` |
| Devolver data | `new SuccessResponse(msg, data).send(res)` |
| Lanzar error de dominio | `throw new NotFoundError(...)` / `BadRequestError` |
| Montar el recurso | `router.use('/<resource>', xRoutes)` en `routes/index.ts` |
| Lógica de negocio | Controller method, nunca en la ruta |

## Antes de declarar listo

- Cada handler async va envuelto en `asyncHandler`; ningún `try/catch` manual manda el error.
- Toda salida sale por `ApiResponse`; ningún `res.json`/`res.send` directo.
- La ruta solo cablea; la lógica vive en el controller.
- `{{qualityGate.fast}}` en verde.
