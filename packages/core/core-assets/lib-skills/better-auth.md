---
name: better-auth
description: Use when touching auth server config, session middleware, the auth client, or a Better Auth plugin (email OTP, bearer, rate limiting) — server/client wiring, session retrieval, schema. Not for a hand-rolled JWT/session implementation.
metadata:
  type: reference
---

# Better Auth — conventions

## When to use this skill

When touching auth: the `betterAuth(...)` server config, session middleware, the auth client, or a plugin (email OTP, bearer tokens, rate limiting). Target version: Better Auth 1.7. On a different major, recheck the CLI command names and plugin pairing below before relying on them — auth is exactly the surface where a stale assumption becomes a security bug, not just a broken build.

## The pattern

One server config, mirrored by a matching client config — the plugin arrays on both sides must line up:

```ts
// server
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  secret,                          // must be >= 32 chars — see gotchas
  trustedOrigins,                  // keep in sync with CORS, see gotchas
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: true, storage: 'database' },
  plugins: [emailOTP({ sendVerificationOTP }), bearer()],
});

app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw)); // before session-dependent routes

// client
export const client = createAuthClient({
  baseURL,
  plugins: [emailOTPClient()],
  fetchOptions: { auth: { type: 'Bearer', token: () => storedToken } },
});
```

## Gotchas that bite

- **`secret` must be at least 32 characters**; gate it with a schema check (e.g. `z.string().min(32)`) at startup — it signs sessions/tokens.
- **`trustedOrigins` is the same allowlist CORS needs — keep them in sync manually**, Better Auth doesn't derive one from the other, or a request can pass CORS and still get rejected by auth.
- **Mount `/api/auth/*` before any route that depends on session state**; a session-reading route mounted earlier in the chain sees no session even on a valid request.
- **`auth.api.getSession({ headers: c.req.raw.headers })` in middleware, storing only the minimal shape in context** — e.g. `{ id, email }`, not the raw session object, to keep the blast radius small if context later gets logged.
- **Client calls return `{ data, error }` (or throw on network failure) — unify that in one helper**; a missed ad hoc `if (error)` check treats a failed auth call as success.
- **Server and client plugin arrays must pair up.** Server `emailOTP()` + `bearer()` needs client `emailOTPClient()` plus `fetchOptions.auth` for the bearer token, or the feature fails silently.
- **Bearer transport means capturing `set-auth-token` and resending it as `Authorization: Bearer <token>`** — no cookie jar does it for you; it has no CSRF surface *because* it never rides on cookies, unlike a cookie-based setup.
- **`sendVerificationOTP({ email, otp, type })` fires for every OTP type the plugin supports** — guard on `type` (e.g. only `'forget-password'`) or you'll send the wrong email for other flows.
- **Not every sensitive endpoint is rate-limited by default** — verify coverage and add a `customRules` entry if missing; on a stateless target (Workers), the in-memory store never throttles, use `storage: 'database'`.
- **Schema: `npx auth@latest generate`** (Prisma/Drizzle/Kysely) produces the schema/migration without applying it; **`npx auth@latest migrate`** applies it directly but only with the Kysely adapter — with Drizzle/Prisma, apply what `generate` produced via that ORM's own tool. A hand-maintained Drizzle schema mirroring Better Auth's shape is a valid third option — never rename a column there without adjusting the adapter mapping.

## Hard rules

1. `secret` is validated (length >= 32) at startup, not assumed.
2. `trustedOrigins` and the CORS allowlist are updated together, in the same change.
3. Session objects passed through context carry only the fields a route actually needs.
4. Server and client plugin arrays are added/removed together.
5. A new sensitive endpoint's rate-limit coverage is checked explicitly.

## Before declaring done

- `secret` length is enforced by a schema check, not just documentation.
- `trustedOrigins` matches the CORS config for this same change.
- Context carries only the minimal session shape; the raw session object doesn't leak past its middleware.
- New/edited plugins are paired on both server and client.
- `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's auth setup (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Which adapter/schema path is in use (CLI-generated vs. hand-maintained Drizzle schema) and why.
     - The transport in use (cookies vs. bearer) per client (web vs. mobile).
     - Which plugins are enabled and what each one is for.
     - The rate-limit storage backend and any custom rules beyond the defaults.
-->
