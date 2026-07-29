## Stack — Keystone 6 (Bun + Prisma)

GraphQL backend on **Keystone 6**, **Bun** runtime, **Prisma + PostgreSQL** persistence. Data is modeled as *lists* (`list({ access, hooks, fields })`) and Keystone derives from them both the Prisma schema and the GraphQL API: `schema.prisma` and `schema.graphql` are **auto-generated**, never edited by hand (see `prisma-keystone`).

Three contracts govern all data code:

- **3-layer access control** — each list declares `operation`, `filter` and `field`; `allowAll` is forbidden. A null session gets a restrictive filter, never an open one. See `keystone-access`.
- **Hooks with a strict contract** — `resolveInput` returns data, `validateInput` throws `Error` (never returns a value), `afterOperation` checks `operation` before acting. See `keystone-models`.
- **`context.sudo()` in hooks and services** — never `context.db` (it would apply the current session's access) or raw Prisma; `context.prisma` is reserved for seed/migration scripts only.

Every external dependency (SMS, payments, third-party APIs) sits behind an interface in `[service].adapter.ts`: services receive the interface, not the implementation, so it can be mocked in tests.

**Context efficiency** — the generated artifacts (`types/graphql.ts` can run into tens of thousands of tokens, `schema.graphql`, `migrations/`, the lockfile) are **not read in full**: infer the types from the *list* in `models/` or from `schema.prisma`, and search with `grep`/`Grep` instead of opening the whole file.
