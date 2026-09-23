---
name: supabase
description: Use when writing app code against Supabase — creating the client, auth and sessions, API keys and env vars, typed queries, Realtime or Storage from the client, or an Expo/React Native app on Supabase. Covers Supabase Cloud and self-hosted. Not for SQL, RLS, or migrations (see supabase-postgres), Edge Functions (see supabase-edge-functions), or running the server (see supabase-selfhost).
metadata:
  type: reference
---

# Supabase — client, auth, and keys

Supabase changes monthly: before trusting memory, read `supabase.com/docs` (append `.md` to any page) and `supabase.com/changelog.md`.

## Cloud or self-hosted — decide first

Self-hosted when the user-section says so or the official Docker stack is present (a `volumes/` folder with the server's `.env`); otherwise ask. A URL not ending in `supabase.co` is only a hint — Cloud custom domains and the CLI's local stack (`127.0.0.1:54321`) don't either. On self-hosted, settings Cloud puts in the dashboard (redirect URLs, SMTP, email confirmation, OAuth providers) live in the server's `.env` instead — that's supabase-selfhost's ground.

## Keys

- **Publishable** (`sb_publishable_…`) goes in clients; **secret** (`sb_secret_…`) only on servers. Legacy JWT keys (`anon`, `service_role`, starting with `eyJ`) still work; Supabase deprecates them by the end of 2026.
- Self-hosted: the new keys exist once `SUPABASE_PUBLISHABLE_KEY` has a value in the server's `.env` (`setup.sh` generates them; otherwise `utils/add-new-auth-keys.sh`). Check before running anything — re-running the signing-key step logs every user out. Prefer the new keys.
- A secret or `service_role` key in client code or under `EXPO_PUBLIC_*` bypasses every RLS policy — never.

## Auth

- Authorize on `app_metadata` (server-set), never `user_metadata` — users can edit it.
- `signUp` returns `session: null` until the email is confirmed, when confirmation is on.
- Redirects (OAuth, magic links) must be in the allow list: the dashboard on Cloud, `ADDITIONAL_REDIRECT_URLS` on self-hosted.
- Deleting a user doesn't revoke tokens already issued.

## Expo / React Native client

- One client module. Storage: `expo-sqlite/localStorage/install` with `storage: localStorage` (Expo docs), or `LargeSecureStore` — AES key in `expo-secure-store`, encrypted session in AsyncStorage — when the session must be encrypted.
- `auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: false }`, plus an `AppState` listener: `startAutoRefresh()` on `active`, `stopAutoRefresh()` otherwise.
- Env: `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — both public by design.
- OAuth: an app `scheme`, `<scheme>://**` in the redirect allow list, `makeRedirectUri()` → `signInWithOAuth({ options: { redirectTo, skipBrowserRedirect: true } })` → `WebBrowser.openAuthSessionAsync` → `setSession` from the returned params.
- Self-hosted in development: a device reaches the server by LAN IP or an HTTPS tunnel, never `localhost`; production needs HTTPS.

## Types, Realtime, Storage

- Type the client with generated types — `createClient<Database>()` — and regenerate after every migration (see supabase-postgres).
- Realtime: Supabase recommends Broadcast on private channels over `postgres_changes`, which checks RLS per subscriber on a single thread. Always `removeChannel` on unmount.
- Storage access is RLS on `storage.objects`; an upsert needs INSERT, SELECT, and UPDATE policies.

## Before declaring done

Copy and check off:

- [ ] No secret or `service_role` key reachable from client code.
- [ ] Authorization reads `app_metadata`, not `user_metadata`.
- [ ] Every redirect used by the app is in the allow list for this mode (Cloud or self-hosted).
- [ ] Queries are typed from freshly generated types.
- [ ] Channels are removed on unmount.
- [ ] `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's Supabase (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Cloud or self-hosted, and the URL per environment.
     - Where the client module lives and which session storage it uses.
     - Auth providers enabled and the app's redirect scheme.
-->
