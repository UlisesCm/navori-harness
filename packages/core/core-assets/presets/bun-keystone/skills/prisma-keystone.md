---
name: prisma-keystone
description: Prisma bajo Keystone 6 — schema.prisma autogenerado (no editar a mano), migraciones vía keystone prisma migrate, y context.prisma solo en scripts. Aplica al cambiar la forma de datos o correr migraciones.
type: reference
---

# Prisma bajo Keystone

## Cuándo usar este skill

Al agregar/cambiar un field o una list (cambia la forma de la BD), al correr o revisar migraciones, o al escribir un script de seed/backfill. El error clásico es editar `schema.prisma` o `schema.graphql` a mano — ambos son artefactos generados y tu cambio se pierde en la siguiente generación.

## Regla base: el schema es derivado, no fuente

- **`schema.prisma` y `schema.graphql` son autogenerados por Keystone** a partir de las lists. La fuente de verdad son los archivos de `models/`. **Nunca los edites a mano.**
- Para cambiar la BD: edita la list (field nuevo, cambio de tipo, relación), regenera y migra. Keystone reescribe el schema.
- No leas `schema.prisma` completo para "entender los tipos" — infiérelos desde la list o busca con `grep`. Es largo y derivado.

## Migraciones (vía Keystone, no Prisma directo)

```bash
# Desarrollo: genera + aplica una migración a partir del cambio en las lists
keystone prisma migrate dev --name <descripcion-corta>

# Producción / deploy: aplica migraciones ya generadas
keystone prisma migrate deploy
```

Usa siempre `keystone prisma ...` (respeta la config de Keystone), no `prisma migrate` suelto. Revisa el SQL generado antes de commitear la migración: una migración destructiva (drop de columna con datos) necesita un plan de datos, no solo el cambio de schema.

## context.prisma — solo en scripts

```ts
context.sudo().db.Model;  // runtime de la app (hooks/services) — ver keystone-models
context.prisma;           // SOLO scripts de seed/migración/backfill — nunca en runtime
```

`context.prisma` te da el cliente Prisma crudo (sin access ni hooks de Keystone). Es la herramienta correcta para un seed o un backfill masivo, y la herramienta incorrecta dentro de un hook o un resolver — ahí siempre `context.sudo().db`.

## Antes de declarar el cambio "listo"

- `{{qualityGate.fast}}` en verde.
- Ni `schema.prisma` ni `schema.graphql` fueron editados a mano (aparecen solo como salida de la regeneración).
- Toda migración nueva está commiteada junto al cambio de la list que la origina.
- Ningún `context.prisma` fuera de `scripts/`.
