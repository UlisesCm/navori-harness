---
name: astro-islands
description: Reglas para Astro Islands — client directives, framework components, performance. Aplica al agregar interactividad a un site Astro.
---

# Astro Islands — convenciones del proyecto

## Cuándo usar este skill

Antes de importar un componente de React/Vue/Svelte/Solid en una página Astro, o cuando agregás interactividad a un site que era static. El modelo Islands es el diferencial de Astro vs Next/Nuxt — usado mal, el bundle infla y se pierde el beneficio.

## Reglas duras

1. **Por default todo es server-rendered + zero JS.** Los componentes `.astro` se ejecutan en build / server y mandan HTML puro. No agregues JS al cliente a menos que necesites interactividad.
2. **`client:*` directives son opt-in y explícitas.** Cada componente con `client:` corre en el navegador y suma al bundle. Usá la directiva mínima:
   - `client:load` — hydrate inmediatamente al cargar la página (caro).
   - `client:idle` — cuando el browser esté idle (mejor para widgets no-críticos).
   - `client:visible` — solo cuando entra al viewport (mejor para below-fold).
   - `client:media="(min-width: 768px)"` — solo si match el media query.
   - `client:only="react"` — skip SSR; renderiza solo en cliente. Útil para libs que tocan `window` en SSR.
3. **`client:visible` > `client:load` para todo lo que no esté above-the-fold.** Carrouseles, formularios secundarios, modales que viven al final de la página: `client:visible` evita hydratar al inicio.
4. **Compartir state entre Islands = Nano Stores, no Context.** Los Islands están aislados — React Context no cruza fronteras. `@nanostores/persistent` o `@nanostores/react` son el patrón oficial.
5. **`.astro` para layout / structure, framework component solo para interactividad.** Si el componente no tiene estado/handler, escribilo en `.astro` (más rápido, menos bundle).

## Patrón típico

```astro
---
// src/pages/index.astro
import Layout from "../layouts/Layout.astro";
import HeroSection from "../components/HeroSection.astro";        // server-only
import NewsletterForm from "../components/NewsletterForm.tsx";    // React island
import CommentsSection from "../components/CommentsSection.tsx";  // React island, below-fold
---

<Layout title="Home">
  <HeroSection />
  <!-- Crítico para conversión → hydrate temprano -->
  <NewsletterForm client:idle />
  <!-- Below-the-fold → hydrate solo si se ve -->
  <CommentsSection client:visible />
</Layout>
```

## Tabla rápida

| Necesito | Cómo |
|---|---|
| Texto estático / structure | `.astro` component (sin JS al cliente) |
| Form simple con validación | React/Vue island con `client:idle` |
| Widget interactivo above-fold | `client:load` (caro pero crítico) |
| Sección below-the-fold | `client:visible` |
| Lib que toca `window` en mount | `client:only="react"` |
| State compartido entre 2 islands | `@nanostores/persistent` + `@nanostores/react` |
| Data en build-time | `import.meta.glob` en frontmatter `.astro` |
| Data en SSR per-request | `Astro.cookies` / `Astro.request` en frontmatter |
| Endpoint API | `src/pages/api/<x>.ts` con `export GET/POST` |

## Antes de declarar el cambio "listo"

- `{{qualityGate.fast}}` en verde.
- Corré `astro build` y revisá el output de bundle size por página. Cada island agrega JS — confirmá que el delta es justificable.
- Lighthouse (Performance + Best Practices) en `astro preview`. Astro debería sostener 95+ en sites mostly-static; si bajó mucho, hidrataste algo que podía ser server-only.
- Si agregaste `client:load`: justificalo en el PR. ¿Por qué no `client:idle` o `client:visible`?
- Si tenés 2 islands que comparten state: confirmá que usás Nano Stores, no que duplicaste fetch / estado en cada uno.
