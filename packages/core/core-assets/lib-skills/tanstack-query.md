---
name: tanstack-query
description: Use when touching fetching, server cache, or remote data mutations — TanStack Query (React Query) patterns: query keys, mutations, invalidation, staleTime.
type: reference
---

# TanStack Query — conventions

## When to use this skill

When reading/writing server data: a `useQuery`, a `useMutation`, invalidating cache, or paginating. TanStack Query is the source of truth for **server state** (fetch + cache + revalidation). Don't use it for pure client state (that's useState/Redux), and don't duplicate its data in another store.

## The pattern

Structured, centralized query keys to invalidate without loose strings:

```ts
const sessionKeys = {
  all: ['sessions'] as const,
  detail: (id: string) => [...sessionKeys.all, id] as const,
};

const { data, isPending, error } = useQuery({
  queryKey: sessionKeys.detail(id),
  queryFn: () => api.getSession(id),
  staleTime: 30_000,
  enabled: Boolean(id),
});

const mutation = useMutation({
  mutationFn: api.updateSession,
  onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionKeys.all }),
});
```

## Gotchas that bite

- **Query keys as data, not strings.** A factory (`sessionKeys`) avoids typos and lets you invalidate by prefix (`sessionKeys.all` invalidates all details).
- **`staleTime` vs `gcTime`.** `staleTime` decides when it refetches; with `0` (default) it refetches aggressively. Raise it for stable data and avoid flicker/extra calls.
- **Don't mirror the data in useState/Redux.** Read from `data` directly; copying it to another state creates two truths that drift apart.
- **`enabled`** for dependent queries — don't fire with the id still `undefined`.
- **`useQuery` has NO `onSuccess`/`onError`/`onSettled`** (v5 removed them; they only survive in `useMutation`). To react to the data, do it in render or with `select`. It's the #1 gotcha when migrating from v4: the callback simply never runs.
- **Full optimistic update**: in `onMutate` do `await queryClient.cancelQueries({ queryKey })` (without it, an in-flight refetch overwrites your update), snapshot with `getQueryData`, apply with `setQueryData`; restore the snapshot in `onError`; `invalidateQueries` in `onSettled`.
- **`isPending` vs `isFetching`**: `isPending` is the first load with no data; `isFetching` is any fetch in progress (including revalidation). Pagination: `placeholderData: keepPreviousData` (v5 replaced `keepPreviousData: true`).

## Hard rules

1. Server state lives in Query; it's not copied to another store.
2. Query keys from a typed factory, never scattered literal arrays.
3. After a mutation, invalidate the affected keys.
4. `enabled` on dependent queries; no queries with invalid params.
5. Explicit `staleTime` when the data doesn't change every second.

## Before declaring done

- New keys come from the factory and are invalidated after mutating.
- No query data duplicated in useState/Redux.
- Dependent queries use `enabled`.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's query layer (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The query-key convention (the factory, if there is one) — the single thing that makes invalidation predictable.
     - Per-domain staleTime/gcTime: what is near-static and what must never be cached.
     - Which mutations invalidate which keys.
     - The repo's own wrapper hooks, if components don't call useQuery directly.
-->
