# Sesión actual

**Estado:** idle. Todo lo trabajado está mergeado en `main` (`2ac67db`). Sin PRs
abiertos ni branches en vuelo.

## Qué se cerró

**Los 8 issues con los que abrió la sesión** (#331, #333-#338, #340): 6 cerrados con PR
mergeado, y #333/#336 con lo viable implementado — sus partes principales quedaron
argumentadas como "no aplica" y comentadas, esperando decisión de cierre.

7 PRs mergeados: **#343** (#340) · **#346** (higiene) · **#347** (#331) · **#349**
(#344, #348) · **#351** (#334, #335) · **#353** (#337, #338) · **#355** (#352).
**#321** cerrado por obsoleto.

## Pendiente de decisión tuya (6 issues, todos con análisis y recomendación)

1. **[#333](https://github.com/UlisesCm/navori-harness/issues/333)** y
   **[#336](https://github.com/UlisesCm/navori-harness/issues/336)** — lo viable ya entró
   en #351. Falta decidir si se cierran: sus partes principales **no aplican** (navori no
   escribe `package.json`, y un `.semgrep.yml` sería inerte porque `check-semgrep.sh` pasa
   un único `--config`). Comentados con la evidencia.
2. **[#354](https://github.com/UlisesCm/navori-harness/issues/354)** (`priority:medium`,
   destapado por el reviewer de #352) — el hook lee **solo el primer receipt** que
   encuentra, así que uno stale en `.claude/` eclipsa al vigente en `.codex/` y el drift
   pasa. Reproducido. En ese issue quedaron anotados otros tres sitios con la misma causa
   (`placeHook` no retargetea): `subagent-stop-handoff.sh:35`, cuatro skills del core que
   contradicen a los agentes sobre la ruta de efímeros bajo Codex, y
   `EPHEMERAL_HARNESS_PATHS` sin `.codex/progress/` — la misma omisión que causó #348, en
   la constante que #348 creó para evitarla.
3. **[#342](https://github.com/UlisesCm/navori-harness/issues/342)** (`-w` en el receipt) →
   hacer **antes** que #341: el delta re-sign necesita poder diffear contra lo firmado.
   ~7 líneas, y solo sirve si además el aborto emite `git diff <blob> <file>`.
4. **[#341](https://github.com/UlisesCm/navori-harness/issues/341)** → opción 4 (delta
   re-sign formalizado) **+ reescribir la Regla A**: su promesa actual es falsa mientras
   exista el byte-gate. El ahorro real es no gastar un `implementer`, no saltarse al reviewer.
5. **[#345](https://github.com/UlisesCm/navori-harness/issues/345)** y
   **[#350](https://github.com/UlisesCm/navori-harness/issues/350)** — `priority:low`.
   #345 resultó no ser bug (reetiquetado): la recomendación es documentar
   `project.libraries` como campo derivado, no construir el merge.

## Deuda operativa

- **`~/.navori/backups` sigue en 131 GB** (6873 backups). El fix de #348 detiene el
  crecimiento — el backup del render pasó de 4.2 GB a 360K — pero lo acumulado hay que
  borrarlo a mano: `rm -rf ~/.navori/backups` (la capa de permisos del harness lo bloquea
  desde el agente, tiene que correrlo Ulises). navori recrea el directorio solo.
- **Release + rollout** a los repos registrados, per-repo (NUNCA `--all`). Hay mucho
  acumulado desde 0.5.1: #340, #331, #344, #348, #334, #335, #337, #338.
  Nota heredada: los repos con `socket.io-client` necesitan `navori update` además de
  `render` para migrar `socketio` → `socketio-client`.
- **Heredado de sesiones previas** (repo externo bonum-webapp): publicar el comentario del
  PR #639, cerrar #640 y #559, y el rebind de SonarCloud (requiere admin).

## Notas

- Follow-ups anotados y no abiertos como issue: `adapter.ts:31` tiene un `backupTargets`
  muerto con `.claude` sin `backupExclude` — copia viva de la forma que arregló #348;
  `summarizeTrigger` corta la descripción en el primer `" — "`, por eso `dominio` aparece
  truncada como *"Use when you discover"* en el índice always-on de cada sesión; y
  `statusCheckRollup` es una unión de tipos — `StatusContext` (Vercel, CircleCI, Jenkins)
  trae `targetUrl` y no tiene run id, así que el paso 3 de `babysit-prs` asume Actions.
- La ruta de los repos Bonum en el `~/.claude/CLAUDE.md` global sigue desactualizada: dice
  `/Users/ulisescm/Documents/dev/bonum/`, la real es `/Users/ulisescm/Documents/Dev - Docs/bonum/`.
- `~/.navori/registry.json` conserva una entrada de prueba apuntando a
  `.../scratchpad/inherit-test`.
