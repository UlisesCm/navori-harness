# Sesión actual

**Estado:** idle. `main` limpio y al día. 11 issues abiertos, **todos con su alcance
ya decidido** — ninguno espera una decisión.

## El siguiente paso es el release 0.6.0

`packages/cli/package.json` dice `0.6.0`, pero el último tag es `v0.5.1` y npm sirve
`0.5.1`. Falta: tag → `gh workflow run deploy-website.yml` → `npm publish` (manual,
OTP de Ulises). El render de auto-hospedaje ya se hizo (#388), así que el repo no va
una versión atrás del paquete que publica.

**Qué avisar en el rollout** (per-repo, NUNCA `--all`):

1. Los assets managed cambiaron bastante —guard, hook del gate, reviewer, pilot, 8
   lib-skills—, así que los repos onboardeados verán drift gestionado en su próximo
   render. Es esperado.
2. **El guard es más estricto con el TEXTO del comando**: un mensaje de commit por
   heredoc que mencione un borrado recursivo de HOME se bloquea. La salida es
   `git commit -F <archivo>`.
3. Heredado: los repos con `socket.io-client` necesitan `navori update` además de
   `render` para migrar `socketio` → `socketio-client`.

## Los 11 issues abiertos, por tanda

**Post-release, con la decisión ya tomada** (cada uno tiene el alcance acordado como
comentario en el issue — no re-litigar):

- **#375** prosa→mecanismo: los 4 casos restantes, derivando de `project.criticalAreas`
  y `qualityGate`.
- **#379** solo la mitad B (tabla señal→mecanismo). **La mitad A se rechazó**: el
  fan-out es always-on precisamente porque es lo que hace que se use.
- **#378** R1 exprés con la exención atada al **diff** (R1 + una tarea + no toca áreas
  críticas), no al juicio del agente. `mem_save` e `history.md` se quedan si hubo commit.
- **#377** fan-out en fase 2 del intake con criterio enumerado (2+ repos, o cruza
  frontend/backend, o módulos sin dependencia).
- **#370** modo asíncrono **solo para cerrar** (`blocked`, `already-solved`,
  `cant-reproduce`, `works-as-intended`, `needs-splitting`). El gate humano se conserva
  para `proceed`.

**Testing más real** (abiertos esta sesión, ordenados por costo/beneficio):

- **#391** `priority:high` — correr los hooks bajo **zsh** además de bash. Reincidencia
  comprobada: #344 y el camino 3 de #365 fueron word-splitting que zsh no hace.
- **#392** `priority:high` — que ningún asset renderizado cite una ruta inexistente.
  Cuatro hallazgos de esa clase: #352, #364 A, #364 B, #389.
- **#394** `priority:medium` — golden snapshot por engine (con las tres mitigaciones
  de ruido escritas en el issue; sin ellas, no vale la pena).
- **#395** `priority:low` — repos fixture (o generadores declarativos, la alternativa
  barata que propone el propio issue).
- **#396** `priority:low` — benchmark de comportamiento del agente. **No es gate de
  CI**: es no determinista, y un check no determinista en el gate enseña a ignorar el
  gate (el error que cometió el backstop del receipt).

**Infraestructura:**

- **#393** `priority:high` — el crecimiento en disco no tiene tope ni vigilancia: la
  purga de backups mira solo los 30 días (nunca el tamaño) y solo corre cuando algo
  crea un backup; los worktrees de agente no tienen dueño.

## Notas

- **`.claude/worktrees/` de este repo: 4.2 GB → 0**, 15 worktrees eliminados tras
  verificar `dirty=0` y que su contenido estaba en `main`. **`git merge-base
  --is-ancestor` no sirve para esa verificación**: con squash-merge da `NO-MERGED` en
  branches que sí shippearon. Lo que sirvió fue cruzar cada branch contra su PR.
  Las 15 branches locales siguen existiendo (refs, no pesan).
- `~/.navori/backups`: 122 MB en 1,192 entradas. Sano en tamaño, pero el conteo crece
  rápido (un backup por `render --apply`) y nada lo acota salvo los 30 días → #393.
- Heredado: la ruta de los repos Bonum en el `~/.claude/CLAUDE.md` global sigue
  desactualizada, `~/.navori/registry.json` conserva una entrada de prueba apuntando
  al scratchpad, y siguen pendientes los PRs del repo externo bonum-webapp (#639,
  #640, #559) más el rebind de SonarCloud.
