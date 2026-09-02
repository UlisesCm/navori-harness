---
name: keystone-graphql
description: Custom GraphQL in Keystone 6 — extendGraphqlSchema, the project-scoped gWithContext<Context>() builder, and the access guard every custom resolver must open with. Use when adding or touching a custom mutation, query or resolver.
type: reference
---

# Keystone Custom GraphQL — extendGraphqlSchema

## When to use this skill

Before adding or changing a custom mutation/query, or when debugging a resolver that won't type-check. A custom resolver does **not** go through the list's `access`: the guard it doesn't write is a guard nobody writes.

## The builder must carry the project `Context`

Keystone 8 renamed `graphql` to `g` and changed how it's typed. Importing `g`/`graphql` straight from `@keystone-6/core` gives `GWithContext<KeystoneContext>` — bound to Keystone's **base** context, not the project's generated `Context`. Resolvers are typed against that generated `Context`, so a field built with the unparametrized builder fails to unify (`TS2322`/`TS2345`): the two contexts are structurally similar but nominally distinct types.

Keystone's documented fix: **one project module builds `gWithContext<Context>()` once**, and everything imports `g` from there. Never import `graphql`/`g` from `@keystone-6/core` in project code.

**One exception — `virtual()` fields on a list.** Keystone types their `field` as `VirtualFieldGraphQLField<BaseItem, KeystoneContext<BaseKeystoneTypeInfo>>`, against the base context, so the project-scoped `g` yields a type that does not unify with it (`TS2322`). Those import `g` from `@keystone-6/core` directly, with a comment saying why; everything under `extendGraphqlSchema` uses the shared builder.

## The pattern: pure resolver + thin field

```ts
/** Accepts an open appeal. Only a moderator may resolve one. */
export async function resolveAcceptAppeal(
  args: { appealId: string },
  context: Context, // the GENERATED Context, not KeystoneContext
): Promise<AppealResult> {
  requireModerator(context, "…"); // guard FIRST, before any data
  // …
}

export const acceptAppeal = g.field({ // g from the project module
  type: g.object<AppealResult>()({ name: "AcceptAppealPayload", fields: { /* … */ } }),
  args: { appealId: g.arg({ type: g.nonNull(g.ID) }) },
  resolve: (_root, { appealId }, context: Context) => resolveAcceptAppeal({ appealId }, context),
});
```

Wire it with `extendGraphqlSchema: g.extend((base) => ({ mutation: { … }, query: { … } }))`; `base.object("Report")` reuses a list's generated type instead of redeclaring one.

## Hard rules

1. **Guard first.** Every custom mutation/query checks session/role before touching data — the list `access` never runs here, so skipping it is an access bypass. Shared guards live in one module (see `keystone-access`).
2. **The resolver is a pure exported function**, separate from the `g.field` wrapping it: `(args, context) => payload`. Testable without booting GraphQL, and the unit under test (see `keystone-testing`).
3. **`g` comes from the project builder**, never from `@keystone-6/core` — `virtual()` fields excepted.
4. **Args are untrusted.** Validate them; never forward a raw `*CreateInput` into a write: the resolver runs through `context.sudo()`, which bypasses field-level access, so unfiltered `data` is mass-assignment. Whitelist what the client may supply.
5. **`context.sudo().db` inside the resolver** (see `keystone-models`); errors surface bounded messages, never internals.

## Before declaring the change "done"

- `{{qualityGate.fast}}` green.
- No `g`/`graphql` imported from `@keystone-6/core` outside the shared builder and `virtual()` fields.
- Every new mutation/query calls its guard before the first read or write.
- The resolver is exported and unit-tested with a mocked context.
- No raw client input reaches a `sudo()` write unfiltered.
