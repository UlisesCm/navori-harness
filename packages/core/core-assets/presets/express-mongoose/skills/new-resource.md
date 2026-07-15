---
name: new-resource
description: Crear un recurso end-to-end en un backend Express + Mongoose (Model + schema Zod + controller + routes + mount). Aplica al sumar un dominio nuevo (modelo + endpoints) de punta a punta.
type: reference
---

# new-resource — recurso end-to-end

## Cuándo usar este skill

Cuando hay que crear un dominio nuevo (Model + endpoints) de punta a punta. Para agregar un endpoint a un recurso que YA existe, usa `new-endpoint`.

Antes de codear decide: ¿sub-dominio (vive bajo un dominio existente → sub-carpetas dentro de cada capa) o top-level (sin sub-carpeta)? ¿Side-effects (email, jobs, colas)? Documéntalos en el plan.

## Pasos (orden estricto)

El orden es estricto: cada paso depende del anterior. Saltarte uno deja la ruta sin mount o el controller sin validación.

1. **Model + Interface** — en el directorio de Models, crea `<Resource>.ts`. Interface `I<Resource>` exportada extendiendo `mongoose.Document`, enums exportados, índices en campos de query frecuente, `timestamps: true`, export default del Model. Convenciones del schema y soft delete: skill `mongoose`.
2. **Schema Zod** — en el directorio de schemas, crea `<resource>.schema.ts` con los schemas de `body`/`params`/`query` y sus DTOs (`z.infer`). Re-usa los enums del Model. Convenciones de validación: skill `zod-validation`.
3. **Controller** — en el directorio de controllers, crea `<Resource>Controller.ts`: class con un método por verbo HTTP (`Create`/`GetAll`/`GetById`/`Update`/`Delete`), firma `(req, res): Promise<void>`. La validación ya ocurrió → tipa con `as <Dto>`. Mongoose ops directas OK; sin Service trivial. Contrato `ApiResponse`/`ApiError`: skill `express-routes`.
4. **Routes** — en el directorio de routes, crea `<resource>Routes.ts`: instancia el controller una sola vez al top, encadena `validate(schema, target)` antes de `asyncHandler(...)`. Helpers: skills `zod-validation` y `express-routes`.
5. **Mount** — en el router raíz, importa y monta: `router.use('/resource', resourceRoutes)`. Sin este paso la ruta no responde; respeta el orden de los vecinos.
6. **Verify** — ver "Antes de declarar listo".

Tests (recomendado): unit del Model (`required`, defaults de enum) e integración de la ruta (400 sin campo, 200 con payload válido) con el runner del repo.

## Reglas duras

- **Orden estricto Model → Schema → Controller → Routes → Mount → Verify.** Un recurso sin mount no responde; un controller sin schema no valida.
- **Validación SIEMPRE con Zod + middleware** `validate`, nunca inline en el controller (skill `zod-validation`).
- **Respuestas con `SuccessResponse`, errores con `throw new <X>Error`** — nunca `res.status(...).json(...)` crudo (skill `express-routes`).
- **Sin Service trivial** que solo envuelva un `Model.find`: del controller directo al Model.
- **Sin Repository inventado** — el preset no usa repository pattern; no introduzcas `IRepository` salvo pedido explícito.
- **Index en campos de query frecuente** en el schema Mongoose.
- **No mezcles dominios** — un sub-recurso fuera de su sub-carpeta rompe la convención.

## Antes de declarar listo

- `{{qualityGate.fast}}` en verde.
- El recurso quedó montado en el router raíz (paso 5) y responde al smoke (golden path crea, edge sin campo da 400).
- Toda validación pasa por el middleware `validate`; el controller no valida inline.
- Las respuestas usan `SuccessResponse` y los errores `throw new <X>Error`.
- Si el dominio tiene side-effects (email, jobs, colas), quedaron en el plan.
