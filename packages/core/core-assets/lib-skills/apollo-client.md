---
name: apollo-client
description: GraphQL con Apollo Client — hooks, fetchPolicy, normalización de caché y actualización tras mutaciones. Aplica al escribir queries/mutations, configurar la caché o los links.
type: reference
---

# Apollo Client — el patrón canónico

Lecturas declarativas con hooks, caché **normalizada por id**, y la UI se mantiene en sync actualizando la caché tras cada mutación. Los concerns de red/auth viven en los links, no en los componentes.

## Cuándo usar este skill

Al escribir una query/mutation, configurar `InMemoryCache`/`typePolicies`, o la cadena de `links`.

## Hooks y aislamiento

`useQuery` (lectura al montar), `useLazyQuery` (bajo demanda, retorna `execute`), `useMutation` (retorna `[mutate, { data, loading, error }]`). Aísla los hooks en una capa (hook + adapter): el componente recibe un **modelo de dominio**, no el shape crudo de GraphQL.

```ts
export function useReport(id: string) {
  const { data, loading, error } = useGetReportQuery({ variables: { id }, fetchPolicy: 'cache-first' });
  return { report: data?.report ? adaptReport(data.report) : null, loading, error };
}
```

## fetchPolicy según el dato

- `cache-first` (default) — catálogos/detalles ya traídos por una lista.
- `cache-and-network` — feeds que cambian seguido (render instantáneo + refresh).
- `network-only` — sesión/bootstrap, datos críticos.
- Evita `no-cache` salvo PII estricta que no deba tocar disco.

## Normalización de caché

```ts
const cache = new InMemoryCache({ typePolicies: { Report: { keyFields: ['id'] } } });
```

Con `keyFields`, Apollo identifica entidades por id y deduplica/actualiza solo. Sin normalización, las listas y detalles se desincronizan.

## Reglas duras

1. **Tras una mutation, actualiza la caché:** `update(cache, { data })` (`cache.modify`/`evict`/`writeQuery`) o `refetchQueries`. Nunca dejes la UI desincronizada.
2. **`optimisticResponse`** para UI instantánea (resultado temporal con `__typename` + id ficticio); `update` reconcilia al llegar la respuesta real.
3. **No over-fetch:** pide solo los campos que el componente usa; apóyate en **fragments con colocation** (el fragmento junto al componente que lo consume). Regenera tipos (codegen) tras editar `.graphql`.
4. **Maneja `loading` y `error` siempre.** Separa error de red (banner genérico, resuelto en un `errorLink`) de error de negocio (`graphQLErrors`, copy según `extensions.code`).
5. **Paginación** con `fetchMore` + `updateQuery`, o `relayStylePagination`/merge en `typePolicies`.
6. Red/auth/upload en la cadena de **links** (auth → error → upload), no en cada componente.

```ts
const [createReport] = useCreateReportMutation({
  optimisticResponse: { createReport: { __typename: 'Report', id: 'temp', ...fields } },
  update(cache) { cache.evict({ fieldName: 'reports' }); }, // invalida la lista
});
```

## Antes de declarar listo

- Hooks aislados en capa (hook + adapter); el componente ve el modelo de dominio.
- Caché normalizada por `keyFields`; mutaciones actualizan/invalidan la caché.
- `fetchPolicy` elegido por tipo de dato; `loading`/`error` manejados.
- `{{qualityGate.fast}}` en verde.
