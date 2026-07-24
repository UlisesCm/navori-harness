---
name: new-resource
description: Crear un recurso/feature de punta a punta en Next.js App Router (tipo → validación → datos → adapter → UI → ruta). Aplica al dar de alta un recurso nuevo; para modificar uno existente, espeja su patrón en vez de rehacerlo.
type: reference
maxWords: 800
---

# new-resource — recurso/feature end-to-end (Next.js App Router)

## Cuándo usar

Al dar de alta un recurso o feature nuevo de punta a punta (datos → UI → ruta). Para tocar uno que ya existe, sigue su patrón; no lo rehagas.

## 0. Antes de crear: reusa y sé consistente (esto primero)

- **Busca un recurso similar YA en el repo y espéjalo**: estructura de carpetas, naming, capa de datos, manejo de estado. Consistencia con el repo > preferencia personal.
- **Reusa antes de crear**: ¿ya hay un componente / hook / util (el UI kit del repo, `shared/`) que sirve? Úsalo. Crea algo nuevo solo si de verdad no existe uno equivalente.
- **Sigue el theme / design system**: usa los tokens y componentes de la lib del repo; nada de estilos hardcodeados ni UI fuera de tema.
- **Una fuente de verdad**: deriva tipos, labels y estados de donde ya viven; no dupliques enums ni constantes.

## Estructura — feature-based + colocación

- Todo lo del recurso **junto, colocado a su feature/ruta** (`_components`, `_lib` privados en App Router — el prefijo `_` los excluye del routing). No lo esparzas en `/components` o `/utils` globales.
- **Regla shared**: si UN feature lo usa → vive dentro del feature; si DOS o más lo usan → promuévelo a `shared/`. Los features **no se importan entre sí** (si hace falta, compón en la page o sube la pieza a shared).
- Nesting 2-3 niveles máx. Empieza simple; agregas estructura cuando el recurso realmente crece.

## Pasos (orden estricto — de adentro hacia afuera)

Cada paso depende del anterior; verifica que compila antes de seguir.

1. **Tipo de dominio** — el modelo del recurso en tu capa de tipos, agnóstico del backend o de tipos generados. Enums + sus labels/variants derivados aquí (fuente única).
2. **Validación en la frontera** — schema (zod) para todo input externo (form, params, respuesta de red). Los DTOs salen del schema (`z.infer`), no se escriben a mano.
3. **Acceso a datos (server)** — la query/mutation por tu capa de datos: fetch en un Server Component, un Server Action o un route handler. Secretos y sesión quedan en el server.
4. **Adapter** (solo si hay tipos generados / GraphQL) — mapea el tipo crudo del backend al tipo de dominio y normaliza enums desconocidos a un valor seguro. La UI consume **dominio**, nunca tipos generados.
5. **UI** — un Server Component que fetchea y compone; empuja `"use client"` a las **hojas** (interactividad, estado, browser APIs), lo más abajo posible. Pasa props serializables hacia abajo y reusa el UI kit.
6. **Routing / nav** — la page/segment en App Router y su entrada de navegación. Sin esto, el recurso no es accesible.

## Server vs Client (App Router)

- **Server Component por default**: data, secretos, composición. Fetchea en el server y evita el API ping-pong (no re-traigas en el cliente lo que ya trajo el server).
- **Client Component** (`"use client"`) solo para interacción, estado local o browser APIs, y siempre lo más abajo posible en el árbol.

## Qué NO hacer (evita over-engineering)

- Nada de hexagonal / DDD / CQRS ni capas de abstracción especulativas para un CRUD. Layered simple alcanza.
- Sin interface o helper genérico con un solo caller, ni parametrización "por si acaso".
- Sin dependencia nueva para lo que el repo, la plataforma o una lib ya instalada resuelven en unas líneas.
- No dupliques un componente que ya existe con otro nombre (rompe la fuente única y el theme).

## Antes de declarar listo

- `{{qualityGate.fast}}` en verde.
- El recurso es accesible (page + entrada de nav) y el golden path anda; el input inválido se rechaza en la frontera (zod).
- Reusaste lo que existía y seguiste el patrón + theme del repo — no inventaste una variante.
- La UI consume tipos de dominio (no generados) y `"use client"` está solo donde hace falta.

<!-- navori:user-section -->
## Convenciones de este repo

<!-- user: documenta aquí lo específico de tu stack para que el scaffold sea exacto:
     - Rutas exactas donde viven tipos, schemas, capa de datos, adapters y features/UI.
     - Tu UI kit / design system y dónde está el theme (tokens, componentes base a reusar).
     - Si usas GraphQL + codegen: el comando (ej. `bun run codegen`) y de dónde salen los tipos generados.
     - El helper de validación y el contrato de respuestas/errores.
     - Un recurso EJEMPLO ya hecho que sirva de molde a espejar.
-->
