## Stack — Astro

Site built on islands architecture: static HTML by default, JavaScript only in the islands that need it, hydrated with `client:*` directives (`client:load`, `client:visible`, …).

Golden rule: minimize client-side JS — hydrate only what's interactive and prefer `client:visible`/`client:idle` over `client:load` when possible. Apply the `astro-islands` skill before adding framework components.
