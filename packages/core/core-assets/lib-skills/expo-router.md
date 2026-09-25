---
name: expo-router
description: Use when adding, moving, or protecting a route on Expo — file-based routing under app/, layouts and route groups, typed routes, redirects/auth guards, or reading URL/search params. Applies to repos already on expo-router. Not for a web SPA's router (TanStack Router/React Router) and not for the app's business logic, which belongs in src/features, not in app/.
metadata:
  type: reference
---

# expo-router — file-based routing (Expo SDK 57)

Written for expo-router ~57 on Expo SDK 57. Check the version in `package.json` first; layout/typed-route APIs have moved between majors before — verify against the changelog on a major bump.

## Wiring

- The `expo-router` Expo plugin goes in `app.json`/`app.config.ts`'s `plugins`, and `"main": "expo-router/entry"` in `package.json`.
- `experiments.typedRoutes: true` in the Expo config generates typed `href`s from the `app/` tree — a route that doesn't exist becomes a type error, not a runtime 404.
- `scheme` in the Expo config is the deep-link scheme; every route under `app/` is reachable by it once the app is installed.

## File-based routes

- Every file under `app/` is a route; its path mirrors the file path (`app/settings/index.tsx` → `/settings`).
- `_layout.tsx` wraps its directory (and nested layouts nest). Use it for a `Stack`/`Tabs` navigator, not for business logic.
- A parenthesized segment (`app/(auth)/`) is a **group**: it organizes/nests layouts without adding a path segment.
- Keep route files thin — read params, call a hook from `src/features/<feature>`, render. Logic, data fetching, validation live in `src/features`, not `app/`.

## Auth guards and redirects

- `<Redirect href="..." />` renders nothing and navigates immediately — use it for an unconditional bounce (e.g. an unauthenticated root redirecting to `/(auth)/sign-in`).
- `Stack.Protected` (also on other layout navigators) conditionally mounts/unmounts a screen or group based on a `guard` boolean, without a remount flash — prefer it over a `Redirect` inside every protected screen when the whole group shares one guard.
- Auth state itself is read from the app's own session hook (e.g. a Zustand store's `useSession()`), never re-derived inside a route file.

## Search params: local vs global

- `useLocalSearchParams()` only updates while its route is focused — the default for reading a route's own params.
- `useGlobalSearchParams()` updates on every navigation event, even for routes that aren't focused — use it sparingly (a screen reacting to a param change in a sibling route), since it re-renders more often.

## Gotchas that bite

- **A non-route file in `app/`** (a shared component, a hook) still becomes routable unless it starts with `_` or lives outside `app/` — keep non-route files in `src/`.
- **Typed routes require the generated types.** After adding/renaming a route, restart the dev server (`--clear` if it doesn't pick it up) so typed `href`s regenerate.
- **Deep links need the scheme AND the route to exist** — a scheme without a matching `app/` path 404s at the router level even if the OS opens the app.

## Before declaring done

Copy and check off:

- [ ] New route files are thin — logic lives in `src/features`, not `app/`.
- [ ] Auth-protected routes use `Stack.Protected` or a `Redirect`, never a bare unauthenticated render.
- [ ] `useGlobalSearchParams` is used only where cross-route reactivity is actually needed.
- [ ] `expo export --clear` succeeds after any routing/layout change.
- [ ] `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's routes (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The route groups in use and what each protects.
     - Where the session/auth hook lives and its shape.
     - Deep link scheme and any universal-link domains configured.
-->
