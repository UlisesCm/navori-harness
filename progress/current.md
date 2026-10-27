# Migración Rust — 2026-10-23

Base estable `migration/rust` en `73fa052f`. #1389/#1391/#1390/#1393 integrados con CI verde.
Usuario autoriza PRs por entrega y merge sólo con todos los checks requeridos verdes sobre SHA
exacto. Desde la última instrucción: principal + UN SOLO clon activo, sin crear más productores.
Comandos manuales por chat, nunca tarjetas. No activar hooks ni cortar TS.

## Integrado

#1393 incorporó ancestry M8, handler puro, hashes D8, executor/dispatch shadow y perfiles
BSD24/GNU21/C6 con diagnósticos NUL explícitos. Último fix `bafb7db9`, merge `73fa052f`.
CI final:98 pruebas Rust;10265 JS, una omitida,484 archivos; cobertura87.91/86.2/90.6/80.95%,
piso162/0. M8 local completo10238/2,482files,2281.8s también verde. No hay gates largos vivos.
Registro/manifiesto productivos vacíos. T23–T26/A8/A9 siguen abiertos.

## Elegibilidad — preparada para PR

Worktree `-rust-eligibility`, branch `feat/0057-rust-e2-m9-eligibility`, base73fa052f.
Componente público collect(Request,cwd,Limits)→Prepared.evaluate, sin wiring en hook.rs.
Plan puro y reglas dentro de fuentes hasheadas D8; collector CLI sólo hechos del entorno.
Rechaza metadatos/env/locale no acreditados antes de probes; None y PreToolUse en Claude/Pi
admitidos, Codex/otros eventos/args rechazados. Claves duplicadas y modificadores se rechazan.
PATH y source lines exactos, sin asumir184; jq presente desconocido nunca es ausencia.
UnixStreams no bloqueantes, stdin null, presupuesto250ms/default y500ms/máximo,64KiB
combinados por probe; kill/reap del hijo directo ante fallo, sin prometer matar descendientes.
Evaluación preparada sigue pura, con Profile y CaptureContext del shell original.
Principal verificó107/107 workspace y fmt0; productor5+4focales/clippy0; revisión de código
independiente cerró jq patch, evento implícito, duplicate env y versiones Node mal formadas.
Sin dependencia nueva ni cambios al manifest/registry. R17/p95 de5ms no acreditado.

## Journal — en paralelo con el mismo clon

Worktree `-rust-journal`, branch `feat/0057-rust-e2-m9-shadow-journal`, base73fa052f.
Principal preparó contrato begin/complete privado y actualizó notas verificadas en tasks.md.
El único clon pasó de elegibilidad a implementar schema/library/tests del journal.
Datos sólo bajo .navori/state/rust-shadow: payload únicamente en divergencias; match sin payload.
Un begin sin complete debe impedir evidencia de cero divergencias. Report requiere impl actual
y engines esperados explícitos;500 observaciones completas/14d por engine, no datos sintéticos.
Prueba fs real confirmó pérdida de append si create escribe primera fila tras otro writer.
Por ello inicializar archivo vacío exclusivo y anexar TODAS las filas con O_APPEND.
Diseño ignored: journal/.navori/state/handoffs/design_0057_shadow_journal.json.

## Siguiente paso

Publicar elegibilidad, abrir PR con cuerpo/comando directo y verificar CI antes de merge.
Completar/revisar journal sin segundo clon; después integrar preflight/registro y fixtures de
auditoría activa. Ningún prepared profile ni test puro acredita A9 por sí solo.
CONTRIBUTING M4 sigue pendiente por bloqueo previo; no reintentar operaciones denegadas.
Estimación comunicada:≈30% implementación y≈22% cerrado por hitos; no equivale a hooks activos.
