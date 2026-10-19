# Suite rápida: tests herméticos, hooks y CLI más baratos, menos tokens — Design

> **Enmienda de alcance (2026-10-19):** el cierre de este PR se reduce a documentación; la
> implementación queda preservada y el trabajo incompleto se transfiere a
> [#1354](https://github.com/UlisesCm/navori-harness/issues/1354). Las tablas y reportes históricos
> siguientes no prueban bytes actuales ni aceleración global. CI preliminar de `6396f0ed` falló
> (1 fallida/9642 aprobadas/1 omitida; causa zsh sin determinar; seguimiento
> [#1353](https://github.com/UlisesCm/navori-harness/issues/1353)). El diagnóstico Pi sigue
> inconcluso ([#1355](https://github.com/UlisesCm/navori-harness/issues/1355)); se conserva Node y no
> se afirma resultado del oráculo. Full actual, revisión independiente, receipt válido y CI funcional
> siguen pendientes; el fast fresco 9/0 no los sustituye. No se elevan límites ni se declaran
> completados R29/T39, M5/R12 o E1.
> El full del 2026-10-19 falló (164 fallidas, 9 567 aprobadas, 2 omitidas; 465 archivos; 32 707.7 s).
> Hubo un salto temporal entre inicio y resultado; la causa de los fallos no está determinada
> (`.navori/state/gate/full-20261019T044833225Z.log`).

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
  caché de campos. El carril de fallos sin Node (D5/R12) se difirió fuera de E1.
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

  Reporta mediana de pared y de CPU por hook, y `execs` por programa. — R3, R8, R10, R11
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
- `_partials/bash-outcome.sh`, `navori_bash_failure_state`, y `bash-outcome-watch.sh`: se conserva el
  carril Node actual. R12/D5 y el oráculo quedan diferidos fuera de E1 por decisión del usuario; no se
  ejecutó el oráculo ni se afirma un resultado. — R12 diferido
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
- `packages/cli/tsdown.config.ts`. `codeSplitting` pasa a activo con `chunkFileNames: "[name].js"`
  en la raíz de `dist/`, para que `bundled-assets.ts` (`HERE`) siga resolviendo `dist/assets/` y
  `dist/../package.json`. El build integrado conserva el límite de 1600 KiB, los 79 chunks, el
  layout raíz y el grafo perezoso; eliminar los hashes repetidos ahorra 3326 bytes (de 1640460 a
  1637134). — R14
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
  - Excepción acotada para líneas de diagnóstico de shell: el replay normaliza números de línea
    solo dentro de `stderr` en ambos lados de la comparación. Diferencias en `stdout`, estado de
    salida, evento de auditoría o mensaje de diagnóstico siguen siendo estrictas. Se conserva la
    paridad existente entre shells y el corpus comprometido no cambia.
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

### D5 — Carril de fallos sin Node (R12 diferido)

Por decisión explícita del usuario, M5/R12 sale de E1 antes de ejecutar el oráculo. El carril actual
con Node se conserva. No hay resultado de aprobado o fallido, y la propuesta técnica que sigue siendo
historia de diseño no autoriza una implementación. Una futura entrega puede reevaluarla con una
comparación contra el comportamiento actual; hasta entonces R12 no forma parte de los requisitos
activos de E1.

### D6 — Arranque de sesión con un solo CLI (R11)

`navori tools session-context` conserva el formato v1 por defecto. Con `--notice-reserve <bytes>`,
el CLI devuelve un encabezado v1 observable que identifica la reserva; el hook usa ese marcador para
saber que el ACK ocurrió dentro de la misma llamada y evita el segundo comando. El cuerpo del aviso se
mide en bytes UTF-8 y la reserva incluye el salto de línea de emisión. Solo se confirma el aviso cuando
ambas secciones del frame validan y caben en la reserva. Si falla la validación antes del ACK, el hook
usa el camino legacy; para un CLI antiguo que ignora el flag, el ACK legacy sigue después de emitir el
frame.

El hook sondea la disponibilidad del flag por stdout, descartando stderr de manera privada; no expone
ese sondeo al agente. Si no puede crear el archivo temporal de diagnóstico de forma segura, conserva el camino
legacy antes de confirmar el aviso. Si aparece una advertencia después de un frame ya confirmado, no
se descarta el contexto. La limitación aceptada sigue vigente: el ACK del CLI puede ocurrir antes de
que el hook alcance a emitir el frame; si el hook muere en ese intervalo, el aviso se pierde y sigue
visible en `navori doctor`. Se conservan también las excepciones de arm, resume de Codex y compatibilidad
con versiones anteriores.

El hook registra su ruta temporal como propia solo después de asignarla. El trap `EXIT` se instala con
esa variable inicializada antes, y limpia únicamente una ruta creada por esta invocación; un valor
heredado en `navori_sc_err` se conserva. Así el cleanup de diagnóstico no elimina un
archivo que el hook no creó.

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
- **Enmienda de implementación (2026-10-16).**
  - La paridad reproduce bajo zsh los 1 610 casos capturados en bash; los 1 386 capturados en zsh ya
    son salida de zsh y no agregan información de paridad.
  - Normaliza la redacción propia de los diagnósticos de cada shell y omite los hooks cuyo corpus trae
    un placeholder sin renderizar (`role-guard`, `engram-write-guard`). Sus tests con la política
    compilada se marcan `shellSensitive`, así que su política generada sigue corriendo en bash y zsh.
  - `KNOWN_DIVERGENCES` excluye un caso real: `plan-gate.sh` lee `$0` dentro de una función y bajo
    zsh la copia de Codex pide confirmación en vez de bloquear sin `navori`. Se corrige en los
    milestones de hooks; un test falla cuando el arreglo llega y obliga a quitar la entrada.
  - Lectura de R21: `check-test-preservation` cuenta casos fuente (`it(`); el eje de shells es una
    matriz, no casos. La garantía de zsh la dan la paridad del corpus y las marcas `shellSensitive`.
  - La paridad previa corrió en macOS local (1 524 de 1 524 casos iguales con la matriz completa); la
    corrida de CI con `all_shells` queda para M10.

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
- **Presupuesto (R30).** `check-test-budget.mjs --propose <bench.json…>` valida exactamente tres
  reportes exitosos, comparables y con `generatedAt` distintos; exige workers iguales, timings y
  carga finitos/no negativos, totales coherentes, y el inventario completo actual de tests en cada
  reporte. Un subconjunto filtrado no se acepta como medición de suite. Propone
  `ms = ⌈max(3 corridas) × 1.25⌉` redondeado a 5 s. Conserva `defaultMs`; solo genera excepciones
  para archivos que lo superen, con motivos que citan las tres muestras, y elimina excepciones ya
  obsoletas. La propuesta se imprime como JSON en stdout y no escribe `test-budget.json`; `--report`
  y la aplicación del factor existente siguen separados. La fórmula no depende del factor de
  enforcement. Para no truncar una propuesta grande enviada por pipe, el CLI fija `process.exitCode`
  y deja drenar stdout en vez de llamar inmediatamente a `process.exit`; la regresión parsea el JSON
  del inventario completo. La prueba finalSTREAM del productor pasó 59/59, sin omitidas, en 3 archivos/5.8 s
  (89195), y su fast gate salió 0 (`.navori/state/gate/fast-20261018T043501990Z.log`). Ese
  checkpoint describía la implementación antes de la continuación R30; las mediciones y la
  aplicación del presupuesto actuales se registran abajo. T12 tiene un checkpoint retrospectivo
  separado; las mediciones de hooks/contexto y el arranque de CLI siguen pendientes.

- **Extracción de `session_id` en D4.** El análisis de la cadena completa para encontrar una clave
  al final de un payload grande volvía a recorrer prefijos y crecía cuadráticamente. La primera
  candidata, con prefijo largo (`##`) y búsqueda global de duplicados, introdujo una regresión:
  el probe Bash con la clave al inicio de 132 000 caracteres ASCII agotó 3 s. Tampoco resolvió la ejecución real
  60201, anterior a STREAM: agotó el timeout de paridad de 300 s (exit 1;
  1 fallo/1 aprobado/0 omitidas, 333.6 s). La variante finalSTREAM consume segmentos delimitados
  por comillas con builtins `read -r -d` en el shell padre, desde here-string. Al encontrar
  `session_id`, conserva el sufijo para la detección original de duplicados y la validación de
  valor; el solapamiento malformado sigue rechazado por la comprobación original de dos puntos.
  Conserva el tratamiento conservador de anidados, tipos, escapes y ausencia, sin procesos nuevos.
  Las regresiones FRONT y TAIL de 132 000 caracteres ASCII deben pasar en Bash y zsh con el límite original de
  2 000 ms: probar solo TAIL ocultó el fallo de la primera candidata. Los probes de 16 000/64 000/132 000 caracteres ASCII, al inicio
  y al final en Bash y zsh, pasaron; a 132 000 caracteres ASCII midieron 138.8/488 ms en Bash (inicio/final) y
  75.3/78.4 ms en zsh. La diferencial de 335 entradas por shell (670 comparaciones) no encontró
  diferencias ni stderr. El intento acotado 82039 pasó 6 pruebas y omitió 18 (exit 0; 119.8 s
  incluyendo espera de lock). Los probes del orquestador `.navori/state/probes/audit-sid-stream-candidate.json`
  y `audit-sid-stream-differential.json` son evidencia del orquestador, no ejecuciones del productor.
  El productor declara las fuentes congeladas tras las pruebas focalizadas y el fast finalSTREAM.
- **Límites de la validación del orquestador.** El replay nativo separado 87835 terminó exit 0:
  2 996 veredictos idénticos con auditoría apagada y
  activa, 347.793 s y captura completa Bash/zsh. Su perfil está en
  `.navori/state/probes/0055-final-replay-profile.jsonl` (lote máximo 27.47 s, guard Claude Bash
  active, 386 casos) y el resultado en `.navori/state/probes/0055-final-replay-result.json`.
  Esto verifica replay/R13. La paridad forzada zsh sobre finalSTREAM, sesión 93018, también pasó: 2
  pruebas/0 omitidas en 1 archivo, 136.9 s con el timeout original de 300 s. La corrida acredita ese
  resultado funcional sobre la fuente actual, no una mejora comparable: las cargas entre pruebas
  difirieron. No se borra el fallo histórico 60201. En ese checkpoint seguían pendientes las tres
  corridas comparables, datos y presupuesto, comparación base/final, full gate y pared de CI; esta
  descripción antecede a la evidencia R29/R30 y T12 registrada más adelante. M6/M10 no recibieron por
  esa evidencia aprobación final ni commit.

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
  - El inventario `.navori/state/bench/graph-2026-10-16T19-40-36-398Z.json` midió 452 archivos de
    prueba, 257 módulos y 29 módulos con fan-in ≥ 40 %. Solo `config.ts` y
    `permission-rules.ts` son excepciones declaradas por 0045; los demás entran al cálculo de salida y
    activan full cuando la selección estimada llega al umbral. No se añadieron hubs declarados.
  - El grafo cubre imports relativos TypeScript bajo `src/`. Cambios a scripts fuera de ese grafo y a
    parciales compartidas de hooks fuerzan full. También fuerza full la falta de merge-base, los nombres
    de configuración/toolchain (`vitest.*`, `tsconfig*.json`, `package.json`, lockfiles y `bunfig.toml`),
    y los hubs declarados. Para hooks selecciona pruebas por ruta y por basename; cambios de
    `core-assets` agregan pruebas de render/golden.
- **Una sola invocación.** `test-affected.mjs` une fuentes y pruebas seleccionadas en un solo
  `vitest related --run`. La versión instalada Vitest 5.0.1 acepta cada test explícito como ruta
  relacionada consigo mismo; el test de `--plan-json` confirma que un test pasado mediante `--files` se
  selecciona directamente. La revisión del selector nativo confirma que las rutas relacionadas se
  incorporan al conjunto afectado antes del cierre de importadores. No queda pendiente la alternativa
  de dos invocaciones.
- **Rutas cubiertas por los probes.** Un plan explícito para un script wrapper fuera del grafo TS ahora
  fuerza full; la prueba de cambios de hooks selecciona 57 casos e incluye `guard-destructive.test.ts`
  y `guard-destructive-progress.test.ts`. El plan anterior seleccionaba 29 y omitía esos dos casos; la
  corrección evita declarar verde un subconjunto incompleto. Estos probes validan la clasificación y la
  selección, no sustituyen el full gate.
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
- **Merge de cobertura desde blobs.** Vitest 5.0.1 instalado acepta el transporte nativo. El probe
  `.navori/state/probes/0055-shard-merge/result.json` usó una fuente y dos tests en un fixture pequeño:
  el `coverage-summary.json` de la corrida sin shards coincide con el merge 2/2 y reporta 100 % en
  líneas, statements, funciones y branches. Tras publicar/copiar los blobs se borraron las carpetas
  temporales originales; el merge siguió funcionando. Un blob con versión distinta es rechazado por
  Vitest. Esto valida el mecanismo en el fixture, no la equivalencia de cobertura del full suite ni su
  rendimiento. La prueba integrada mantiene el piso y el presupuesto como dobles; tests unitarios
  separados fijan su orden, el conjunto completo N, fallos por fase y preservación de directorios del
  caller.
- **N = 4, con cota inferior medida.** `--shard` reparte por archivo, así que la pared de un shard no
  baja de su archivo más lento: la línea base de `slice.test.ts` tiene un presupuesto de 360 s, fuera de
  alcance de M10. La pared de cada shard y la duración de `slice` en CI quedan por medir en M11. Si un
  shard queda dominado por un archivo, se declara ese piso en la tabla de resultado, y N se elige por
  medición (de 3 a 6), no por la estimación histórica de ~447 s / 4 (run `38945840400`).
- **Protección de ramas.** Consulta GitHub de solo lectura el 2026-10-18 alrededor de las 02:30 UTC:
  `/branches/dev/protection` y `/branches/main/protection` devolvieron 404; `rules/branches/dev` y
  `rules/branches/main` devolvieron listas vacías. No se observaron entonces reglas de checks
  requeridos, por lo que la división del job `quality` no cambiaba un check protegido. No se modificó
  configuración de GitHub.
- **Límite de aceptación.** La prueba nativa de merge es un fixture pequeño y las pruebas de workflow
  son focalizadas. No demuestran equivalencia de cobertura del full suite, rendimiento por shard ni
  pared de CI; esas mediciones y el full gate verde siguen pendientes para M11.

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

### D15 — Paridad en dos proyectos nativos, sin solapamiento de archivos (M11)

**Decisión autorizada:** opción 2 de
`.navori/state/handoffs/architecture_0055-parity-scheduling.md`, contrastada con
`challenge_0055-parity-scheduling.md` y aplicada según `schedulingContinuation` de
`impl_0055-suite-rapida-e1.json`. La prioridad dentro de un grupo no impide concurrencia;
se adoptan dos proyectos inline `extends:true` en una sola invocación: `parity`, con el
archivo completo `hooks-zsh-parity.test.ts` y `groupOrder: 1`, y `suite`, con el resto y
`groupOrder: 2`. Los órdenes positivos conservan la barrera también con un worker.
No se añade runner, secuenciador ni invocación separada.

- Cada hijo declara su include; se retira el include amplio explícito de la raíz porque la
  herencia concatena arrays. La raíz resuelta conserva el default nativo, no un include amplio
  heredado por los hijos. Parity se excluye únicamente de la selección de `suite`, nunca de
  sus contribuciones a cobertura.
- Setup global, provide, reporters, cobertura y política de workers siguen siendo propiedad de
  la raíz; `setupFiles` se hereda una sola vez por hijo. El inventario resuelto real registra
  `forks` y workers raíz/parity/suite **4/4/4**, con `NAVORI_TEST_WORKERS`,
  `VITEST_MAX_WORKERS` y `NAVORI_COVERAGE_SHARD` sin definir. Se preserva la política de
  overrides existente: esto no establece un hard cap universal frente a overrides.
- La barrera separa ejecución de archivos y sus hooks esperados, no garantiza que todos los PIDs
  hayan terminado entre grupos. No reserva CPU global, no elimina carga externa u otras
  invocaciones y no promete mejora de pared ni que la paridad quede bajo 300 s.

**Evidencia acotada del mecanismo (no aceptación de la suite real).** El fixture inicial de
21 comandos pasó antes de integrar la configuración productiva; el probe final extendido pasó
sus 27 comandos en primer plano con Vitest 5.0.1 y Node v24.20.0. Evidencia archivada en
`.navori/state/probes/0055-parity-scheduling/`: `success.json`, `results.json`,
`provenance.json`, `fixture-inventory.json` y `fixture/`. El bloqueo histórico del pase de
arquitectura no es evidencia de ejecución; el productor declara que esta continuación autorizada
no recibió bloqueo ni hizo retry/bypass de un deny.

- Cinco archivos y cuatro fuentes medidas verifican con workers 1 y 2 que el fin de archivo/
  afterAll de parity precede a todo setup normal; setup/teardown global ocurren una vez,
  setup por archivo una vez e inject funciona en ambos proyectos. HOME y temporales son locales
  al fixture; no se adquiere el lock ni se hace el build productivo dentro de él.
- Aggregate y cuatro shards nuevos con merge nativo conservan inventario/casos exact-once y no
  ejecutan tests ni setup al fusionar. Coverage full/merge coincide profundamente por fuentes,
  mapas, denominadores y hits deterministas `s/f/b`: fuente nunca importada presente a cero,
  exclusiva de parity al 100 % y ambas ramas compartidas cubiertas. Los cuatro blobs y el merge
  proceden de una asignación nueva, misma configuración/hash, versiones y nombres de proyecto;
  no se reutiliza evidencia histórica.
- CompactReporter real combinado con JSON funciona en aggregate y merge; los controles de caso
  fallido, omitido, error de setup y error de módulo conservan estados, errores visibles y salida
  acotada. Los nombres de proyecto se verifican en specs nativos, no en un campo `projectName`
  inexistente del reporter JSON. Threshold negativo full/merge y controles reales copiados de
  floor y budget producen salidas finales no cero; sólo alteran datos/presupuestos del fixture.
  **C4:** el wrapper full local no ejecuta budget; ese control se invoca en merge. Un full verde
  no demuestra por sí solo presupuesto ni equivalencia full/merge de ese control.
- Focal parity/normal y related compartido/exclusivo/test explícito pasan en el fixture; related
  usa `affectedVitestArgs` con una invocación nativa por selección. El wrapper real conserva
  `full:true` ante un cambio en `packages/cli/vitest.config.ts`, sin editar afectados.

**Inventario y regresión reales, sin importar el corpus:** `globTestSpecifications` conserva los
464 paths previos exactamente una vez y añade únicamente el nuevo `vitest-scheduling.test.ts`
autorizado: **465 = 464 + 1** (`inventory-before.json`, `inventory-after.json`). Parity pertenece
una vez a `parity` y nunca a `suite`. La regresión versionada tiene tres casos: inventario nativo
y fixture mínimo con 1/2 workers reutilizando las declaraciones reales; el probe extendido queda
efímero. La corrida focal final pasó **78 pruebas/0 omitidas, 7 archivos, 2.3 s**;
`navori gate fast` salió 0 (`.navori/state/gate/fast-20261018T074413937Z.log`, AST 9/0).
Preservación estática independiente: 72 archivos cambiados/0 eliminados contra `origin/dev`
`a251417b`; no sustituye el inventario ni prueba selección del nuevo test aún sin stage.

**Continuidad y aceptación pendiente.** No se reemplaza la evidencia previa de M6/M10/M11 ni se
atribuye su autoría a esta continuación. Se conserva la reparación de guardas CI: 47 pruebas/0
omitidas, comparaciones bidireccionales CI/gate, checks incondicionales y equivalencia del wrapper
shard/merge con cuatro controles negativos; fast `fast-20261018T052630361Z.log` verde. También se
conserva el cambio del driver de lotes de `cat` a lectura builtin Bash/zsh, con el stripping legacy
de saltos finales intacto: 54 pruebas/0 omitidas y fast `fast-20261018T053604878Z.log` verde.
El inventario anterior y sus evidencias siguen referidos por los archivos inmutables
`.navori/state/archive/0055-m11-before-ci-guard/impl_0055-suite-rapida-e1.json` y
`.navori/state/archive/0055-m10-reviewed-pending-full/impl_0055-suite-rapida-e1.json`.

El full del orquestador anterior a esta configuración,
`.navori/state/gate/full-20261018T071303896Z.log`, falló únicamente por paridad a 300 s:
9 723 aprobadas, 2 omitidas y 1 fallo en 464 archivos/976.4 s. Se conserva como antecedente,
no como validación del routing nuevo. Posteriormente, el orquestador reportó el full
`.navori/state/gate/full-20261018T162643513Z.log` verde: exit 0, **9 727 aprobadas/2 omitidas,
465 archivos/853.1 s**, cobertura líneas/statements/funciones/branches
**87.59/85.94/90.2/80.5 %**, piso de **159 módulos/0 excepciones**. Ese gate precede a la
última reparación de consola+blob y hermeticidad del test; no acredita los bytes actuales.
El productor de esa reparación no ejecutó ni inspeccionó independientemente ese full.

El primer shard real (`T170505Z`) falló por `NAVORI_TEST_REPORT` heredado en una aserción
unitaria; el diagnóstico se extrajo del blob, sin publicar un blob de éxito. La continuación
hace hermético el default sólo en el test, conserva el contrato del reporte explícito del caller
y combina el reporter de consola elegido por TTY con blob en modo shard. La regresión nativa
pequeña comprueba nombre/aserción visibles, exit 1, ausencia de controles posteriores y directorio
de publicación de éxito vacío. Pasaron 16 pruebas focales con reporte heredado, 80 de consumidores
sin ese entorno y el fast `fast-20261018T171214585Z.log`; el detalle está en M11 de `tasks.md`.
Estas pruebas no sustituyen repetir los shards reales ni su merge.

En ese checkpoint seguían pendientes la revisión independiente, el full sobre bytes finales, zsh
disponible y dos casos de paridad sin skips. La primera corrida y el merge fallido por presupuesto
se documentan abajo, junto con el remerge verde posterior; no se elevaron timeouts, workers, lanes ni
límite alguno. La adopción de la entrega
actual quedó a cargo de un implementer Codex nativo 0.163.0 mediante la ruta soportada. Adoptó 72
rutas pendientes sin reescribir fuentes; la evidencia de autoría histórica Pi se conserva en
`.navori/state/archive/0055-before-codex-adoption-20261018/` y no se reasigna. Su verificación fresca
pasó 205 pruebas focales/0 omitidas en 12 archivos y fast gate
(`.navori/state/gate/fast-20261018T183003589Z.log`). La identidad actual la registra el CLI; no
implica aprobación de entrega.

La corrida inicial de cuatro shards está registrada en `.navori/state/probes/0055-real-shards-20261018T180334Z/`: shards 1–3 pasaron; shard 4 tuvo ocho timeouts durante suspensión del host y su retry pasó sobre la misma fuente. El primer merge terminó `exit 1` por cuatro presupuestos previos a R30. Tras aplicar solo la propuesta R30, el remerge de los mismos cuatro blobs exitosos terminó `exit 0` (`.navori/state/probes/0055-remerge-r30-20261018T214908Z/`): 9 729 aprobadas/2 omitidas en 465 archivos, cobertura líneas/statements/funciones/branches 87.6/85.95/90.22/80.52 %, piso 159 módulos/0 excepciones y factor de budget 1. El shard fallido inicial se excluyó.

La comparación local R29 usó tres reportes válidos por lado con workers=4 y carga inicial ≤4. Base: 452 archivos/9 551 tests; rama: 465/9 731. Medianas base/rama: pared 847.029/828.643 s, suma por archivo 3 177.592/2 680.946 s y 35 256/34 754 spawns. Como las poblaciones difieren, no se infiere aceleración global. CI base exacta: 457 s (`39051363851`); la rama aún no tiene medición. El run `38945840400` (447 s) permanece preliminar histórico. T38/R30 está completada con `defaultMs` de 20 000 ms, factor 1 y 47 excepciones derivadas; detalles en M11 de `tasks.md` y `.navori/state/bench/comparable-native-20261018T185623Z/`.

Las microcorridas y full reportados en los checkpoints siguientes son históricos y no validan los bytes actuales. La continuación recortó el alcance: R3/R29/T39 y M5/R12 quedan transferidos a [#1354](https://github.com/UlisesCm/navori-harness/issues/1354), la CI preliminar fallida a [#1353](https://github.com/UlisesCm/navori-harness/issues/1353), y el diagnóstico Pi inconcluso a [#1355](https://github.com/UlisesCm/navori-harness/issues/1355). El PR no está listo para merge: full actual, revisión independiente, receipt válido y CI funcional siguen pendientes. El fast fresco 9/0 no los sustituye; R29/T39, M11 y E1 permanecen abiertos.

**Trazabilidad posterior a las mediciones (2026-10-18).** La continuación añadió `// Covers:` únicamente en cinco rutas: tres fixtures YAML con snippets inválidos (R7: 6, R20: 3, R22: 4), y dos archivos TS con cinco marcadores R17 y tres extensiones R29 de contratos de datos, no de medición/CI. El manifiesto `.navori/state/probes/0055-traceability-native-20261018T2343Z/delta.json` (SHA256 `59d86ee7c0c8fdfee6278f1200779bab1fd4033097adaf55c41e6df2cffc8b03`) registra los hashes previos y posteriores:

| Ruta | SHA256 antes | SHA256 después |
|---|---|---|
| `ast-grep/rule-tests/no-real-home-in-tests-test.yml` | `5b58abf3da7e5eea899fbbc24638d7c138f42d5060381609c574543ceb2019c4` | `ffe2aadc3e8ddc91412f298d57322d9e86f6f884a9e9cbda447dec88d1c1221e` |
| `ast-grep/rule-tests/no-fixed-wait-in-tests-test.yml` | `119a43a719f3fb1bd711f08c086a7d1bb664f0806138a72bd86f1e1e87f30f60` | `c03fbbcb147b6ddcd3bcf95e994abcc6c99b3a3dd9d745aa3e0fa8bb19fa2a6c` |
| `ast-grep/rule-tests/no-prose-assertion-test.yml` | `1be40e1a1dd96b108aaa40936ca2dd6846cf297932ea0368c8c8295117f0f6b3` | `f3dffa7e01e908b0b9f14d70f5d4214eaf446e66a9dbe6341ed686a052226f87` |
| `packages/cli/src/__tests__/cli.e2e.test.ts` | `7757c9052e08932de860e60e8381f521b8b1721d45607b5de5c6cfb61da64f9d` | `fcf176781708af8de944d3f6eefadbd81ac85fa847668c991c8250732ba5fb5c` |
| `packages/cli/src/__tests__/bench-scripts.test.ts` | `61be140a0ce738bdce0b3e2d4e264a5f272853090f7fe73e8b2b621056db366` | `749671dbecd57800c958af2f793ae88d27ccd3bdfa0776ef806bbc7822849d74` |

La normalización al quitar los standalone `// Covers:` restituye el contenido previo de los cinco
archivos. Los casos YAML siguen 9/6/9; las declaraciones TS siguen 95/13; el inventario Vitest
permanece en 465 (SHA256 `1577eabf011f23f291fe0945fbc2263f466ddd8b4fb1f1ede70a96e207dda1b6`). El
TypeScript CLI 7.0.2 con `removeComments` emitió JavaScript idéntico antes/después para los dos TS.
El root verificó 35 focales aprobadas y 90 filtradas intencionalmente, AST 9/0 y fast 9/0. Los seis
reportes M0/final y cuatro blobs exitosos de shards preceden estos comentarios; no se les atribuyen
bytes nuevos ni se infiere efecto causal entre poblaciones distintas. A2/A8/A10/A12 observados antes
del delta también requieren captura vigente para contar como aceptación actual. R29 cubre los
contratos de reporte/comparabilidad/bytes, no demuestra tabla medida, CI real ni A11.

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
- **Carril de fallos (D5):** R12/M5 está diferido; E1 mantiene el carril Node y no tiene resultado de
  oráculo. La propuesta `jq` no se ejecuta ni se presenta como aceptación.
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
  - divergencia de cobertura del full suite → el fixture de dos shards confirma el transporte y merge
    nativos, pero no la equivalencia del full suite; conservar esta validación pendiente de M11;
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
- **Propuesta de normalización de errores sin Node (D5/R12, diferida)** → la comparación futura,
  si se retoma en otra entrega, usaría la tabla oráculo de ~30 mensajes (rutas, home, tmp, fechas,
  duraciones, hashes, ANSI) más uno de 300 KiB para comparar body, conteo y advice. No se ejecutó en E1.
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
- **Diferencia entre shards y corrida completa** → fixture nativo acotado confirma el merge 2/2;
  equivalencia del full suite y rendimiento siguen pendientes de M11. Antes del merge, `runCoverage`
  valida N nombres únicos del mismo total y después ejecuta piso y presupuesto en orden.
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

**Preliminar** (2026-10-16, investigación previa a la spec, carga no controlada; M0 debía
reemplazarlo con tres corridas comparables). Final contiene las medianas de suite local abajo; queda
incompleta hasta cerrar las demás métricas de D10, la pared real de CI y las validaciones de cierre.

| Métrica | Preliminar | M0 (reposo) | Final (reposo) | Objetivo |
|---|---|---|---|---|
| Suite local, pared | 380 s (0054 T43, reposo) | 847.029 s | 828.643 s | baja (sin cifra fija en R) |
| Suite local, suma por archivo | 1 438 s (0054 T43) | 3 177.592 s | 2 680.946 s | — |
| Procesos por corrida | ~6 000 | 35 256 | 34 754 | — |
| CI, paso de tests | ~447 s (preliminar, run `38945840400`) | 457 s (base exacta `a251417b`, run [`39051363851`](https://github.com/UlisesCm/navori-harness/actions/runs/39051363851)) | — | 4 shards + merge |
| `guard-destructive` | 41 ms (raíz de auditoría) / 10 ms sin raíz | costes M0 por engine/evento en tabla detallada | costes Final por engine/evento en tabla detallada | comparación por escenario; objetivo ~10 ms con raíz y sin log (R8) |
| `routing-watch` | 53 ms (jq ×5, git, perl) | costes M0 por engine/evento en tabla detallada | costes Final por engine/evento en tabla detallada | comparación por escenario; jq ≤ 1 (R10) |
| `role-guard` | 54 ms | costes M0 por engine/evento en tabla detallada | costes Final por engine/evento en tabla detallada | solo escenarios Codex; jq ≤ 1 |
| `bash-outcome-watch` (fallo) | 48 ms (node ≈ 28) | sin escenario en la matriz actual | sin escenario en la matriz actual | Node conservado; objetivo R12 diferido fuera de E1 |
| `implementer-no-markdown` | 34 ms | costes M0 por engine/evento en tabla detallada | costes Final por engine/evento en tabla detallada | comparación por escenario; jq ≤ 1 |
| `quality-gate-pre-commit` | 42 ms | costes M0 por engine/evento en tabla detallada | costes Final por engine/evento en tabla detallada | comparación por escenario; jq ≤ 1 |
| `plan-gate` | 161 ms (navori ≈ 122) | costes M0 por engine/evento en tabla detallada | costes Final por engine/evento en tabla detallada | comparación por escenario; baja con R14 |
| `session-start-context` | 474 ms (navori ×3, CLI global 0.12.1) | costes M0 por engine/evento en tabla detallada | costes Final por engine/evento en tabla detallada | comparación por escenario; 1 CLI (R11) |
| `audit-mode-close` | 139 ms | sin escenario en la matriz actual | sin escenario en la matriz actual | no atribuir coste medido en esta comparación |
| `navori` en frío | 114–128 ms (`node -e 0` = 28 ms) | — | — | baja con R14 |
| Bytes de `SessionStart` | — | 6 947 B Claude / 857 B Codex | 6 947 B / 857 B | iguales; sin contexto vacío (R4/R28) |
| Bytes de `test:affected` / gate en verde | — | 464 B emulado / 122 B | 88 B nativo / 122 B | modos distintos; sin atribución causal (R26) |
| Hooks con contexto sin nada que señalar | sin confirmar | 0 | 0 | lista vacía; común a ambos lados (R28) |
| Capturas del corpus de hooks (no cobertura semántica) | — | — | 2 996 casos / 22 hooks; Claude 2 212, Codex 588, Pi 196 | publicada; < 60 % de cobertura semántica ⇒ regla de D2 |
| Arranque frío `tools session-context` | — | 184.287 ms | 107.703 ms (−41.557 %) | baja ≥20 ms y ≥20 % (R14) |
| Arranque frío `plan gate` | — | 150.424 ms | 113.139 ms (−24.787 %) | baja ≥20 ms y ≥20 % (R14) |
| Arranque `--version` | — | 163.006 ms | 91.832 ms | no empeora |
| Potencial restante de carga perezosa `tools` / `plan` | — | 44.8 / 37.7 ms | 4.7 / 12.8 ms | separado del arranque observado |
| Gate real: bytes de salida (mismo test) | — | 283 B ×3 | 126 B ×3 | solo bytes funcionales; tiempos no admitidos |
| Hubs medidos (fan-in de tests ≥ 40 %) | `config.ts`, `permission-rules.ts` (0045) | base 29 (257 módulos) | rama 29 (269 módulos) | lista de D12 |
| Pared por shard / archivo más lento en CI | — | — | — | piso declarado (D13) |



#### Coste por hook, engine y escenario

Costes observados: medianas de tres observaciones por escenario. Cada fila muestra las tres auditorías en orden `absent/root/active`; no se mezclan escenarios. La matriz contiene 45 combinaciones, 135 escenarios y 17 nombres de hook. Matcher, CPU y conteos de procesos están en `.navori/state/bench/micro-native-20261018T222241Z/validated-summary.json`; los hooks fuera de la matriz no tienen medición nueva.

| Engine | Hook | Evento / payload | M0 ms (absent / root / active) | Final ms (absent / root / active) |
|---|---|---|---|---|
| claude | `audit-mode-trigger.sh` | UserPromptSubmit / UserPromptSubmit | 161 / 131 / 45 | 139 / 113 / 47 |
| claude | `comment-draft-confirm.sh` | PreToolUse / Bash | 11 / 11 / 11 | 11 / 10 / 11 |
| claude | `general-purpose-confirm.sh` | PreToolUse / Agent | 9 / 9 / 9 | 9 / 9 / 10 |
| claude | `guard-destructive.sh` | PreToolUse / Bash | 19 / 44 / 45 | 18 / 19 / 48 |
| claude | `implementer-no-markdown.sh` | PreToolUse / Bash | 11 / 40 / 46 | 17 / 17 / 49 |
| claude | `implementer-no-markdown.sh` | PreToolUse / Edit | 11 / 37 / 41 | 17 / 18 / 49 |
| claude | `managed-drift-watch.sh` | PostToolUse / Bash | 27 / 55 / 60 | 32 / 32 / 64 |
| claude | `managed-drift-watch.sh` | PostToolUse / Edit | 26 / 53 / 57 | 32 / 33 / 64 |
| claude | `model-advisor.sh` | SessionStart / SessionStart | 43 / 69 / 74 | 44 / 45 / 76 |
| claude | `plan-gate.sh` | PreToolUse / Agent | 12 / 40 / 43 | 12 / 13 / 44 |
| claude | `pr-publisher-confirm.sh` | PreToolUse / Bash | 11 / 11 / 11 | 11 / 11 / 11 |
| claude | `quality-gate-pre-commit.sh` | PreToolUse / Bash | 17 / 44 / 48 | 20 / 21 / 54 |
| claude | `routing-watch.sh` | PostToolUse / Agent | 38 / 45 / 45 | 38 / 39 / 47 |
| claude | `routing-watch.sh` | PostToolUse / Bash | 20 / 29 / 28 | 20 / 21 / 30 |
| claude | `routing-watch.sh` | PostToolUse / Edit | 59 / 64 / 64 | 52 / 50 / 58 |
| claude | `session-start-context.sh` | SessionStart / SessionStart | 359 / 401 / 387 | 180 / 182 / 217 |
| claude | `subagent-no-background.sh` | PreToolUse / Bash | 11 / 36 / 42 | 11 / 13 / 44 |
| claude | `subagent-stop-handoff.sh` | PostToolUse / Agent | 23 / 51 / 60 | 21 / 22 / 53 |
| codex | `audit-mode-trigger.sh` | UserPromptSubmit / UserPromptSubmit | 191 / 165 / 68 | 156 / 132 / 63 |
| codex | `comment-draft-confirm.sh` | PreToolUse / Bash | 18 / 18 / 18 | 17 / 17 / 17 |
| codex | `general-purpose-confirm.sh` | PreToolUse / Agent | 16 / 16 / 16 | 16 / 16 / 16 |
| codex | `guard-destructive.sh` | PreToolUse / Bash | 41 / 67 / 73 | 35 / 36 / 67 |
| codex | `implementer-no-markdown.sh` | PreToolUse / Bash | 30 / 56 / 61 | 34 / 34 / 64 |
| codex | `implementer-no-markdown.sh` | PreToolUse / Edit | 30 / 56 / 62 | 33 / 34 / 65 |
| codex | `managed-drift-watch.sh` | PostToolUse / Bash | 46 / 72 / 76 | 48 / 49 / 81 |
| codex | `managed-drift-watch.sh` | PostToolUse / Edit | 45 / 72 / 77 | 48 / 50 / 83 |
| codex | `model-advisor.sh` | SessionStart / SessionStart | 50 / 78 / 81 | 50 / 54 / 83 |
| codex | `plan-gate.sh` | PreToolUse / Agent | 18 / 46 / 49 | 18 / 20 / 51 |
| codex | `pr-publisher-confirm.sh` | PreToolUse / Bash | 17 / 17 / 17 | 17 / 17 / 17 |
| codex | `quality-gate-pre-commit.sh` | PreToolUse / Bash | 38 / 63 / 70 | 37 / 37 / 71 |
| codex | `role-guard.sh` | PreToolUse / Agent | 30 / 57 / 61 | 33 / 34 / 65 |
| codex | `role-guard.sh` | PreToolUse / Edit | 31 / 57 / 61 | 34 / 35 / 66 |
| codex | `routing-watch.sh` | PostToolUse / Agent | 58 / 64 / 64 | 55 / 55 / 63 |
| codex | `routing-watch.sh` | PostToolUse / Bash | 68 / 75 / 76 | 70 / 68 / 76 |
| codex | `routing-watch.sh` | PostToolUse / Edit | 75 / 79 / 80 | 67 / 67 / 77 |
| codex | `session-start-context.sh` | SessionStart / SessionStart | 373 / 410 / 405 | 201 / 197 / 234 |
| codex | `worktree-reclaim.sh` | SessionStart / SessionStart | 63 / 89 / 94 | 63 / 63 / 95 |
| pi | `comment-draft-confirm.sh` | PreToolUse / Bash | 8 / 8 / 7 | 7 / 7 / 7 |
| pi | `guard-destructive.sh` | PreToolUse / Bash | 12 / 41 / 43 | 15 / 15 / 46 |
| pi | `managed-drift-watch.sh` | PostToolUse / Bash | 22 / 49 / 54 | 28 / 29 / 60 |
| pi | `managed-drift-watch.sh` | PostToolUse / Edit | 22 / 49 / 57 | 28 / 30 / 61 |
| pi | `master-accept-confirm.sh` | PreToolUse / Bash | 12 / 39 / 43 | 14 / 15 / 46 |
| pi | `pr-publisher-confirm.sh` | PreToolUse / Bash | 7 / 8 / 7 | 7 / 7 / 7 |
| pi | `quality-gate-pre-commit.sh` | PreToolUse / Bash | 13 / 40 / 44 | 15 / 16 / 48 |
| pi | `subagent-no-background.sh` | PreToolUse / Bash | 7 / 34 / 39 | 8 / 9 / 40 |

Las medianas locales provienen de tres observaciones válidas por lado en
`.navori/state/bench/comparable-native-20261018T185623Z/validated-summary.json`. Base: 452 archivos,
9 551 tests; rama: 465 archivos, 9 731 tests. Las cargas iniciales de las seis muestras válidas
fueron ≤4 con workers=4. La segunda observación inicial de base (loadavg 3.592, por tanto admisible
por carga) se excluyó por una interrupción/suspensión: exit 1, 13 archivos fallidos, pared medida
1 266.410 s frente a 741.091 s monotónicos; fue sustituida por un retry válido. Una preparación de
baseline anterior, separada de estas seis muestras, tuvo carga 10.85 y no es comparable. Las
diferencias de inventario describen poblaciones distintas y no sustentan una afirmación de mejora
global. La corrida de CI base exacta es 457 s en el run `39051363851`; 447 s del run `38945840400`
permanece solo como cifra preliminar. Ninguna mide la rama. Las microcorridas válidas de hooks,
contexto y arranque están registradas a continuación; el full de los bytes actuales, la revisión nativa
independiente, el receipt y la pared real de CI siguen pendientes. El checkpoint T12 se registra aparte.

**Microcorrida nativa de M11** (`.navori/state/bench/micro-native-20261018T222241Z/validated-summary.json`): tres observaciones por escenario. En los 135 escenarios de hooks, la suma de medianas de pared fue 8 123 ms en base y 6 294 ms en rama; los conteos agregados de procesos observados fueron `jq` 289/192, `node` 31/25, `perl` 132/68, `git` 156/156 y `navori` 16/10 (base/rama). `SessionStart` fue 6 947 B Claude/857 B Codex en ambos lados; gate verde 122 B en ambos; los hooks sin señal produjeron cero bytes. Los valores de arranque son medianas de tres rondas × diez muestras, con carga inicial admisible: `tools session-context` 184.287→107.703 ms (−41.557 %), `plan gate` 150.424→113.139 ms (−24.787 %), `--version` 163.006→91.832 ms. Estos microescenarios no sustituyen la comparación de suite, cuyas poblaciones difieren.

El gate real adicional de bytes (`.navori/state/bench/gate-byte-acceptance-native.json`) mide el mismo test sin cambios en tres pares: 283→126 B. La carga registrada fue 4.762/4.700; la autorización cubre únicamente bytes funcionales (`timingsAccepted=false`, `comparablePerformance=false`). El resultado sintético 194→231 B y el rechazo de configuración se conservan como diagnósticos, no como aceptación. Para `test:affected`, M0 emulado produjo 464/1 308 B y Final nativo 88/497 B; el cambio de modo impide atribuir el diferencial exclusivamente a M9.

El grafo nativo `.navori/state/bench/graph-native-comparison-20261018.json` cuenta base 452 tests,
257 módulos y 29 hubs; rama 465 tests, 269 módulos y 29 hubs. El artefacto
`.navori/state/probes/0055-corpus-coverage-native.json` contiene 2 996 capturas en 22 hooks:
2 212 Claude, 588 Codex y 196 Pi. `model-advisor` tiene 0 capturas en ese corpus. Estos conteos
describen la captura observada; no equivalen a cobertura semántica total ni permiten completar la
regla de porcentaje de D2.

**T12 — re-medición retrospectiva de M2 tras el entorno hermético.** Una observación válida en el
checkout base `a251417bd231415c43bc091f051d9a994cf7e885`, con los observers y la normalización comunes:
453 archivos/9 556 tests, workers=4, carga inicial 3.950, pared 743 210 ms, suma por archivo
2 790 367 ms y 35 258 spawns (`2026-10-18T22:05:15.926Z`). El reporte
`.navori/state/bench/hermetic-checkpoint-native-20261018T213656Z/1/tests.json` tiene SHA256
`0601de8310dc118b68cad1fb69a504be22afbcff92e5ca4cba0af2553e000164`; snapshot de fuentes verificado,
gap pared/monotónico 0.00745 s. T12 pide esta re-medición singular; las tres muestras por lado de
D10/R29 se completaron aparte y no se afirma causalidad entre poblaciones. No sustituye M0 ni entra
al cálculo R30. El plan conservó la intención original de tres observaciones retrospectivas, pero
el checkpoint válido y el plan update root cerraron T12 antes de lanzar otras dos. El scheduler raíz
fue detenido antes de su segunda muestra; su salida 143 no corresponde al reporte, que terminó
exit 0 y `comparable: true`.

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
| **M2c — Fallos sin Node (diferido fuera de E1)** | R12/D5; sin ejecución de oráculo ni veredicto | — | — | — |
| **M2d — Sesión y contexto** | D6 (`--notice-reserve`), R28 según la lista de M0, render de espejos, replay final | R11, R13, R28 | M2b | ~200 |
| **M3 — CLI perezoso** | **solo si el probe de M0 da ≥ 20 ms**: `src/cli.ts`, `tsdown` con chunks, `check:size`, test de carga | R14, R15 | M0 | ~250 |
| **M4 — Suite** | shells y paridad con corpus (D9), e2e en proceso, lotes, plantillas git, `vi.waitFor`, prosa, preservación genérica y reglas ast-grep | R16–R22 | M1, M2 (corpus validado), M3 o un `src/cli.ts` estático | ~2 500 cambiadas (neto negativo) |
| **M5 — Tokens** | reporter `compact`, línea del piso, `summarizeGreen` | R26, R27 | M0 | ~350 |
| **M6 — CI** | `test:affected` (`--base`, `--plan-json`, hub por salida, una invocación), `run-test-coverage --shard/--merge`, `ci.yml`; transporte y merge nativos validados en fixture; pared por shard pendiente | R23–R25 | M4, M5 | ~300 |
| **M7 — Cierre** | tres corridas en reposo por lado, tabla final, `check-test-budget --propose`, `test-budget.json` | R29, R30 | todos | ~80 + datos |

M2a, M2b y M2d son independientes de la propuesta M2c, que queda diferida fuera de E1. M5 va antes de
M6 porque ambos tocan `test-affected.mjs` y la salida de CI. M4 no reduce casos de un hook con cobertura
de corpus menor al 60 % hasta que M2 esté verde (D2).

## Preguntas abiertas (para el orquestador)

Resueltas: R7 (solo estático) y R11 (camino común) ya están enmendados en `requirements.md`. La
consulta de protección de ramas descrita en D13 refleja únicamente lo observado en GitHub el
2026-10-18 alrededor de las 02:30 UTC.

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
5. **R12:** diferido fuera de E1 por decisión explícita del usuario; el oráculo no se ejecutó y no hay
   resultado de aprobado o fallido.

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
  2026-10-16 como referencias secundarias. La guía oficial consultada no documenta la cobertura
  combinada; el comportamiento de Vitest 5.0.1 se verificó en el fixture limitado descrito en D13,
  sin inferir equivalencia ni rendimiento del full suite.
- citty 0.1.6, tipos `Resolvable` y `SubCommandsDef` en `packages/cli/node_modules/citty/dist/index.d.mts`
  (checkout principal).
- Perfil de CPU de `navori --version` 0.12.1 y `/usr/bin/jq` presente: medidos en esta máquina el
  2026-10-16, con loadavg 16–47 (solo proporciones).
