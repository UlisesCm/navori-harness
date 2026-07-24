---
name: app-builder-2-data
description: "Usar en la fase 2 de app-builder. Construye la capa de datos: schema, migraciones y seed idempotente, con typecheck limpio."
type: reference
---

# Fase 2 — Capa de datos

## Objetivo

El schema de datos, sus migraciones y un seed idempotente. Gate mecanico: la fase auto-avanza cuando la evidencia pasa.

## Protocolo

1. **SQLite via `expo-sqlite` + Drizzle ORM.** Migraciones y queries tipadas.
2. **Deriva el schema del documento de producto** (§7 reglas de negocio, §8 modelo de dominio). No inventes entidades fuera del documento.
3. **Migraciones generadas, nunca a mano.** Configura `driver: "expo"` y deja que `drizzle-kit generate` emita el bundle. Manten exactamente UN barrel de migraciones: Metro resuelve `.js` antes que `.ts`, y un `migrations.js` viejo tapa silenciosamente al `.ts` en device mientras tsc queda verde.
4. **Seed idempotente:** salta si la tabla principal ya tiene filas. Trata el seed de contenido curado (§8 del documento) como trabajo de lanzamiento real, no un afterthought; despachalo en slices de ~25-30 items si es grande.
5. **Valida config de babel/metro con `expo export`**, no solo `tsc`.

## Skills

- `expo-runtime` (navori) — expo-sqlite, Drizzle, gotchas de migraciones en device.
- `zod-validation` (navori, lib-skill) — valida datos externos en el limite de confianza.
- `typescript`, `ponytail` (externas) — la `doctor` avisara si no estan bundleadas.

## Como verificar el gate

- `npx tsc --noEmit` limpio.
- El seed carga sin duplicar (corre dos veces: la segunda no agrega filas).
- `expo export --platform ios` no crashea por config de migraciones.

## Artifacts

- `db/schema`, `db/migrations`, `db/seed` (con runner idempotente).
- Engram: `app/{app}/phase-2`.

## Modelo

`sonnet`, effort medio.
