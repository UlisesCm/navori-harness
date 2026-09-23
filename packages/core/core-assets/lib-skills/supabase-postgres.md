---
name: supabase-postgres
description: Use when writing a Supabase migration, a table, an RLS policy, a Postgres function, trigger, or view, or when deploying schema changes to a Supabase database (Cloud or self-hosted). Keeps every table behind RLS and every change in a migration. Not for client code (see supabase) or Edge Functions (see supabase-edge-functions).
metadata:
  type: reference
---

# Supabase Postgres — schema, RLS, migrations

Every schema change is a migration in git; every table in an exposed schema (`public` by default) has RLS, or anyone with the publishable key reads it.

## RLS

- `alter table … enable row level security` on every table, in the migration that creates it.
- **Grants run before RLS.** A missing grant fails with "permission denied"; a missing SELECT/UPDATE/DELETE policy returns no rows, silently (a failed INSERT check does raise). Automatic grants to `anon` / `authenticated` are becoming opt-in: grant explicitly, and revoke the automatic ones on existing tables — adding policies doesn't take them back.
- One policy per operation (select, insert, update, delete), never `for all`, always with `to authenticated` or `to anon`.
- `to authenticated` alone lets any user reach every row — add an ownership predicate: `using ((select auth.uid()) = user_id)`.
- UPDATE needs `using` and `with check`, plus a SELECT policy, or it silently updates zero rows.
- Wrap `auth.uid()` and `auth.jwt()` in `(select …)` so Postgres evaluates them once, and index every column a policy filters on.

## Functions, triggers, views

- Default to `security invoker`, with `set search_path = ''` and schema-qualified names.
- `security definer` bypasses RLS and, in `public`, anyone can execute it. Never add it to silence a permission error; if it's truly needed, put it in a non-exposed schema.
- Views bypass RLS unless created `with (security_invoker = true)`.

## Migrations

- Imperative flow: `supabase migration new <name>`, write the SQL, apply it locally, review the diff.
- Declarative (a `supabase/schemas/` folder): edit the schema files, then `supabase db schema declarative sync -f <name>` generates the migration — not `supabase db diff`.
- Never change a remote schema by hand. Self-hosted releases before 0.6.0 ran Studio as `supabase_admin`, leaving superuser-owned objects that break migrations; upgraded installs fix ownership with `utils/reassign-owner.sh`.
- Keep the local CLI stack on the server's Postgres major version.
- Deploying:
  - Cloud (linked project): `supabase db push`.
  - Self-hosted (`supabase link` doesn't apply): `supabase db push --db-url "<url>" --dry-run`, then without it. Connect directly or in session mode (Supavisor: user `postgres.<tenant>`, port 5432); transaction mode (6543) lacks prepared statements. Percent-encode the password.
- After every migration, regenerate types and run the advisors against the same target: `supabase gen types typescript` and `supabase db advisors` with `--local`, `--linked` (Cloud), or `--db-url` (self-hosted).

## Before declaring done

Copy and check off:

- [ ] Every new table enables RLS, has explicit grants (automatic ones revoked), and one policy per operation with an ownership predicate.
- [ ] `auth.uid()` is wrapped in `(select …)`; policy columns are indexed.
- [ ] Functions are `security invoker` with `search_path = ''`, or justify `security definer` in a non-exposed schema.
- [ ] The change is a migration in git; nothing was applied by hand.
- [ ] Types regenerated and advisors clean.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's database (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Imperative or declarative migrations, and the deploy target per environment.
     - Roles and ownership model used by policies.
     - Where generated types are written.
-->
