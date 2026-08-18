---
name: drizzle-orm
description: Use when touching the schema, a query or a migration with Drizzle — inferred types, generated migrations, transactions, and the differences between drivers.
type: reference
---

# Drizzle ORM — conventions

## When to use this skill

When adding a table or a column, writing a query, or generating a migration. Drizzle is not an ORM that hides SQL: the schema IS the source of truth for types and migrations, so touching it wrong breaks both at once.

## The pattern

The schema declares the table; the types are derived from it, never hand-written:

```ts
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  coachId: uuid("coach_id").notNull().references(() => users.id),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  status: text("status", { enum: ["scheduled", "done", "cancelled"] }).notNull(),
});

export type Session = typeof sessions.$inferSelect;   // what a SELECT returns
export type NewSession = typeof sessions.$inferInsert; // what an INSERT accepts

const upcoming = await db
  .select()
  .from(sessions)
  .where(and(eq(sessions.coachId, coachId), gte(sessions.startsAt, new Date())));
```

## Gotchas that bite

- **Never edit an applied migration.** `drizzle-kit generate` writes an immutable file; changing it makes the journal and the database diverge and the next migration lands on a schema that doesn't exist. Fix it forward with a new migration.
- **Changing the schema is not enough — you have to generate.** Editing the `pgTable` only changes the types; without `generate` + `migrate` the DB stays as it was and the code compiles against a table that doesn't exist yet.
- **`$inferSelect` ≠ `$inferInsert`.** Columns with a default or generated are optional on insert and mandatory on select. Using one type for both forces casts.
- **`db.select()` returns an ARRAY, always.** Even filtering by the primary key. Destructure (`const [row] = …`) and handle `undefined`.
- **A query inside a transaction must use the transaction's handle.** `db.…` inside a `db.transaction(async (tx) => …)` runs OUTSIDE it: it neither rolls back nor sees the uncommitted changes. Use `tx.…`.
- **Drivers are not interchangeable.** pg, mysql and expo-sqlite differ in types (uuid, timestamptz, booleans), in whether they support `returning`, and in transaction semantics. Code written against one may not translate.
- **`where` with several conditions needs `and()`.** Chaining two `.where()` calls replaces the condition instead of combining it.

## Hard rules

1. The schema is the source of truth: types come from `$inferSelect`/`$inferInsert`, never hand-written.
2. Every schema change comes with its generated migration in the same commit.
3. An applied migration is immutable — fix forward.
4. Inside a transaction, everything goes through `tx`.
5. Relations declared with `references()` so cascades and joins are explicit.

## Before declaring done

- Migration generated, applied to a clean DB, and committed alongside the schema.
- Queries typed with no casts.
- Multi-write operations wrapped in a transaction.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's data model (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Where the schema lives and how it is split (per table, per domain).
     - The driver in use (pg, expo-sqlite, …) and its differences that bite.
     - The migration flow: who generates them, who applies them, and where they are applied.
     - Operations that MUST run in a transaction.
-->
