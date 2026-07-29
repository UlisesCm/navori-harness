---
name: nextjs-app-router
description: Use when touching app/ or components/ in Next.js App Router — rules for Server vs Client Components, Server Actions, layouts.
type: reference
---

# Next.js App Router — project conventions

## When to use this skill

Before creating or modifying files under `app/` or components that will render in Next 13+ App Router. The Server/Client model is the source of 80% of bugs if not respected.

## Hard rules

1. **Default is Server Component.** Don't add `"use client"` unless the component needs state, effects, browser APIs, or event handlers. Every `"use client"` cuts the subtree's server-rendering and grows the bundle.
2. **`"use client"` goes up, not down.** If a Client Component renders a Server Component as children, that works. But importing a Server Component inside a Client Component turns it into client (breaks the model).
3. **Server Actions for mutations, not API routes.** Forms with `"use server"` actions + `useActionState` (from `react`; `useFormState` is deprecated) / `useFormStatus`. **A Server Action is a public POST endpoint**: validate the input (zod) and **verify auth/authorization INSIDE each action** (`const session = await auth(); if (!session) throw`) — the UI doesn't protect it.
4. **`async` only in Server Components.** Client Components can NOT be async (but they can receive a promise from a Server Component and unwrap it with `use(promise)`). For client-side fetch: React Query/SWR.
5. **`params`/`searchParams` and `cookies()`/`headers()` are async in Next 15.** `const { id } = await params`; `const store = await cookies()`. These APIs are server-only — don't read them in Client Components; pass them as props.

## Typical pattern

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

## Quick table

| I need | Where |
|---|---|
| Render static/dynamic HTML server-side | Server Component (default) |
| useState, useEffect, onClick | Client Component (`"use client"`) |
| Mutate data (form submit, button click) | Server Action (`"use server"`) |
| Public endpoint / webhook | `app/api/<route>/route.ts` |
| Shared layout | `app/<segment>/layout.tsx` (Server by default) |
| Loading state | `app/<segment>/loading.tsx` (Suspense fallback) |
| Error UI | `app/<segment>/error.tsx` ("use client" required) |

## Before calling the change "done"

- `{{qualityGate.fast}}` green.
- If you added `"use client"`: justify it (does it really need state/effect/handler?). If not, remove it.
- If you touched a Server Action: validate input and verify auth **inside** the action; don't expose sensitive data in the response (it's serialized to the client).
- If you added `revalidatePath` / `revalidateTag`: test the full flow (mutation → revalidation → updated UI).
