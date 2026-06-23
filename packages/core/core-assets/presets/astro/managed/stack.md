## Stack — Astro

Sitio con islands architecture: HTML estático por default, JavaScript solo en las islands que lo necesitan, hidratadas con directivas `client:*` (`client:load`, `client:visible`, …).

Regla de oro: minimiza el JS de cliente — hidrata solo lo interactivo y prefiere `client:visible`/`client:idle` sobre `client:load` cuando se pueda. Aplica el skill `astro-islands` antes de agregar componentes con framework.
