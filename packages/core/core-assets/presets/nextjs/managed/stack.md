## Stack — Next.js (App Router)

App with the App Router (`app/`). Server Components by default; `"use client"` only in components with interactivity or client state. Data fetching lives on the server (Server Components, route handlers, server actions).

Golden rule: don't mark a whole tree `"use client"` for one interactive leaf — push the client boundary as far down as possible. Apply `nextjs-app-router` for structure and `nextjs-data-fetching` for fetching/caching.
