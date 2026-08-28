# Sesión actual

**Estado:** `idle`. Branch `fix/538-json-authorship-prune`, **PR #539 abierto contra `main` con CI verde,
sin mergear**. Es lo único abierto: 0 issues (#538 lo cierra el PR), 1 PR.

## SIGUIENTE PASO: mergear #539 y seguir con los dos issues que faltan abrir

**Mergear PR #539** (`fix(prune): el criterio de autoría lee también la notación JSON del marcador`).
CI verde, 2796 tests. Cierra #538. Después, `main` queda listo para el rollout pendiente.

Los dos issues siguientes salieron de **usar** navori en el rollout a `bonum-webapp`, no de auditar.
Ninguno está abierto todavía:

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

**Basura que el prune no puede reclamar solo:** los 5 repos Bonum con `.codex/hooks.json` huérfano
(`notifications--server`, `services--sessions`, `bonum-dashboard`, `bonum-nexus`, `services--evaluations`).
Lo escribió navori 0.5.1 sin marcador de ninguna notación, así que ningún criterio por contenido lo
alcanza — y borrar por path es #496 otra vez. **Bórralos a mano** al pasar por cada repo. Con #539 el
prune al menos ya no afirma que son tuyos.

## Hechos verificados de #538 (no re-investigar)

- **El marcador de autoría tiene DOS notaciones**: el comentario (`navori:managed … version="X"`) y la
  clave `$navori` de nivel 1, para los JSON que navori genera enteros. La segunda vive en
  `packages/cli/src/lib/json-ownership.ts`, en `lib/` y no en el engine claude, porque la leen dos
  preguntas: sobrescribir vs. borrar.
- **La autoría se decide por CONTENIDO, jamás por path.** Volver a un mapa de paths es exactamente el
  defecto que quitó #496. Cualquier propuesta futura sobre el prune tiene que respetar esa lección.
- **Híbrido ≠ generado**: un JSON donde navori reconcilia solo algunas claves (`.mcp.json` → solo
  `mcpServers`; un `settings.json` coexistente) lleva `$navori` **sin** `managed: true`, deliberadamente.
  Estamparle `managed` lo volvería borrable con la configuración del usuario dentro.
- **`.codex/hooks.json` ya no lo genera el CLI**: el engine codex escribe `config.toml`.

## Hechos verificados de la jornada anterior (no re-investigar)

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
en **todos** los PRs del repo. Es el rebind pendiente. BT-1427 y BT-1425 se quedan en `CODE REVIEW` hasta
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
