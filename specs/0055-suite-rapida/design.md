# Suite rápida: tests herméticos, hooks y CLI más baratos, menos tokens — Design

**Estado:** revisado tras el challenge (`.navori/state/handoffs/challenge_0055-suite-rapida.md`) y
las decisiones del orquestador · **Fecha:** 2026-10-16 · **Base verificada:** `git fetch origin
dev` → `FETCH_HEAD` = `50d9470b`, igual a `HEAD` de `feat/0055-suite-rapida`. El ref `origin/dev` no
resuelve en este worktree, así que cada afirmación "ya existe" se leyó en `HEAD` (= `FETCH_HEAD`).
El PR apunta a `dev`.

**Señal arquitectónica:**

- áreas críticas: hooks (veredictos, auditoría), escrituras del hook de fallos en `.navori/state`, CI;
- contratos compartidos: la caché de campos del payload (todas las parciales de hook), el layout de
  `dist/` (chunks) frente a `bundled-assets.ts`, y el esquema JSON de los bench;
- migración: reescritura de tests con preservación de casos y CI con shards.

## Decision drivers

Salen de `docs/DIRECTION.md` (calidad > tokens > velocidad), de `CLAUDE.md` (áreas críticas; simple >
clever), de las lecciones de 0054 y de `requirements.md`.

1. **Veredictos intocables.** Un hook más barato que decide distinto es una regresión de seguridad
   (R13). Toda optimización de hook se demuestra con un corpus reproducido, no con la suite reescrita.
2. **Fail-closed hacia el costo, nunca hacia el silencio.** Si un atajo duda (detección de log de
   auditoría, caché de campos, `test:affected`), paga el camino de hoy.
3. **Un dueño por regla.** El entorno hermético vive en un solo sitio (`createTempFile`); el conteo de
   procesos en un solo wrapper; la extracción del payload en una sola función.
4. **Cero dependencias nuevas.** Vitest, citty y tsdown se quedan; `isomorphic-git` no entra (D7).
5. **Medir en reposo.** Una corrida bajo carga no es evidencia (0054: ruido 20–30 %).
6. **Multi-engine.** Todo cambio de hook vale para Claude, Codex y Pi (espejos `.claude/`, `.codex/`,
   `.pi/` por `check:render`).

## Approach

La suite cuesta procesos, no CPU. El diseño ataca el costo **por proceso** (hooks y CLI más baratos,
que también abaratan las sesiones reales) y el **número de procesos** (menos spawns por caso), en ese
orden, porque lo primero multiplica a lo segundo.

- **Medir primero (A).** `bench:tests` cuenta procesos por archivo, `bench:hooks` cuenta procesos por
  hook con el CLI local, y `bench:context` mide bytes. Sin eso, R29 y R30 no tienen línea base.
- **Entorno hermético (B)** en el único punto que ya fija el entorno del worker
  (`vitest.tempLifecycle.ts`, `createTempFile`), antes de cualquier optimización, porque cambia las
  mediciones.
- **Hooks (C)**: la auditoría se decide por log activo, sin procesos; un solo `jq` por hook vía una
  caché de campos; el carril de fallos sin Node.
- **CLI (D)**: subcomandos perezosos con la capacidad que citty ya tiene, y `dist/` en chunks, solo
  si el probe de M0 mide al menos 20 ms de ahorro en los subcomandos calientes.
- **Suite (E)**: zsh solo donde el shell cambia el resultado, e2e en proceso, lotes de hook,
  plantillas git, sondeo en vez de esperas, sin aserciones de prosa; todo bajo el control de
  preservación.
- **CI (F)**: shards con blob en push; tests afectados en PR.
- **Tokens (G)**: un reporter compacto propio y el resumen verde del gate a una línea por paso.

**Escalera de la decisión de mayor riesgo — cómo bajar `jq` a uno por hook (R10):**

- **Patrón existente: `payload_fields` de 0054 en cada hook** (`_partials/extract-cmd.sh`,
  `payload_fields`). Descartado como solución completa: 0054 D10 (desviación M6) dejó fuera
  `implementer-no-markdown`, `routing-watch`, `role-guard`, `pr-publisher-confirm` y
  `bash-outcome-watch` porque leen campos tras compuertas que evitan el fork; un `payload_fields`
  temprano les pondría un `jq` en caminos que hoy no lo pagan.
- **Extensión: caché perezosa en `extract-cmd`.** **Elegida.** Cada hook declara su lista de campos;
  `payload_load` la extrae una vez, con el mismo `payload_fields` endurecido, en el punto donde el hook
  ya sabe que necesita un campo; después `payload_field` lee la caché sin procesos (D3).
- **Nueva abstracción: un parser de JSON en shell puro.** Descartada: bash 3.2 sin arrays asociativos,
  escapes `\u` y NUL; es exactamente la clase de código que 0054 B3 mostró frágil.

## Components

### A — Medición

- `packages/cli/vitest.setup.ts`. El wrapper de `child_process` que ya existe (parche de
  `execFileSync`/`execSync`, #1272) pasa a envolver también `spawn`, `spawnSync`, `exec`, `execFile` y
  `fork`, y cuenta las llamadas del archivo. En `afterAll`, si `NAVORI_BENCH_PROC_DIR` está definido,
  escribe `{ file, spawns }` ahí. Conserva `util.promisify.custom` de `exec`/`execFile`. — R1
- `packages/cli/scripts/bench-tests.mjs`, `summarizeReport` y `main`. Fija `NAVORI_BENCH_PROC_DIR`,
  une los conteos por archivo al JSON (`files[].spawns`, `sumSpawns`), registra
  `loadavgBefore`/`loadavgAfter` (ya existen) y `workers`, y calcula `comparable` (D10). — R1, R2
- `scripts/js/bench-hooks.mjs`. Gana tres cosas (D10):
  - `navori` del PATH apunta al `dist/` local mediante un symlink en un directorio scratch, no al
    global instalado;
  - escenarios de auditoría `absent` (sin raíz), `root` (raíz sin log activo) y `active` (log de la
    sesión del payload);
  - una pasada de conteo con shims en el PATH (`jq`, `node`, `perl`, `git`, `navori`, `date`, `sed`,
    `grep`, `tr`, `head`, `tail`, `basename`) que registra execs por hook, separada de la pasada de
    tiempo para no inflarla.

  Reporta mediana de pared y de CPU por hook, y `execs` por programa. — R3, R8, R10, R11, R12
- `scripts/js/bench-context.mjs` + `bench:context` (nuevo). Reutiliza el armado scratch de
  `bench-hooks.mjs` (exporta su función de setup) y mide bytes de: salida de `SessionStart` (Claude y
  Codex), salida de cada hook con los payloads del bench, `navori gate fast --force` verde, y
  `test:affected --files <lista fija>` en verde y con un fixture que falla. — R4, R26–R28
- `packages/cli/src/__tests__/fixtures/hook-verdict-corpus/` (nuevo, generado en M0). Corpus de casos
  de hook capturado en M0 dentro de `runHookIsolated`/`runHookBatch` y, para los spawns directos de
  hooks, en el wrapper de `vitest.setup.ts`, con `NAVORI_HOOK_CORPUS=<dir>`. Lleva dos salidas
  esperadas por caso: auditoría apagada y auditoría activa (D2). — R13, R16

### B — Tests herméticos

- `packages/cli/vitest.tempLifecycle.ts`, `createTempFile` y `environmentKeys`. Ya asigna `HOME`,
  `USERPROFILE`, `TMPDIR` y `NAVORI_BACKUP_ROOT` por archivo (#954) y borra `CODEX_HOME`. Suma (D1):
  - `NAVORI_AUDITS_ROOT=<root>/no-audits` (ruta que no existe);
  - `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<root>/gitconfig` (archivo vacío),
    `GIT_TEMPLATE_DIR=<root>/git-template` (solo `hooks/` e `info/` vacíos) y
    `XDG_CONFIG_HOME=<root>/xdg`;
  - borra todo `GIT_*` heredado y `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`,
    `NAVORI_AUDIT_HOST` y `NAVORI_AUDIT_SESSION_ID`.

  Todo se restaura en `dispose`, como hoy. — R5, R6
- `packages/cli/src/__tests__/helpers/hermetic-env.ts` (nuevo, pequeño). `auditsUnderHome(env)`
  quita `NAVORI_AUDITS_ROOT` para los tests que siembran `$HOME/.navori/audits` a propósito. — R5
- `ast-grep/rules/no-real-home-in-tests.yml` (ast-grep, nuevo; corre en `check:ast`). Verificación solo
  estática (R7 enmendado), con dos patrones en `**/*.test.ts` y `**/__tests__/helpers/**`:
  - `userInfo()` (`os.userInfo().homedir`);
  - literales de string que empiecen por `/Users/` o `/home/`.

  La allowlist va en el propio archivo de regla (`ignores:` por archivo, cada uno con su motivo en un
  comentario). M1 la llena con los 15 archivos de test que hoy tienen esos literales; casi todos usan
  la ruta como *dato* (mensajes de error, normalización de rutas) y no la tocan en disco. Un archivo
  nuevo fuera de la lista falla con su nombre. — R7

### C — Hooks

- `packages/core/core-assets/hooks/_partials/audit-log.sh`, `navori_audit_begin` y
  `navori_audit_log`. La decisión de auditar pasa de "existe la raíz" a "existe el log de esta sesión"
  con solo builtins, incluidos los repos cuyo nombre empieza por punto (D4). El encabezado del
  invariante del escritor no cambia. — R8, R9
- `_partials/extract-cmd.sh`. Suma `payload_load`, la caché ligada al valor de `payload`
  (`_nv_pf_src`) y la lectura de la caché en `payload_field`. `payload_fields` se conserva y es su
  implementación (D3). — R10
- `_partials/hook-input.sh`. Llama `payload_load` antes de su lectura de `cwd` en el nivel superior
  (Codex/Pi). Por eso la declaración `nv_payload_fields="…"` va **antes** de los includes en cada hook
  (D3). — R10
- Los 22 hooks de `core-assets/hooks/` que incluyen `extract-cmd` declaran `nv_payload_fields` como
  primera asignación del script y llaman `payload_load` donde ya saben que necesitan un campo. — R10
- `_partials/bash-outcome.sh`, `navori_bash_failure_state`, y `bash-outcome-watch.sh`. Un programa
  `jq` que lee el payload por stdin reemplaza al `node -e` de estado y al de emisión (D5). — R12
- `session-start-context.sh` y `commands/tools.ts` (`navori tools session-context
  --notice-reserve`). Ver D6. — R11
- Hooks que inyectan contexto sin nada que señalar. Criterio de cierre: M0 publica en "Línea base y
  resultado" la lista que produce `bench:context` (bytes > 0 con el payload neutro de cada evento).
  M2 vacía la salida de cada hook de esa lista; si la lista sale vacía, R28 se declara cumplido por
  medición y queda fijado por el test de Testing. — R28
- `scripts/js/hook-verdict-replay.mjs` (nuevo). Reproduce el corpus de M0 contra los hooks
  renderizados de la rama en dos modos, `--audit off` y `--audit active`. Falla con el primer caso cuyo
  `exit`, `stdout`, `stderr` o evento de auditoría normalizado difiera (D2). — R9, R13
- Espejos `.claude/hooks/`, `.codex/hooks/` y `.pi/navori/hooks/`, regenerados con `bun run
  render:apply`; `check:render` los verifica. — R8–R13

### D — Arranque del CLI

Todo este bloque está **condicionado al probe de M0** (D8): si el ahorro medido es menor a 20 ms en
los subcomandos calientes, M3 sale de la entrega y D8 registra la medición.

- `packages/cli/scripts/probe-lazy-load.mjs` (nuevo, M0). Empaqueta por separado, con las mismas
  opciones de `tsdown.config.ts`, una entrada mínima por subcomando caliente (`tools`, `plan`) que
  solo importa ese comando. Mide el arranque en frío de cada uno frente a `dist/index.js` (D8). — R14
- `packages/cli/src/cli.ts` (nuevo). Exporta `main` (`defineCommand`) con `subCommands` perezosos:
  `init: () => import("./commands/init.ts").then((m) => m.initCommand)`, uno por subcomando (D8).
  — R14
- `packages/cli/src/index.ts`. Queda como entrada: workers de avisos, `runUpdateNotice` y
  `runMain(main)`. Ya no importa ningún `commands/*`. — R14, R15
- `packages/cli/tsdown.config.ts`. `codeSplitting` pasa a activo con `chunkFileNames: "[name]-[hash].js"`
  en la raíz de `dist/`, para que `bundled-assets.ts` (`HERE`) siga resolviendo `dist/assets/` y
  `dist/../package.json`. — R14
- `packages/cli/scripts/check-bundle-size.mjs`. Mide la suma de `dist/*.js`, no solo `index.js`. — R14
- `packages/cli/src/__tests__/cli-lazy-load.test.ts` (nuevo). Lee `dist/`: `index.js` no importa
  estáticamente ningún chunk de `commands/*`, y la clausura estática de cada chunk de subcomando no
  contiene el chunk de otro subcomando. — R14
- `packages/cli/src/__tests__/fixtures/cli-surface.golden.json` (nuevo, capturado en M0 desde el
  `dist/` de la base). `--version`, `--help`, `<sub> --help` de cada subcomando y un comando
  desconocido: stdout, stderr y exit. `cli-surface.test.ts` lo compara con el `dist/` de la rama.
  Se captura aunque M3 se retire: protege también a M4. — R15

### E — Suite

- `packages/cli/src/lib/__tests__/helpers/shells.ts`. `HOOK_SHELLS` pasa a `["bash"]`;
  `shellSensitive(reason)` devuelve `["bash", "zsh"]` (si zsh existe) y exige un motivo no vacío;
  `acrossShells(run, { sensitive?: string })`. `NAVORI_TEST_ALL_SHELLS=1` restaura la matriz completa
  (D9). — R16
- `packages/cli/src/__tests__/hooks-zsh-parity.test.ts` (nuevo). Reproduce el corpus **completo** de
  veredictos (D2) bajo zsh, en un lote por hook (`runHookBatch`, un proceso por hook), y lo compara
  byte a byte con la salida esperada de bash. Es la red que reemplaza a la matriz. — R16
- `packages/cli/src/__tests__/helpers/cli-in-process.ts` (nuevo). `runCliInProcess(args, { cwd, env })`
  ejecuta `runCommand(main, { rawArgs })` de citty con stdout y stderr capturados, `process.exit`
  interceptado y `cwd`/`env` restaurados al final. Falla el caso si al terminar queda
  `process.exitCode` distinto de `undefined`/0 sin haberlo reportado. Requiere `main` exportado: si M3
  se retira, M4 crea igual `src/cli.ts` con imports estáticos. — R17
- `packages/cli/src/__tests__/cli.e2e.test.ts`. Pasan a `runCliInProcess` los casos de flags
  numéricos (#283), despacho de `migrations` (#466), variantes `--json` y errores de config. Quedan ~25
  smoke contra `dist/index.js`, al menos un caso de exit real por subcomando (T13 de 0054). — R17
- Lotes de hook con `createHookBatch`/`runHookBatch` (`src/__tests__/helpers/hook-batch.ts`) en
  `pi-policy-parity`, `routing-watch`, `implementer-no-markdown` (singles), la tabla hostil de
  `audit-hooks` y los singles de `guard-destructive` que solapan la tabla `VERDICTS`.
  - `runHookBatch` gana `{ lanes?: number }`.
  - Los lotes con log de auditoría activo usan `lanes: 1` o una raíz de auditoría por caso, para que
    dos carriles no escriban el mismo `session-*.log` o spool.

  — R18
- `src/__tests__/helpers/repo-template.ts`. Suma `emptyRepo()` y `committedRepo(files)`, plantillas
  por archivo de test con `createRepoTemplate`. Migran los archivos con `git init` por caso (81 según
  el censo previo; M4 filtra por spawns reales). Los tests de `git worktree`, de `.git` como archivo
  o de un `GIT_DIR` externo conservan `git init` real (D7). — R19
- `ast-grep/rules/no-git-init-per-case.yml` (ast-grep, nuevo). Prohíbe spawns de `git init` dentro de `it(`/
  `test(`. Las excepciones van listadas en la regla, por archivo y con motivo: tests de `init` en sí y
  tests de worktree. — R19
- `ast-grep/rules/no-fixed-wait-in-tests.yml` (ast-grep, nuevo). Prohíbe `Atomics.wait` y
  `setTimeout(…, <literal>)` envuelto en `new Promise` en tests; la alternativa es `vi.waitFor`.
  Migran `temp-lifecycle.integration` (11 s) y `lib/gate/__tests__/run.test.ts` (1 s ×2). — R20
- `scripts/js/check-test-preservation.mjs` + `test-preservation.config.json`. Pasa de lista fija a
  "todo `*.test.ts` cambiado o borrado contra el merge-base", con `removedCases` y `merges` por
  archivo. Se cablea como `check:tests-preserved` en `check`, en `qualityGate.full` y en CI (D11).
  — R21
- `ast-grep/rules/no-prose-assertion.yml` (ast-grep, nuevo). En archivos de test que leen `core-assets`,
  `SKILL.md`, `docs/` o `.md`, prohíbe `toContain`/`toMatch` con un literal de 6 palabras o más. Las
  aserciones se reescriben como marcadores, tokens contractuales (tablas al estilo de
  `doctrine-contracts.test.ts`) o presupuestos. — R22

### F — CI

- `packages/cli/scripts/test-affected.mjs`, `mergeBase`, `planAffected` y `main`. Gana (D12):
  - `--base <ref>` y `NAVORI_AFFECTED_BASE`;
  - `--files` y `--plan-json`, que solo imprime el plan `{ full, reason, related, tests,
    estimatedFiles }` sin correr vitest;
  - una sola invocación de vitest;
  - la regla de hub por salida.

  — R24
- `packages/cli/scripts/test-import-graph.mjs` (nuevo, M0). Grafo estático de imports de `src/`
  (especificadores relativos `.ts`). Da el fan-in de tests por módulo y el número estimado de archivos
  de test que selecciona un conjunto de cambios. Lo usan `test-affected.mjs` y la medición de hubs de
  M0. — R24
- `.github/workflows/ci.yml`. El job `quality` se parte (D13):
  - `checks`: los pasos actuales sin tests, en push y en PR;
  - `plan` (solo PR): `test:affected --plan-json --base origin/<base_ref>`, que publica `full`;
  - `test`, matriz de 4 shards: en push a `dev`/`main`, y en PR cuando `plan.full == true` o
    `base_ref == main`;
  - `test-merge`: combina blobs y corre piso de cobertura y presupuesto, cuando corrió `test`;
  - `affected` (solo PR, `plan.full == false`): el subconjunto, sin cobertura y con presupuesto por
    archivo.

  Suma `workflow_dispatch` con la entrada `all_shells` para la corrida de D9. — R23, R24, R25
- `packages/cli/scripts/run-test-coverage.mjs`, `runCoverage`. Gana los modos `--shard i/N`
  (blob con cobertura, sin umbrales) y `--merge <dir>` (merge-reports con cobertura, json, piso). Un
  solo dueño para cobertura local y CI. — R23, R25
- `packages/cli/vitest.config.ts`. `coverage.thresholds` vacío cuando `NAVORI_COVERAGE_SHARD=1`. — R25

### G — Tokens

- `packages/cli/vitest.reporter.ts` (nuevo). Reporter `compact` (D14):
  - en verde, una línea: `Tests: <n> passed, <s> skipped (<f> files) in <t>s`;
  - en rojo:
    - los errores globales y de módulo (colección, `afterAll`, unhandled, umbrales), con tope;
    - una línea con el nombre de cada caso fallido, hasta 50;
    - el detalle de los 10 primeros: aserción, diff y `console` del caso, 1 KiB por caso, recortado
      por el medio (cabeza y cola).

  — R26, R27
- `packages/cli/vitest.config.ts`. `reporters`: `compact` cuando stdout no es TTY; `default` en TTY.
  `coverage.reporter` pasa a `["json-summary"]` (sin `text-summary`). — R26
- `packages/cli/scripts/check-coverage-floor.mjs`. En verde imprime una línea
  `Coverage: lines x%, statements y%, functions z%, branches w% (floor ok)`. — R26
- `packages/cli/src/lib/gate/summary.ts`, `summarizeGreen` y `totalsLines`. En verde: el centinela
  más una línea de totales por runner reconocido, sin la cola de 3 líneas. `TOTALS` ya reconoce
  `Tests:` y gana `Coverage:`. El rojo no cambia (`RED_CAP`). — R26
- `scripts/js/bench-context.mjs` (ver A). — R4

### H — Resultado

- Sección **Línea base y resultado** de este documento. — R29
- `packages/cli/test-budget.json` y `packages/cli/scripts/check-test-budget.mjs`, que gana
  `--propose <bench.json…>` (D10). — R30

## Decisions

### D1 — Entorno hermético en `createTempFile` (R5, R6)

- **Lo que ya existe.** `createTempFile` (`vitest.tempLifecycle.ts`) reescribe `process.env` del
  worker antes de importar el spec, y todo hijo lo hereda. Por eso los hijos de la suite ya tienen un
  `HOME` temporal por archivo (#954), y `vitest.homeGuard.ts` (`describeNavoriHomeLeak`) falla el
  archivo que escribe en ese `~/.navori`.
  - **Corrección al contexto de `requirements.md`:** la suite no hereda el `HOME` real. La medición
    "36 ms con la raíz de auditoría, 10 ms sin ella" es de `bench:hooks`, cuyo `env` crea
    `NAVORI_AUDITS_ROOT` como directorio (`scripts/js/bench-hooks.mjs`, armado scratch). En la suite el
    ahorro de R5 es de robustez, no de tiempo; en sesiones reales el ahorro llega por R8.
- **Qué se suma.** Las claves de Components B. `GIT_CONFIG_GLOBAL` vacío preserva la semántica de hoy:
  con `HOME` temporal no había `~/.gitconfig`. `GIT_CONFIG_NOSYSTEM` corta `/etc/gitconfig` o la
  config de Homebrew. `GIT_TEMPLATE_DIR` evita copiar los hooks de ejemplo en cada `git init`, y
  conserva `hooks/` e `info/` vacíos para los tests que escriben ahí. Se borran todas las `GIT_*`
  heredadas, no solo `REPO_LOCAL_GIT_VARS` (`scripts/js/git-env.mjs`): un `pre-commit` que corre la
  suite exporta `GIT_INDEX_FILE`, y una lista blanca vacía es más simple que mantener otra lista.
- **"Salvo que el test declare otra" (R5).** Un test que pasa `env` explícito gana, como hoy. Los
  tests que siembran `$HOME/.navori/audits` (M1 los censa; hoy 12 archivos nombran `audits`, y 23
  fijan `NAVORI_AUDITS_ROOT` ellos mismos) usan `auditsUnderHome(env)`.

### D2 — Corpus de veredictos y su replay (R13)

- **Dónde se captura (M0, antes de tocar un hook).** La captura va dentro de los helpers que ven cada
  caso, no en el wrapper de spawn: `runHookBatch` lanza un solo driver y el wrapper vería eso, no los
  casos. Son dos puntos:
  - `runHookIsolated` y `runHookBatch`, por caso, con `envDelta` = solo `c.env`;
  - el wrapper de `child_process` de `vitest.setup.ts`, para los tests que lanzan un hook con su
    propio `execFileSync`/`spawnSync` (singles locales). Su `envDelta` son las claves cuyo valor
    difiere del `process.env` del worker, así que el `HOME`/`TMPDIR` temporal heredado no cuenta.
- **Qué entra.** Todo caso cuyo `cwd` sea ausente o esté dentro del checkout. Un caso con `cwd` en un
  fixture temporal entra solo si su `envDelta` y su payload no nombran ese temporal. Los que dependen
  de un repo fixture (`resolve-worktree`, `progress-ratchet`, `gate-trigger`) quedan fuera: el estado
  git de un fixture borrado no se puede recrear en general.
- **Cobertura publicada (criterio de aceptación de M0).** Por hook: casos en el corpus y porcentaje de
  sus casos de test. Va en "Línea base y resultado".
- **Enmienda de implementación (2026-10-16, decisión del orquestador).**
  - Cada caso corre sobre su propia copia del proyecto y su propia raíz de auditoría; los lanes
    corren en paralelo en ambos modos.
  - El modo activo agrega `session_id: "corpus-active"` a un payload que no lo trae; sin eso la
    mayoría de los hooks nunca recorre el camino de auditoría.
  - Un `cwd` temporal se guarda como `@CWD@` y se reproduce en un directorio vacío nuevo;
    `NAVORI_AUDITS_ROOT` sale del `envDelta`, porque lo fija el modo del replay. Solo queda excluido
    un `cwd` fuera del checkout y del temporal (motivo en `coverage.json`).
  - El replay expande la fuente de `packages/core/core-assets/hooks` con `expandHookIncludes`; los
    espejos los verifica `check:render`.
  - Resultado en `dev` 94047c0f: 2 996 casos (claude 2 212, codex 588, pi 196), un `<hook>.jsonl`
    por hook (5.4 MB) y replay idéntico en apagado y activo. Todo hook tiene casos salvo
    `model-advisor`, que ningún test invoca.
- **Lo que no cubre el corpus lo cubre la suite sin tocar.** M2 (hooks) va antes que M4 (reescritura
  de tests), así que cada commit de M2 se valida con:
  - el replay;
  - la suite **sin modificar**, con su matriz bash×zsh completa y las expectativas de `dev`.

  Un hook con cobertura de corpus menor al 60 % no recibe en M4 ninguna reescritura que reduzca sus
  casos hasta que el replay y su suite hayan pasado M2. El orden de milestones ya lo garantiza; la
  regla lo deja explícito.
- **Dos salidas esperadas por caso.** En M0, el replay corre contra los hooks de la base en dos modos:
  - `--audit off`: raíz inexistente, el entorno de M1;
  - `--audit active`: raíz y `session-<id>.log` creados para el `session_id` del payload.

  En modo activo guarda también el evento de auditoría escrito, normalizado: `tsMs` y `ms` se
  enmascaran como "entero de 13 dígitos" y "entero ≥ 0". Así el replay ejercita R9 aunque el entorno
  de la suite apague la auditoría.
- **Replay.** `hook-verdict-replay.mjs` corre cada caso con `runHookBatch` (con `lanes: 1` en modo
  activo) contra el hook renderizado de la rama y compara byte a byte. Corre en cada commit de M2 y en
  el cierre. El corpus se commitea como fixture.

### D3 — Caché de campos del payload (R10)

- **Declaración.** `nv_payload_fields="tool_name tool_input.command cwd session_id …"`, literal y
  **antes de los includes**, porque `hook-input.sh` lee `cwd` en el nivel superior durante el include
  (Codex/Pi) y debe hacerlo desde la caché. Un test de drift recorre los hooks renderizados y exige:
  - que cada `payload_field <ruta>` literal del hook y de sus parciales esté en la lista;
  - que la declaración preceda al primer `# navori:include`.
- **`payload_load`.** Si `_nv_pf_loaded=1` y `[ "$payload" = "$_nv_pf_src" ]`, no hace nada. Si no,
  llama a `payload_fields` sobre la lista declarada, guarda cada valor en `_nv_pf_<ruta con . → __>`,
  y fija `_nv_pf_src=$payload` y `_nv_pf_loaded=1`. Hereda las garantías de 0054 D10 (centinela,
  rechazo de NUL, repetición campo por campo ante cualquier anomalía).
- **`payload_field <ruta>`.** Usa la caché solo si está cargada, la ruta está en la lista **y** el
  `payload` actual es el mismo que la llenó (comparación de strings, builtin). Si no, hace lo de hoy
  (jq → node → sed). Esto cubre a los hooks que reasignan `payload`: `routing-watch.sh` lo cambia por
  `navori_acceptance_payload` antes de `navori_bash_success_lane` y lo restaura después. Con la caché
  ciega, esa lane leería `command`/`cwd`/`session_id` del payload original. La ruta se valida contra
  `[A-Za-z0-9_.]` antes del `eval` de lectura; nunca es entrada del usuario.
- **Forma de los valores.** `payload_field` usa `jq -r` y `payload_fields` usa `tostring`, que difieren
  en objetos y arreglos (pretty contra compacto). Regla: una ruta declarada debe resolver a escalar; el
  test de equivalencia por ruta (Testing) lo fija con `false`, `0`, `""`, salto de línea final, y con
  `tool_input` como string. En ese último caso el filtro usa `?` para que un `Cannot index string` no
  tire el lote a Node.
- **Dónde se llama.** `payload_load` va en el shell de nivel superior: en `hook-input.sh` antes de su
  lectura y, en los hooks sin `hook-input`, después de las salidas tempranas que no necesitan campos.
  Nunca va dentro de `$(…)`, donde la subshell perdería la caché. Las funciones que corren en subshell
  (`nv_tool`, `extract_cmd`) leen la caché heredada.
- **Alcance de R10** (enmendado): solo cuenta la extracción. El `jq` de auditoría activa no cuenta, y
  tampoco el de emisión de la salida. `bench:hooks` mide los `jq` **por engine** (`.claude/`,
  `.codex/`, `.pi/navori/`), y un test por hook y engine lo verifica con el shim.

### D4 — Auditoría decidida por log activo, sin procesos (R8, R9)

- **Hoy.** `navori_audit_begin` activa la auditoría si existe la raíz y toma `t0` con
  `navori_audit_now`, que sin `EPOCHREALTIME` (bash 3.2 de macOS, zsh sin `zsh/datetime`) lanza `perl`.
  `navori_audit_log` lanza otro `perl` y arma el JSON con `jq`; solo después
  `navori_audit_record_metadata` descubre si hay log de sesión.
- **Nuevo `navori_audit_begin`.**
  1. Sin raíz → apagado (igual que hoy).
  2. Extrae `session_id` del payload con builtins, y solo si la clave `"session_id"` aparece
     exactamente una vez y su valor cumple `^[A-Za-z0-9_-]+$` (la regla `id` del jq de hoy). Una clave
     literal `"session_id"` seguida de `:` no puede aparecer dentro de un string JSON, donde las
     comillas van escapadas. Es la técnica de la vía rápida de `plan-gate` (0054 D11).
  3. Con id → encendido solo si hay un archivo regular en `"$root"/*/"session-$sid.log"` **o** en
     `"$root"/.[!.]*/"session-$sid.log"` o `"$root"/..?*/"session-$sid.log"`. El glob por defecto no
     casa directorios ocultos, y `navori_audit_record_metadata` acepta repos como `.dotfiles`. Los
     globs usan `null_glob` local en zsh y `nullglob` restaurado en bash.
  4. `SessionStart`/`UserPromptSubmit` con algún `.armed` bajo los mismos tres globs → encendido
     (consumo de arm).
  5. Id ambiguo o ausente → encendido: el camino de hoy (driver 2).
- **Encendido** toma `t0` como hoy. Formato y precisión no cambian (R9): misma función
  `navori_audit_now`, mismo jq de metadata.
- **El log nace durante el hook.** Pasa cuando `audit-mode-trigger` arranca la sesión, y también en los
  hooks del **mismo evento** que corren en paralelo con él (otros `UserPromptSubmit`). Con
  `navori_audit_on=0`, `navori_audit_log` revisa los globs al salir. Si el log ya existe, registra el
  evento con `ms: 0` (no hubo `t0`) y `tsMs` tomado al salir. Es el único valor observable que cambia,
  y se limita a los eventos de esa ventana. R9 debería decirlo (Preguntas abiertas).
- **Log borrado durante el hook:** ya lo cubre `navori_audit_record_metadata`, que sale si el archivo
  no existe.
- **Engines sin `session_id` en el payload** caen al paso 5: correcto, pero sin ahorro. M0 verifica el
  payload del puente de Pi (`.pi/navori/`) con `bench:hooks` por engine. Si Pi no trae `session_id`, R8
  no se cumple ahí y se reporta.

### D5 — Carril de fallos sin Node (R12)

- **Un programa `jq`** reemplaza lo que hoy hace el `node -e` de `navori_bash_failure_state`. Se invoca
  así: `jq -n --rawfile state <archivo> '(input) as $p | …'`, con el payload **por stdin**, como hoy en
  Node (`<<< "$payload"`). Por argv, un payload de más de 128 KiB (`MAX_ARG_STRLEN` en Linux) haría
  fallar el arranque. El programa:
  - valida el payload (`tool_name`, `session_id`, `is_interrupt`, `command`, `cwd`);
  - normaliza el error con las mismas sustituciones: las de raíz y home son literales (`split|join`),
    equivalentes a la regex escapada de hoy; las demás pasan a regex Oniguruma con flags `g`/`gi`;
  - actualiza las filas `{key,sig,count,notified,epoch}` (tope 3, 50 filas);
  - emite, separados por NUL, el material de `key` y `sig`, el estado nuevo y el JSON
    `hookSpecificOutput` listo.
- **Hash.** `key` y `sig` pasan de sha256 en Node a `git hash-object --stdin`, una llamada por valor
  (~3 ms cada una); git ya es dependencia dura de los hooks (`navori_git`). Las filas viejas no casan y
  el conteo reinicia una vez tras actualizar (sección Migration).
- **Escritura.** El shell escribe `tmp` con `set -C; umask 077` y `mv`, con las mismas comprobaciones
  de componentes no-symlink de hoy.
- **Codex.** `codexExit` se reduce a validar en el mismo `jq` la línea que el shell ya extrae con
  `grep -F` (tipo, `item.id`, `exit_code` entero).
- **Requisito de `jq`.** Versión ≥ 1.6 (`--rawfile`). Sin `jq` o con uno más viejo, el carril calla sin
  advice y el hook sale 0. macOS 15+ trae `/usr/bin/jq` (presente en esta máquina) y ubuntu-latest
  también.
- **Compuerta de equivalencia (decide si R12 entra).** La tabla oráculo de Testing (~30 mensajes más uno
  de 300 KiB) compara el `node -e` viejo con el `jq` nuevo. Si en M2 no da **100 %** de igualdad en
  `body` normalizado, conteo y advice, R12 sale de la entrega y se propone para una spec aparte: son
  ~100 líneas de lógica por ~18 ms en un camino raro (fallos de Bash).
- **Costo esperado:** ~10 ms (jq + 2 × git) contra ~28 ms de `node -e`. **UNVERIFIED** hasta M0: si
  `git hash-object` costara más que Node, se usaría `openssl dgst -sha256`.

### D6 — Arranque de sesión con un solo CLI (R11)

- **Lo que ya existe.** `session-start-context.sh` hace **una** llamada (`navori tools
  session-context`, 0054 D12) cuando el CLI conoce el subcomando. Las 3 llamadas medidas son el camino
  de compatibilidad: el `navori` global de esta máquina es 0.12.1, sin el subcomando, y el memo
  `~/.navori/.no-session-context` contiene `0.12.1`. Ese camino paga `--version`, `tools notice` y
  `dominio inject`.
- **Cambio 1: el ack va dentro de la misma llamada.** `navori tools session-context
  --notice-reserve <bytes>`: el CLI marca el aviso como entregado solo si su cuerpo cabe en la reserva,
  que es la misma condición que hoy evalúa el hook. El hook ya no llama `tools notice --ack`.
  - Límite declarado: si el hook muere después del CLI y antes de emitir, se pierde un aviso. Sigue
    visible en `navori doctor`.
- **Cambio 2: `bench:hooks` mide con el CLI local** (Components A). Así R11 se verifica contra la rama
  y no contra el global publicado.
- **Fuera de R11 (enmendado en `requirements.md`):**
  - el consumo de arm (`navori audit --consume-arm`, solo con `.armed`);
  - el `plan resume` de Codex en `resume`;
  - el camino de compatibilidad con un CLI anterior al subcomando.

  Los tres son acciones distintas o casos raros; fundirlos en `session-context` mezcla
  responsabilidades.

### D7 — Fixtures git por plantilla (R19)

- `emptyRepo()` y `committedRepo(files)` construyen la plantilla una vez por archivo (`beforeAll`) con
  el binario git real y la copian por caso con `cpSync`. Es el patrón de 0054 D4: la plantilla no
  guarda rutas absolutas.
- Con `GIT_TEMPLATE_DIR` vacío (D1), la copia mueve ~15 archivos.
- **`isomorphic-git`: no.** Ganaría 3–4× solo en fixtures de árbol/commit, a costa de una
  devDependency y de una segunda implementación de git cuya fidelidad (índice, modos, config) habría
  que probar. La plantilla ya quita el costo dominante (init + commit por caso) con fidelidad total.

### D8 — Subcomandos perezosos (R14, R15), condicionados a un probe

- **Capacidad.** citty 0.1.6 acepta `Resolvable<CommandDef>` en `subCommands` (`index.d.mts`, tipo
  `SubCommandsDef`). `--help` del comando raíz resuelve cada uno para listar las descripciones, así que
  la salida es idéntica y solo `--help` raíz paga la carga completa.
- **Por qué hace falta un probe.** El perfil disponible es de `--version` (0.12.1, 1.55 MB, loadavg
  47, así que solo valen las proporciones): `compileSourceTextModule` 28 %, evaluación de nivel
  superior 22 %, `undici` ~10 %. Pero los caminos calientes de los hooks (`tools session-context`,
  `plan gate`) importan `readConfig` y, con él, zod, que es la mayor parte del bundle
  (`check-bundle-size.mjs`). Ese código seguiría en el chunk compartido, y la ganancia en esos
  comandos es incierta.
- **Probe de M0 (`probe-lazy-load.mjs`).** Por cada subcomando caliente (`tools`, `plan`):
  - empaqueta una entrada mínima que solo importa ese comando, con las opciones de
    `tsdown.config.ts` y sin splitting. Es la cota superior de lo que el chunking puede lograr;
  - mide el arranque en frío de `node <entrada> <sub> --help` frente a `node dist/index.js <sub>
    --help`: 10 corridas alternadas, en reposo (D10), mediana.
- **Regla.** Si el ahorro es **menor a 20 ms** en `tools session-context` y en `plan gate`, M3 se
  retira. D8 queda con la medición y el motivo, y `src/cli.ts` se crea en M4 solo como export con
  imports estáticos (para R17). En ese caso, la alternativa barata (diferir la carga de zod/config al
  primer uso) se reporta como posible spec aparte, no se hace aquí.
- **Umbral propuesto para R14 (lo enmienda el orquestador).** Arranque en frío de `navori tools
  session-context` y de `navori plan gate`: mediana de 10 corridas en reposo al menos **20 % menor** que
  la base, y al menos **20 ms** menos en términos absolutos. `navori --version` no puede quedar peor
  que la base.
- **Layout (si M3 entra).** Los chunks van en la raíz de `dist/`, junto a `index.js`.
  `bundled-assets.ts` calcula `HERE` del `import.meta.url` del chunk que lo contenga, que sigue siendo
  `dist/`, y `cli-lazy-load.test.ts` lo fija. Un `navori` global enlazado por symlink resuelve los
  chunks por realpath; `bench:hooks` lo ejercita porque usa justo un symlink a `dist/index.js`. El
  sello de `ensure-dist` (0054 D2) no cambia: hashea entradas, no salidas.
- **`undici` en el arranque.** M3 identifica qué módulo lo carga. Si es un import de nivel superior en
  `update-notice.ts` o `tool-version-notice.ts`, se difiere al worker. Si no, se reporta y no se
  persigue.

### D9 — zsh solo donde el shell cambia el resultado (R16)

- **La red es el corpus, no la clasificación.** No existen tokens `Covers: #344/#365/#391` en los
  tests (0 coincidencias), así que clasificar a mano cientos de casos no tiene ancla mecánica.
  `hooks-zsh-parity.test.ts` reproduce el corpus **completo** de D2 bajo zsh y lo compara byte a byte
  con la salida de bash. Usa un lote por hook y shell, así que su costo es despreciable. Eso cubre las
  construcciones que difieren (separación de palabras, globbing y `nomatch`, NUL, unicode, `printf -v`,
  `read -d ''`, `$0` en funciones, `set -u`), porque el corpus las trae de los tests reales.
- **`shellSensitive(motivo)`** queda para los casos de la suite que el corpus no puede reproducir
  (estado git o fixtures) y cuyo resultado depende del shell. Cada uno lleva el motivo con la
  construcción concreta. Un test de lint exige que el motivo no esté vacío.
- **Antes de reducir la matriz (condición de M4):** una corrida con `NAVORI_TEST_ALL_SHELLS=1` en CI
  (`workflow_dispatch` con `all_shells`, ubuntu con zsh) y otra en macOS local, con la rama de M2 y sin
  divergencias. Ambas se citan en el commit de M4.

### D10 — Mediciones: comparabilidad y presupuesto (R1–R3, R29, R30)

- **Comparable (R2).** `comparable = loadavgBefore[0] <= workers`. `loadavgAfter` se registra como
  dato: al final, la carga de 1 minuto incluye a la propia suite (4 workers más ~6 000 hijos), así que
  usarla marcaría toda corrida como no comparable. `workers` sale de `NAVORI_TEST_WORKERS` o de
  `resolveMaxWorkers` (`vitest.workers.ts`), importado desde el `.mjs` con el type stripping de
  Node 24. **UNVERIFIED**: si el import falla, `bench:tests` fija `NAVORI_TEST_WORKERS` y lo registra.
- **Procesos por archivo (R1)** son los hijos *directos* del worker. Los nietos (los `jq` de un hook)
  no se pueden observar de forma portable desde Node; los cubre R3 por hook.
- **Execs por hook (R3).** Shims en el PATH (Components A), en una pasada separada de la de tiempo. Un
  comando invocado por ruta absoluta escapa al conteo; un test exige que los hooks gestionados no usen
  rutas absolutas a esos programas.
- **Protocolo en reposo** (R29, R30): tres corridas por lado, alternando base y rama, cada una
  comparable; se reporta la mediana. La base es un worktree temporal del merge-base con `bun install
  --frozen-lockfile --ignore-scripts`, eliminado al terminar.
- **Presupuesto (R30).** `check-test-budget.mjs --propose` toma los bench comparables y propone
  `ms = ⌈max(3 corridas) × 1.25⌉` redondeado a 5 s. Solo es excepción el archivo que supere
  `defaultMs`, y el motivo cita la medición.

### D11 — Preservación genérica (R21)

- El script descubre los `*.test.ts` cambiados **o borrados** contra el merge-base de `--base`
  (default `origin/dev`, después `dev`). Por cada uno exige que el número de casos no baje más que
  `removedCases` y que el conjunto `Covers:` no pierda tokens.
- **Archivo borrado:** todos sus casos deben aparecer en `removedCases` o en un `merges.from`.
- **Archivo movido:** con `--no-renames` aparece como borrado más alta, así que se declara en
  `merges` (`into`/`from`), que ya existe.
- **Tablas.** `countCases` cuenta un `it.each` una vez (límite conocido de 0054). Las reescrituras de
  0055 usan filas con `id:` y `rowIds: true`, y una fusión de tablas sin `rowIds` es un punto ciego
  declarado.
- **Cableado.** `check:tests-preserved` entra en `check` y en `qualityGate.full`. En push a `dev`, el
  merge-base es `HEAD` y el paso es trivial; el valor está en el PR y en el gate local.

### D12 — `test:affected` con base y regla de hub medida (R24)

- **Base.** `--base <ref>` o `NAVORI_AFFECTED_BASE`; sin ninguno, la cadena de hoy (`origin/dev`,
  `dev`). En CI de PR: `origin/${{ github.base_ref }}` (el checkout ya usa `fetch-depth: 0`).
- **Evidencia (0045).** `specs/0045-review-adaptativo/design.md`, decisión "sin selector de tests":
  `vitest related` sobre los módulos hub `src/lib/config/config.ts` y
  `src/engines/shared/permission-rules.ts` seleccionó 241 archivos y tardó 518 s, contra ~408 s de la
  suite completa. El selector cuesta más que la suite cuando el conjunto relacionado es grande.
- **Regla por salida, no por entradas.**
  - `test-import-graph.mjs` estima `estimatedFiles`: los tests cuya clausura estática de imports
    contiene algún cambio, más los que eligen las reglas de texto existentes.
  - **Full** si `estimatedFiles ≥ 40 %` de los archivos de test. Es el umbral donde 0045 midió la
    inversión: 241 de ~436 archivos ≈ 55 %, ya más lento que full. 40 % deja margen.
  - Los dos módulos de 0045 quedan como **hubs declarados** (full directo, aunque el grafo estime
    menos), con su cita.
  - M0 mide el fan-in de todos los módulos con el mismo grafo y publica en "Línea base y resultado"
    los que superan el 40 %. Se suman a la lista solo si la estimación no los cubre (por ejemplo,
    imports dinámicos).
  - Siguen los disparadores de hoy de `planAffected` (`trigger`: `vitest.*`, `tsconfig*`,
    `package.json`, lockfile).
- **Una sola invocación.** `vitest related --run <fuentes…> <tests…>`. **UNVERIFIED** (afecta solo el
  costo): si vitest no acepta un test como ruta relacionada consigo misma, se conservan las dos
  invocaciones de hoy.
- **`--plan-json`** imprime el plan sin correr nada; CI lo usa para decidir la matriz (D13).
- **Salida.** Abre igual (`test:affected: affected subset, not a gate`) y usa el reporter `compact`.

### D13 — CI: shards en push y en PR completos; afectados en el resto (R23–R25)

- **Matriz única de suite completa** (`test` + `test-merge`). Corre en:
  - push a `dev`/`main`;
  - PR con `base_ref == main` (siempre: hay pocos PRs de release y el push a `main` es irreversible);
  - PR cuyo `plan` (D12) diga `full`.

  Así un PR que dispara la suite completa nunca corre en una sola máquina.
  - `test`: 4 shards, `run-test-coverage.mjs --shard i/4`, que corre `vitest run --coverage
    --reporter=blob --shard=i/4` con `NAVORI_COVERAGE_SHARD=1` (sin umbrales por shard) y sube
    `.vitest-reports/`.
  - `test-merge`: `run-test-coverage.mjs --merge`, que exige N blobs y corre `vitest --merge-reports
    --coverage --reporter=json`, después `check-coverage-floor.mjs` y `check-test-budget.mjs` (factor
    2, como hoy). En un PR completo el piso también corre: son los mismos jobs.
- **PR afectado** (`plan.full == false`, base `dev`). El job `affected` corre el subconjunto sin
  cobertura y con presupuesto por archivo. `checks` corre siempre.
- **Merge de cobertura desde blobs.** Lo introdujo vitest PR #5736 (fuentes secundarias; las páginas
  oficiales de CLI, reporters y coverage consultadas no lo mencionan). **UNVERIFIED** y bloqueante para
  M6: un probe local con 2 shards debe dar el mismo `coverage-summary.json` que la corrida sin shards.
  Si no coincide, el fallback es que cada shard escriba `coverage-final.json` y `test-merge` los combine
  con `istanbul-lib-coverage`, que ya está en el lockfile como transitiva de `@vitest/coverage-v8` (sin
  dependencia directa nueva).
- **N = 4, con cota inferior medida.** `--shard` reparte por archivo, así que la pared de un shard no
  baja de su archivo más lento: hoy `slice.test.ts` tiene un presupuesto de 360 s, fuera de alcance. El
  probe de M6 reporta la pared de cada shard y la duración de `slice` en CI. Si un shard queda dominado
  por un archivo, se declara ese piso en la tabla de resultado, y N se elige por medición (de 3 a 6), no
  por la estimación de ~447 s / 4 (run `38945840400`).
- **Protección de ramas.** `main` y `dev` no tienen branch protection ni rulesets (verificado por el
  orquestador con `gh`), así que partir `quality` no rompe checks requeridos.

### D14 — Reporter compacto (R26, R27)

- Se implementa con `onTestRunEnd(testModules, errors, reason)` (API de reporters de Vitest ≥3), más
  `testModule.errors()` para los fallos de colección y de hooks de ciclo de vida (`afterAll`, el guard
  de `HOME` de `vitest.setup.ts`). Recibe por `onUserConsoleLog` la salida de consola de los casos que
  fallan (`silent: "passed-only"`) y la asocia a su caso. No extiende `DefaultReporter`, para no atarse
  a su salida interna.
- **Rojo, en orden:**
  1. errores globales y de módulo, con tope de 2 KiB en total;
  2. una línea por caso fallido (`FAIL <archivo> > <nombre>`), hasta 50, más `… <k> more failed`;
  3. el detalle de los 10 primeros: aserción, diff y `console` del caso, 1 KiB por caso, recortado por
     el medio (`truncateMiddle` de `lib/gate/summary.ts`, que conserva cabeza y cola), porque la causa
     suele estar al final del stack.

  El agente ve todos los nombres en una pasada y no reintenta para descubrir qué más falló.
- **Por qué no `minimal`.** Vitest trae `minimal` (alias `agent`), que en verde no imprime nada y se
  activa solo al detectar un agente. R26 pide la línea de totales que lee `summary.ts` (`TOTALS` casa
  `Tests:`), y la detección automática haría distinta la salida según quién corre. El reporter propio es
  determinista: TTY → `default`; si no → `compact`.
- `bench:tests` y CI pasan `--reporter` explícito, que reemplaza a los de config: no les afecta.

## Contracts

- **Entorno de hook en tests** (`createTempFile`): `HOME`, `USERPROFILE`, `TMPDIR`/`TMP`/`TEMP`,
  `NAVORI_BACKUP_ROOT`, `NAVORI_AUDITS_ROOT` (inexistente), `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL`, `GIT_TEMPLATE_DIR`, `XDG_CONFIG_HOME`. Se borran `CODEX_HOME`, `GIT_*`,
  `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`, `NAVORI_AUDIT_HOST` y `NAVORI_AUDIT_SESSION_ID`. Un
  `env` explícito del test gana.
- **Payload de hook.** Sin cambios de forma. Contrato interno nuevo:
  - `nv_payload_fields`: rutas `[A-Za-z0-9_.]+` separadas por espacios, declaradas antes del primer
    include y que resuelven a escalares;
  - `payload_load`: idempotente mientras `payload` no cambie (`_nv_pf_src`);
  - `payload_field`: la caché por delante cuando la ruta está declarada y `payload` no cambió; si no,
    el camino de hoy.
- **Auditoría.** El evento conserva campos, formato y precisión. Única excepción: `ms: 0` en los
  eventos de los hooks que corren mientras nace el log (D4).
- **CLI.**
  - `src/cli.ts` exporta `main`; con M3, los `subCommands` son funciones `() => Promise<CommandDef>`.
  - Con M3, `dist/` = `index.js` + `<name>-<hash>.js` + `assets/`.
  - `tools session-context` gana `--notice-reserve <bytes>` (opcional; sin él no hace ack, como hoy).
  - `test-affected.mjs` gana `--base`, `--files` y `--plan-json` (`{ full, reason, related, tests,
    estimatedFiles }`).
- **Bench JSON** (`.navori/state/bench/`), todos con `generatedAt`, `cpus`, `loadavgBefore`,
  `loadavgAfter`, `workers` y `comparable`:
  - `tests-<ts>.json`: lo de hoy + `files[].spawns` y `sumSpawns`;
  - `hooks-<ts>.json`: `measurements[]` con `{ engine, event, hook, scenario, audit:
    "absent"|"root"|"active", wallMsMedian, cpuMsMedian, runsMs[], execs: { jq, node, perl, git,
    navori, … } }`;
  - `context-<ts>.json`: `{ sessionStart: { claude, codex }, hooks: [{ engine, hook, scenario, bytes
    }], gate: { green }, testAffected: { green, red } }`, todo en bytes UTF-8;
  - `lazy-<ts>.json` (probe de D8): `{ sub, bundleMs[], isolatedMs[], savingMsMedian }`.
- **`removedCases`.** En `test-preservation.config.json`, `files[]: { path, removedCases?: string[],
  reason?: string }` y `merges[]: { into, from[] }`. Cada título borrado va literal y el motivo es
  obligatorio cuando hay `removedCases`. El caso que absorbe conserva los `Covers:` del borrado.
- **Corpus de veredictos.** JSONL `{ hook, shell, input, envDelta, cwdKind: "none"|"repo", expected: {
  off: { status, stdout, stderr }, active: { status, stdout, stderr, event } } }`. Solo se regenera en
  M0 o con una spec que cambie veredictos a propósito.

## Failure modes

- **Detección del log de auditoría:**
  - el log nace durante el hook, o en un hook paralelo del mismo evento → re-chequeo al salir, `ms: 0`
    (D4);
  - repo con nombre que empieza por punto → globs de directorios ocultos (D4) y un test con un repo
    `.foo`;
  - `session_id` duplicado, escapado o ausente (un `tool_input` MCP con su propio `session_id`, o un
    engine sin la clave) → encendido, el costo de hoy;
  - `.armed` de otro repo → encendido de más (solo costo);
  - `nomatch` de zsh en el glob → `null_glob` local; un test corre `navori_audit_begin` bajo zsh sin
    logs.
- **Caché de campos:**
  - el hook reasigna `payload` (la lane de aceptación de `routing-watch`) → la caché no casa con
    `_nv_pf_src` y se lee del payload actual (D3);
  - `payload_load` llamado en subshell → la caché se pierde y el siguiente `payload_field` vuelve al jq
    de hoy. Es correcto pero más caro, y lo caza el test de conteo por hook y engine;
  - campo no declarado o declarado después de un include → camino de hoy; lo cazan el drift test y el de
    conteo;
  - anomalía de extracción → repetición campo por campo (0054 D10). Nunca deja vacío "por error".
- **Carril de fallos (D5):** payload grande → por stdin, sin límite de argv; `jq` ausente o < 1.6 → el
  carril calla sin advice (no hay veredicto que perder: el hook es advisory y sale 0).
- **Carga perezosa (si M3 entra):**
  - chunk faltante en `dist/` (publicación parcial) → `import()` rechaza y citty imprime el error con
    exit 1. Lo cubren el smoke e2e por subcomando y `cli-surface.test.ts`;
  - un chunk fuera de `dist/` rompería `HERE` en `bundled-assets.ts`, y `cli-lazy-load.test.ts` lo
    fija;
  - `check:size` pasa a sumar: el límite (1600 KB) se mantiene sobre el total.
- **e2e en proceso:** lo que el proceso real tiene y el helper no.
  - Pérdidas: códigos de salida por señal, vaciado de stdout al salir con `process.exit`, resolución
    de assets desde `src/` (otro `HERE`) y estado de módulo compartido entre casos (cachés de
    `readConfig`).
  - Mitigación: el helper falla si queda un `exitCode` sin reportar, y queda un smoke de exit real por
    subcomando contra `dist/`.
- **Merge de shards:**
  - la cobertura no se combina igual → probe bloqueante en M6 y fallback `istanbul-lib-coverage`
    (D13);
  - falta un blob (shard cancelado) → `test-merge` falla si el número de blobs ≠ N;
  - umbrales evaluados por shard → `NAVORI_COVERAGE_SHARD=1` los vacía;
  - un shard dominado por un archivo lento → piso declarado (D13).
- **HOME hermético contra tests que necesitan `HOME`:**
  - los que siembran `$HOME/.navori/audits` pierden su raíz por `NAVORI_AUDITS_ROOT` →
    `auditsUnderHome`; M1 los censa y la suite completa en M1 los delata;
  - los que esperan `.git/hooks/*.sample` → `GIT_TEMPLATE_DIR` mínimo; M1 los censa (`grep .sample`);
  - los que dependían de un `CLAUDE_PROJECT_DIR` heredado eran no deterministas; pasan a fijarlo.
- **Reporter compacto en CI:** CI no es TTY y ve `compact`. Los fallos salen con nombre, aserción, diff
  y consola recortada por el medio. Un error fuera de un caso (colección, `afterAll`) sale en la sección
  de errores. El log completo de un caso truncado se recupera con `--reporter=default` local.
- **Riesgo aceptado (decisión del usuario): en PR afectado no corren el piso de cobertura ni la suite
  completa.**
  - Un PR puede mergearse verde a `dev` y dejarlo rojo: un test afectado que el grafo estático no ve
    (import dinámico, lectura de archivo por ruta) o un piso de cobertura que baja.
  - Lo caza el push a `dev` (R23), y el PR `dev → main` siempre corre completo (D13), así que el rojo
    no llega a `main`.
  - Mientras `dev` esté rojo, los PRs siguientes pueden mergearse sobre esa base. No se agrega una
    compuerta de salud de `dev`; se corrige con el siguiente commit.

## Migration

- **Estado del carril de fallos:** las filas viejas (sha256) no casan con las nuevas
  (`git hash-object`) y el conteo de "3 fallos iguales" reinicia una vez por sesión activa durante la
  actualización.
- **`dist/` con chunks:** un `navori` global actualizado reemplaza el directorio completo (npm). Un
  `dist/` local viejo se recompila por el sello de `ensure-dist`.
- **CI:** los nombres de job cambian (`quality` → `checks`, `plan`, `test`, `test-merge`, `affected`).
  `main` y `dev` no tienen checks requeridos, así que no hay nada que actualizar en GitHub.

## Testing strategy

Cada test responde a un riesgo con nombre.

- **Veredicto distinto tras optimizar un hook** → `hook-verdict-replay` en modos `off` y `active` sobre
  el corpus de M0 (D2), más la suite sin modificar durante M2, con la matriz bash×zsh completa.
- **Un hook sigue pagando el timestamp sin log activo** → test que **fuerza el camino sin
  `EPOCHREALTIME`**. El driver hace `unset EPOCHREALTIME` y sustituye `navori_audit_now` por un
  contador que escribe en un archivo, tras incluir la parcial. Con raíz presente y sin log, para
  `guard-destructive`, `routing-watch` y `role-guard`: contador 0. Corre en bash y zsh. Sin el `unset`,
  el test sería vacío en bash 5 (CI), que nunca llama a `perl`. El conteo de `perl` del bench es
  informativo y solo de macOS.
- **Log activo sin evento, o con otro formato** → el modo `active` del replay, más el caso de carrera
  (log creado por el propio hook ⇒ evento con `ms: 0`) y el de repo `.foo` ⇒ evento escrito.
- **Más de un `jq` por hook** → test parametrizado por hook **y engine** (`.claude/`, `.codex/`,
  `.pi/navori/`) con los payloads del bench y el shim: `execs.jq ≤ 1` sin contar el jq de auditoría
  activa.
- **Caché obsoleta tras reasignar `payload`** → `routing-watch` con la lane de aceptación de Codex: la
  evidencia escrita lleva el `command`/`cwd` del payload de aceptación, no los del original.
- **Caché con otra forma de valor** → equivalencia por ruta declarada entre la caché y el
  `payload_field` de hoy, con `false`, `0`, `""`, salto de línea final, `tool_input` string y una ruta
  que resuelve a objeto (debe estar fuera de las listas).
- **Caché no declarada o declarada tarde** → drift test de `nv_payload_fields` (D3).
- **Normalización de errores distinta tras quitar Node** → tabla oráculo de ~30 mensajes (rutas, home,
  tmp, fechas, duraciones, hashes, ANSI) más uno de 300 KiB. Se evalúa con el `node -e` viejo, copiado
  en el test como oráculo, y con el `jq` nuevo: mismo `body`, mismo conteo y mismo advice. Es la
  compuerta de D5.
- **Arranque con más de un CLI** → `session-start-context` con un `navori` falso que cuenta
  invocaciones: 1 con aviso y ack, 1 sin aviso (R11 enmendado excluye arm y resume de Codex).
- **Contexto inyectado sin nada que señalar** → un test por hook y engine con el payload neutro de
  `bench:context`: stdout vacío (R28).
- **Subcomando que carga a los demás** (si M3 entra) → `cli-lazy-load.test.ts` (D8).
- **Salida o exit distintos del CLI** → `cli-surface.test.ts` contra el golden de la base, más los
  casos e2e movidos en proceso con su misma aserción.
- **Referencia al home real** → la regla `no-real-home-in-tests` con sus tests de regla (`ast-grep
  test`): un literal `/Users/x` fuera de la allowlist falla; uno dentro, con motivo, pasa.
- **Git del usuario filtrado** → test de entorno: `git config --list --show-origin` dentro de un test
  no muestra orígenes fuera del root temporal.
- **Matriz reducida que oculta una divergencia** → `hooks-zsh-parity.test.ts` con el corpus completo,
  más las corridas con `NAVORI_TEST_ALL_SHELLS=1` previas, en CI y local (D9).
- **Lotes con auditoría activa que se pisan** → test de `runHookBatch` con `lanes: 1`: N eventos en el
  log, sin pérdidas.
- **Caso borrado sin declarar** → `check-test-preservation.test.ts` gana casos para descubrimiento por
  diff, archivo borrado, archivo movido vía `merges` y motivo obligatorio.
- **Espera fija o `git init` por caso reintroducidos** → reglas ast-grep con sus tests de regla.
- **Aserción de prosa reintroducida** → regla `no-prose-assertion` con sus tests de regla.
- **Shards que no suman lo mismo** → probe de M6 (D13) y, en `test-merge`, conteo de blobs igual a N y
  `numTotalTests` igual al de un `vitest list` del mismo commit.
- **Hub no detectado** → test de `planAffected`: un cambio en `config.ts` o `permission-rules.ts` ⇒
  `full`; un plan con `estimatedFiles` ≥ 40 % ⇒ `full`; un cambio en una hoja ⇒ subconjunto.
- **Salida verde que crece** → `bench:context` contra la línea base; en `summary.ts`, un test de verde
  con logs de vitest y de cobertura ⇒ una línea por runner.
- **Salida roja que esconde fallos** → test del reporter con fixtures: un fallo de aserción, un fallo
  de colección (import roto), un `afterAll` que lanza y 60 casos fallidos. Se esperan los errores de
  módulo presentes, 50 nombres más `… 10 more failed`, 10 detalles con tope de 1 KiB y la cola del
  stack conservada.

Los bench (`bench:tests`, `bench:hooks`, `bench:context`, `probe-lazy-load`) son criterios `A<n>`, no
tests de la suite.

## Línea base y resultado

**Preliminar** (2026-10-16, investigación previa a la spec, carga no controlada; M0 la reemplaza con
tres corridas comparables).

| Métrica | Preliminar | M0 (reposo) | Final (reposo) | Objetivo |
|---|---|---|---|---|
| Suite local, pared | 380 s (0054 T43, reposo) | — | — | baja (sin cifra fija en R) |
| Suite local, suma por archivo | 1 438 s (0054 T43) | — | — | — |
| Procesos por corrida | ~6 000 | — | — | — |
| CI, paso de tests | ~447 s (run `38945840400`) | — | — | 4 shards + merge |
| `guard-destructive` | 41 ms (raíz de auditoría presente) / 10 ms sin raíz | — | — | ~10 ms con raíz y sin log (R8) |
| `routing-watch` | 53 ms (jq ×5, git, perl) | — | — | jq ≤ 1 (R10) |
| `role-guard` | 54 ms | — | — | jq ≤ 1 |
| `bash-outcome-watch` (fallo) | 48 ms (node ≈ 28) | — | — | sin node (R12) |
| `implementer-no-markdown` | 34 ms | — | — | jq ≤ 1 |
| `quality-gate-pre-commit` | 42 ms | — | — | jq ≤ 1 |
| `plan-gate` | 161 ms (navori ≈ 122) | — | — | baja con R14 |
| `session-start-context` | 474 ms (navori ×3, CLI global 0.12.1) | — | — | 1 CLI (R11) |
| `audit-mode-close` | 139 ms | — | — | — |
| `navori` en frío | 114–128 ms (`node -e 0` = 28 ms) | — | — | baja con R14 |
| Bytes de `SessionStart` | — | — | — | registrado (R4) |
| Bytes de `test:affected` / gate en verde | — | — | — | 1 línea de totales por paso (R26) |
| Hooks con contexto sin nada que señalar | sin confirmar | — | — | lista vacía (R28) |
| Cobertura del corpus por hook (casos, % de sus tests) | — | — | — | publicada; < 60 % ⇒ regla de D2 |
| Probe de carga perezosa: ahorro en `tools`, `plan` | — | — | — | ≥ 20 ms o M3 se retira (D8) |
| Hubs medidos (fan-in de tests ≥ 40 %) | `config.ts`, `permission-rules.ts` (0045) | — | — | lista de D12 |
| Pared por shard / archivo más lento en CI | — | — | — | piso declarado (D13) |

## Milestone order

Una entrega: un PR a `dev`. Commits atómicos por milestone, y **M2 en un commit por mecanismo** para
que sea bisectable en un área crítica, con el replay verde en cada uno. Las LOC estiman código y
tests, sin contar fixtures generados.

| M | Contenido | R | Depende de | LOC |
|---|---|---|---|---|
| **M0 — Medición** | wrapper de procesos, `bench:tests` (spawns, comparable), `bench:hooks` (CLI local, escenarios de auditoría, shims, por engine), `bench:context`, `test-import-graph.mjs` y medición de hubs, `probe-lazy-load.mjs`, captura del corpus (off y active) y del golden de CLI desde la base, cobertura del corpus por hook, línea base en reposo | R1–R4, R29 (base) | — | ~650 |
| **M1 — Hermético** | `createTempFile`, `auditsUnderHome`, regla `no-real-home-in-tests` con allowlist, censo y arreglos; **re-medición** (cambia la base) | R5–R7 | M0 | ~250 |
| **M2a — Auditoría** | D4 | R8, R9 | M0, M1 | ~250 |
| **M2b — Caché de campos** | D3 en 22 hooks y 3 engines, drift test, conteo por engine | R10 | M2a | ~450 |
| **M2c — Fallos sin Node** | D5 con la tabla oráculo; sale de la entrega si la compuerta no da 100 % | R12 | M2b | ~350 |
| **M2d — Sesión y contexto** | D6 (`--notice-reserve`), R28 según la lista de M0, render de espejos, replay final | R11, R13, R28 | M2c | ~200 |
| **M3 — CLI perezoso** | **solo si el probe de M0 da ≥ 20 ms**: `src/cli.ts`, `tsdown` con chunks, `check:size`, test de carga | R14, R15 | M0 | ~250 |
| **M4 — Suite** | shells y paridad con corpus (D9), e2e en proceso, lotes, plantillas git, `vi.waitFor`, prosa, preservación genérica y reglas ast-grep | R16–R22 | M1, M2 (corpus validado), M3 o un `src/cli.ts` estático | ~2 500 cambiadas (neto negativo) |
| **M5 — Tokens** | reporter `compact`, línea del piso, `summarizeGreen` | R26, R27 | M0 | ~350 |
| **M6 — CI** | `test:affected` (`--base`, `--plan-json`, hub por salida, una invocación), `run-test-coverage --shard/--merge`, `ci.yml`; **probe de cobertura y de pared por shard primero** | R23–R25 | M4, M5 | ~300 |
| **M7 — Cierre** | tres corridas en reposo por lado, tabla final, `check-test-budget --propose`, `test-budget.json` | R29, R30 | todos | ~80 + datos |

M2 completo (~1 250) y M3 son independientes entre sí. M5 va antes de M6 porque los dos tocan
`test-affected.mjs` y la salida de CI. M4 no reduce casos de un hook con cobertura de corpus menor al
60 % hasta que M2 esté verde (D2).

## Preguntas abiertas (para el orquestador)

Resueltas: R7 (solo estático) y R11 (camino común) ya están enmendados en `requirements.md`. CI: `main`
y `dev` no tienen protección de ramas ni rulesets, así que partir `quality` no rompe checks requeridos.

Aplicadas en `requirements.md` (2026-10-16) las cinco enmiendas siguientes:

1. **R14:** agregar el umbral de D8. Arranque en frío de `navori tools session-context` y `navori plan
   gate` al menos 20 % y 20 ms menor que la base (mediana de 10, en reposo), y `--version` no peor. Si
   el probe de M0 da menos de 20 ms, R14 sale de esta entrega.
2. **R9:** declarar la excepción `ms: 0` para los eventos de hooks que corren mientras nace el log
   (D4).
3. **R24:** la suite completa en PR (por hub medido o con base `main`) es una excepción de seguridad
   que debería figurar en el propio requisito, no solo en D12/D13.
4. **R16:** la red es el corpus completo bajo zsh (D9); "casos marcados" queda para los que el corpus
   no reproduce. Conviene reflejarlo en el texto.
5. **R12:** queda condicionado a la compuerta de equivalencia de D5 (100 % con la tabla oráculo); si no
   se cumple, sale a una spec aparte.

## NOT in scope

- Optimizar `fingerprintTree` u otro código de producto que domine `slice`/`escalation` más allá de lo
  que hizo 0054 R35.
- Cambiar `maxWorkers`/`WORKER_CAP` (0054: subir a 8 regresó bajo carga). M7 puede re-medir, sin
  compromiso.
- `isomorphic-git` (D7), Rust/napi, `bun test`, shells alternativos, bats, `es-git` y runners más
  grandes: descartados en `requirements.md`.
- Cambiar el formato del log de auditoría o la vía rápida de `plan-gate`.
- Reemplazar `perl` en `navori_audit_now` con log activo (R9 conserva el camino).

## Durable knowledge

Destino propuesto; no se escribe en esta fase.

- Convenciones de tests: zsh solo con `shellSensitive(motivo)`, plantillas git por archivo,
  `vi.waitFor` en lugar de esperas, sin aserciones de prosa y `removedCases` con motivo →
  `CONTRIBUTING.md`, sección nueva "Tests" junto a "Parciales de hook y su test de comportamiento".
- "La auditoría de hooks se decide por log activo, con builtins" y "un hook extrae el payload con a lo
  más un `jq` (`nv_payload_fields` + `payload_load`)" → encabezados de `_partials/audit-log.sh` y
  `_partials/extract-cmd.sh`.
- "`dist/` son chunks en su raíz; ningún chunk fuera de `dist/`" → comentario de `tsdown.config.ts`
  (reemplaza el actual "single `dist/index.js`").
- Protocolo de medición en reposo (comparable = loadavg inicial ≤ workers; tres corridas alternadas) →
  `CONTRIBUTING.md`, junto a `bench:tests`.

## Fuentes

- Vitest, Improving Performance (sharding, blob, `--merge-reports`),
  https://vitest.dev/guide/improving-performance, consultada el 2026-10-16. No dice si la cobertura se
  combina.
- Vitest CLI (`--shard`, `--merge-reports`), https://vitest.dev/guide/cli, consultada el 2026-10-16.
- Vitest Reporters (`minimal`/`agent`, `blob`, `summary: false`), https://vitest.dev/guide/reporters,
  consultada el 2026-10-16.
- Vitest Coverage, https://vitest.dev/guide/coverage, consultada el 2026-10-16. No menciona sharding.
- Merge de cobertura desde blobs: vitest PR #5736 (https://github.com/vitest-dev/vitest/pull/5736) y el
  Knapsack Pro Vitest cookbook (https://docs.knapsackpro.com/vitest/cookbook), consultados el
  2026-10-16. **[SIN VERIFICAR]** contra la documentación oficial; lo cierra el probe de M6.
- citty 0.1.6, tipos `Resolvable` y `SubCommandsDef` en `packages/cli/node_modules/citty/dist/index.d.mts`
  (checkout principal).
- Perfil de CPU de `navori --version` 0.12.1 y `/usr/bin/jq` presente: medidos en esta máquina el
  2026-10-16, con loadavg 16–47 (solo proporciones).
