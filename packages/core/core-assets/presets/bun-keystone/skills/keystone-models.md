---
name: keystone-models
description: Convenciones para lists de Keystone 6 — estructura list({ access, hooks, fields }), contrato de hooks (resolveInput/validateInput/afterOperation) y uso de context.sudo(). Aplica al crear o modificar un modelo.
type: reference
---

# Keystone Models — convenciones del proyecto

## Cuándo usar este skill

Antes de crear una list nueva, agregar/cambiar un field, o tocar un hook de un modelo. Los hooks y el access de una list son el punto donde vive la lógica de negocio y la seguridad de los datos; saltarse el contrato rompe la integridad o abre huecos de acceso.

## Estructura de una list

```ts
export const Report = list({
  access: { /* ver skill keystone-access */ },
  hooks: { resolveInput, validateInput, afterOperation },
  fields: {
    title: text({ validation: { isRequired: true } }),
    author: relationship({ ref: "User.reports", many: false }),
    // ...
  },
});
```

Un modelo se compone de tres bloques: `access` (quién puede qué — skill aparte), `hooks` (lógica de dominio en el ciclo de vida) y `fields` (forma de los datos). Manténlos en ese orden.

## Contrato de hooks (reglas duras)

1. **`resolveInput` transforma y retorna** — devuelve el objeto de datos resuelto: `return { ...resolvedData, slug };`. Es el único hook que muta lo que se va a persistir. Nunca lanzas desde aquí para validar (eso es `validateInput`).
2. **`validateInput` valida y lanza** — chequea invariantes de negocio y, si algo está mal, `addValidationError(msg)` o `throw new Error(msg)`. **Nunca retorna un valor**; su único efecto es dejar pasar o abortar la operación.
3. **`afterOperation` reacciona** — corre después de persistir (side-effects: encolar un job, recalcular un agregado, emitir un evento). **Siempre** chequea `operation` antes de actuar: `if (operation === "create" || operation === "update") { ... }`. En `delete` los datos ya no existen — usa `originalItem`.

## context.sudo() cheatsheet

```ts
context.sudo().db.Model;   // hooks + services: bypass del access, para lógica interna confiable
context.db.Model;          // NUNCA en hooks/services — re-aplica el access de la sesión y puede filtrar/negar de más
context.prisma;            // SOLO en scripts de seed/migración, nunca en runtime de la app
```

Dentro de un hook o service **siempre** usa `context.sudo()`. Usar `context.db` en un hook es un bug latente: la operación puede fallar o devolver datos parciales según quién esté logueado.

## Tabla rápida

| Necesito | Dónde / Cómo |
|---|---|
| Derivar un campo antes de guardar | `resolveInput` → `return { ...resolvedData, campo }` |
| Rechazar una operación inválida | `validateInput` → `throw new Error(...)` / `addValidationError(...)` |
| Efecto secundario tras guardar | `afterOperation` con guard `operation === 'create'\|'update'` |
| Leer/escribir otro modelo desde un hook | `context.sudo().db.OtroModelo` |
| Relación entre modelos | `relationship({ ref: "Otro.campoInverso" })` |

## Antes de declarar el cambio "listo"

- `{{qualityGate.fast}}` en verde.
- Ningún hook retorna desde `validateInput` ni lanza desde `resolveInput`.
- Ningún `afterOperation` actúa sin chequear `operation`.
- Ningún `context.db` ni `context.prisma` dentro de hooks/services (usa `context.sudo()`).
- Si agregaste un field a un modelo existente: corre la migración (ver `prisma-keystone`), no edites `schema.prisma` a mano.
