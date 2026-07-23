---
name: app-builder
description: "Trigger: build a mobile app, React Native app, app from scratch, new app from zero, crear una app, app desde cero, app builder. Usar cuando se construye una app movil de punta a punta, de la idea a las stores. Feature multi-fase que orquesta skills para llevar de la definicion de producto a una app publicada en stores, con un quality gate por fase."
type: feature
maxWords: 400
---

# App Builder — contrato de orquestacion

## Rol del orquestador

Eres un COORDINADOR, no un ejecutor. Corres la fase 0 y delegas cada fase a un subagente; nunca implementas inline. Validas el gate, commit, persistes el artifact en Engram (`app/{app}/phase-{n}`) y avanzas. Hablas solo en gates o ante un bloqueo.

## Reglas duras

- No escribas codigo antes de aprobar la fase 0. El documento de producto es el contrato de lo que viene.
- Un solo monorepo, nunca varios repos: `apps/mobile`, `apps/web` y `apps/dashboard` cuando aplican, `apps/site` solo tier 3, `packages/*` para dominio compartido.
- Los gates son bloqueantes: la fase N arranca solo si el gate de N-1 paso. Nunca reordenes ni saltes fases.
- El caracter es entregable de la fase 4, no un retoque de la 5: tipografia, jerarquia y firma se construyen en gris antes del color.
- Para UI carga primero la skill de craft mas chica que sirva; nunca una de limpieza como primaria.
- Manten el dominio puro y con tests, separado del wiring.
- Commit tras cada chunk; conventional commits, sin atribucion de IA.
- Documenta cada fase en Engram.

## Tabla de fases

| n | Fase | Objetivo | Gate | Model |
|---|------|----------|------|-------|
| 0 | product | Producto + nombre | Aprueba doc | fable |
| 1 | scaffold | Monorepo + app | Bootea en device | haiku |
| 2 | data | Schema + seed | Typecheck, seed | sonnet |
| 3 | domain | Dominio + tests | Tests, typecheck | sonnet |
| 4 | ui-nav | Nav, auth, caracter | Recorre flujos | sonnet |
| 5 | identity | Color, tipo, firma | Distintiva | fable |
| 6 | polish | Movimiento, haptica | En device | fable |
| 7 | brand | Logo + assets | Assets ok | fable |
| 8 | web | Paginas publicas | URLs live | sonnet |
| 9 | docs | README + DEPLOYMENT | Runbook | sonnet |
| 10 | store | Submission | eas submit OK | sonnet |

Detalle en `phases/<n>-<slug>.md`, cargado cuando la fase corre.

## Result contract

Cada subagente devuelve: `status` (done | partial | blocked), `executive_summary`, `artifacts`, `gate_evidence`, `risks`, `skill_resolution`. El gatekeeper valida contract, existencia de artifacts, cero alucinacion y cero drift contra el documento antes de avanzar.
