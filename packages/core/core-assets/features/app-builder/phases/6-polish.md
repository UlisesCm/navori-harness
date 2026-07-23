---
name: app-builder-6-polish
description: "Usar en la fase 6 de app-builder. Agrega pulido creativo: microinteracciones, movimiento y haptica, verificado en device real."
type: reference
---

# Fase 6 — Pulido creativo

## Objetivo

Microinteracciones, movimiento y haptica que hacen la app deleitable, sin romper la identidad ya comprometida. Gate humano: verificado en device real.

## Protocolo

1. **Deleite con criterio.** Lo que funciona: scale-on-press (`active:scale-95`), animaciones de entrada escalonadas, un elemento de firma con movimiento, haptica solo en acciones significativas. Decora contenido, nunca affordances criticas.
2. **Nunca gatees una CTA critica tras una animacion `entering` con delay.** En el primer mount tras el splash (fuentes/DB cargando), Reanimated puede congelar entradas con delay en opacity 0: boton invisible, sin error.
3. **Nunca pongas className en un seam `cssInterop(createAnimatedComponent(...))` para UI critica.** Cuando el interop falla, falla SILENCIOSO en runtime mientras tsc, tests y `expo export` quedan verdes. El press feedback va en un `Pressable` plano o un wrapper interno.
4. **Haptica detras de un wrapper** `lib/haptics.ts`. Respeta reduce-motion.
5. **Dev build en device fisico temprano:** los simuladores esconden haptica, fuentes y performance.

## Skills

- `rn-performance` (navori) — performance de animaciones en RN.
- `verify-before-done` (navori) — mapea a la verificacion en device: no des la fase por hecha sin evidencia real.
- `ui:motion`, `not-boring-mobile` (externas) — la `doctor` avisara si no estan bundleadas.

## Como verificar el gate

- El usuario verifica el movimiento y la haptica en un device real.
- Ninguna CTA critica queda invisible tras el primer mount.
- reduce-motion honrado.

## Artifacts

- `lib/haptics.ts`, animaciones y microinteracciones.
- Engram: `app/{app}/phase-6`.

## Modelo

`fable`, effort medio: el gusto guia, pero el scope es acotado.
