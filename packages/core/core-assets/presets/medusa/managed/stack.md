## Stack — Medusa.js v2 (backend)

Headless e-commerce backend. The domain lives in modules (`src/modules/`), the API in `src/api/` and multi-step logic in workflows. Admin extensions in `src/admin/`.

Golden rule: business logic lives in the **module services**; API routes only validate input and orchestrate workflows/services — they never access the data layer directly. Before touching `src/modules/` apply the `medusa-modules` skill; before `src/api/`, `medusa-api-routes`.
