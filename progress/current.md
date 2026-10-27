# Migración Rust — 2026-10-27

Base: `migration/rust` con #1412 y #1413 integrados. Sin subagentes por instrucción del usuario.
PRs por incremento contra esa base; merge sólo con CI requerido verde. No activar hooks ni cortar
TS sin aprobación. Comandos manuales en chat.

## Entrega actual

Spec 0058, E3 M5 (plan de render Claude) en `feat/0058-rust-e3` (PR #1411), worktree
`-rust-0058`. Cambios inline sin revisión independiente: el gate full es obligatorio antes de
marcar el PR listo.

Portados con paridad y mutaciones: `interpolate`, `frontmatter`, `hook-includes`, assets
embebidos, núcleo de `render-plan`, carga de presets, registro de skills de librerías
(validadores zod compartidos en `navori_core::zod`) y carga de plugins (`render::plugins`).
Plugins: el esquema reproduce la salida zod sin validar hojas (bytes embebidos, verificados por
el oráculo); manifiestos sintéticos vía `loadPlugin` real con `readFileSync` parcheado.
Mutaciones de presets y plugins muertas salvo `basename` (equivalente con los datos actuales).

## Siguiente paso

1. Portar `effectiveConfig`, el plan de bloques de `CLAUDE.md`, el motor Claude (T14),
   `build-settings`/coexist y el wiring nativo (T15) y las cadenas (T16). A5:
   `render_claude.rs` aún no existe.
2. 0057: cambios sin commitear de CONTRIBUTING{,.es,.zh-CN}.md (T17) en worktree `-rust`,
   pendiente decisión del usuario. T27 (`subagent-no-background` a `active`) requiere resumen de
   sombra de uso vivo (500 matches/14d por engine, host no-Claude) y aprobación. T23 abierto.
3. Pendiente ajeno: `navori-cli/tests/facts_cache.rs` (0057) es intermitente por un presupuesto
   de 1 ms.
