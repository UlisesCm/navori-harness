---
name: app-builder-9-docs
description: "Usar en la fase 9 de app-builder. Genera la documentacion de entrega anclada al repo real: README.md y DEPLOYMENT.md."
type: reference
---

# Fase 9 — Docs de entrega

## Objetivo

Un `README.md` y un `DEPLOYMENT.md` anclados al repo real, nunca boilerplate. Gate mecanico: derivados del repo y verificados contra el.

## Protocolo

1. **README.md derivado del repo.** Que/por que, arquitectura, layout del monorepo, prerequisitos, setup local, scripts, testing, troubleshooting. Cada dato sale del repo real; nada inventado.
2. **DEPLOYMENT.md como runbook completo.** Referencia de env, runbooks de backend/web/mobile, checklist post-deploy, rollback. Debe ser verificable paso a paso.
3. **Verifica contra el repo.** El README tiene que bootear un clone limpio: si un comando o path no existe en el repo, es un error, no un hueco.

## Skills

- `verify-before-done` (navori) — verifica los comandos documentados en este turno, no los asumas.
- `ship-docs`, `cognitive-doc-design` (externas) — la `doctor` avisara si no estan bundleadas.

## Como verificar el gate

- Un clone limpio sigue el README y la app corre.
- `DEPLOYMENT.md` cubre env, deploy y rollback de cada superficie.
- Cero comandos o paths que no existan en el repo.

## Artifacts

- `README.md`, `DEPLOYMENT.md`.
- Engram: `app/{app}/phase-9`.

## Modelo

`sonnet`, effort medio.
