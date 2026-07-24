---
name: app-builder-4-ui-nav
description: "Usar en la fase 4 de app-builder. Construye navegacion, pantallas core, onboarding, la superficie de auth completa y el caracter estructural en gris; incluye el ciclo de refinamiento UX/UI."
type: reference
---

# Fase 4 — UI + navegacion

## Objetivo

El modelo de navegacion (con iconos de tab bar), las pantallas core, el onboarding, los componentes propios y la superficie de auth COMPLETA. Esta fase es donde la app gana su CARACTER: despues, las fases solo recolorean y animan.

## Protocolo

1. **Auth completa, no solo login.** Ademas de sign-up/sign-in/sign-out: forgot/reset password, change password y borrado de cuenta in-app. El borrado de cuenta es OBLIGATORIO para cualquier app con creacion de cuenta (guideline 5.1.1(v) de Apple). Planea el reset temprano; OTP por codigo evita la complejidad de deep-links.
2. **Caracter estructural en gris.** Construye una escala tipografica real (jerarquia de peso/tamano, no plana), ritmo de espaciado deliberado y el elemento de firma estructural AHORA, todo bajo paleta NEUTRA (cero decisiones de color). Caracter estructural no es color: tipografia, composicion, iconografia y craft de empty states se construyen aqui, en gris. Una fase 4 con pantallas planas, de peso uniforme y fuente del sistema es fallo de gate aunque los flujos funcionen.
3. **Solo primitivos en pantallas.** Nunca `Pressable` ni `TextInput` directo para un control estandar: si un primitivo no calza, extiendelo en `components/ui/*`. Extrae cualquier patron usado en 2+ lugares a un componente propio.
4. **Refinamiento UX/UI (ciclo con el usuario).** Tras el primer recorrido, itera sobre ergonomia de navegacion, defaults, empty states, copy de error y conteo de taps del core loop; audita la densidad de informacion y re-jerarquiza pantallas saturadas (progressive disclosure). Cero identidad visual: la paleta neutra se queda.

## Skills

- `expo-runtime`, `rn-performance` (navori) — runtime y performance de RN.
- `app-ia`, `ui:impeccable` (primaria, carga y APLICA), `ui:bolder`, `react-19`, `typescript`, `ponytail` (externas) — la `doctor` avisara si no estan bundleadas.

## Como verificar el gate

- El usuario recorre TODOS los flujos y funcionan; confirma que las pantallas leen claras y ya tienen personalidad estructural en gris.
- `rg -n "Pressable|TextInput" app/ --glob '!components/ui/*'` devuelve cero.
- `rg -n "height: [0-9]|paddingVertical: [0-9]" app/` no muestra styling de control fuera de `components/ui/*`. Cualquier hit es fallo de gate automatico.

## Artifacts

- `app/*` (rutas, nav, auth), `components/ui/*` extendido.
- Engram: `app/{app}/phase-4`.

## Modelo

`sonnet`, effort alto: aqui decide el juicio de diseno.
