---
name: keystone-rest
description: Endpoints REST/Express sobre Keystone 6 — el controller valida el input con Zod safeParse y delega a un service que usa context.sudo().db. Aplica al crear o tocar una ruta, un controller o un service REST.
type: reference
---

# Keystone REST — controller fino, service con la lógica

Keystone expone GraphQL, pero un backend suele montar además rutas REST/Express (vía `extendExpressApp` o un router propio) para webhooks, integraciones y endpoints a medida. La regla: el **controller** solo habla HTTP; la **lógica de datos vive en un service** que usa el `context` de Keystone.

## Cuándo usar este skill

Al crear o tocar una ruta REST, su controller o el service que hay detrás; o al depurar un endpoint que valida mal, filtra de más o expone internals.

## El patrón

```ts
// controller — SOLO HTTP: valida el borde y delega. Nunca lógica de negocio aquí.
export async function createReport(req: Request, res: Response) {
  const parsed = CreateReportSchema.safeParse(req.body); // safeParse, NUNCA parse
  if (!parsed.success) return sendError(res, "Input inválido", 422);
  const report = await reportService.create(parsed.data, req.context);
  return sendSuccess(res, { data: report }, 201);
}

// service — la lógica; recibe context, no (req, res). context.sudo().db, no context.db.
export const reportService = {
  /** Crea un Report aplicando las reglas de negocio (no el access de la sesión). */
  async create(input: CreateReportInput, context: Context) {
    return context.sudo().db.Report.createOne({ data: input });
  },
};
```

## Reglas duras

1. **`safeParse`, nunca `parse`.** El input HTTP es hostil: valídalo con el schema Zod y responde 4xx ante el fallo; una excepción sin capturar se fuga como 500.
2. **Controller fino.** El controller no accede a la DB ni implementa reglas: parsea, delega al service, formatea la respuesta. Toda la lógica testeable vive en el service.
3. **El service recibe `context`, no `req`/`res`.** Así se testea sin HTTP y se reusa desde otro controller, un hook o un job. Dentro usa `context.sudo().db` (ver `keystone-access` para el porqué de `sudo`).
4. **Errores sin internals.** Nunca devuelvas stacktraces, SQL ni mensajes de librería al cliente; loguea el detalle y responde un mensaje acotado con su código.
5. **Respuestas consistentes.** Éxito y error pasan por un formateador único (un `sendSuccess`/`sendError` o equivalente), no por `res.json` suelto en cada controller.

## Antes de declarar el cambio "listo"

- Ningún controller llama a `.parse(` sobre el input HTTP (búscalo: debe ser `safeParse`).
- Ningún controller usa `context.db.` directo — la lógica está en un service con `context.sudo().db`.
- El service nuevo/tocado tiene unit tests (recibe un `context` mockeado; ver `keystone-testing`).
