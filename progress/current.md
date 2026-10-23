# Sesión actual

Programa Rust (specs 0057–0060). Base remota estable: `migration/rust`; branches por spec/entrega
y PR hacia esa base por instrucción del usuario. Paralelismo con clones autorizado.

## Trabajo activo

- PR1389: checkpoint M1–M5, abierto como draft contra migration/rust; todos los checks
  requeridos y los seis jobs Rust verdes. No se ha mergeado.
- M6: `feat/0057-rust-e2-m6`, worktree principal. Entrada CLI de hooks y emisión segura en Rust;
  renderer compartido con firma exacta, selección de inventario y fallback. Registro/manifiesto
  productivo siguen sin hooks. 62 focales TS y 54 pruebas Rust verdes, clippy/fmt verdes.
  Revisión cerró ownership/coexist/antirollback/markers/symlinks y stamp legacy sin wrapper.
  Full preliminar: roja del stamp y timeout doctor; fix focal verde, doctor aislado verde.
  Oráculo final 52/0. Full final verde:10240aprobadas/2omitidas,483archivos,1369.1s,piso162/0.
  Commitdf872f8c subido; draft pendiente de ejecución humana (request9698c747).
- M7: `feat/0057-rust-e2-m7-audit`, worktree hermano `navori-harness-wt-0057-rust-audit`.
  Clon implementa auditoría independiente: metadata y bridge best-effort al writer TS único,
  sin append directo ni wire IDs propios. Seis focales iniciales verdes, incluyendo shell+jq
  byte exacto y writer TS real. Workspace/clippy/fmt/fast y revisión verdes. Full: 10217 verdes,
  un timeout zsh300s; aislado 2/2 verde en166.7s sin cambiar límites. Commitd62f12e8 subido;
  creación draft pendiente de ejecución humana (request2dde538e). Full final en ejecución.
- M8: `feat/0057-rust-e2-m8-tools`, worktree hermano `navori-harness-wt-0057-rust-tools`.
  Replay/adapter Rust directo, bench wall-time y fuzz determinista: 57 focales y fast verdes.
  Registro vacío, defer y auditoría active sin fixture válido fallan explícitamente.
  T23–T25 siguen parciales hasta probar con portes reales; full de tools aún no iniciado.

## Contratos a conservar

- La firma file= está fuera del marker; prólogo dentro. Evita ciclo SHA1(marker)/SHA256(file).
- Un noop previo no autoriza cambios: JSON final pasa otra vez por versión/floor/force.
- No reabrir destinos skip/minimal ni reparar markers alterados al retirar wrappers.
- Zsh puede devolver0 al printf con stdout cerrado: redirección explícita >&1 detecta fallo.
- NAVORI_DELEGATED==pid da70 antes de toda ruta, incluido hook; descendiente legítimo difiere3.
- D12 y A7 antiguos son obsoletos: replay ignora flags Rust/audit/only y no tiene audit-writer.
  M7 preserva escritor TS único; aceptación debe probar metadata y bridge realmente.
- Hooks con extraVars/transform no reproducidas siguen shell; argumentos Claude con expansión
  conservan legacy para evitar doble evaluación. No activar hooks antes de sombra T26/D9.

## Siguiente paso

1. Cerrar full/oráculo de M6; marcar T20/T21 y publicar PR a migration/rust. Rama depende del
   checkpoint PR1389; no mergearlo ni tocar dev/main sin pedido.
2. Revisar y verificar M7 en su worktree, documentar corrección D12/A7, publicar PR separado.
3. M4 sigue pendiente solo de CONTRIBUTING (escritura shell bloqueada; no reintentada).
4. El host de Codex bloquea crear PRs por falta de consentimiento autenticado; preparar campos
   revisados/solicitud canónica y pedir ejecución humana si vuelve a ocurrir. No eludirlo.
