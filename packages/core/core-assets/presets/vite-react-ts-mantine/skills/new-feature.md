---
name: new-feature
description: Use when creating a new resource/feature end-to-end. Defines the strict layer order (interface → service → adapter → component → router) so data flows consistently. Domain-specific templates go in the user-section.
type: reference
---

# New feature — layer order

## When to use this skill

When creating a new resource or feature end-to-end (an endpoint that ends up consumed on a screen). It defines the ORDER in which the layers are built; the concrete content of each is your repo's domain (goes in the user-section).

## Strict order

Build from the inside out. Don't skip layers or do them out of order:

1. **interface / types** — define the shape of the data: the shape of the raw response and of the model the UI consumes. Without this, everything above is cast blindly.
2. **service** — the network call. URL from config (no hardcode), cancellation, error handling. Returns the typed raw data.
3. **adapter** — PURE function that transforms the raw data into the UI model. Explicit defaults for nullables, fallback for unknown enums. No I/O, no global state.
4. **component / page** — consumes the model via the adapter. Loading + error states. No raw fetch in the component.
5. **router / navigation** — only once the screen works, you wire it into the router.

Rule: if layer N needs something from layer N-1 that doesn't exist yet, **stop and do N-1 first**. Data flows `network → service → adapter → component`; building it backwards creates casts and debt.

## Before calling it "done"

- `{{qualityGate.fast}}` green.
- The data looks correct in the UI with real data (not just the mocked happy path).
- Apply `verify-before-done`; if you touched screens, validate manually.

## Connection

- `implementer`: follow this order when creating a resource; document in `progress/impl_<feature>.md` what was left in each layer.
- `review-diff`: the reviewer validates each layer (types, data layer, component/page) with its severities.

<!-- navori:user-section -->
## Resource templates and rules (your domain)

<!-- user: add here the concrete templates for YOUR stack for each layer (the ones that are NOT generalizable). Suggestions:
     - The real skeleton of a service (HTTP client, required headers, cancellation pattern).
     - The repo's adapter pattern (naming, defaults, enum fallback).
     - The form/validation pattern (lib + resolver).
     - Folder convention and suffixes (where each layer goes, file naming).
     - Legacy ↔ new backend migration rules if applicable.
-->
