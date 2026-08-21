# Sesión actual

**Estado:** release 0.6.0 **completado** y 6 issues cerrados. Quedan **2 ciclos en vuelo**
(#404 y #402: implementados y aprobados/en review, con el trabajo **sin commitear** en sus
worktrees) y **un `render` de auto-hospedaje pendiente** que ya no es cosmético.

## Lo primero al retomar: el `render` de auto-hospedaje

Seis PRs mergeados hoy tocaron assets managed, y el espejo renderizado de este repo
(`.claude/`) sigue en la versión vieja. **Ya no es solo prosa desalineada**: los scripts
renderizados `.claude/scripts/check-semgrep.sh` y `check-jscpd.sh` están en la versión de
#305 y **no traen el fix de portabilidad de #391/#413** (les falta el `nl=$'\n'`
pre-expandido). Es decir, los hooks que corren en ESTE repo siguen con el fail-open de zsh
que ya arreglamos en el core.

Un solo `navori render` recoge los seis cambios. **No hay ningún check de CI que detecte
ese drift** — candidato a issue (ver abajo).

## Los 2 ciclos en vuelo (worktrees con trabajo sin commitear)

- **#404** — aísla el store de backups de la suite. Worktree
  `.claude/worktrees/agent-a3f069e9fece3f819`, 7 archivos. Implementación DONE, review
  lanzada. Al retomar: leer `.claude/progress/review_issue404.md` en ese worktree y, si
  está `APPROVED`, cerrar con el pilot.
- **#402** — caché por contenido del gate de semgrep. Worktree
  `.claude/worktrees/agent-ada56c21ece4b93d7`, 2 archivos. Implementación DONE, review
  lanzada. Mismo procedimiento: `.claude/progress/review_issue402.md`.

⚠️ **No borres esos dos worktrees**: contienen el único ejemplar del trabajo.

## Hallazgo grave de #404 (verificado en `main`, afecta datos reales)

La suite de tests **ha estado borrando backups reales** del `~/.navori` del usuario.
`purgeOldBackups()` (`packages/cli/src/lib/backup.ts:161`) hace `rmSync` de todo lo que
pase de 30 días bajo el root activo, y ese root era el home real; los tests la invocan vía
`execute-plan`, `render` y `prose-harness`. El issue asumía que era solo basura acumulada
y que el riesgo llegaba con el tope por tamaño de #393 — falso: **la pasada por edad ya
borraba antes de #411**. El tope de 2 GiB solo agregó un segundo modo de pérdida.

Dato colateral: el store creció de 1696 a 1752 entradas **mientras se implementaba el fix**,
por otro agente corriendo la suite sin parchear en otro worktree. La fuga ocurría en vivo.

**Limpieza manual pendiente (decisión de Ulises, NO automatizada)**: de 1752 entradas,
1743 son fixtures de test y solo 9 son reales. El comando exacto con dry-run está en
`.claude/progress/impl_issue404.md` del worktree de #404. Ojo: `navori backup prune` **no**
sirve — borra por edad y se llevaría justamente los 9 backups reales viejos.

## Rollout 0.6.0: CONGELADO

Ulises pidió explícitamente **no hacer el rollout** a los repos onboardeados hasta que lo
indique. No proponerlo ni arrancarlo. Cuando toque, es per-repo (NUNCA `--all`) y con estos
avisos:

1. Drift gestionado esperado en el próximo render (guard, hook del gate, reviewer, pilot,
   8 lib-skills, y ahora los 6 cambios de hoy).
2. El guard es más estricto con el TEXTO del comando: un mensaje de commit que mencione un
   borrado recursivo de HOME se bloquea. La salida es `git commit -F <archivo>`.
   (Pasó de verdad al commitear #391: el pilot reformuló el mensaje, sin bypass.)
3. Heredado: los repos con `socket.io-client` necesitan `navori update` además de `render`.

## Issues abiertos

**Cerrados hoy:** #391, #392, #393, #398, #399, #400.

**Nuevo:** **#417** `priority:medium` — `AGENT_IDS` es lista fija y ya perdió a `auditor`;
el contrato de forma no lo valida. Verificado: no hay bug vivo, `auditor.md` cumple los 5
asserts; es cobertura ausente. Propuesta: derivar del directorio.

**Con alcance ya decidido (no re-litigar):** #375 (prosa→mecanismo, los 4 casos restantes),
#379 (solo mitad B), #378 (R1 exprés atado al diff), #377 (fan-out en fase 2 del intake),
#370 (asíncrono solo para cerrar).

**Auditoría de reprocesos, sin empezar:** #401 (ceremonia de memoria duplicada), #403
(allowlist derivado del config), #405 (backup proporcional al diff), #406
(`core/src/index.ts` muerto), #407 (ruta semgrep inexistente), #408 (bloque fantasma «?» en
doctor), #409 (`solution_*` fuera del contrato de handoffs).

**Testing:** #394 (golden snapshot), #395 (repos fixture), #396 (benchmark, NO gate de CI).

## Candidatos a issue detectados hoy (sin abrir)

1. **Drift de los scripts renderizados sin check de CI** — el caso que hoy dejó a este repo
   con hooks sin el fix de #391/#413. Es la clase de #392 pero para `.claude/scripts/`.
2. **Strings en español en `check-semgrep.sh` (líneas 65 y 136) y `check-jscpd.sh`** —
   contradicen la doctrina de #284/#295 (mensajes runtime de hooks en inglés).
3. **jscpd tiene el mismo patrón de rescan que #402** — el marcador es trasplantable casi
   tal cual (dispara solo en commit, así que ahorra menos).
4. **Otros directorios machine-global sin override**, misma clase que #404:
   `registry.ts` (`~/.navori/registry.json`), `workspace.ts`, `migrate.ts`,
   `global-config.ts`. Hoy los cubren mocks de `safeHomedir`, pero sin guard.
   `interactive-flows.test.ts:47` dice explícitamente que `migrate.ts` mueve archivos al
   `~/.navori/migrations` real.

## Gotcha de proceso aprendido hoy

**Editar el body de un PR puede romper el auto-cierre del issue.** Al reescribir el body de
#416 para documentar el delta se perdió la línea `Closes #399`, así que el merge no cerró el
issue; hubo que cerrarlo a mano. Si un pilot reescribe un body, debe conservar esa línea.

## Notas heredadas

- Reportes de la auditoría en `.claude/progress/`: `audit_wiring.md`, `audit_reprocesos.md`,
  `research_hooks_costo.md`, `research_cli_reprocesos.md`.
- La ruta de los repos Bonum en el `~/.claude/CLAUDE.md` global sigue desactualizada,
  `~/.navori/registry.json` conserva una entrada de prueba apuntando al scratchpad, y siguen
  pendientes los PRs del repo externo bonum-webapp (#639, #640, #559) más el rebind de
  SonarCloud.
