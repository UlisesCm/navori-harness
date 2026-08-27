# Sesión actual

**Estado:** `idle`. `main` en `cf6fcb0`, working tree limpio, **0 issues / 0 PRs**, un solo worktree.
Tests **2124 → 2716**. `navori@0.6.2` publicado en npm.

## SIGUIENTE PASO: publicar 0.6.3

Los 5 fixes del rollout (#519–#523) están en `main` pero **no en npm**, así que ningún repo los tiene.
El más urgente de propagar es el de `.prettierignore` en `init`: **solo actúa al onboardear**, así que
cada día que pasa es otro repo que puede congelarse sin que nadie lo note.

Proceso: bump `packages/cli/package.json` → `render:apply` + `test:golden` (el bump reestampa los
marcadores) → gate → PR → tag → `npm publish` (manual, OTP de Ulises).

## Lo que se hizo hoy

**22 issues cerrados en 6 PRs**, todos con CI verde:

| PR | Qué |
|---|---|
| #513 | Seguridad: #495 #506 #509 #510 #511 |
| #514 | Pérdida de datos: #496 #497 #498 #504 |
| #515 | Contrato de agentes: #499 #500 #501 #502 #507 |
| #516 | Config: #503 #505 #508 |
| #518 | Release 0.6.2 |
| #524 | Los 5 del rollout: #519 #520 #521 #522 #523 |

**Rollout a los 3 repos de `/navori`**, uno a uno: `alertaciudadana_app`, `alertaciudadana_backend`,
`navori-dashboard-template`. Los tres en `0.6.2`, verificado **contra las ramas base**, no contra la
copia local. 5 PRs mergeados allá.

## Pendientes de Ulises (no bloquean navori)

- **3 issues de seguridad** abiertos en sus repos:
  - `alertaciudadana_app#113` — PII y CURP a logcat en build release; cookie de sesión en requests públicas.
  - `alertaciudadana_backend#148` — un reporte fuera de zona se crea igual y queda **invisible para toda
    autoridad** (`reportQueryFilter` nunca matchea `zone: null`).
  - `navori-dashboard-template#53` — overview sin `requireRole`, con `catch {}` que hace el access-denied
    idéntico a "no hay datos"; anonimato en una sola capa (presentación).
- `docs/status-enum-truth-144` (backend) tiene 1 commit **sin publicar**.
- WIP de `fix/adapter-pattern-82` (app) en `stash@{0}`: viola `project-no-graphql-generated-import-in-ui`,
  la regla que esa misma rama introdujo. Completar el refactor es trabajo de esa rama.
- `navori-dashboard-template` declara `branchBase: main` pero el flujo real es `dev` (60 commits adelante).
  Esa discrepancia me hizo ramificar mal; corregirla es una línea.

## El patrón, que vale más que los 22 parches

> Las defensas describían el peligro por su **forma textual** —`-rf`, un nombre de binario, un mapa de
> rutas, un conteo de apóstrofos— en vez de por su **semántica**, y **ninguna verificaba que pudo hacer
> su trabajo**.

Los fixes reales no taparon el caso: **quitaron la dependencia de la forma**.

**La patología de tests, OCHO apariciones.** Un test que congela la *forma de la implementación* en vez
de verificar la *regla*. En cuatro casos **protegía el bug** — corregir el código rompía el test:

- `guard-destructive.test.ts` — 30 casos de `rm`, los 30 con `-rf`. Eje del target agotado, eje de flags inexistente.
- `gate-hook-worktree.test.ts` — `it("semgrep BLOCKS…")` con `toBe(1)`. La suite tenía escrito que bloquear era 1.
- `build-settings.test.ts` — `expect(allow).toContain("Bash(sg:*)")`: aseveraba el agujero de seguridad.
- `schema-publish.test.ts` — `$id` fijado a un dominio NXDOMAIN.
- `protocol-coherence.test.ts` — congelaba la cadena literal de la redacción ambigua de R1.
- `removal-parity.test.ts` — symlink como *hijo*, nunca como *raíz*.
- `render-prune-orphans.test.ts` — `it("does NOT delete…")` afirmando que el preview **no reportara nada**.
- Y la guarda de `--accept-new`: **borrarla dejaba 125 tests en verde**.

**Dos las produje yo**, con el patrón fresco y en tests escritos para no caer en él. Las atrapó lo único
que las atrapa: **mutar producción y comprobar el rojo**. Razonar sobre el fixture no basta.

## Hechos verificados (no re-investigar)

- **`gh pr create` inmediatamente tras el push no encola el evento**: CI no arranca. Lo reemiten
  `reopened` (cerrar/reabrir) o `synchronize` (un push). No es facturación —el repo es público— ni latencia.
- **`vitest` corre `tsup` en `globalSetup` y ese build limpia `dist/`**: dos suites concurrentes hacen que
  los e2e ejecuten un binario a medio escribir. Medido **7 003 s contra 55 s**, con 28 fallos inexistentes.
- **La carga de daemons de macOS** dispara `Test timed out in 15000ms` en masa. Usar `--testTimeout=90000`,
  y **correr un archivo aislado antes de creer un fallo**.
- **Un `git stash` en árbol compartido** se lleva el trabajo de todos los agentes activos.
- **Cambiar de rama con implementers activos** arrastra su trabajo sin commitear a la otra rama.
- **Un agente que muere a mitad de una mutación deja producción rota** (apareció `nukeStaleThing` con
  `rmSync` recursivo en `lib/semver.ts`). Los encargos exigen aplicar y restaurar en el MISMO turno.
- **Los conflictos de rebase en `.claude/` y `CLAUDE.md` no se resuelven a mano**: son espejo. Tomar la
  versión de `main` y regenerar con `render:apply`.
- **eslint no corre dentro de un worktree anidado** (encuentra el plugin dos veces). Por eso los agentes
  no podían commitear ahí. Ya lo detecta `doctor` (#522).

## Notas heredadas

- `~/.navori/backups` acumula fixtures de test históricos. **Filtrar por prefijo, no por edad.**
- La ruta de los repos Bonum del `~/.claude/CLAUDE.md` global está desactualizada; siguen pendientes los
  PRs de bonum-webapp (#639, #640, #559) y el rebind de SonarCloud.
