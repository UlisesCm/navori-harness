---
name: supabase-selfhost
description: Use when configuring, securing, upgrading, or operating a self-hosted Supabase (the official Docker stack) — its .env and compose file, keys, auth settings, HTTPS, Edge Functions volume, backups, or the MCP endpoint. Not for app code (see supabase) or schema work (see supabase-postgres).
metadata:
  type: reference
---

# Self-hosted Supabase — running the Docker stack

Self-hosted, what Cloud does for you is yours: secrets, HTTPS, backups, upgrades, exposure. The stack is the `docker/` folder of `supabase/supabase` (docs: `supabase.com/docs/guides/self-hosting`), released as `self-hosted/v<x>` — record the one in use; behavior changes between releases.

## Secrets and keys

- Never start with `.env.example` values: its `JWT_SECRET`, demo keys, `POSTGRES_PASSWORD`, and `DASHBOARD_PASSWORD` are public. Generate them with `utils/generate-keys.sh`; change the DB password later with `utils/db-passwd.sh`.
- The `sb_` keys and signing keys (JWKS) come from `utils/add-new-auth-keys.sh` (`setup.sh` runs it). Rotating API keys (`utils/rotate-new-api-keys.sh`) keeps sessions; re-running the signing-key script ends the new-key (ES256) sessions. Changing `JWT_SECRET` means regenerating the JWKS.
- Keep `.env` and `.env.functions` out of git; prefer a secrets manager.

## Configuration lives in `.env`

Settings Cloud puts in the dashboard are variables here, applied by recreating the containers (`sh run.sh recreate`):

- Auth: `SITE_URL`, `ADDITIONAL_REDIRECT_URLS` (comma-separated, globs allowed — the mobile app's `<scheme>://**` goes here), `SMTP_*` (no working default), OAuth providers as `<PROVIDER>_ENABLED` / `_CLIENT_ID` / `_SECRET` plus uncommenting their `GOTRUE_EXTERNAL_*` lines in the compose file.
- Defaults to review: `ENABLE_EMAIL_AUTOCONFIRM=false`, but `ENABLE_PHONE_AUTOCONFIRM=true`.
- API schemas: `PGRST_DB_SCHEMAS`.
- Gateway: Envoy since 0.8.0 (Kong is a deprecated override). Studio uses basic auth (`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`).

## Exposure

- Put HTTPS in front with the Caddy or nginx override — the gateway doesn't terminate TLS — and switch `SUPABASE_PUBLIC_URL`, `API_EXTERNAL_URL`, and `SITE_URL` to `https`. OAuth providers and iOS need it.
- Postgres isn't exposed by default; keep it that way. Supavisor publishes 5432 (session) and 6543 (transaction) on the host — firewall them. The pooler user is `postgres.<POOLER_TENANT_ID>`.
- The MCP endpoint (`/mcp`, via Studio) is denied by default. Open it only to an allow-list over SSH or VPN, never on production data: rows can carry injected instructions.

## Edge Functions

- `FUNCTIONS_VERIFY_JWT` is `false` by default and global: every function is callable by anyone unless it checks auth itself (`withSupabase({ auth: "user" })`).
- Deploy by copying into `volumes/functions/<name>/` and restarting the service; the stack's `.gitignore` excludes those folders except `main` and `hello`.
- `.env.functions` loads only after adding it as `env_file` of the `functions` service, then `sh run.sh recreate functions`.

## Backups and upgrades

- You own backups: `update.sh` saves only config. Schedule `supabase db dump --db-url` (roles, schema, data) and copy `volumes/storage`.
- Upgrade: back up, run `update.sh` (a three-way merge), review, then `run.sh pull` and `run.sh recreate`. Major Postgres upgrades have their own script; installs from before 0.6.0 run `utils/reassign-owner.sh`.

## Before declaring done

Copy and check off:

- [ ] No value from `.env.example` survives; `.env` files aren't in git.
- [ ] HTTPS terminates in the proxy; Postgres, 5432, 6543, and `/mcp` aren't publicly reachable.
- [ ] Redirect URLs include the app's scheme; SMTP works; autoconfirm settings are intended.
- [ ] A backup exists and was restored at least once.
- [ ] The self-hosted release in use is recorded.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's server (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Host, domain, and the self-hosted release in use.
     - Proxy (Caddy or nginx), backup schedule, and where backups go.
     - Who can reach Studio and how.
-->
