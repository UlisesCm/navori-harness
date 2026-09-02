---
name: keystone-testing
description: Testing Keystone 6 with Vitest — hooks and access with a mocked context, GraphQL/REST endpoints with Supertest, factories. Use when writing or reviewing tests for models, access, hooks or API.
type: reference
---

# Keystone Testing — Vitest + Supertest

Two levels: **unit** (hooks/access/services with Keystone's `context` mocked, no DB) and **integration/e2e** (real GraphQL/REST API with Supertest against a Keystone instance and a test DB). Unit is fast and covers the logic; integration covers the contract.

## When to use this skill

When writing tests for a hook, an `access/` function, a service or an endpoint; when choosing the level (unit vs integration); or when debugging a flaky mock test.

## Unit — hooks and access with a mocked context

Hooks and access functions are pure functions over `{ session, context, ... }`: they're tested without a DB, mocking the `context`.

```ts
// The context mock exposes sudo().db.<Model> and query; return it from a reusable helper.
const context = makeMockContext({ session: adminSession });

it("validate rejects manual truthState", async () => {
  const addValidationError = vi.fn();
  await Report.hooks.validate.create({
    resolvedData: { truthState: "TRUE" }, context, addValidationError,
  });
  // Not `.rejects.toThrow()` — a compliant `validate` resolves, so that passes vacuously.
  expect(addValidationError).toHaveBeenCalled();
});

it("access.filter.query narrows to the owner's records", () => {
  expect(reportAccess.filter.query({ session: userSession })).toEqual({
    author: { id: { equals: userSession.itemId } },
  });
});
```

Test **each access layer separately** (`operation`/`filter`/`field`) and **the null session** (it must deny/filter, never open).

## Integration — API with Supertest

Bring up Keystone against a test DB and hit the real endpoint (validates the full contract: access + hooks + resolvers).

```ts
const res = await request(app)
  .post("/api/graphql")
  .set("Cookie", authCookie)
  .send({ query: `mutation { createReport(data: {...}) { id } }` });
expect(res.status).toBe(200);
expect(res.body.errors).toBeUndefined();
```

The test DB is brought up/migrated/seeded before and torn down after (`test:db:*` / `test:e2e` scripts). Requires Docker.

## Hard rules

1. **Factories, not inline fixtures.** Centralize test data construction in factories (`test-factories`) and the session in helpers (`test-auth`); don't repeat `session`/`data` objects in every file.
2. **A single reusable context mock.** The `context` mock (with `sudo().db`) lives in a shared helper, not re-invented per test.
3. **Access tested across the 3 layers + null session.** It's the most sensitive code; each layer and the no-session case have their test.
4. **SDD traceability.** In SDD-scope features, each `R<n>` is covered by ≥1 test that references it in its name or a `// Covers: R<n>` comment.
5. **Don't generate tests unless asked** (if the project defines it that way); when asked, they go to the right level (unit for logic, integration for contract).

## Vitest gotchas (v4.x)

- **`vi.hoisted()`** for factories that use external variables inside `vi.mock` (the mock is hoisted above the declarations).
- **Mock-constructor with a regular function, not an arrow** (an arrow is not `new`-able).
- **`vi.clearAllMocks()` does NOT clear implementations** (only `mock.calls`); use `vi.resetAllMocks()`/`restoreAllMocks()` when you need to reset the implementation.

## Before declaring done

- New or touched hooks/access have unit tests (including the null session).
- Test data comes from factories; the context comes from the shared mock.
- If it's SDD-scope, each `R<n>` is traceable to a test.
- `{{qualityGate.fast}}` green (Docker tests run with the full gate).
