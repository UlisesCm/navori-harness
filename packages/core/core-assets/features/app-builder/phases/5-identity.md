---
name: app-builder-5-identity
description: "Usar en la fase 5 de app-builder. Aplica la identidad visual: valores de color, tipografia caracteristica y elemento de firma como edicion de tokens Capa 2."
type: reference
---

# Fase 5 — Identidad visual

## Objetivo

Una direccion de color comprometida (valores de tokens) mas las dos cosas que un swap de color no arregla: (1) tipografia real —un display face con caracter mas un body face, cargados y aplicados via escala tipografica, nunca la fuente del sistema— y (2) un elemento de FIRMA por el que la app se recuerda. Es la pasada de Capa 2 (identidad) sobre los tokens de Capa 1 (estructura) de la fase 1.

## Protocolo

1. **Identidad = edicion de valores de tokens, no de pantallas.** Redefine sobre los MISMOS nombres de token de Capa 1: colores, familias de fuente (pairing display/body real), valores del elemento de firma. Landear Capa 2 es un token-value edit, no estructura nueva.
2. **Cambiar la SHAPE es barato aqui.** Un cambio compartido (mas radio en todos los botones) = una edicion de token en `lib/theme.ts`. Un cambio estructural (una variante nueva de Button) = un archivo de primitivo en `components/ui/*`. Las pantallas quedan intactas por construccion.
3. **De-genericizar vive en tipo + firma, no en hex.** Un swap de token de color sobre una estructura generica sigue siendo generico. Un fondo casi-blanco/crema lee como "el default de la IA"; la distincion viene de comprometerse con color y tipo.
4. **Presenta 2-4 opciones concretas** de direccion visual; el usuario elige. Nunca impongas una.

## Skills

- `frontend-design` (primaria), `ui:typeset`, `ui:colorize`, `tailwind-4` (externas) — la `doctor` avisara si no estan bundleadas.

## Como verificar el gate

- El usuario confirma que se siente distintiva, no generica, EN DEVICE.
- El diff toca SOLO `lib/theme.ts` y `components/ui/*`. Cualquier cambio a un archivo de pantalla por styling es fallo de gate: significa que la Capa 2 se filtro a las pantallas en vez de landear como edicion de token.

## Artifacts

- `lib/theme.ts` (tokens Capa 2), `components/ui/*`.
- Engram: `app/{app}/phase-5`.

## Modelo

`fable`, effort alto: aqui decide el gusto.
