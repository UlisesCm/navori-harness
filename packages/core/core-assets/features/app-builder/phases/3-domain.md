---
name: app-builder-3-domain
description: "Usar en la fase 3 de app-builder. Construye el motor de dominio: logica pura mas wiring de persistencia, con tests unitarios y typecheck limpio."
type: reference
---

# Fase 3 — Motor de dominio

## Objetivo

La logica de dominio pura mas su wiring de persistencia, cubierta por tests unitarios. Gate mecanico: auto-avanza cuando la evidencia pasa.

## Protocolo

1. **Separa puro de wiring.** El modulo puro (`scoring.ts`) no importa DB ni RN y es unit-testeable; el modulo de wiring (`engine.ts`) conecta la logica pura a Drizzle. Esta separacion es una regla dura de la feature.
2. **El dominio compartido vive en `packages/*`**, para que mobile y web lo reusen (browser-isomorphic). Nunca dupliques una regla de negocio entre app y dashboard: divergen.
3. **Deriva las reglas del documento** (§7). Cada regla de negocio debe ser verificable en codigo o por observacion; escribe un test por cada una.
4. **Queries de Drizzle son lazy** — haz `await` de cada mutacion o nunca corre.
5. **Fechas de solo dia:** construye desde componentes de fecha local, nunca `toISOString()` (el timezone corre el dia).

## Skills

- `verify-before-done` (navori) — corre el quality gate en este turno, no lo asumas del informe del subagente.
- `typescript`, `ponytail` (externas) — la `doctor` avisara si no estan bundleadas.

## Como verificar el gate

- Los tests unitarios pasan (incluye un test por regla de negocio del §7).
- `npx tsc --noEmit` limpio.
- La logica pura no tiene imports de framework ni de IO.

## Artifacts

- `packages/*` (dominio puro compartido), `features/<domain>/engine` (wiring).
- Engram: `app/{app}/phase-3`.

## Modelo

`sonnet`, effort medio.
