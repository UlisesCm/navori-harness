---
name: nextjs-app-router
description: Reglas para Next.js App Router — Server vs Client Components, Server Actions, layouts. Aplica antes de tocar app/ o components/.
type: reference
---

# Next.js App Router — convenciones del proyecto

## Cuándo usar este skill

Antes de crear o modificar archivos bajo `app/` o componentes que vayan a renderizar en Next 13+ App Router. El modelo Server/Client es la fuente del 80% de bugs si no se respeta.

## Reglas duras

1. **Default es Server Component.** No agregues `"use client"` a menos que el componente necesite estado, efectos, browser APIs o handlers de evento. Cada `"use client"` corta el server-rendering del subárbol y aumenta el bundle.
2. **`"use client"` sube, no baja.** Si un Client Component renderiza un Server Component como children, eso funciona. Pero importar un Server Component dentro de un Client Component lo convierte en client (rompe el modelo).
3. **Server Actions para mutaciones, no API routes.** Formularios con `"use server"` actions + `useActionState` (de `react`; `useFormState` está deprecado) / `useFormStatus`. **Una Server Action es un endpoint POST público**: valida el input (zod) y **verifica auth/authorization DENTRO de cada action** (`const session = await auth(); if (!session) throw`) — la UI no la protege.
4. **`async` solo en Server Components.** Client Components NO pueden ser async (pero pueden recibir una promise de un Server Component y desenvolverla con `use(promise)`). Para fetch en cliente: React Query/SWR.
5. **`params`/`searchParams` y `cookies()`/`headers()` son async en Next 15.** `const { id } = await params`; `const store = await cookies()`. Estas APIs son server-only — no las leas en Client Components; pásalas como props.

## Patrón típico

```
app/
├── (auth)/
│   ├── login/
│   │   ├── page.tsx          # Server Component
│   │   └── actions.ts        # "use server" actions
│   └── layout.tsx            # Server Component
├── dashboard/
│   ├── page.tsx              # Server: fetch data
│   ├── DashboardClient.tsx   # "use client": interactivity
│   └── loading.tsx           # Suspense fallback
└── layout.tsx                # Root layout
```

## Tabla rápida

| Necesito | Dónde |
|---|---|
| Renderizar HTML estático/dinámico server-side | Server Component (default) |
| useState, useEffect, onClick | Client Component (`"use client"`) |
| Mutar datos (form submit, button click) | Server Action (`"use server"`) |
| Endpoint público / webhook | `app/api/<ruta>/route.ts` |
| Layout compartido | `app/<segment>/layout.tsx` (Server por default) |
| Loading state | `app/<segment>/loading.tsx` (Suspense fallback) |
| Error UI | `app/<segment>/error.tsx` ("use client" obligatorio) |

## Antes de declarar el cambio "listo"

- `{{qualityGate.fast}}` en verde.
- Si agregaste `"use client"`: justifícalo (¿realmente necesita estado/efecto/handler?). Si no, remuévelo.
- Si tocaste un Server Action: valida input y verifica auth **dentro** de la action; no expone datos sensibles en el response (se serializa al cliente).
- Si agregaste `revalidatePath` / `revalidateTag`: prueba el flow completo (mutación → revalidación → UI actualizada).
