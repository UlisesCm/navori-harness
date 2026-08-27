# Sesión actual

**Estado:** `idle`. `main` en `90bd0ad`, working tree limpio, **3 issues / 0 PRs**, sin worktrees.
Tests **2716 → 2730**. `navori@0.6.3` publicado en npm, tags `v0.6.2` y `v0.6.3` creados.

## SIGUIENTE PASO: decidir si se publica 0.6.4

El fix de #528 está en `main` pero **no en npm**, así que arrastra el problema que él mismo arregla:
el punto entero era alcanzar a los 19 repos ya onboardeados, y no los alcanza hasta que se publique.
Es la misma trampa que dejó a 0.6.2 sin propagar durante un día.

Contra publicar ya: 0.6.3 salió hace menos de una hora. A favor: sin publicar, el fix no hace nada.

Proceso: bump `packages/cli/package.json` → `render:apply` + `test:golden` → gate → PR → tag →
`npm publish` (manual, OTP de Ulises).

## Rollout: casi todo el parque está dos releases atrás

| Dónde | Versión | Se saltaron |
|---|---|---|
| 15 repos Bonum (+14 worktrees `wt-*` de webapp) | **0.5.1** | 0.6.0 → 0.6.3 |
| `moonar-medusa-monorepo`, `navori-health` | **0.5.1** | idem |
| 3 repos de `/navori` | 0.6.2 | los 5 del rollout |
| `navori-harness` | 0.6.3 | — |

Lo que 0.5.1 no tiene incluye los 4 fixes de seguridad (#495, #506, #509–#511) y los 4 de pérdida de
datos (#496–#498, #504). Es riesgo del **agente operando** en esos repos, no del código de producción.

## Issues abiertos (los tres salieron del chat, no de una auditoría)

- **#527** — un hook que reclame el worktree del agente al terminar. Hoy la única vía es que el
  orquestador lea la línea `worktree:` del pilot y pregunte; si la sesión se corta, el worktree se
  queda para siempre (la limpieza del 25 encontró 27 / ~2.6 GB). El criterio de seguridad es lo
  difícil: **squash merge no deja ancestría**, así que `--is-ancestor` responde "no mergeado" para
  ramas que shipearon hace días.
- **#529** — `testsForNewCode` existe pero es preguntado, no derivado (este repo ni lo declara), y es
  un interruptor global sin noción de suite. Ulises quiere unitarios sí y los flows de **Maestro**
  (`.maestro/flows/*.yaml` en `alertaciudadana_app`) no. `legacyPaths` no sirve: dice "código
  congelado", no "suite que no cuenta".
- **#530** — el harness asume las tools nativas. En auto mode todo pasa por Bash: `Edit` falla
  ruidosamente y `sed -i` no, las reglas `allow`/`deny` sobre Edit/Write dejan de aplicar, y
  `guard-destructive` no cubre `sed -i`, `>` ni `tee` sobre archivos managed.

## Pendientes de Ulises (no bloquean navori)

- **3 issues de seguridad** abiertos en sus repos: `alertaciudadana_app#113` (PII y CURP a logcat en
  build release), `alertaciudadana_backend#148` (un reporte fuera de zona queda invisible para toda
  autoridad), `navori-dashboard-template#53` (overview sin `requireRole`).
- **En el backend aparecieron 5 más el 27-08 a las 00:03**, dos críticos: `#151` (el worker borra
  registros de `Multimedia` ante cualquier 404 de S3, `NoSuchBucket` incluido) y `#150` (~1 mes de jobs
  encolados en BullMQ que se ejecutarán al reactivar el worker). Si están vivos, pesan más que el rollout.
- `navori-dashboard-template` declara `branchBase: main` pero el flujo real es `dev`.
- WIP de `fix/adapter-pattern-82` (app) en `stash@{0}`; `docs/status-enum-truth-144` (backend) con 1
  commit sin publicar.

## Hechos verificados esta sesión (no re-investigar)

- **`check:assets` resuelve la versión publicada con `latestTag()`, no con npm.** Un release sin tag lo
  deja comparando contra una versión vieja y avisando de subcomandos que ya se publicaron.
- **`ensurePrettierIgnore` solo se llamaba desde `init.ts`**; ni `update` ni `render` ni `doctor` la
  tocaban. El hermano `gitignore-harness` sí tiene sus dos consumidores (`doctor.ts:19`,
  `render.ts:21`) — esa asimetría era el bug.
- **Este repo corre biome, no prettier**, así que `render` no se crea `.prettierignore` a sí mismo y
  `check:render` sigue en 0 pending.
- **Las sesiones no crean worktrees**; los crea el host al lanzar subagentes aislados. `commit-pr-pilot`
  tampoco: corre *dentro* de uno y solo reporta si es seguro removerlo.

## Notas heredadas

- `~/.navori/backups` acumula fixtures de test históricos. **Filtrar por prefijo, no por edad.**
- La ruta de los repos Bonum del `~/.claude/CLAUDE.md` global está desactualizada; siguen pendientes los
  PRs de bonum-webapp (#639, #640, #559) y el rebind de SonarCloud.
- **`gh pr create` inmediatamente tras el push a veces no encola el evento**: CI no arranca. Lo reemiten
  `reopened` o `synchronize`. (Esta sesión sí arrancó solo en los dos PRs.)
- **`vitest` corre `tsup` en `globalSetup` y ese build limpia `dist/`**: no correr dos suites concurrentes.
- **La carga de daemons de macOS** dispara `Test timed out in 15000ms` en masa. Usar `--testTimeout=90000`.
