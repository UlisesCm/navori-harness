# Migración Rust — 2026-10-27

Base: `migration/rust` con #1411–#1414 integrados (E1 de 0058 cerrada). Sin subagentes por
instrucción del usuario. PRs por incremento contra esa base; merge sólo con CI requerido verde.
No activar hooks ni cortar TS sin aprobación. Comandos manuales en chat.

## Entrega actual

Spec 0058, E3 M5 (plan de render Claude), segundo tramo en `feat/0058-rust-e3-plan`, worktree
`-rust-0058`, sin PR todavía. Cambios inline sin revisión independiente: gate full obligatorio
antes de marcar listo el PR. Ojo: el gate full escribe sobre `progress/current.md` del repo real;
revisar `git status` después de correrlo.

Integrado en #1411: `interpolate`, `frontmatter`, `hook-includes`, assets embebidos, núcleo de
`render-plan`, presets, skills de librerías, `navori_core::zod` y plugins. En esta rama, con
paridad y mutaciones: `config::effective_config` y `render::block_plan`
(`compute_render_plan`, `canonical_managed_order`). Delegan al TS los errores que el TS lanza o
reporta con mensajes no reproducidos (preset inválido, manifiesto roto, asset ilegible).

## Siguiente paso

1. Publicar este tramo (PR contra `migration/rust`) con gate full y CI verdes.
2. Motor Claude (T14: plan puro de `PendingWrite`/`PendingRemoval`, `.gitignore` anidados),
   `build-settings`/coexist y wiring nativo (T15) y cadenas (T16). A5: `render_claude.rs` aún
   no existe.
3. 0057: T23/A9 (replay `--impl rust` con fixtures del escritor CLI y los 163 casos
   `shell-runtime`; requiere workplan). T27 bloqueado por uso vivo (500 matches/14d por engine,
   host no-Claude, 0 divergencias).
4. `navori-cli/tests/facts_cache.rs` (0057) es intermitente (3/5 fallas aisladas) por un
   presupuesto de 1 ms; puede tumbar CI.
