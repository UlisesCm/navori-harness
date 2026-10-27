# Migración Rust — 2026-10-27

Spec 0058, E3 M5 (plan de render Claude) en `feat/0058-rust-e3`, worktree `-rust-0058`, contra
`migration/rust`. Cambios escritos sin subagentes por instrucción del usuario: el gate full es
obligatorio antes del PR. Comandos manuales en chat. No activar hooks ni cortar TS.

## Estado

Portados con paridad y mutaciones: `interpolate`, `frontmatter`, `hook-includes`, assets
embebidos, núcleo de `render-plan`, carga de presets y registro de skills de librerías
(validadores zod compartidos en `navori_core::zod`). En la carga de presets, las sondas de
mutación (`custom`, `.`/`..`/vacío, BOM, id, libraries, local sobre incluido, tabla) mueren todas.

## Siguiente paso

Portar `plugins.ts` (managed entries de plugins habilitados en `render-plan`), luego
`effectiveConfig`, el plan de bloques de `CLAUDE.md`, el motor Claude (T14), `build-settings`/
coexist y el wiring nativo (T15) y las cadenas (T16). A5: `render_claude.rs` aún no existe.
Pendiente ajeno: `navori-cli/tests/facts_cache.rs` (0057) es intermitente por un presupuesto de 1 ms.
