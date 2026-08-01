---
name: security-guidance
description: Use when running /security-review or auditing security. Documents the BUSINESS security invariants that the static scanner (semgrep) and the built-in review can't infer from code alone — server-side authorization, object access (IDOR), secrets and env exposed to the client, trust boundaries, PII in logs. The skeleton is universal; your stack's rules go in the user-section.
type: reference
maxWords: 1200
---

<!-- navori:managed id="security-guidance-base" hash="77f8ed93" version="0.5.0" source="@navori/core" -->
# Security guidance — the business security layer

Feeds the `/security-review` flow. The generic web vuln patterns (XSS, SSRF, hardcoded secrets, insecure deserialization, injection) are already covered by semgrep and the built-in reviewer. What goes here is what the model **can't infer from code alone**: the authorization and trust invariants that depend on the domain.

Report with severity `[CRITICAL]`/`[HIGH]`/`[MEDIUM]` and `file:line`, as in `review-diff`. An authorization bypass or an exposed secret is CRITICAL.

## 1. Authorization — enforced on the server

- Every route / endpoint / action that exposes protected data or effects MUST verify the role or permission **on the server**, before the query or the effect. A missing server-side guard = **authorization bypass, CRITICAL**.
- Client guards (conditional render, in-component checks, a `useAuth()`) **are never enough on their own** — they are UX, not enforcement. A protected view that only trusts the client is CRITICAL.
- Navigation / UI config (menus, an `allowedRoles` in the nav array) filters the UI, it does **not** control access. Adding an entry there without the corresponding server-side guard is a finding.
- The guard must **fail closed**: no session or backend down → deny / redirect, never "let it through just in case". Don't add a path that cuts on error toward the permissive side.

## 2. Object access (IDOR)

- An id coming from input (URL, body, query) does NOT authorize by existing. **Ownership / scope is verified server-side** (ideally in the backend or the access layer), not on the client.
- A view that fetches a record by URL-id must trust the backend's access error (`ACCESS_DENIED` / 403), not invent its own ownership check nor assume the id is valid.
- Lists of sensitive entities are never queried from the client with broad filters — they go through the server with the authenticated session.

## 3. Auth error handling

- Authentication / authorization errors (expired session, locked account, 401/403) are handled **globally and fail-closed** (logout / redirect), not swallowed locally nor shown inline as a form error.
- Define the backend's error-code contract (e.g. 401 session, 423 lock, 429 rate-limit) and respect it. Custom handling of those codes in a one-off component is a finding.

## 4. Secrets and environment variables

- Zero hardcoded secrets / tokens / internal URLs — **including tests and `.env.example` files** (use placeholders). A secret in code is CRITICAL.
- Vars that are **bundled into the client** (prefixes like `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`) MUST be safe to leak: no API keys, tokens or internal URLs behind that prefix. Putting a sensitive value there is CRITICAL.

## 5. Trust boundaries / data flow

- All data from an external source (backend, network, input) is **validated and normalized at the boundary** before entering the domain. Don't pass raw backend values straight to the UI.
- Fallbacks for unknown enums / states → to a known safe value, never raw passthrough nor throw (an untrusted raw enum in the UI = state confusion or potential XSS).
- Respect the architectural boundaries the repo declares (which layer may import generated types or talk to which backend).

## 6. Logging and PII

- No `console.log` / print of user data, tokens, session cookies or PII (email, phone, documents) on production paths. Debug logs only behind an environment guard (e.g. `NODE_ENV === 'development'`).

## How to use it in the review

1. Walk the diff or the area with these 6 categories as a checklist.
2. Report with severity and `file:line`.
3. Cross-check with the **rules specific to your stack** (below): the concrete names of your guards, error codes and env prefixes live there — without that, the review only covers the universal layer.
<!-- /navori:managed id="security-guidance-base" -->

## Your stack's security invariants

<!-- user: document here what the model CAN'T infer from code — the concrete rules of YOUR domain. Suggestions:
     - AUTHORIZATION: name and signature of the mandatory server-side guard (e.g. `requireRole([...])`), where it goes, its terminal paths, and which routes require it.
     - IDOR: how resources are identified (UUID / CUID / slug), the validation helper, and which entities are sensitive.
     - ERRORS: the exact code contract of your backend (401/403/423/429…) and the global handler.
     - ENV: the secrets manager (Infisical / Vault / …), your framework's client-var prefix, and what NEVER carries that prefix.
     - BOUNDARIES: which layer may import what (generated types, backend clients), adapter and sanitization rules.
     - Repo anti-patterns that are auto-CRITICAL.
-->
