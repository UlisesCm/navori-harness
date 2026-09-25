---
name: better-auth
description: Use when touching auth server config, session middleware, the auth client, or a Better Auth plugin (email OTP, bearer, rate limiting) — server/client wiring, session retrieval, schema. Not for a hand-rolled JWT/session implementation.
metadata:
  type: reference
---

# Better Auth — conventions

Target version: Better Auth 1.7. On a different major, recheck the CLI command names and plugin pairing below — auth is a surface where a stale assumption becomes a security bug, not just a broken build.

## The pattern

One server config, mirrored by a matching client config — the plugin arrays on both sides must line up:

```ts
// server
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  secret,                          // >= 32 chars — see gotchas
  trustedOrigins,                  // keep in sync with CORS
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: true, storage: 'database' },
  plugins: [emailOTP({ sendVerificationOTP }), bearer()],
});

app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw)); // before session routes

// client
export const client = createAuthClient({
  baseURL,
  plugins: [emailOTPClient()],
  fetchOptions: { auth: { type: 'Bearer', token: () => storedToken } },
});
```

## Gotchas that bite

- **`secret` must be at least 32 characters**; gate it with a schema check (e.g. `z.string().min(32)`) at startup — it signs sessions/tokens.
- **`trustedOrigins` is the same allowlist CORS needs — keep them in sync manually**; a request can pass CORS and still get rejected by auth.
- **Mount `/api/auth/*` before any session-dependent route**; mounted later, that route sees no session even on a valid request.
- **`auth.api.getSession({ headers: c.req.raw.headers })` in middleware, storing only `{ id, email }` in context**, not the raw session object.
- **Client calls return `{ data, error }` (or throw on network failure) — unify that in one helper**; a missed ad hoc `if (error)` check treats a failed call as success.
- **Server and client plugin arrays must pair up.** Server `emailOTP()` + `bearer()` needs client `emailOTPClient()` plus `fetchOptions.auth`, or the feature fails silently.
- **Bearer transport means capturing `set-auth-token` and resending it as `Authorization: Bearer <token>`** — no cookie jar does it for you; no CSRF surface since it never rides on cookies.
- **`sendVerificationOTP({ email, otp, type })` fires for every OTP type** — guard on `type` (e.g. `'forget-password'`) or you'll send the wrong email for other flows.
- **Not every sensitive endpoint is rate-limited by default** — verify coverage and add a `customRules` entry if missing; on Workers the in-memory store never throttles, use `storage: 'database'`.
- **Schema: `npx auth@latest generate`** (Prisma/Drizzle/Kysely) produces the schema/migration without applying it; **`npx auth@latest migrate`** applies it directly but only with the Kysely adapter — with Drizzle/Prisma, apply what `generate` produced via that ORM's own tool. A hand-maintained Drizzle schema mirroring Better Auth's shape also works — never rename a column there without a matching adapter change.

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
