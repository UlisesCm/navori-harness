---
name: nextjs-data-fetching
description: Use when touching pages with fetch or server-side queries in Next.js App Router (Next 15+) — rules for data fetching: cache opt-in, revalidate, dedup, parallel loading, Suspense.
type: reference
---

# Next.js Data Fetching — conventions (Next 15+)

## When to use this skill

Before adding `fetch()`, a DB client, or external APIs in Server Components, layouts, or `route.ts`. **In Next 15 the cache is opt-IN**: `fetch` is NOT cached by default (it's `no-store`). Assuming the old Next 14 default (`force-cache`) is the #1 source of bugs.

## Hard rules

1. **`fetch()` does NOT cache by default** (Next 15). To cache, opt in explicitly: `fetch(url, { cache: 'force-cache' })` or `fetch(url, { next: { revalidate: <sec> } })`. Without that, every request hits the origin.
2. **Don't `fetch` your own `route.ts` from a Server Component.** It's a useless internal HTTP round-trip: call the data/DB layer directly. Reserve `fetch` for **external** APIs, and there use an **absolute** URL (a relative one fails on the server: there's no base URL).
3. **Dedup non-`fetch` queries with React `cache()`.** Wrap the DB getter in `cache()` so multiple components in one render share a single query. (`fetch` with the same URL+opts already dedups itself.)
4. **`revalidateTag` > `revalidatePath`** for precise invalidation. Tag with `next: { tags: ['orders'] }` and revalidate granularly after the mutation.
5. **Parallel with `Promise.all`, not chained.** Two independent datasets: `await Promise.all([a(), b()])`. Chaining `await` creates a waterfall.
6. **Streaming with `<Suspense>`**: wrap the slow piece (an async child); the rest of the HTML ships while it loads.

## Typical pattern

```tsx
import { Suspense } from 'react';
import { cache } from 'react';

// deduplicated DB getter — NOT a fetch to your own /api
const getUser = cache(async (id: string) => db.user.findUnique({ where: { id } }));

export default async function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;            // params is a Promise in Next 15
  const user = await getUser(id);
  return (
    <div>
      <Header user={user} />
      <Suspense fallback={<OrdersSkeleton />}>
        <OrdersList userId={user.id} />
      </Suspense>
    </div>
  );
}

async function OrdersList({ userId }: { userId: string }) {
  const orders = await getOrders(userId);  // direct data layer; cache()/revalidate if applicable
  return <ul>{orders.map((o) => <li key={o.id}>{o.total}</li>)}</ul>;
}
```

## Quick table

| I need | How |
|---|---|
| Fresh data every request (default) | `fetch(url)` — already `no-store` in Next 15 |
| Cache indefinitely / every N sec | `{ cache: 'force-cache' }` / `{ next: { revalidate: N } }` |
| DB query (not fetch) | wrap in `cache()` (dedup per render) |
| Invalidate after mutation | `revalidateTag('X')` in a Server Action |
| Two independent datasets | `Promise.all([a(), b()])` |
| Partial UI while loading | `<Suspense>` with an async child |

## Before calling the change "done"

- `{{qualityGate.fast}}` green; tested with `next start` (the cache differs from `next dev`).
- Every external `fetch` declares a conscious policy (`no-store`/`force-cache`/`revalidate: N`) and uses an absolute URL; no DB query goes through your own `route.ts` (getters with `cache()`).
- If you mutated data in a Server Action: `revalidateTag`/`revalidatePath` is called, otherwise the UI stays stale.
</content>
