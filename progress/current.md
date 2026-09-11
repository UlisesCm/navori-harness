# Sesión actual

**Estado:** **0.8.4 publicado** — npm `latest: 0.8.4` (161 archivos, 1,568,540 bytes
desempaquetados, idéntico al `--dry-run`), tag `v0.8.4` sobre `e8b2c54`, `main` en `9dc556f`
con CI verde. **1 issue**: #661 (tool-mix), abierto a propósito.

Abierto: el PR de este ciclo (trigger del deploy del website + README + esta bitácora).

## Dónde quedó todo

Ver `progress/history.md`, entradas del 2026-09-10. No se repite aquí.

Resumen de una línea: **el release salió bien y no llegaba al sitio** — el footer del website
llevaba dos releases mostrando `v0.8.2` porque el filtro de `paths` del deploy no incluía el
manifest del CLI.

## Lo primero al retomar

1. **Verificar que el sitio quedó en 0.8.4.** Se disparó un `workflow_dispatch` manual del
   deploy; el arreglo durable (el manifest del CLI en el filtro de `paths`) va en el PR de este
   ciclo. Comprobación de un comando:

   ```bash
   curl -s https://ulisescm.github.io/navori-harness/ | grep -o 'font-mono">v[0-9.]*'
   ```

2. **El working tree sigue sucio a propósito.** `docs/inspiration.md` (+109) está en
   `stash@{0}` —`docs/inspiration.md fuera de ciclo (pre-release 0.8.4)`— y los dos untracked
   de `docs/research/` (`awesome-harness-engineering.md`, `claude-code-harness-lessons.md`)
   siguen en disco. Son de otro ciclo y quedaron fuera de todo commit por diseño. **Es la
   decisión más vieja pendiente**: ya sobrevivió a dos sesiones.

3. **Los reportes de la auditoría viven en `.claude/progress/` (gitignored)**, así que no
   viajan en git: `audit_consolidado_navori-audit.md` (síntesis), `audit_deep_navori-audit.md`
   (detalle con evidencia `file:line`) y `plan_navori-audit.md` (plan priorizado). Si se quieren
   durables, hay que moverlos.

## Lo que la auditoría dejó pendiente

Con los 4 altos ya shippeados en 0.8.4, el siguiente lote por orden de valor:

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

1. **Rollout de 0.8.4 al parque.** El 0.8.3 se rodó a 20 repos; 0.8.4 no se ha rodado a
   ninguno.
2. `bonum-webapp` tiene 43 archivos de `.claude/` trackeados, contra la convención de que en
   los repos `/bonum` el harness no se commitea. Puede ser deliberado; conviene decidirlo a
   propósito.
