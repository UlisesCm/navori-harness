---
name: app-builder-8-web
description: "Usar en la fase 8 de app-builder. Entrega las paginas publicas / web app segun la jerarquia de tres tiers; privacy y support obligatorias para la submission."
type: reference
---

# Fase 8 — App web

## Objetivo

Paginas publicas de compliance (privacy + support OBLIGATORIAS; landing pitch opcional) live y validas para App Store Connect. La decision clave es que tier construir.

## Jerarquia de tres tiers — elige el PRIMER tier que aplique

1. **El producto tiene web app (`apps/web`) → dobla las paginas publicas adentro** como rutas publicas: un solo codebase/deploy, reusa shadcn + tokens. La web app hereda los packages de dominio/datos compartidos (browser-isomorphic), asi que es sobre todo un proyecto de UI. Orquesta con foundation-then-slices: un agente FOUNDATION secuencial (modelo top) que instala TODO, porta el design system y arma el shell + router con cada ruta pre-registrada; luego agentes FEATURE en PARALELO (sonnet) que espejan pantallas mobile, cada uno duenio de carpetas de ruta DISJUNTAS, sin npm installs ni edicion de archivos compartidos; luego un review gate.
2. **No hay web app, pero existe un dashboard (`apps/dashboard`) → agrega privacy/support como rutas PUBLICAS en el dashboard.** Las rutas viven FUERA del auth gate y el deployment las sirve publicas. NADA de un Astro aparte: un site separado junto a un dashboard existente es infraestructura innecesaria. Despliega el dashboard si aun no lo esta (ese deploy vale por si solo). El dashboard es su propia app (React 19 + Vite + shadcn, registro restringido).
3. **Ni web app ni dashboard → site estatico minimo Astro (`apps/site`).**

## Skills

- `astro-islands` (navori, solo tier 3), `review-diff` (navori, review gate de consistencia) — mapeados al catalogo.
- `app-ia`, `dashboard-ia` (tier 2), `react-19`, `tailwind-4`, `frontend-design` (externas) — la `doctor` avisara si no estan bundleadas.

## Como verificar el gate

- URLs publicas de privacy y support devuelven HTTP 200 SIN auth (verifica con `curl -I`, no con un browser logueado).
- Para deploys en Vercel: SSO deployment protection OFF en paginas publicas, Root Directory apuntando a la app correcta, alias no stale.

## Artifacts

- Segun tier: `apps/web` (rutas publicas) | rutas publicas en el dashboard | `apps/site`.
- Engram: `app/{app}/phase-8`.

## Modelo

`sonnet`, effort alto: la orquestacion del fan-out decide la calidad.
