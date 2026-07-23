---
name: app-builder-0-product
description: "Usar en la fase 0 de app-builder. Produce el documento de definicion de producto: ronda de preguntas batched, documento desde template, aprobacion del usuario con nombre definitivo y sync del nombre al config."
type: reference
---

# Fase 0 — Producto

## Objetivo

Un documento de definicion de producto aprobado por el usuario, con el nombre definitivo de la app decidido. Es el contrato de todo lo que se construye despues: no se escribe codigo hasta que este aprobado.

## Protocolo

1. **Ronda de preguntas batched PRIMERO.** Antes de redactar nada, haz UNA sola ronda de preguntas que cubra las decisiones que dan forma al documento: profundidad del motor, estrategia de contenido, limites de alcance, audiencia, y si el producto tiene dos lados (usuarios que consumen datos y staff que los administra → posible `apps/dashboard`). Nunca redactes el documento desde la idea cruda.
2. **Documenta desde el template.** Usa `assets/product-definition-template.md` como base. La seccion de nombre y marca es parte del documento, no un paso aparte. Apunta a un maximo de 2 iteraciones del documento (economia de tokens).
3. **Gate: aprobacion explicita CON nombre definitivo.** No avances al scaffold sin que el usuario apruebe el documento y confirme el nombre definitivo. El nombre definitivo es un artifact declarado de esta fase y parte de su gate.
4. **Sync del nombre al config.** Al cerrar la fase, ejecuta `navori configure name <definitivo>` como paso mecanico. Renombrar la carpeta es opcional y cosmetico; nada del harness depende del basename despues del init.

## Skills

- `cognitive-doc-design` (externa) — carga al redactar el documento para reducir carga cognitiva del lector. La `doctor` avisara si no esta bundleada; documenta la dependencia igual.

## Como verificar el gate

- El usuario dice explicitamente que aprueba el documento.
- El documento incluye seccion de nombre y marca con el nombre definitivo.
- `docs/product-definition.md` existe en el repo.
- `navori configure name <definitivo>` corrio y el `name` del config quedo actualizado.

## Artifacts

- `docs/product-definition.md` — siempre vive en el repo, cualquiera sea el store.
- `config: name` definitivo via `navori configure name`.
- Engram: `app/{app}/phase-0` (decisiones y nombre bloqueados).

## Modelo

`fable` (Fable si esta disponible, si no Opus), effort alto: la fase la decide el juicio, no la mecanica.
