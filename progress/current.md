# Migración Rust — 2026-10-27

Base: `migration/rust` en `d385b524` (#1410 integrado). Sin subagentes por instrucción del
usuario. PRs por incremento contra esa base; merge sólo con CI requerido verde. No activar
hooks ni cortar TS sin aprobación.

## Entrega actual

`fix/0057-rust-quality-deps`, worktree `-rust-ci`. El job `quality` de `rust.yml` falla en
`migration/rust` desde #1410: `config_parity` importa `config.ts` y no hay `node_modules`
(`ERR_MODULE_NOT_FOUND: zod`). Fix: `setup-bun` + `bun install --frozen-lockfile` en `quality`,
igual que `oracle`. Reproducido en checkout limpio: falla sin install, 2/2 con install.
Cambio inline sin revisión independiente.

## Siguiente paso

1. Integrar el fix con CI verde; luego actualizar #1412 (T26, `subagent-no-background` en
   sombra) con `migration/rust` y integrarlo con CI verde.
2. Cambios sin commitear de CONTRIBUTING{,.es,.zh-CN}.md (T17) en worktree `-rust`: pendiente
   decisión del usuario.
3. T27: pasar `subagent-no-background` a `active` con resumen de sombra de uso vivo
   (500 matches/14d por engine, host no-Claude) y aprobación del usuario. T23 sigue abierto.
