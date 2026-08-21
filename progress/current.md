# Sesión actual

**Estado:** los 2 ciclos que quedaban en vuelo están **cerrados y mergeados**, el espejo del
harness está al día, y el tablero quedó ordenado. No hay trabajo a medias ni worktrees vivos.

## Lo que se cerró

- **#404** (aislamiento del store de backups) — PR #419 mergeado. **Verificado sobre datos
  reales**: la corrida de 1679 tests creó cero backups fixture en `~/.navori/backups`; la
  única entrada nueva del día fue la legítima del `render --apply`.
- **#402** (caché del scan de semgrep por huella de contenido) — PR #426 mergeado tras una
  segunda ronda que cerró el TOCTOU. Suite de 7 casos nueva; baseline `1679` → `1686`.
- **Render de auto-hospedaje** — PRs #420 (15 archivos, los 6 PRs de ayer) y el del script
  cacheado de #402. Los hooks de este repo ya corren con el fix de portabilidad de #391.

## Decisión pendiente de Ulises (no automatizar)

`~/.navori/backups` tiene **1865 entradas / 193 MB**, de las cuales solo **9 son reales**
(prefijo `navori-harness`); las otras 1856 son fixtures de test históricos
(`navori-agentsmd-*`, `navori-preset-engine-*`, `agent-*`). La fuga ya está tapada por #404,
esto es limpiar lo acumulado.

**El filtro seguro es por prefijo, no por edad.** `navori backup prune` borra por edad y se
llevaría justamente los 9 backups reales, que son los más viejos. El conteo de lo que sobra
se obtiene con `ls ~/.navori/backups | grep -v '^navori-harness-' | wc -l`.

## Rollout 0.6.0: CONGELADO

Ulises pidió explícitamente **no hacer el rollout** a los repos onboardeados hasta que lo
indique. No proponerlo ni arrancarlo. Cuando toque, es per-repo (NUNCA `--all`) y con estos
avisos:

1. Drift gestionado esperado en el próximo render (guard, hook del gate, reviewer, pilot,
   8 lib-skills, los 6 cambios de ayer y ahora el caché de semgrep).
2. El guard es más estricto con el TEXTO del comando: un mensaje de commit que mencione un
   borrado recursivo de HOME se bloquea. La salida es `git commit -F <archivo>`.
3. Heredado: los repos con `socket.io-client` necesitan `navori update` además de `render`.

## Issues abiertos

**Nuevos de esta sesión:**

- **#421** `priority:high` — CI no detecta que el espejo renderizado quedó viejo. Es el caso
  que dejó a este repo con los hooks sin el fix de #391. `render --json` ya responde la
  pregunta; falta que CI la consulte.
- **#424** `priority:high` — los otros 5 directorios bajo `~/.navori` (`registry`,
  `global-config`, `workspaces`, `migrations`, `.trash`) no tienen el guard de suite que
  #404 construyó para backups. Misma forma que tenía #404 antes de estallar.
- **#422** `priority:low` — 3 strings de runtime en español (`check-semgrep.sh:67`,
  `check-jscpd.sh:68` y `:72`). **Depende de nada ya**: #402 mergeó, pero su test asserta
  sobre el string en español, así que hay que actualizarlo en el mismo commit.
- **#423** `priority:low` — jscpd sin caché por contenido. **Medir antes**: si el ahorro no
  lo justifica, cerrarlo como `wontfix` con la medición adjunta.
- **#425** `priority:low` — falta el test del marcador por worktree del caché de semgrep.

**Con alcance ya decidido (no re-litigar):** #375 (prosa→mecanismo, los 4 casos restantes),
#379 (solo mitad B), #378 (R1 exprés atado al diff), #377 (fan-out en fase 2 del intake),
#370 (asíncrono solo para cerrar).

**Auditoría de reprocesos, sin empezar:** #401 (ceremonia de memoria duplicada), #403
(allowlist derivado del config), #405 (backup proporcional al diff), #406
(`core/src/index.ts` muerto), #407 (ruta semgrep inexistente), #408 (bloque fantasma «?» en
doctor), #409 (`solution_*` fuera del contrato de handoffs).

**Testing:** #394 (golden snapshot), #395 (repos fixture), #396 (benchmark, NO gate de CI),
#417 (`AGENT_IDS` es lista fija y ya perdió a `auditor`).

## Gotchas de proceso vigentes

- **Editar el body de un PR puede romper el auto-cierre del issue.** Al reescribir el body de
  #416 se perdió la línea `Closes #399` y el merge no cerró el issue. Si un pilot reescribe
  un body, debe conservar esa línea.
- **En zsh, `$0` dentro de una función es el nombre de la función**, no la ruta del script.
  Leerlo dentro de una función habría apagado el caché de semgrep en silencio solo bajo zsh.
- **El `||` del llamador suprime errexit dentro de la función llamada.** Por eso cada
  `git hash-object` de la huella lleva `|| exit 1`: sin él, un hash fallido produciría una
  huella sobre una receta incompleta en vez de degradar a "sin caché".

## Notas heredadas

- La ruta de los repos Bonum en el `~/.claude/CLAUDE.md` global sigue desactualizada,
  `~/.navori/registry.json` conserva una entrada de prueba apuntando al scratchpad, y siguen
  pendientes los PRs del repo externo bonum-webapp (#639, #640, #559) más el rebind de
  SonarCloud.
