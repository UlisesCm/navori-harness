---
name: astro-islands
description: Rules for Astro Islands — client directives, framework components, performance. Use when adding interactivity to an Astro site.
type: reference
maxWords: 520
---

# Astro Islands — project conventions

## When to use this skill

Before importing a React/Vue/Svelte/Solid component into an Astro page, or when you add interactivity to a site that was static. The Islands model is Astro's differentiator vs Next/Nuxt — misused, the bundle bloats and the benefit is lost.

## Hard rules

1. **By default everything is server-rendered + zero JS.** `.astro` components run at build / server time and ship pure HTML. Don't add client JS unless you need interactivity.
2. **`client:*` directives are opt-in and explicit.** Every component with `client:` runs in the browser and adds to the bundle. Use the minimal directive:
   - `client:load` — hydrate immediately on page load (expensive).
   - `client:idle` — when the browser is idle (better for non-critical widgets).
   - `client:visible` — only when it enters the viewport (better for below-fold).
   - `client:media="(min-width: 768px)"` — only if the media query matches.
   - `client:only="react"` — skip SSR; render only on the client. Useful for libs that touch `window` during SSR.
3. **`client:visible` > `client:load` for anything not above-the-fold.** Carousels, secondary forms, modals that live at the bottom of the page: `client:visible` avoids hydrating on load.
4. **Sharing state between Islands = Nano Stores, not Context.** Islands are isolated — React Context doesn't cross boundaries. `@nanostores/persistent` or `@nanostores/react` is the official pattern.
5. **`.astro` for layout / structure, framework component only for interactivity.** If the component has no state/handler, write it in `.astro` (faster, less bundle).

## Typical pattern

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
  <!-- Critical for conversion → hydrate early -->
  <NewsletterForm client:idle />
  <!-- Below-the-fold → hydrate only if visible -->
  <CommentsSection client:visible />
</Layout>
```

## Quick table

| Need | How |
|---|---|
| Static text / structure | `.astro` component (no client JS) |
| Simple form with validation | React/Vue island with `client:idle` |
| Interactive widget above-fold | `client:load` (expensive but critical) |
| Below-the-fold section | `client:visible` |
| Lib that touches `window` on mount | `client:only="react"` |
| Shared state between 2 islands | `@nanostores/persistent` + `@nanostores/react` |
| Build-time data | `import.meta.glob` in `.astro` frontmatter |
| Per-request SSR data | `Astro.cookies` / `Astro.request` in frontmatter |
| API endpoint | `src/pages/api/<x>.ts` with `export GET/POST` |

## Before declaring the change "done"

- `{{qualityGate.fast}}` green.
- Run `astro build` and check the per-page bundle size output. Every island adds JS — confirm the delta is justifiable.
- Lighthouse (Performance + Best Practices) on `astro preview`. Astro should hold 95+ on mostly-static sites; if it dropped a lot, you hydrated something that could be server-only.
- If you added `client:load`: justify it in the PR. Why not `client:idle` or `client:visible`?
- If you have 2 islands sharing state: confirm you use Nano Stores, not that you duplicated fetch / state in each.
