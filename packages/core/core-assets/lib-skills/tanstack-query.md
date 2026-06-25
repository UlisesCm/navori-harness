---
name: tanstack-query
description: Patrones de TanStack Query (React Query) — query keys, mutations, invalidación, staleTime. Aplica al tocar fetching, cache de servidor o mutaciones de datos remotos.
type: reference
---

# TanStack Query — convenciones

## Cuándo usar este skill

Al leer/escribir datos del servidor: un `useQuery`, un `useMutation`, invalidar cache, o paginar. TanStack Query es la fuente de verdad del **estado de servidor** (fetch + cache + revalidación). No lo uses para estado de cliente puro (eso es useState/Redux), ni dupliques su data en otro store.

## El patrón

Query keys estructuradas y centralizadas para invalidar sin strings sueltos:

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

## Gotchas que muerden

- **Query keys como datos, no strings.** Una factory (`sessionKeys`) evita typos y permite invalidar por prefijo (`sessionKeys.all` invalida todos los detalles).
- **`staleTime` vs `gcTime`.** `staleTime` decide cuándo refetchea; con `0` (default) refetchea agresivo. Súbelo para data estable y evita parpadeos/llamadas extra.
- **No espejes la data en useState/Redux.** Lee de `data` directo; copiarla a otro estado crea dos verdades que se desincronizan.
- **`enabled`** para queries dependientes — no dispares con el id aún `undefined`.
- **Invalidación tras mutar**, no edición manual del cache, salvo update optimista deliberado con rollback en `onError`.
- **`isPending` vs `isFetching`**: `isPending` es la primera carga sin data; `isFetching` es cualquier fetch en curso (incluye revalidación).

## Reglas duras

1. Estado de servidor vive en Query; no se copia a otro store.
2. Query keys desde una factory tipada, nunca arrays literales dispersos.
3. Tras una mutation, invalida las keys afectadas.
4. `enabled` en queries dependientes; nada de queries con params inválidos.
5. `staleTime` explícito cuando la data no cambia cada segundo.

## Antes de declarar listo

- Las keys nuevas salen de la factory y se invalidan tras mutar.
- Ningún dato de query duplicado en useState/Redux.
- Las queries dependientes usan `enabled`.
- `{{qualityGate.fast}}` en verde.
