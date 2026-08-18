---
name: apollo-client
description: Use when writing queries/mutations, configuring the cache, or wiring the links — GraphQL with Apollo Client: hooks, fetchPolicy, cache normalization, and updating after mutations.
type: reference
---

# Apollo Client — the canonical pattern

Declarative reads with hooks, cache **normalized by id**, and the UI stays in sync by updating the cache after every mutation. Network/auth concerns live in the links, not in the components.

## When to use this skill

When writing a query/mutation, configuring `InMemoryCache`/`typePolicies`, or the `links` chain.

## Hooks and isolation

`useQuery` (read on mount), `useLazyQuery` (on demand, returns `execute`), `useMutation` (returns `[mutate, { data, loading, error }]`). Isolate the hooks in a layer (hook + adapter): the component receives a **domain model**, not the raw GraphQL shape.

```ts
export function useReport(id: string) {
  const { data, loading, error } = useGetReportQuery({ variables: { id }, fetchPolicy: 'cache-first' });
  return { report: data?.report ? adaptReport(data.report) : null, loading, error };
}
```

## fetchPolicy by data type

- `cache-first` (default) — catalogs/details already fetched by a list.
- `cache-and-network` — feeds that change often (instant render + refresh).
- `network-only` — session/bootstrap, critical data.
- Avoid `no-cache` except strict PII that must not touch disk.

## Cache normalization

```ts
const cache = new InMemoryCache({ typePolicies: { Report: { keyFields: ['id'] } } });
```

With `keyFields`, Apollo identifies entities by id and deduplicates/updates on its own. Without normalization, lists and details drift out of sync.

## Hard rules

1. **After a mutation, update the cache:** `update(cache, { data })` (`cache.modify`/`evict`/`writeQuery`) or `refetchQueries`. Never leave the UI out of sync.
2. **`optimisticResponse`** for instant UI (a temporary result with `__typename` + a fake id); `update` reconciles when the real response arrives.
3. **Don't over-fetch:** request only the fields the component uses; lean on **colocated fragments** (the fragment next to the component that consumes it). Regenerate types (codegen) after editing `.graphql`.
4. **Always handle `loading` and `error`.** Separate network errors (generic banner, resolved in an `errorLink`) from business errors (`graphQLErrors`, copy based on `extensions.code`).
5. **Pagination** with `fetchMore` + `updateQuery`, or `relayStylePagination`/merge in `typePolicies`.
6. Network/auth/upload in the **links** chain (auth → error → upload), not in each component.

```ts
const [createReport] = useCreateReportMutation({
  optimisticResponse: { createReport: { __typename: 'Report', id: 'temp', ...fields } },
  update(cache) { cache.evict({ fieldName: 'reports' }); }, // invalidate the list
});
```

## Before declaring done

- Hooks isolated in a layer (hook + adapter); the component sees the domain model.
- Cache normalized by `keyFields`; mutations update/invalidate the cache.
- `fetchPolicy` chosen by data type; `loading`/`error` handled.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's GraphQL layer (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The endpoint and the link chain (auth, retry, error).
     - typePolicies / cache normalization that isn't the default, and why.
     - Shared fragments and where they live.
     - Which queries run against the network on purpose (fetchPolicy) and which don't.
-->
