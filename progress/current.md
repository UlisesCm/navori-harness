# Sesión actual

**Estado:** `idle`. `main` en `8ab7fa7`, working tree limpio, **0 issues / 0 PRs** en navori.
La jornada del 2026-08-27 fue **operativa fuera de navori**: no se tocó código de `packages/cli`.

## SIGUIENTE PASO: dos issues de navori que salieron de usarlo

Los dos aparecieron haciendo el rollout real a `bonum-webapp`, no auditando. Ninguno está abierto todavía.

**1. `navori update` propone pisar configuración declarada.** En un repo con `engines: ["claude"]` y un
`qualityGate` propio, propuso truncar el gate (se comía `lint` y `test:unit`) y **reactivar los engines
desactivados a propósito** — justo el que estábamos eliminando. No distingue un valor DETECTADO
(re-derivable) de uno DECLARADO a mano. Mitigación: es interactivo, así que nunca contestar "Yes" a
ciegas; para arreglar solo `libraries`, editar la config a mano y `render --apply`.

**2. El `doctor` no detecta skills project-local desalineadas.** Un bloque managed desalineado se caza por
hash; una skill local no tiene detector. `typescript-first` de webapp llevaba 16 días afirmando cosas
falsas, y su regla dura ordenaba descartar errores de `compile` como ajenos. Feature barata y acotada:
que el doctor verifique las rutas `src/...` que citan las skills locales (un grep de 3 líneas encontró
una muerta).

## El rollout, que sigue pendiente

| Dónde | Versión |
|---|---|
| **`bonum-webapp`** | **0.6.4 — hecho, en PR #651 (sin mergear)** |
| 14 repos Bonum restantes | 0.5.1 |
| `moonar-medusa-monorepo`, `navori-health` | 0.5.1 |
| 3 repos de `/navori` | 0.6.2 |

Método probado: `doctor` → (corregir `libraries` a mano si el registro retiró alguna) → `render --apply`
→ `render --prune --apply` → `doctor`. **No usar `navori update`** hasta que se arregle el punto 1.

## Lo que se hizo (2026-08-27)

- **~30.7 GB liberados** en worktrees de `/bonum`: 18 eliminados + 32 `node_modules`. El censo real eran
  **53**, no 34 — 19 estaban ocultos en `.wt-services-users/` (dos ubicaciones) y `.claude/worktrees/`.
- **Ruta de los repos Bonum corregida** en el `~/.claude/CLAUDE.md` global (apuntaba a una carpeta
  inexistente; son `/Users/ulisescm/Documents/Dev - Docs/bonum`).
- **3 PRs en webapp**: #651 (harness 0.6.4 + codex fuera), #653 (BT-1427), #654 (BT-1425).
- **BT-1427 y BT-1425** comentados en Jira con mención en ADF y movidos a `CODE REVIEW`.

## Hechos verificados (no re-investigar)

- **El patrón de Mantine en webapp:** todo default suyo expresado en `rem` sale al **62.5%** (su helper
  divide entre 16; la app fija la raíz al 62.5%). Tres apariciones confirmadas. **Merece ticket propio.**
- **Mantine monta el dropdown del Combobox en un portal sobre `<body>`**: cualquier regla SCSS anidada
  bajo la clase del componente no lo alcanza jamás, en silencio. La salida es el prop `classNames`.
- **Los PRs de Bonum mergean con squash**, así que `--is-ancestor` responde "no mergeado" para ramas que
  shipearon. Para juzgar un worktree: `gh pr list --head <branch> --state all`.
- **`git worktree remove` no borra la branch** (ni local ni remota): la operación es reversible.
- **El flujo `<base>-harness`** funciona: branch local sin upstream con base + harness, y antes de
  pushear `git rebase --onto origin/<base> <base>-harness <ticket>`. Probado: 49→3 y 44→1 archivos.
- **Para forzar una pantalla sin login** (usuario que ya pasó el onboarding): módulo temporal dentro de
  `src/` que Vite transforma — un `<script type="module">` inline NO resuelve los bare imports. Importar
  un `.scss` de pantalla directo revienta por variables; hay que importar `src/scss/global.scss`.

## Bloqueo que no depende de nosotros

Los 3 PRs de webapp **no pueden mergear**: SonarCloud falla con `Could not find the pullrequest with key`
en **todos** los PRs del repo. Es el rebind pendiente. Los dos tickets se quedan en `CODE REVIEW` hasta
que se resuelva.

## Pendientes de Ulises (no bloquean navori)

- **Críticos en `alertaciudadana_backend`**: `#151` (el worker borra registros de `Multimedia` ante
  cualquier 404 de S3, `NoSuchBucket` incluido) y `#150` (~1 mes de jobs encolados en BullMQ que se
  ejecutarán al reactivar el worker).
- **Seguridad**: `alertaciudadana_app#113` (PII y CURP a logcat en build release),
  `alertaciudadana_backend#148`, `navori-dashboard-template#53`.
- Aplicar `project.testsExclude: [".maestro/flows"]` en `alertaciudadana_app`.
- `navori-dashboard-template` declara `branchBase: main` pero el flujo real es `dev`.
- En webapp: `wt-BTBS-148-webmentoring` tiene el commit `dde6a8f` pusheado **sin PR**; y `specs/` sigue
  en `.gitignore` con el bloque SDD activo.
- **23 PRs abiertos** a nombre de Ulises en webapp. Merece una pasada.

## Notas heredadas

- `~/.navori/backups` acumula fixtures de test históricos. **Filtrar por prefijo, no por edad.**
- **`check:assets` resuelve la versión publicada con `latestTag()`** (tags de git, no npm): un release sin
  tag lo deja comparando contra una versión vieja.
- **`find -newer` tiene resolución de 1 segundo** en el runner de CI; comparar contenido, no mtime.
- **El guard de aislamiento `~/.navori` da falso positivo** cuando otra sesión corre con audit-mode
  activo en otro repo mientras la suite corre.
- **`vitest` corre `tsup` en `globalSetup` y ese build limpia `dist/`**: no correr dos suites concurrentes.
- **La carga de daemons de macOS** dispara `Test timed out in 15000ms` en masa. Usar `--testTimeout=90000`.
