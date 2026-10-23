# Sesión actual

Checkpoint de `0057-migracion-rust` hasta E2/M5 en `feat/rust-0057-avance-m5`.
Destino del PR solicitado por el usuario: `migration/rust`, creado desde la base original
`72908547` para incluir todo el avance M1–M5 en el diff. Ejecución directa sin subagentes.

## Estado y siguiente paso

- E1/M1–M3 completos localmente; versión, parser/delegación, oráculo y serializador JS.
- E1/M4: CI, controles e instalación implementados. CONTRIBUTING en tres idiomas y CI remoto
  pendientes; el hook bloqueó la escritura shell de las guías y no se reintentó.
- E2/M5: runner e integridad implementados y probados como bibliotecas.
- Siguiente: E2/M6 (T20/T21), integración CLI/renderer, escritura final y fallback seguro.
  No hay hooks Rust activos; mantener el manifiesto sin hooks hasta T26 en sombra.
- Aviso opcional de `NAVORI_TS_CLI` inexistente: no implementado.

## Verificación

`bun check`: exit 0, 10,218 aprobadas, 2 omitidas, 481 archivos; cobertura sobre el piso.
El fallo Pi #1386 anterior no se reprodujo.
Oráculo posterior a M5: 52 casos, 0 diferencias.
Antes de publicar: `bun run check:fast`, Cargo fmt/clippy/workspace tests verdes;
instalación local comprobó que `navori` conserva ruta y SHA-256.

El oráculo de integridad escapa U+2028/U+2029 solo en el transporte JSONL hacia Node;
JSON.parse recupera los caracteres originales para comparar. Tiene regresión determinista.
