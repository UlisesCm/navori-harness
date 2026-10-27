# Migración Rust — 2026-10-27

Base: `migration/rust` con #1412, #1413 y #1414 integrados (E1 de 0058 cerrada). Sin subagentes
por instrucción del usuario. PRs por incremento contra esa base; merge sólo con CI requerido
verde. No activar hooks ni cortar TS sin aprobación. Comandos manuales en chat.

## Entrega actual

Spec 0058, E3 M5 (plan de render Claude) en `feat/0058-rust-e3` (PR #1411, draft), worktree
`-rust-0058`. Cambios inline sin revisión independiente: el gate full es obligatorio antes de
marcar el PR listo. Gate full local verde sobre `4863673b`: 10474 aprobadas, 2 omitidas,
496 archivos; cobertura 88.09/86.41/91.32/81.03%, piso 172 módulos sin excepciones.

Portados con paridad y mutaciones: `interpolate`, `frontmatter`, `hook-includes`, assets
embebidos, núcleo de `render-plan`, carga de presets, registro de skills de librerías
(validadores zod compartidos en `navori_core::zod`) y carga de plugins (`render::plugins`).
Mutaciones de presets y plugins muertas salvo `basename` (equivalente con los datos actuales).

## Siguiente paso

1. #1411: CI verde y decisión del usuario sobre marcarlo listo como incremento de M5.
2. Portar `effectiveConfig`, el plan de bloques de `CLAUDE.md`, el motor Claude (T14),
   `build-settings`/coexist y el wiring nativo (T15) y las cadenas (T16). A5:
   `render_claude.rs` aún no existe.
3. 0057: T23/A9 (replay `--impl rust` con fixtures del escritor CLI y los 163 casos
   `shell-runtime`; requiere workplan). T27 bloqueado por uso vivo (500 matches/14d por engine,
   host no-Claude, 0 divergencias).
4. `navori-cli/tests/facts_cache.rs` (0057) es intermitente (3/5 fallas aisladas) por un
   presupuesto de 1 ms; puede tumbar CI.
