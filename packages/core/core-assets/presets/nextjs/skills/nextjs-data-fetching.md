---
name: nextjs-data-fetching
description: Reglas para data fetching en Next.js App Router — cache, revalidate, parallel loading, Suspense. Aplica al tocar páginas con fetch o queries server-side.
type: reference
---

# Next.js Data Fetching — convenciones del proyecto

## Cuándo usar este skill

Antes de agregar `fetch()`, cliente de DB o llamadas a APIs externas dentro de Server Components, layouts o `route.ts`. El modelo de cache de Next es opt-out, no opt-in — entender qué cachea por default evita data stale en producción.

## Reglas duras

1. **`fetch()` cachea por default** (igual que `cache: "force-cache"`). Para data fresca usa `fetch(url, { cache: "no-store" })` o `next: { revalidate: <segundos> }`.
2. **Una request `cache: "no-store"` en un Server Component hace toda la ruta dinámica.** Eso significa que Next NO la pre-renderea en build — cada request hits server. Decisión deliberada.
3. **`revalidateTag` > `revalidatePath`** para invalidaciones precisas. Etiqueta los fetches con `next: { tags: ["user", "user-orders"] }` y revalida granular.
4. **Llamadas paralelas: `Promise.all`, no encadenadas.** Si necesitas dos datasets independientes, `await Promise.all([fetchA(), fetchB()])`. Encadenar (`const a = await A(); const b = await B()`) duplica el round-trip.
5. **Streaming con Suspense para slow data.** Si una parte de la página es lenta, envuélvela en `<Suspense>` con un componente async dentro. El resto del HTML se manda mientras esa pieza carga.

## Patrón típico

```tsx
// app/dashboard/page.tsx
import { Suspense } from "react";

export default async function DashboardPage() {
  // Datos rápidos: en serie está bien
  const user = await getUser();

  return (
    <div>
      <Header user={user} />
      {/* Datos lentos: streaming */}
      <Suspense fallback={<OrdersSkeleton />}>
        <OrdersList userId={user.id} />
      </Suspense>
    </div>
  );
}

async function OrdersList({ userId }: { userId: string }) {
  // Etiquetado para revalidación precisa
  const res = await fetch(`/api/orders?u=${userId}`, {
    next: { tags: [`orders:${userId}`], revalidate: 60 },
  });
  const orders = await res.json();
  return <ul>{orders.map((o) => <li key={o.id}>{o.total}</li>)}</ul>;
}
```

## Tabla rápida

| Necesito | Cómo |
|---|---|
| Data estática (build-time) | `fetch(url)` con default cache |
| Data fresca cada request | `fetch(url, { cache: "no-store" })` |
| Refrescar cada N segundos | `fetch(url, { next: { revalidate: N } })` |
| Invalidar tras mutación | `revalidateTag("X")` en Server Action |
| Dos datasets independientes | `Promise.all([a(), b()])` |
| UI parcial mientras carga | `<Suspense fallback={...}>` con async child |

## Antes de declarar el cambio "listo"

- `{{qualityGate.fast}}` en verde.
- Prueba la página en `next start` (production build), no solo en `next dev`. El cache se comporta distinto.
- Si agregaste un fetch nuevo: documenta su política de cache (¿estática? ¿revalidate cada cuánto? ¿no-store?). Una request sin política explícita usa el default y puede dar data stale.
- Si tocaste un Server Action que muta datos: confirma que `revalidateTag` / `revalidatePath` se llama, sino la UI no se actualiza.
