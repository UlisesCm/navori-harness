---
name: hono
description: Use when adding a route, middleware, or error handling to a Hono API, or wiring its typed RPC client — chained app composition, typed context, validation, runtime adapters. Not for Express or other Node frameworks.
metadata:
  type: reference
---

# Hono — conventions

## When to use this skill

When touching the API app: adding a route, a middleware, validation, or wiring the typed client against it. Target version: Hono 4.13. On a different major, recheck the RPC-typing mechanics below before relying on them — they depend on TypeScript inference over the exact return type of the chain, which is the kind of thing a major bump can subtly change.

## The pattern

Build the app as one chained expression; assigning intermediate steps to variables breaks the type inference the RPC client depends on:

```ts
const app = new Hono<AppEnv>()
  .use('*', cors({ origin: trustedOrigins }))
  .use('*', requestLogger)
  .get('/health', (c) => c.json({ ok: true }))
  .on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  .use('*', sessionMiddleware(auth))
  .route('/notes', notesRoute)
  .onError(onError)
  .notFound(onNotFound);

export type AppType = typeof app;
```

## Gotchas that bite

- **Chain the methods; never `app = app.route(...)` as a separate statement.** Each Hono method returns a new type carrying the accumulated route info. Breaking the chain loses that type, and `hc<AppType>()` on the client stops seeing the split-off routes — it still compiles, it just silently drops type safety for those endpoints.
- **`Hono<AppEnv>()` is where context typing comes from.** Define `AppEnv` as `{ Variables: { db: Db, user: SessionUser | null } }` once; every route/middleware reads with `c.get('user')`/`c.get('db')` and writes with `c.set(...)`. A route not declared against `AppEnv` gets `c.get()` back as `unknown`.
- **Sub-routers are their own `new Hono<AppEnv>()` instance**, composed with `.route('/notes', notesRoute)` in the parent chain — keeps a resource's routes in one file while sharing the Env type; skip `<AppEnv>` on the sub-router and `c.get`/`c.set` typing breaks inside it.
- **`zValidator('json', schema)` as route middleware, then `c.req.valid('json')` in the handler** for the typed, validated body — reading `await c.req.json()` directly in a route that also has `zValidator` bypasses both validation and type narrowing.
- **`onError` logs structured fields only — method, path, error name/message.** Never log headers or the raw request/response body: that's where auth tokens and PII live.
- **`HTTPException` (from `hono/http-exception`) throws a typed HTTP error from deep in a handler/middleware** and surfaces with the right status through Hono's error handling — a plain `Error` loses the status code.
- **Runtime adapters are not interchangeable.** Node: `@hono/node-server`'s `serve({ fetch: app.fetch, port })`. Workers: `export default { fetch(request, env) { return app.fetch(request, env) } }` — Workers has **no `process.env`**; config comes through `env`/`c.env`, validated (e.g. Zod) before the app is built.
- **`hc<AppType>(baseURL)` from `hono/client`** gives a fully typed RPC client — only if `AppType` was exported from the chained app itself, not an intermediate variable.

## Hard rules

1. The app is built as one chained expression; no intermediate `app = app.x(...)` reassignment.
2. Every route/middleware is typed against the shared `AppEnv`; no untyped `c.get`/`c.set`.
3. Validated bodies are read with `c.req.valid(...)`, never `c.req.json()` alongside an active `zValidator`.
4. `onError` never logs headers, tokens, or raw body content.
5. Cloudflare-targeted code reads config from `env`/`c.env`, never `process.env`.

## Before declaring done

- The app definition is one chain; `AppType` is exported from that chain, not an intermediate variable.
- Every new route/middleware is typed against `AppEnv`.
- `onError` output contains no headers, tokens, or body content.
- `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's API layer (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The shape of `AppEnv` and where each Variable gets set.
     - Which runtime(s) this API actually deploys to (Node, Workers, both) and where env validation lives.
     - The RPC client's consumers — who imports `AppType` and how.
     - Any route-specific rate limiting or auth requirement not covered by the shared middleware.
-->
