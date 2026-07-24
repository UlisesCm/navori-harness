---
name: app-builder-10-store
description: "Usar en la fase 10 de app-builder. Ejecuta la submission a stores como codigo: metadata, screenshots, eas build y eas submit a ambas stores."
type: reference
---

# Fase 10 — Store ship

## Objetivo

La submission a las stores como codigo, hasta que `eas submit` corre en ambas y el checklist manual queda entregado.

## Prerequisitos duros

- **Metadata copy deriva del documento de producto (fase 0).** Nunca inventes el pitch de store.
- **URLs de privacy/support vienen de la fase 8.** Sin ellas la submission de App Store Connect no cierra.

Ambos son prerequisitos duros: verifica que existan antes de arrancar.

## Protocolo

1. **`store/` como codigo.** Metadata de iOS via `eas metadata`, arbol supply de Play, screenshots.
2. **`eas.json`** con perfiles de build y submit.
3. **Screenshots con Maestro** corridos contra data demo seeded, en la matriz de devices requerida.
4. **Build y submit.** `eas build` + `eas submit` a TestFlight / track interno de Play.
5. **Checklist manual explicito.** App Privacy y content-rating questionnaires, primer upload de AAB en Play, cuenta demo para review. Las submissions corren en las cuentas de store del usuario.

## Skills

- `store-ship` (externa) — envuelve EAS build/submit, metadata as code y screenshots Maestro. La `doctor` avisara si no esta bundleada.

La fase opcional de video promocional de la skill de origen queda fuera de v1; se retoma como iteracion posterior si el usuario la pide.

## Como verificar el gate

- `eas submit` OK en ambas stores: build visible en TestFlight, release creado en el track interno de Play.
- El checklist manual esta entregado al usuario.

## Artifacts

- `store/` (metadata iOS + Play), `eas.json`, flujos Maestro de screenshots.
- Engram: `app/{app}/phase-10`.

## Modelo

`sonnet`, effort medio.
