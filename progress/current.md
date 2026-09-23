idle

Último ciclo: auditoría del área search v2 (tgrep + codegraph). Sin código editado, sin PR — seis
issues abiertos y un arreglo de infraestructura fuera del repo. Detalle completo en
`progress/history.md` (entrada 2026-09-22 20:40). Reportes en `.claude/progress/`
(gitignored, referencia local): `audit_deep_{prosa-search-v2,tests-search-v2,codegraph}.md` y
`scout_{v1_vs_v2,uso_search_tools}.md`.

Issues abiertos por este ciclo, todos sin empezar:
- **#943** `doctor` no detecta el índice obsoleto de tgrep (bug/high/cableado). El comentario del
  issue fija la forma: scan hermano de `scanOtelReceiver`, NO dentro de `scanMissingExternalTools`.
- **#944** la prosa de tgrep conflaciona índice ausente con índice obsoleto (bug/high/docs).
- **#945** el ruteo manda a CodeGraph preguntas sobre `.md`/`.sh`/`.json`, que no indexa
  (bug/high/docs). Incluye el gap de `maxFiles`, ausente de los dos bloques.
- **#946** falta el test de "índice en disco + mutación + sin server" (tests/high).
- **#947** D19 da 7.3% contra umbral de 25% (tech-debt/high). **Tiene fecha**: la ventana cierra
  ~2026-09-30; hay que correr el instrumento y registrar en `docs/research/search-v2-results.md`.
- **#948** el presupuesto de arranque no cuenta lo que inyectan los MCP (bug/medium).

#944 y #945 tocan prosa managed con el presupuesto al límite (`AGENTS.md` al 82% del cap de Codex):
deben reescribir, no sumar. #944 además debe conservar las cadenas `tgrep search` y `--no-index`, o
rompe el invariante declarado en `packages/plugins/tgrep/plugin.json`.

Fuera del repo, ya hecho y verificado: LaunchAgent
`~/Library/LaunchAgents/com.ulisescm.tgrep-serve.navori-harness.plist` mantiene `tgrep serve` vivo
(PPID 1, watcher nativo). Sin él, las búsquedas textuales de este repo vuelven a mentir.

Arrastrados de ciclos anteriores, sin resolver:
- Abrir issue por la colisión en `dist/` descubierta en PR #912 (`vitest.globalSetup.ts` ->
  `bun run build` bajo concurrencia).
- #908 (techo de CLAUDE.md agotado) — otra sesión lo tenía en curso.
- Observación cosmética no bloqueante: comentario desactualizado en
  `guard-destructive.test.ts:1200-1204` ("5s budget" tras subir a 8000).
- Pendiente de decisión del usuario (de #891): abrir issue por el conflicto de merge en
  `progress/current.md` cuando corren dos sesiones en paralelo sobre la misma raíz.
