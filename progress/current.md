# Sesión actual

**Estado:** branch `fix/audit-cifras-y-sellado` en `4205a63`, **PR #669 abierto** contra `main`
(check `quality` recién lanzado al cerrar). **1 issue**: #661 (tool-mix), abierto a propósito.

## Dónde quedó todo

Ver `progress/history.md`, entrada del 2026-09-10 15:40. No se repite aquí.

Resumen de una línea: **el `audit` registraba bien y sumaba mal**; los cuatro números que
mentían están corregidos en #669, y la auditoría dejó 16 hallazgos más priorizados.

## Lo primero al retomar

1. **Verificar el check de #669 y mergearlo.** Si salió rojo, el sospechoso NO es la suite
   —el gate corrió verde sobre esos bytes exactos— sino `check:assets:ci`, el único paso
   exento del gate porque su `--strict` depende de tags que CI trae y un clon fresco no tiene.

2. **El working tree quedó sucio a propósito y NO se parqueó en `main`.** `docs/inspiration.md`
   (+110) y los dos untracked de `docs/research/` son de otro ciclo y quedaron fuera del commit
   por diseño. Decidir qué se hace con ellos antes de cambiar de branch.

3. **Los reportes de la auditoría viven en `.claude/progress/` (gitignored)**, así que no
   viajan en git: `audit_consolidado_navori-audit.md` (síntesis), `audit_deep_navori-audit.md`
   (detalle con evidencia `file:line`) y `plan_navori-audit.md` (plan priorizado). Si se quieren
   durables, hay que moverlos.

## Lo que la auditoría dejó pendiente

Con los 4 altos ya shippeados, el siguiente lote por orden de valor:

- **Quick wins (S/XS)**: M3 separar `logParseErrors` de `parseErrors` —hoy un log corrupto
  dispara `format-drift` del transcript, diagnóstico equivocado—; M4 acumular los parseErrors
  de transcripts de subagentes, que se descartan; M7 colapsar re-emisiones de `permission-mode`
  (el encabezado dice `auto:145` para una sesión que jamás cambió de modo); M9 leer solo
  `permissionMode`, porque la key `mode` ya pertenece a otro record del formato.
- **Con diseño**: M1 descontar Bash allow-listed de `classifier-round-trips` (hoy la sesión
  disciplinada que rutea todo por el wrapper aparece con el peor número); M2 carril "wrapper"
  en `tool-mix`, que hoy no ve tgrep; M5 canario de drift semántico —un rename de
  `message.usage` produce tokens 0 y CERO señales—; M6 anclar `findVerdict`, que hoy matchea
  "APPROVED" dentro de "NOT APPROVED".
- **Señales del host que el parser no consume**, por valor: `toolUseResult.agentId` (join
  exacto padre→subagente, mata el fallback posicional frágil), `isCompactSummary` (la
  compactación es invisible hoy y distorsiona `startupTokens`), `system/turn_duration`
  (latencia por turno), `attributionSkill` (resuelve "touched vs used"), y registrar la fase
  `PermissionDenied`. Todo vive en el mismo archivo que el parser ya recorre.
- **Limpieza**: B3 un solo `k()` (hoy triplicado con comportamiento divergente bajo 1000).

Decisiones humanas que la auditoría dejó abiertas: B2 (dos repos homónimos comparten carpeta
de audits y sus sesiones se mezclan), B6 (los prompts viajan en claro en el log y en su copia
junto al reporte — ¿nota de privacidad, `chmod 600`, o nada?), y si `MCP_HINTS` debe derivarse
de `.mcp.json` en vez de hardcodear codegraph+engram.

## Pendiente fuera de este repo

`bonum-webapp` tiene 43 archivos de `.claude/` trackeados, contra la convención de que en
los repos `/bonum` el harness no se commitea. Puede ser deliberado; conviene decidirlo a
propósito.
