---
name: keystone-models
description: Conventions for Keystone 6 lists — list({ access, hooks, fields }) structure, hooks contract (resolveInput/validate/afterOperation) and use of context.sudo(). Use when creating or modifying a model.
type: reference
---

# Keystone Models — project conventions

## When to use this skill

Before creating a new list, adding/changing a field, or touching a model's hook. A list's hooks and access are where business logic and data security live; skipping the contract breaks integrity or opens access holes.

## Structure of a list

```ts
export const Report = list({
  access: { /* see keystone-access skill */ },
  hooks: { resolveInput, validate, afterOperation },
  fields: {
    title: text({ validation: { isRequired: true } }),
    author: relationship({ ref: "User.reports", many: false }),
    // ...
  },
});
```

A model is made of three blocks: `access` (who can do what — separate skill), `hooks` (domain logic in the lifecycle) and `fields` (the shape of the data). Keep them in that order.

## Hooks contract (hard rules)

1. **`resolveInput` transforms and returns** — returns the resolved data object: `return { ...resolvedData, slug };`. It's the only hook that mutates what will be persisted. Never throw from here to validate (that's `validate`).
2. **`validate` validates and reports** — checks business invariants and calls `addValidationError(msg)` when one fails. **Returns nothing.** Prefer it over `throw`: Keystone groups the accumulated errors as validation failures, while a `throw` aborts on the first and surfaces as an internal error. Keyed by operation: `validate: { create, update, delete }`.
3. **`afterOperation` reacts** — runs after persisting (side-effects: enqueue a job, recompute an aggregate, emit an event). **Always** check `operation` before acting: `if (operation === "create" || operation === "update") { ... }`. On `delete` the data no longer exists — use `originalItem`.

## context.sudo() cheatsheet

```ts
context.sudo().db.Model;   // hooks + services: bypass access, for trusted internal logic
context.db.Model;          // NEVER in hooks/services — re-applies the session's access and can over-filter/over-deny
context.prisma;            // ONLY in seed/migration scripts, never in app runtime
```

Inside a hook or service **always** use `context.sudo()`. Using `context.db` in a hook is a latent bug: the operation may fail or return partial data depending on who's logged in.

## Quick table

| I need | Where / How |
|---|---|
| Derive a field before saving | `resolveInput` → `return { ...resolvedData, field }` |
| Reject an invalid operation | `validate` → `addValidationError(...)` |
| Side-effect after saving | `afterOperation` with an `operation === 'create'\|'update'` guard |
| Read/write another model from a hook | `context.sudo().db.OtherModel` |
| Relation between models | `relationship({ ref: "Other.inverseField" })` |

## Before declaring the change "done"

- `{{qualityGate.fast}}` green.
- No hook returns from `validate` nor throws from `resolveInput`; no list declares `validateInput`/`validateDelete` (removed in v8 — silently ignored, so the validation never runs).
- No `afterOperation` acts without checking `operation`.
- No `context.db` or `context.prisma` inside hooks/services (use `context.sudo()`).
- If you added a field to an existing model: run the migration (see `prisma-keystone`), don't edit `schema.prisma` by hand.
