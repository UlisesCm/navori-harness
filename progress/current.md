# Migración Rust — 2026-10-23

Base remota estable `migration/rust` en `51d4367c`; #1389/#1391/#1390 integrados con CI verde.
Clones paralelos y merge de PRs Rust con todos los checks requeridos verdes autorizados.
Comandos manuales por chat; no tarjetas. No activar hooks ni cortar TS.

## Entrega preparada

`feat/0057-rust-e2-m9-integration`, worktree hermano `-rust-integration`, PR #1393 draft
contra `migration/rust`, head publicado `18235009` antes del fix portable. Incorpora M8,
handler, executor y hashes. Commits propios:
`96800fde` hashes D8, `7ba49a8f` dispatch, `d2ef3263` profundidad, `5518dedd` tooling.

- Workspace final desde principal:98/98, Node24 sin Bun en PATH; paquete hooks30/30.
  Formato y clippy workspace/all-targets con warnings como errores verdes.
- Herramientas:63/63; fast final y precommits verdes. Revisión independiente sin hallazgos
  abiertos en el alcance. Handler:232 casos y149 comparaciones shell locales.
- Auto-shadow devuelve el shell una vez; Rust forzado evalúa nativo incluso descriptor shadow.
  Integridad/cwd preceden stdin; cwd eliminado difiere3; lectura fallida usa D6 por engine/evento.
- Error de profundidad consumido ya no se convierte en Null/Permit: Failure→Claude ask/Pi2.
  Es un fix seguro, no paridad exacta de esa entrada. Límites de recursión conservados.
- Hashes coinciden con Node, orden UTF16 y bytes/NUL; watches detectan add/remove/edit.
  Original `feat/0057-rust-e2-m9-hashes` conserva `b84c7433`, subido.
- Fix portable: clases explícitas BSD24/GNU21/C6; NEL excluido en BSD (libc local confirmado).
  CaptureContext aporta dialecto, pathbytes y líneas: Bash5 advierte por captura raw y cada
  fallback individual con NUL, sin duplicar caché. Ocho regresiones NUL; stderr exacto.
- Registro y manifiesto productivos vacíos. A9 real falla explícitamente por auditoría activa;
  con `--audit off`, por registro vacío. T23–T26/A8/A9 siguen abiertos.

El usuario creó https://github.com/UlisesCm/navori-harness/pull/1393. M8 no tiene PR separado;
su ancestry está incluida en1393. No reintentar creación bloqueada. Mantener draft hasta
resolver todos los checks y pendientes de cierre; no activar registry por CI verde.

## Verificación

M8 `4fed8109`/`-rust-tools`: full final exit0,10238 verdes/2 omitidas,482 archivos,2281.8s;
cobertura87.83/86.15/90.46/80.94%, floor160/0. Un worker; origen del timeout previo no determinado.
Exec54824 completado. Log: `-rust-tools/.navori/state/m8-full-resume.log`.
1393/head18235009: cuatro shards JS y test-merge verdes; también oracle/manifest/freshness/
tarball/install/checks. Sólo quality falló cuatro tests GNU/NUL; fix local98/98 pendiente push/CI.
Log root workspace final: `-rust-integration/.navori/state/m9-portability-workspace.log`.

## Siguiente paso

Subir fix portable y recuperar CI1393; merge sólo con checks verdes sobre SHA exacto.
Cerrar perfil de elegibilidad antes de stdin; el contexto del handler es explícito, no selección
automática. Docker bloqueado previamente, sin más intentos. No asumir JqAndNode/Utf8 por defecto.
Para D9, evaluar writer CLI con primitivas privadas `audit/paths.ts`: ledger técnico por
invocación/engine sin payload en matches, payload sólo divergencias; esquema/identidad aún pendientes.
Faltan registro/manifest, fixtures active y evidencia500/14d por engine antes de activar.
CONTRIBUTING M4 pendiente por bloqueo previo. Detalle histórico en progress/history.md.
