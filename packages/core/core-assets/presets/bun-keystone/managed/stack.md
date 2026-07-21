## Stack — Keystone 6 (Bun + Prisma)

Backend GraphQL sobre **Keystone 6**, runtime **Bun**, persistencia **Prisma + PostgreSQL**. Los datos se modelan como *lists* (`list({ access, hooks, fields })`) y Keystone deriva de ahí el schema Prisma y la API GraphQL: `schema.prisma` y `schema.graphql` son **autogenerados**, nunca se editan a mano (ver `prisma-keystone`).

Tres contratos gobiernan todo el código de datos:

- **Access control en 3 capas** — cada list declara `operation`, `filter` y `field`; `allowAll` está prohibido. Una sesión nula recibe un filtro restrictivo, nunca abierto. Ver `keystone-access`.
- **Hooks con contrato estricto** — `resolveInput` retorna datos, `validateInput` lanza `Error` (nunca retorna un valor), `afterOperation` chequea `operation` antes de actuar. Ver `keystone-models`.
- **`context.sudo()` en hooks y services** — nunca `context.db` (aplicaría el access de la sesión actual) ni Prisma directo; `context.prisma` queda solo para scripts de seed/migración.

Toda dependencia externa (SMS, pagos, APIs de terceros) va detrás de una interfaz en `[servicio].adapter.ts`: los services reciben la interfaz, no la implementación, para poder mockearla en tests.

**Eficiencia de contexto** — los artefactos generados (`types/graphql.ts` puede rondar decenas de miles de tokens, `schema.graphql`, `migrations/`, el lockfile) **no se leen completos**: infiere los tipos desde la *list* en `models/` o desde `schema.prisma`, y busca con `grep`/`Grep` en vez de abrir el archivo entero.
