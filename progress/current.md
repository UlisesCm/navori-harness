# Checkpoint Rust — 2026-10-23

Base remota estable `migration/rust` en `51d4367c`. PRs por spec/entrega y clones paralelos
autorizados. El usuario autoriza mergear PRs Rust con todos los checks requeridos verdes.
Comandos manuales siempre por chat, nunca tarjetas de pregunta. No activar hooks ni cortar TS.

## Integrado

- #1389 (M1–M5), #1391 (M6) y #1390 (M7) mergeados con CI verde, conservando ancestry.
- M6: full10240/2omitidas,483archivos; Rust54; oráculo52/0; T20/T21 cerrados.
- M7: full10218/2omitidas,481archivos,1915.7s; Rust47 y seis audit verdes.
  Test del writer real usa Node24 transform-types; Bun no existe en Rustquality.

## Trabajo preservado (worktrees hermanos)

- `feat/0057-rust-e2-m8-tools` / `-rust-tools`: `4fed8109`, subido; PR aún no creado.
  Replay/fuzz/bench59focales y fast verdes. Full:10237verdes/2omitidas y timeout zsh300s,
  origen pendiente. No atribuirlo al diff ni declarar gate completo verde.
  Registro vacío y auditoría active Rust sin fixture válido fallan explícitamente.
- `feat/0057-rust-e2-m9-handler` / `-rust-handler`: `2e93d58a`, checkpoint WIP.
  Siete grupos verdes desde principal (11.77s):232corpus y148comparaciones shell locales.
  Perfiles jq/Node/sed, locale, UTF16 y overflow; serde_json raw_value/arbitrary_precision.
  Workspace/clippy finales y portabilidad Bash5/GNU-BSD pendientes. T26/A9 abiertos.
- `feat/0057-rust-e2-m9-shadow-runtime` / `-rust-shadow`: `75c65024`, checkpoint.
  Ocho shadow tests y36CLI verdes; fmt/clippy y revisión verdes. Callback puro, shell0/1/2
  autoritativo, transporte binario concurrente y EPIPE temprano. Sin wiring/registro/ledger.
- `-rust-hashes`: branch creada desde M6, vacía; no implementación ni agente asignado.

## Retomar

1. Resolver/validar timeout zsh de M8 y crear su PR con el comando ya entregado; mergear sólo
   con CI verde. T23–T25 siguen parciales hasta portes reales/audit activa/shadow log.
2. Cerrar workspace/clippy y portabilidad del handler; integrar handler y executor, hashes D8,
   registro y forced-native para comparar shadow sin devolver shell como resultado Rust.
3. D9 necesita contador técnico por invocación: sólo divergencias no prueba500/14d por engine.
   Fallos anómalos shadow usan D6 por engine; nunca1 universal (Claude fail-open).
4. M4 CONTRIBUTING sigue pendiente: escritura shell bloqueada y no reintentada.

No gates largos ni productores activos al checkpoint. Estimación comunicada:25% implementación,
22% cerrado por hitos; no equivale a hooks activos. Detalle y evidencia en progress/history.md.
