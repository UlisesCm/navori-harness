---
name: nextjs-data-fetching
description: Reglas para data fetching en Next.js App Router (Next 15+) — cache opt-in, revalidate, dedup, parallel loading, Suspense. Aplica al tocar páginas con fetch o queries server-side.
type: reference
---

# Next.js Data Fetching — convenciones (Next 15+)

## Cuándo usar este skill

Antes de agregar `fetch()`, cliente de DB o APIs externas en Server Components, layouts o `route.ts`. **En Next 15 el cache es opt-IN**: `fetch` NO se cachea por default (es `no-store`). Asumir el viejo default de Next 14 (`force-cache`) es la fuente #1 de bugs.

## Reglas duras

1. **`fetch()` NO cachea por default** (Next 15). Para cachear, opt-in explícito: `fetch(url, { cache: 'force-cache' })` o `fetch(url, { next: { revalidate: <seg> } })`. Sin eso, cada request pega al origen.
2. **No hagas `fetch` a tu propio `route.ts` desde un Server Component.** Es un round-trip HTTP interno inútil: llama la capa de datos/DB directo. Reserva `fetch` para APIs **externas**, y ahí usa URL **absoluta** (una relativa falla en server: no hay base URL).
3. **Dedup de queries no-`fetch` con React `cache()`.** Envuelve el getter de DB en `cache()` para que múltiples componentes en un render compartan una sola query. (`fetch` con misma URL+opts ya se deduplica solo.)
4. **`revalidateTag` > `revalidatePath`** para invalidar preciso. Etiqueta con `next: { tags: ['orders'] }` y revalida granular tras la mutación.
5. **Paralelo con `Promise.all`, no encadenado.** Dos datasets independientes: `await Promise.all([a(), b()])`. Encadenar `await` crea un waterfall.
6. **Streaming con `<Suspense>`**: envuelve la pieza lenta (un async child); el resto del HTML sale mientras carga.

## Patrón típico

```tsx
import { Suspense } from 'react';
import { cache } from 'react';

// getter de DB deduplicado — NO un fetch a /api propio
const getUser = cache(async (id: string) => db.user.findUnique({ where: { id } }));

export default async function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;            // params es Promise en Next 15
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
  const orders = await getOrders(userId);  // capa de datos directa; cache()/revalidate si aplica
  return <ul>{orders.map((o) => <li key={o.id}>{o.total}</li>)}</ul>;
}
```

## Tabla rápida

| Necesito | Cómo |
|---|---|
| Data fresca cada request (default) | `fetch(url)` — ya es `no-store` en Next 15 |
| Cachear indefinido / cada N seg | `{ cache: 'force-cache' }` / `{ next: { revalidate: N } }` |
| Query de DB (no fetch) | envolver en `cache()` (dedup por render) |
| Invalidar tras mutación | `revalidateTag('X')` en Server Action |
| Dos datasets independientes | `Promise.all([a(), b()])` |
| UI parcial mientras carga | `<Suspense>` con async child |

## Antes de declarar el cambio "listo"

- `{{qualityGate.fast}}` en verde; probado en `next start` (el cache difiere de `next dev`).
- Cada `fetch` externo declara política consciente (`no-store`/`force-cache`/`revalidate: N`) y usa URL absoluta; ninguna query de DB pasa por un `route.ts` propio (getters con `cache()`).
- Si mutaste datos en un Server Action: `revalidateTag`/`revalidatePath` se llama, sino la UI queda stale.
</content>
