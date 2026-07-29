---
name: keystone-access
description: Keystone 6 access control in 3 layers (operation / filter / field). allowAll forbidden; null session → restrictive filter. Use when defining or changing the access of any list.
type: reference
---

# Keystone Access Control — 3 layers

## When to use this skill

Whenever you define or modify a list's `access`. A misplaced line here is a data leak or a total lockout — it's the most sensitive code in the backend. Read it in full before touching `access`.

## The 3 layers

```ts
access: {
  operation: { query, create, update, delete }, // can the user run the operation?
  filter:    { query, update, delete },          // over WHICH records? (returns a where)
  field:     { fieldName: { read, create, update } }, // can it read/write THIS field?
}
```

1. **`operation`** — boolean gate per operation. Returns `true`/`false` based on the session. It's the "does it have permission to attempt it?".
2. **`filter`** — returns a Prisma `where` that narrows the set of visible/affectable records. It's the "over which?". E.g.: a user only sees/edits their own records → `{ author: { id: { equals: session.itemId } } }`.
3. **`field`** — fine-grained per-field control (hide a sensitive field on read, prevent writing a computed field).

The three combine: `operation` decides whether the request gets in, `filter` narrows the set, `field` trims columns.

## Hard rules

1. **`allowAll` is forbidden.** Never `access: allowAll`. Every list declares explicit rules per operation. If something "is public", express it with a scoped function that returns `true`, not with `allowAll`.
2. **Null session → restrictive, not open.** When there's no session, the default is to deny (or a `filter` that matches nothing), never to open. Start closed and open just enough.
3. **`filter` returns a where, not a boolean.** If you need to deny everything in a `filter` layer, return an impossible where (`{ id: { equals: null } }`), not `false`.
4. **Access logic goes in `access/`, not inline.** Extract reusable functions (`isSignedIn`, `isOwner`, `isAdmin`) into `access/` files and compose; don't duplicate the same condition inline across lists.
5. **Access ≠ business validation.** Access decides who sees/touches what; business rules (a valid value, an allowed state) go in `validateInput` (see `keystone-models`).

## Quick table

| I want | Layer | Form |
|---|---|---|
| Block create for non-admins | `operation.create` | `({ session }) => isAdmin(session)` |
| Everyone sees their own | `filter.query` | `({ session }) => ({ owner: { id: { equals: session?.itemId } } })` |
| Hide a sensitive field | `field.<field>.read` | `({ session }) => isAdmin(session)` |
| Prevent editing a computed field | `field.<field>.update` | `() => false` |

## Before declaring the change "done"

- `{{qualityGate.fast}}` green.
- `grep -rn "allowAll" access/ models/` → 0 results.
- Every touched list declares the 3 layers where they apply; no operation was left implicitly open.
- Null session tested: the list denies or filters, never exposes everything.
- New conditions extracted into `access/` if they repeat across more than one list.
