## Stack — Next.js (App Router)

App con App Router (`app/`). Server Components por default; `"use client"` solo en componentes con interactividad o estado de cliente. El data fetching vive en el servidor (Server Components, route handlers, server actions).

Regla de oro: no marques `"use client"` un árbol entero por una hoja interactiva — empuja el límite cliente lo más abajo posible. Aplica `nextjs-app-router` para estructura y `nextjs-data-fetching` para fetching/caching.
