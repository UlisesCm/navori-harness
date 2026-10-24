# Migración Rust — 2026-10-23

Base remota estable `migration/rust` en `51d4367c`; #1389/#1391/#1390 integrados con CI verde.
Clones paralelos y merge de PRs Rust con todos los checks requeridos verdes autorizados.
Comandos manuales por chat; no tarjetas. No activar hooks ni cortar TS.

## Entrega preparada

`feat/0057-rust-e2-m9-integration`, worktree hermano `-rust-integration`, subida en `01a83eae`
antes de este registro. Incorpora M8, handler, executor y hashes. Commits propios:
`96800fde` hashes D8, `7ba49a8f` dispatch, `d2ef3263` profundidad, `5518dedd` tooling.

- Workspace combinado desde principal:88/88, Node24 sin Bun en PATH. Formato y clippy verdes.
- Herramientas:63/63; fast final y precommits verdes. Revisión independiente sin hallazgos
  abiertos en el alcance. Handler:232 casos y149 comparaciones shell locales.
- Auto-shadow devuelve el shell una vez; Rust forzado evalúa nativo incluso descriptor shadow.
  Integridad/cwd preceden stdin; cwd eliminado difiere3; lectura fallida usa D6 por engine/evento.
- Error de profundidad consumido ya no se convierte en Null/Permit: Failure→Claude ask/Pi2.
  Es un fix seguro, no paridad exacta de esa entrada. Límites de recursión conservados.
- Hashes coinciden con Node, orden UTF16 y bytes/NUL; watches detectan add/remove/edit.
  Original `feat/0057-rust-e2-m9-hashes` conserva `b84c7433`, subido.
- Registro y manifiesto productivos vacíos. A9 real falla explícitamente por auditoría activa;
  con `--audit off`, por registro vacío. T23–T26/A8/A9 siguen abiertos.

PRs M8/M9 aún sin crear al consultar GitHub. Cuerpos ignorados preparados:
`-rust-tools/.navori/state/m8-pr.md`, `-rust-integration/.navori/state/m9-pr.md`.
El hook exige creación humana; comandos completos ya entregados en chat, sin reintentar deny.
M9 incorpora ancestry M8; integrar M8 primero cuando ambos existan. No declarar shipping verde.

## Verificación en curso

M8 sigue en `4fed8109`/`-rust-tools`. Full anterior:10237 verdes/2 omitidas y timeout zsh300s.
Focal nuevo:2/2,162.56s. Origen no determinado; fuente/timeout intactos.
Nuevo `NAVORI_TEST_WORKERS=1 bun check` iniciado17:55CST, exec session54824 aún en ejecución
al registrar18:21CST. Log: `-rust-tools/.navori/state/m8-full-resume.log`. No arrancar otro full
pesado antes de recuperar su resultado. Full sobre diff final M9 también pendiente.

## Siguiente paso

Recuperar gate M8 y CI tras creación humana; merge sólo con checks verdes sobre SHA exacto.
Cerrar perfil de elegibilidad antes de stdin y portabilidad Bash5/GNU; prueba Docker bloqueada
por guard, sin ejecutar contenedor ni buscar alternativa. No asumir JqAndNode/Utf8 por defecto.
Para D9, evaluar writer CLI con primitivas privadas `audit/paths.ts`: ledger técnico por
invocación/engine sin payload en matches, payload sólo divergencias; esquema/identidad aún pendientes.
Faltan registro/manifest, fixtures active y evidencia500/14d por engine antes de activar.
CONTRIBUTING M4 pendiente por bloqueo previo. Detalle histórico en progress/history.md.
