---
name: supabase-edge-functions
description: Use when writing, testing, or deploying a Supabase Edge Function (Deno) — its handler, auth mode, CORS, secrets, shared code, or deployment on Cloud or a self-hosted server. Not for database code (see supabase-postgres) or client code (see supabase).
metadata:
  type: reference
---

# Supabase Edge Functions

Edge Functions run on Deno in Supabase's edge runtime. The recommended handler changed recently: code written from memory usually uses the old pattern.

## The handler

Supabase's current guidance: do not use `Deno.serve`. Export a `fetch` handler wrapped in `withSupabase` from `npm:@supabase/server` — it handles auth, CORS, and gives you ready clients:

```ts
import { withSupabase } from "npm:@supabase/server@^1";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const { data, error } = await ctx.supabase.from("profiles").select("*");
    if (error) throw error; // never return raw database errors to the caller
    return Response.json(data);
  }),
};
```

- `auth` modes: `user` (a signed-in user's JWT; `ctx.supabase` runs under their RLS), `publishable`, `secret` (or `secret:<name>`), `none` — or an array to accept several. Use `ctx.supabaseAdmin` only when the function must bypass RLS, and never return what it reads without checking the caller.
- Any mode other than `user` needs JWT verification off for that function (`verify_jwt = false` in `supabase/config.toml`).
- Self-hosted: supported from self-hosted release 0.8.1. `auth: "user"` needs `SUPABASE_JWKS`, which exists only after the server runs `utils/add-new-auth-keys.sh`. JWT verification is one global switch (`FUNCTIONS_VERIFY_JWT`), not per function.

## Code

- Imports use `npm:` or `jsr:` specifiers with an explicit version (`@^1` counts). The self-hosted stack's import map lets its examples import `@supabase/server` bare — valid only there.
- Shared code lives in `supabase/functions/_shared/`, imported by relative path.
- Only `/tmp` is writable. Background work after the response goes through `EdgeRuntime.waitUntil`.
- Secrets come from environment variables, never from code or the repo.

## Deploying

- Cloud: `supabase functions deploy <name>`; secrets with `supabase secrets set --env-file <file>`.
- Self-hosted: there is no deploy command. The function's folder goes into the server's `volumes/functions/<name>/`, then the functions service restarts. Secrets need `.env.functions` wired as `env_file` of the `functions` service and `sh run.sh recreate functions` — a restart doesn't reload variables (see supabase-selfhost).
- Test: `supabase functions serve` against the local stack, or the self-hosted stack after deploying.

## Before declaring done

Copy and check off:

- [ ] Handler is `export default { fetch }` with `withSupabase`; no `Deno.serve`.
- [ ] The auth mode matches who may call it; `verify_jwt` agrees with it.
- [ ] `supabaseAdmin` is used only where RLS must be bypassed, with the caller checked.
- [ ] Imports are versioned `npm:` / `jsr:` specifiers; no secret in code or git.
- [ ] Called once with a real credential for its auth mode.
- [ ] `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's functions (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Functions and the auth mode each one uses.
     - Cloud or self-hosted deploy path, and who deploys.
     - Secrets each function expects.
-->
