# Sesión actual

**Estado:** `idle`. `main` en `5c7c6fe`, working tree limpio, **0 issues / 0 PRs**, sin worktrees.
`navori@0.6.4` publicado en npm. Tests **2716 → 2787**. Tags `v0.6.2`, `v0.6.3` y `v0.6.4`.

## SIGUIENTE PASO: el rollout

Todo lo de esta jornada ya está en npm, así que por primera vez en dos días no hay nada atrapado entre
`main` y el registro. Lo que falta es que los repos lo reciban.

| Dónde | Versión | Se saltaron |
|---|---|---|
| 15 repos Bonum (+14 worktrees `wt-*` de webapp) | **0.5.1** | 0.6.0 → 0.6.4 |
| `moonar-medusa-monorepo`, `navori-health` | **0.5.1** | idem |
| 3 repos de `/navori` | 0.6.2 | los 5 del rollout + esta jornada |
| `navori-harness` | 0.6.4 | — |

Lo que 0.5.1 no tiene incluye los 4 fixes de seguridad (#495, #506, #509–#511) y los 4 de pérdida de
datos (#496–#498, #504). Es riesgo del **agente operando** en esos repos, no del código de producción.

Método que funcionó la vez pasada: uno a uno, `doctor` → `render --apply` → `doctor`, verificando
**contra las ramas base**, no contra la copia local.

## Lo que se hizo hoy

**Dos releases y 4 issues cerrados**, todos con CI verde:

| PR | Qué |
|---|---|
| #526 | Release 0.6.3 (los 5 fixes del rollout, atrapados un día en `main`) |
| #528 | #523 alcanza a los repos ya onboardeados: `render` aplica, `doctor` detecta |
| #532 | #530 — auto mode: regla 6 del guard + el primer `PostToolUse` del harness |
| #533 | #529 — `testsForNewCode` derivado + `testsExclude` |
| #534 | #527 — hook `SessionEnd` que reclama worktrees |
| #535 | Release 0.6.4 |

## El patrón de la jornada

> Una salvaguarda cableada en `init` no protege a nadie que ya esté onboardeado, y **la asimetría con su
> módulo hermano es lo que la delata**: `gitignore-harness` tenía dos consumidores (doctor escanea,
> render aplica) y `prettierignore-harness` tenía cero.

Cuando un módulo mantiene un archivo del usuario, la pregunta de review no es "¿existe la función?" sino
**"¿quién la aplica en cada ciclo y quién detecta que falta?"**.

## Hechos verificados (no re-investigar)

- **`check:assets` resuelve la versión publicada con `latestTag()`, no con npm.** Un release sin tag lo
  deja comparando contra una versión vieja y avisando de subcomandos que ya se publicaron.
- **`find -newer` tiene resolución de 1 segundo** en el filesystem del runner de CI. Cualquier detección
  basada en mtime pierde escrituras dentro del mismo segundo. Comparar contenido cuesta ~25ms sobre 60
  archivos y no depende del reloj.
- **`git worktree list` imprime rutas FÍSICAS**; el `cwd` de un payload llega con symlinks. Comparar las
  dos formas no matchea nunca — resolver con `pwd -P` antes.
- **Un heredoc a un intérprete NO es inerte para el guard** (python podría ejecutarlo), así que un test
  que cite `> CLAUDE.md` no se puede escribir con `python3 - <<PY`. Misma clase que #462. La salida es la
  tool nativa `Edit` — el caso legítimo de "Bash no puede hacerlo".
- **`gh pr create` inmediatamente tras el push a veces no encola el evento**: CI no arranca. Lo reemiten
  `reopened` (cerrar/reabrir) o `synchronize` (otro push). Pasó en #535.
- **El guard de aislamiento `~/.navori` da falso positivo** cuando otra sesión de Claude Code corre con
  audit-mode activo en otro repo: su log entra a `~/.navori/audits/` mientras la suite corre. El propio
  mensaje del guard lo nombra.
- **`vitest` corre `tsup` en `globalSetup` y ese build limpia `dist/`**: no correr dos suites concurrentes.
- **`makeTmpRepo` (cli.e2e) no crea directorios intermedios**: los fixtures van planos.

## Pendientes de Ulises (no bloquean navori)

- **Críticos en `alertaciudadana_backend`**: `#151` (el worker borra registros de `Multimedia` ante
  cualquier 404 de S3, `NoSuchBucket` incluido) y `#150` (~1 mes de jobs encolados en BullMQ que se
  ejecutarán al reactivar el worker). Pesan más que el rollout si están vivos.
- **Seguridad**: `alertaciudadana_app#113` (PII y CURP a logcat en build release),
  `alertaciudadana_backend#148`, `navori-dashboard-template#53`.
- Aplicar `project.testsExclude: [".maestro/flows"]` en `alertaciudadana_app` — el mecanismo ya existe
  desde 0.6.4, falta declararlo allá.
- `navori-dashboard-template` declara `branchBase: main` pero el flujo real es `dev`.
- WIP de `fix/adapter-pattern-82` (app) en `stash@{0}`; `docs/status-enum-truth-144` (backend) con 1
  commit sin publicar.

## Notas heredadas

- `~/.navori/backups` acumula fixtures de test históricos. **Filtrar por prefijo, no por edad.**
- La ruta de los repos Bonum del `~/.claude/CLAUDE.md` global está desactualizada; siguen pendientes los
  PRs de bonum-webapp (#639, #640, #559) y el rebind de SonarCloud.
- **La carga de daemons de macOS** dispara `Test timed out in 15000ms` en masa. Usar `--testTimeout=90000`.
