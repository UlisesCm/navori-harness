## Stack — Medusa.js v2 (backend)

Backend de e-commerce headless. El dominio vive en módulos (`src/modules/`), la API en `src/api/` y la lógica multi-paso en workflows. Admin extensions en `src/admin/`.

Regla de oro: la lógica de negocio vive en los **module services**; las API routes solo validan input y orquestan workflows/services — nunca acceden a la capa de datos directamente. Antes de tocar `src/modules/` aplica el skill `medusa-modules`; antes de `src/api/`, `medusa-api-routes`.
