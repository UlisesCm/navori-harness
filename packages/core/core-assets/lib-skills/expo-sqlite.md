---
name: expo-sqlite
description: Use when opening the local database, adding a migration, writing live queries, or debugging "no such table" / stale data on device with expo-sqlite, alone or under Drizzle. Covers the on-device failures that typecheck and node tests never see. Not for schema or query design (see drizzle-orm).
metadata:
  type: reference
---

# expo-sqlite — local-first on device

The worst bugs here share one shape: typecheck and node tests pass while the app crashes or misbehaves only on device, because Metro bundles differently from Node. Check the installed majors of `expo-sqlite`, `drizzle-orm`, and `drizzle-kit` in `package.json` before applying the migration rules below.

## The pattern

Two supported setups — follow the one the repo already uses:

- **Drizzle:** open once at module level, migrate in the root layout before rendering app UI.
- **Plain expo-sqlite:** `<SQLiteProvider databaseName="app.db" onInit={migrateDbIfNeeded}>` + `useSQLiteContext()`, with migrations keyed on `PRAGMA user_version`.

```ts
import { openDatabaseSync } from "expo-sqlite";
import { drizzle } from "drizzle-orm/expo-sqlite";
import { useMigrations } from "drizzle-orm/expo-sqlite/migrator";
import migrations from "./drizzle/migrations";

const expoDb = openDatabaseSync("app.db", { enableChangeListener: true });
export const db = drizzle(expoDb);

// Root layout: render app UI only once `success` is true; surface `error`.
const { success, error } = useMigrations(db, migrations);
```

## Gotchas that bite

- **Live queries need `enableChangeListener: true`.** Without it `useLiveQuery` runs once and every write looks like a stale-UI bug.
- **`useLiveQuery` watches only its own table.** Writes to a joined table don't refresh it; changed parameters need the `deps` argument.
- **The migrations bundle (`migrations.js`) is generated, never hand-written.** `driver: "expo"` in `drizzle.config.ts`, then `drizzle-kit generate`. Its keys must match what the migrator looks up — a hand edit crashes on device with "Missing migration".
- **Exactly one bundle file.** Expo's Metro resolves `.ts` before `.js`: a stale `migrations.ts` next to the generated `migrations.js` shadows it on device ("no such table") while tools read the right one.
- **Drizzle 0.x only — journal order.** The bundle imports `meta/_journal.json`, and the migrator skips any migration whose `when` is not newer than the last applied one: migrated devices skip it, fresh installs pass. Never hand-edit the journal. Drizzle 1.x drops the journal and tracks migrations by folder name.
- **`.sql` must be bundleable:** `babel-plugin-inline-import` for `.sql` in `babel.config.js` and `"sql"` in Metro's `resolver.sourceExts`.
- **Transactions:** prefer `withExclusiveTransactionAsync` (or Drizzle's `tx`) — `withTransactionAsync` also captures unrelated queries that run meanwhile.
- **Bulk writes block the JS thread.** Drizzle's expo driver is synchronous: batch them in one `tx`. Without Drizzle, prefer the async API (`*Async`) over `*Sync` for heavy work.
- **Key-value settings** go in `expo-sqlite/kv-store`, secrets in `expo-secure-store` — not ad-hoc tables.

## Before declaring done

Copy and check off:

- [ ] Migrations bundle regenerated with `drizzle-kit generate`, committed with the schema change; one bundle file.
- [ ] A guard test exists that fails on a second bundle file, a key mismatch, or (0.x) a non-increasing journal `when`.
- [ ] `npx expo export --clear` succeeds after any babel/Metro change.
- [ ] Verified on a device or simulator that already had the previous schema, not only a fresh install.
- [ ] `{{qualityGate.fast}}` green.

If any item fails, fix it and re-run the whole list.

<!-- navori:user-section -->
## This repo's local database (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Setup in use (Drizzle or SQLiteProvider) and where `db` is exported from.
     - Seeded tables and the seed's idempotency check.
     - Screens that rely on live queries.
-->
