---
name: new-feature
description: Usar al crear un recurso/feature nuevo end-to-end. Define el orden estricto de capas (interface → service → adapter → component → router) para que el dato fluya consistente. Los templates concretos del dominio van en la user-section.
type: reference
---

# New feature — orden de capas

## Cuándo usar este skill

Al crear un recurso o feature nuevo de punta a punta (un endpoint que termina consumido en una pantalla). Define el ORDEN en que se construyen las capas; el contenido concreto de cada una es del dominio de tu repo (va en la user-section).

## Orden estricto

Construye de adentro hacia afuera. No saltees capas ni las hagas en desorden:

1. **interface / tipos** — define la forma del dato: el shape de la respuesta cruda y el del modelo que consume la UI. Sin esto, todo lo de arriba se castea a ciegas.
2. **service** — la llamada de red. URL desde config (sin hardcode), cancelación, manejo de error. Devuelve el dato crudo tipado.
3. **adapter** — función PURA que transforma el dato crudo al modelo de UI. Defaults explícitos para nullables, fallback de enums desconocidos. Sin I/O, sin estado global.
4. **component / page** — consume el modelo vía el adapter. Loading + error states. Nada de fetch crudo en el componente.
5. **router / navegación** — recién cuando la pantalla anda, la enganchas al router.

Regla: si la capa N necesita algo de la capa N-1 que todavía no existe, **paras y haces N-1 primero**. El dato fluye `red → service → adapter → component`; construir al revés genera casts y deuda.

## Antes de declarar "listo"

- `{{qualityGate.fast}}` en verde.
- El dato se ve correcto en la UI con datos reales (no solo el happy path mockeado).
- Aplica `verify-before-done`; si tocaste pantallas, valida manualmente.

## Conexión

- `implementer`: sigue este orden al crear un recurso; documenta en `progress/impl_<feature>.md` qué quedó en cada capa.
- `review-diff`: el reviewer valida cada capa (tipos, capa de datos, component/page) con sus severidades.

<!-- navori:user-section -->
## Templates y reglas del recurso (tu dominio)

<!-- user: agrega acá los templates concretos de TU stack para cada capa (los que NO son generalizables). Sugerencias:
     - El esqueleto real de un service (cliente HTTP, headers obligatorios, patrón de cancelación).
     - El patrón de adapter del repo (naming, defaults, fallback de enums).
     - El patrón de form/validación (lib + resolver).
     - Convención de carpetas y sufijos (dónde va cada capa, naming de archivos).
     - Reglas de migración legacy ↔ nuevo backend si aplica.
-->
