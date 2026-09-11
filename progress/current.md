# Sesión actual

**Estado:** **0.8.4 preparado y verde en el PR #671**, sin mergear. El código de #669 ya está
en `main` (`9232093`), con sus cuatro fixes verificados **por contenido**, no solo por el
título del commit. **1 issue**: #661 (tool-mix), abierto a propósito.

## Dónde quedó todo

Ver `progress/history.md`, entradas del 2026-09-10. No se repite aquí.

Resumen de una línea: **el `audit` registraba bien y sumaba mal**; los cuatro números que
mentían están corregidos en #669, y la auditoría dejó 16 hallazgos más priorizados.

## Lo primero al retomar

1. **Cerrar el release 0.8.4.** El PR #671 está verde (`quality pass`, 1m42s) y el tarball
   verificado con `npm pack --dry-run`: `navori-0.8.4.tgz`, 161 archivos, 158 assets, el
   binario reporta `0.8.4`. Faltan tres pasos **en este orden**: merge de #671 → tag `v0.8.4`
   sobre el merge commit → `npm publish` desde `packages/cli`. El re-render del espejo ya va
   dentro del PR (46 archivos, +74/−74, pura estampa de versión).

   **`npm whoami` devuelve 401**: la sesión de npm está deslogueada y `npm login` es
   interactivo, así que ese paso lo corre Ulises.

2. **El working tree quedó sucio a propósito.** `docs/inspiration.md` (+109) está en un stash
   —`docs/inspiration.md fuera de ciclo (pre-release 0.8.4)`— para poder cambiar de branch
   durante el release; los dos untracked de `docs/research/` siguen en disco. Los tres son de
   otro ciclo y quedaron fuera de todo commit por diseño. Decidir qué se hace con ellos.

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
