---
name: new-resource
description: Use when adding a brand-new resource/feature end-to-end in Next.js App Router (type → validation → data → adapter → UI → route). For modifying an existing one, mirror its pattern instead of rebuilding it.
type: reference
maxWords: 800
---

# new-resource — end-to-end resource/feature (Next.js App Router)

## When to use

When adding a new resource or feature end-to-end (data → UI → route). To touch one that already exists, follow its pattern; don't rebuild it.

## 0. Before creating: reuse and be consistent (this first)

- **Find a similar resource ALREADY in the repo and mirror it**: folder structure, naming, data layer, state handling. Consistency with the repo > personal preference.
- **Reuse before creating**: is there already a component / hook / util (the repo's UI kit, `shared/`) that fits? Use it. Create something new only if there's really no equivalent.
- **Follow the theme / design system**: use the repo lib's tokens and components; no hardcoded styles or off-theme UI.
- **One source of truth**: derive types, labels, and states from where they already live; don't duplicate enums or constants.

## Structure — feature-based + colocation

- Everything for the resource **together, colocated with its feature/route** (`_components`, `_lib` private in App Router — the `_` prefix excludes them from routing). Don't scatter it across global `/components` or `/utils`.
- **Shared rule**: if ONE feature uses it → it lives inside the feature; if TWO or more use it → promote it to `shared/`. Features **don't import each other** (if needed, compose in the page or move the piece up to shared).
- Nesting 2-3 levels max. Start simple; add structure when the resource actually grows.

## Steps (strict order — inside out)

Each step depends on the previous one; verify it compiles before moving on.

1. **Domain type** — the resource model in your types layer, agnostic of the backend or generated types. Enums + their derived labels/variants here (single source).
2. **Validation at the boundary** — schema (zod) for every external input (form, params, network response). DTOs come out of the schema (`z.infer`), not written by hand.
3. **Data access (server)** — the query/mutation through your data layer: fetch in a Server Component, a Server Action, or a route handler. Secrets and session stay on the server.
4. **Adapter** (only if there are generated types / GraphQL) — maps the backend's raw type to the domain type and normalizes unknown enums to a safe value. The UI consumes **domain**, never generated types.
5. **UI** — a Server Component that fetches and composes; push `"use client"` to the **leaves** (interactivity, state, browser APIs), as far down as possible. Pass serializable props down and reuse the UI kit.
6. **Routing / nav** — the page/segment in App Router and its navigation entry. Without this, the resource isn't reachable.

## Server vs Client (App Router)

- **Server Component by default**: data, secrets, composition. Fetch on the server and avoid the API ping-pong (don't re-fetch on the client what the server already fetched).
- **Client Component** (`"use client"`) only for interaction, local state, or browser APIs, and always as far down as possible in the tree.

## What NOT to do (avoid over-engineering)

- No hexagonal / DDD / CQRS or speculative abstraction layers for a CRUD. Simple layered is enough.
- No generic interface or helper with a single caller, nor "just in case" parametrization.
- No new dependency for what the repo, the platform, or an already-installed lib solves in a few lines.
- Don't duplicate a component that already exists under another name (breaks the single source and the theme).

## Before calling it done

- `{{qualityGate.fast}}` green.
- The resource is reachable (page + nav entry) and the golden path works; invalid input is rejected at the boundary (zod).
- You reused what existed and followed the repo's pattern + theme — you didn't invent a variant.
- The UI consumes domain types (not generated) and `"use client"` is only where needed.

<!-- navori:user-section -->
## This repo's conventions

<!-- user: document your stack-specific details here so the scaffold is exact:
     - Exact paths where types, schemas, data layer, adapters, and features/UI live.
     - Your UI kit / design system and where the theme is (tokens, base components to reuse).
     - If you use GraphQL + codegen: the command (e.g. `bun run codegen`) and where the generated types come from.
     - The validation helper and the response/error contract.
     - An EXAMPLE resource already built that serves as a mold to mirror.
-->
