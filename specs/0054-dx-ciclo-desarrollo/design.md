# DX del ciclo de desarrollo: menos re-procesos, suite más rápida, hooks más baratos — Design

**Estado:** revisado tras el challenge (`.navori/state/handoffs/challenge_0054-dx-ciclo-desarrollo.md`),
el veredicto del orquestador y las respuestas del usuario · **Fecha:** 2026-10-15 · **Base
verificada:** `origin/dev` = `613bfb9b` tras `git fetch origin dev`.

Las afirmaciones "ya existe" se leyeron en el checkout local (`5d4d18c3`, ancestro de
`origin/dev`). Cada archivo citado se comparó con `git diff HEAD origin/dev` y no difiere, salvo
`navori.config.json` (solo `harnessVersion`) y `lib/plan/gate.ts`, que se leyó en `origin/dev`. El PR
apunta a `dev`.

**Señal arquitectónica:**

- áreas críticas: hooks, gate, recibos, permisos de `settings-base` y escrituras en el repo del
  usuario;
- contratos compartidos: identidad de evidencia de 0038/0042, claves nuevas de `qualityGate` y el
  invariante del escritor de auditoría;
- concurrencia: caché de gate, `dist/` y spool de auditoría.

## Decision drivers

Salen de `docs/DIRECTION.md` (calidad > tokens > velocidad; independencia del reviewer), de
`CLAUDE.md` (áreas críticas; simple > clever) y de `requirements.md`.

1. **Fail-closed hacia correr.** Si un atajo duda, se corre el trabajo completo (R14, R17, R22, R24,
   R25).
2. **Una identidad de contenido.** El gate, el pre-commit y la evidencia comparan bytes con la misma
   primitiva.
3. **Un dueño por regla.** Los roles salen del roster, las exclusiones de `PROGRESS_DIRS` y la
   decisión de compilar de una sola función.
4. **Cero dependencias nuevas.** Vitest se queda.
5. **Multi-engine.** Todo cambio de hook vale igual para Claude y Codex.

## Approach

- **Medir primero (A).** Dos bench fijan la línea base y verifican R4 y R27.
- **No recalcular bytes ya verificados (B, C, D).**
  - El gate cachea su verde por identidad de contenido.
  - `dist/` se compila por huella de entradas.
  - La evidencia de runners puros deja de depender de `HEAD`.
- **Bajar el costo fijo (B, E).** Fixtures compartidos, paralelismo acotado por medición y hooks sin
  forks en el camino común.
- **Menos rondas por cambio chico (F, G).** Es 0045 E4 más su prosa.

**Escalera de la caché** (la decisión de mayor riesgo):

- **Patrón existente: el recibo** (`lib/diagnose/receipt.ts`, `signReceipt`). Descartado: es
  evidencia de review, y usarlo como caché viola R15.
- **Extensión: registrar el verde en `lib/gate/run.ts` con la huella `navori-content/v1`**
  (`primitives/content-identity.ts`, `contentIdentity`). **Elegida:** es de solo lectura, excluye
  `PROGRESS_DIRS` y `.claude/worktrees`, y falla como valor.
- **Caché por paso tipo turborepo.** Descartada: requiere una dependencia o un subsistema, y ningún
  requisito la pide.

## Components

- `packages/cli/scripts/bench-tests.mjs` + `bench:tests`. Corre `vitest run` con reporter `json`
  (`--outputFile.json`) y escribe `.navori/state/bench/tests-<ts>.json`. Registra pared, duración por
  archivo, top 25, `loadavg`, CPUs y `ulimit -n`. — R1, R4
- `packages/cli/test-budget.json`. Define `{ defaultMs, exceptions: [{ file, ms, reason }] }`, con
  un esquema zod en el script de abajo. — R2. Desviación de M3: las 40 excepciones llevan `ms` = duración
  medida en M1 bajo carga (loadavg 9–21), redondeada hacia arriba a 5 s. Están infladas por la carga; M8
  (T43) las re-mide y aprieta. Las razones de `slice` y `escalation` dicen «R35 en M5».
- `packages/cli/scripts/check-test-budget.mjs`. Lee el JSON del reporter y aplica
  `ms × NAVORI_TEST_BUDGET_FACTOR` (default 1; CI declara su factor). Falla nombrando archivo,
  duración y presupuesto. Corre en `quality` después de `test:coverage`, que suma el reporter `json`
  con `NAVORI_TEST_REPORT`. — R3
- `packages/cli/scripts/ensure-dist.ts`, ejecutado con `bun` (D2). — R5, R6, R18. Desviación de M2: se añadió el script raíz `ensure-dist` y CI lo llama con `bun run ensure-dist`.
- `packages/cli/vitest.distLock.ts`. `LockOwner` gana `pid` y `host`. Un esperador reclama el lock
  solo si el host coincide y `kill(pid, 0)` da `ESRCH`; enmienda el comentario "never reclaimed".
  — R5, R6
- `packages/cli/vitest.globalSetup.ts`. Toma el lock, llama a `ensureDist({ lockHeld: true })` y lo
  conserva toda la suite. — R5
- `packages/cli/scripts/check-render-locked.ts` + `check:render`. Toma el lock, corre
  `ensureDist({ lockHeld: true })` y `scripts/js/check-render.mjs` como hijo, y solo después
  libera. — R6
- `.github/workflows/ci.yml`. El job `quality` corre también en PRs y pushes a `dev`, compila una
  vez, y `check:render` y la suite encuentran el sello. Se reescribe el comentario "rebuilds ON
  PURPOSE": la huella cubre `core-assets` y `packages/plugins`. — R3, R18
- `packages/cli/vitest.config.ts`. `maxWorkers` vale `NAVORI_TEST_WORKERS` o
  `min(availableParallelism() - 1, CAP, ⌊ulimit -n / FDS_PER_WORKER⌋)`. `ulimit -n` se lee una vez
  con `sh -c 'ulimit -n'`, y `CAP` y `FDS_PER_WORKER` se fijan en M2. — R10. **Enmienda (CAP=4):** `WORKER_CAP` vale 4 en `packages/cli/vitest.workers.ts`, no 8. Con CAP=8 bajo carga, la pared fue 545–568 s frente a 495–574 s con 4 workers; el tiempo por archivo fue 1.3–1.8× (suma 3 833–4 072 s frente a 1 822 s), hubo timeouts en `slice`, `escalation` y `role-guard`, y 28 archivos superaron su presupuesto. Se revalida en M8 con la máquina libre. **Medido en M2 (CAP=8, ya superado por la enmienda):** `CAP`=8 y `FDS_PER_WORKER`=64 con `NAVORI_TEST_WORKERS=8` en `bench:tests`, `ulimit -n 1048576`, 10 CPU; loadavg antes 15.26/10.32/8.74 y después 14.35/21.63/16.39 (máquina muy cargada). Resultado: 441 archivos, 9 227 tests, 473.8 s, 0 `EMFILE`, `vitestExit` 1 por tres archivos (`render-drift-check` y `repo-config-gate` fallaron por cambios de scripts de este milestone, corregidos después; `role-guard` falló bajo carga y pasa aislado). Es **una** corrida, no tres, y no es línea base válida para R4. Evidencia: `.navori/state/bench/tests-2026-10-16T01-53-26-608Z.json`.
- `packages/cli/scripts/test-affected.mjs` + `test:affected` (D3). — R11
- Reescrituras (D4):
  - `lib/master/__tests__/slice.test.ts` y `lib/plan/__tests__/escalation.test.ts`;
  - `guard-destructive`, `audit-hooks` e `implementer-no-markdown`;
  - `cli.e2e`;
  - helpers `src/__tests__/helpers/{repo-template,hook-batch}.ts`.

  — R7, R9.

  Desviaciones de M3:
  - `repo-template` ahorra ~10 de ~700 spawns de git por test pesado. El costo dominante es
    `fingerprintTree` (82 llamadas × 7 spawns en un solo test), código de producto en `evidence.ts`,
    fuera de alcance. El presupuesto de 20 s por archivo no se cumple bajo carga: `slice` ~130 s
    (loadavg 9–16), `escalation` 28–72 s y `cli.e2e` ~118 s. `escalation` agotó 15 s en una corrida
    con loadavg ~20 (4.4 s sin carga). Cumplirlo requiere un memo o menos llamadas a `fingerprintTree`
    en producto.
  - `hook-batch` ejecuta hasta 4 casos (`LANES`) en subshells concurrentes dentro de un solo `bash`. Un
    lote serial midió igual que spawns aislados: el costo (~100 ms por caso) es del hook, no del spawn.
  - `audit-hooks` no se migró. Sus escenarios tienen estado (consumo de arm, raíz por test, CLI real) y
    no son batchables; solo su tabla de entrada hostil lo sería, y no ahorra nada medible. Por eso T12
    queda sin marcar.

- `src/__tests__/doctrine-contracts.test.ts`, que fusiona los cuatro tests de prosa, y
  `scripts/js/doctrine-literal-diff.mjs`, la prueba de equivalencia de D4. — R8. Desviación de M3:
  `doctrine-literal-diff.mjs` no se creó. La equivalencia la cubre el último caso de
  `doctrine-contracts` más el fixture `packages/cli/src/__tests__/fixtures/doctrine-literals.baseline.json`,
  capturado instrumentando `expect` en los cuatro archivos viejos (114 literales positivos, 43 negativos).
- **Sección "Casos e2e borrados"** de este documento. — R9
- `lib/gate/cache.ts` (nuevo): `gateCacheKey`, `lookupGreen`, `recordGreen` y `fastCoveredByFull`
  (D1). — R12, R13, R14, R15
- `lib/gate/run.ts`, `runGate`. Hace el lookup y graba. Agrega al log un centinela de éxito antes
  de hashearlo. `commands/gate.ts`: `--force` y el modo `probe` (D1). — R12, R13, R14, R17
- `primitives/content-identity.ts`. Agrega `indexContentIdentity(cwd)` y exporta
  `IDENTITY_EXCLUDES`. — R12, R17, R20
- `scripts/git-hooks/pre-commit` y `core-assets/hooks/quality-gate-pre-commit.sh` (Claude y Codex).
  Corren el probe antes del gate rápido (D1). — R17
- `config/schema.ts`. Agrega `qualityGate.affected?` y `qualityGate.docs?`, ambos validados por
  `isSafeGateChain`. Este repo declara:
  - `affected` = `bun run test:affected`;
  - `docs` = `bun run check:links && bun run check:doc-budgets && cd packages/cli && bun run
    test:docs`, donde `test:docs` es un `vitest run` sobre la lista declarada de tests que leen
    `docs/` o `specs/` del repo.

  — R16, R21
- `navori.config.json` y `package.json` raíz. `check:fast` pasa a los mismos pasos raíz que `full`
  (`bun run format:check && bun run lint && bun run typecheck && bun run check:dup && bun run
  check:ast`), para que `fastCoveredByFull` sea verdadero en este repo. Es nota de tarea para M4.
  Desviación de M4: la regla de permiso `bun run check:fast:*` sale de `settings.json` tras el render.
  — R13, R17
- `lib/plan/evidence.ts`. Cambian `candidateProblem`, `PURE_EVIDENCE_RUNNERS`, `FINGERPRINT_EXCLUDES`
  (que pasa a ser `IDENTITY_EXCLUDES`) y `EvidenceLineSchema` (gana `fp`) (D5). — R19, R20
- `_partials/bash-outcome.sh`, `navori_tree_fingerprint`. Suma `':(exclude)progress'` y escribe
  `"fp":2`. — R20
- `lib/diagnose/receipt.ts` y `commands/receipt.ts`: `--gate-ran docs` (D6). — R21
- `_partials/extract-cmd.sh`, `payload_fields VAR=ruta…` (D10). Migran los hooks con 2 o más
  campos: `hook-input`, `subagent-stop-handoff`, `routing-watch`, `implementer-no-markdown`,
  `pr-publisher-confirm`, `subagent-no-background`, `bash-outcome`, `gate-ask` y
  `resolve-worktree`. — R22
- `hooks/managed-drift-watch.sh` (D7). — R23
- `hooks/plan-gate.sh`. Agrega una vía rápida en shell puro (D11) con `{{navori.nonImplementerRoles}}`,
  renderizada desde `NON_IMPLEMENTER_ROLES` (`engines/shared/roster.ts`). — R24
- `commands/tools.ts`, `navori tools session-context`, y `session-start-context.sh` (D12). — R25
- `_partials/audit-log.sh`, `navori_audit_record_metadata`, más el encabezado enmendado.
  `lib/audit/cli-event.ts`, `consolidateSpool`. `commands/audit.ts`: `--start` crea el directorio de
  spool, y `--stop` y los lectores consolidan (D8). — R26
- `scripts/js/bench-hooks.mjs` + `bench:hooks`. Toma los hooks de `.claude/settings.json` y de
  `.codex/config.toml`, con payloads en `scripts/js/bench-payloads/`. Hace 3 corridas con
  `/usr/bin/time -p` (user+sys), saca medianas por hook y sumas por evento, y sale con 1 si Bash sin
  audit pasa de 300 ms. — R23, R24, R27
- `lib/plan/gate.ts` (`NIVEL0_LINE`, `evaluateNivel0`). Gramática
  `nivel-0: <paths> <feature> | verify: \`<cmd>\` → <expected>`: 0045 D8 sobre la forma de 0052.
  `<expected>` es texto libre no vacío porque E3 queda diferida. — R28
- `lib/plan/classify.ts` + `commands/plan.ts`. `classify --diff` publica `reviewDepth: light|full`,
  según 0045 D9. — R29
- `lib/handoff/render.ts` (nuevo) y `navori handoff render <feature>`, según 0045 D13, con la
  contención restablecida en Contracts. El permiso `Bash(navori handoff render:*)` va en
  `settings-base`. — R30
- Prosa en `core-assets`: `agents/{reviewer,publisher,implementer,orchestrator}.md`,
  `skills/verify-before-done`, `skills/planificacion` y sus espejos Codex. Cubre R13, R15, R16, R17,
  R21, R28–R31 y 0045 D14. — R29, R31, R32
- `specs/0045-review-adaptativo/tasks.md`. E3 queda "diferida (0054)" y E4 "absorbida por 0054".
  — R33

- `core-assets/hooks/plan-gate.sh`, camino de negación: ante exit 2 de `navori plan gate`, compara
  `navori --version` con `harnessVersion` (lectura de `navori.config.json` en shell) y agrega al
  motivo `CLI <v> < harness <v>: actualiza navori`. El `allow` no paga la consulta. — R34

- `lib/plan/evidence.ts`, `fingerprintTree`: deja de lanzar un proceso de git por archivo; lee el
  índice y la lista de archivos en una o dos llamadas y hashea en proceso, con una prueba de
  equivalencia de huella contra la versión previa. Es la causa dominante del tiempo de
  `slice.test.ts` y de `plan update` en uso real (medido en M3). — R35

## Decisions

### D1 — Caché del gate y probe del pre-commit (R12–R15, R17)

- **Clave.** Se guarda campo por campo:
  - `fingerprint`: `contentIdentity(cwd).fingerprint`;
  - `kind` y `commandHash` (sha256 de `qualityGate[kind]`);
  - `lockHash`: sha256 de los lockfiles presentes en la raíz (`bun.lock`, `bun.lockb`,
    `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`);
  - `navoriVersion`, `bunVersion` (`bun --version`) y `nodeVersion` (`node --version`, spawned; desviación de M2: no `process.version`, para que bun y vitest coincidan). Es el mismo
    conjunto de versiones que la huella de `dist/` (D2).
- **Registro.** Vive en `.navori/state/gate/results.json`, en el state root de cada checkout
  (`resolveStateRoot`). Guarda 16 entradas. Se escribe con `withFileLock` más
  `writeStateFileAtomic` y se lee sin lock.
  - Cada worktree tiene el suyo, porque `node_modules` y `dist/` también son de cada uno.
- **Grabar.** `runGate` calcula la huella antes y después de la cadena. Si coinciden y el exit es 0,
  agrega al log la línea `[navori gate] PASS <kind> <fingerprint>`, hashea el log (`logSha256`) y
  graba.
- **Hit.** La clave tiene que coincidir completa, el log tiene que existir con ese sha256 y la última
  línea tiene que ser el centinela de éxito. Cualquier otra cosa es miss (R14).
- **`full` satisface `fast` (R13).** Lo decide `fastCoveredByFull`: se parten las dos cadenas por
  `&&` y se lleva el `cwd` efectivo de cada paso (los `cd X`). Vale solo si cada par `(cwd, paso)` de
  `fast` aparece literal en `full`. Enmienda de T19: `qualityGate.fast` queda como `bun run check:fast`,
  porque escribir la cadena en línea rompió `agent-prompt-bytes` y `doc-budgets`. `fastCoveredByFull`
  expande **un solo nivel**: cada paso `bun|npm run <script>` con `cwd` raíz se sustituye por el script
  de `package.json` raíz, y `full` se compara literal. `check:fast` de la raíz es la cadena alineada con
  `full`. Los scripts desconocidos, anidados o que no son cadena no quedan cubiertos.
- **Probe (R17)** es `navori gate probe [--index | --clean]`. Es el positional `probe` del comando
  `gate`, y un CLI viejo responde `unknown kind` con exit 2, así que el hook corre el gate. Responde 0
  si hay hit para `fast` y 1 si no; nunca corre la cadena.
  - `--index`, para el hook de git: la huella del índice debe coincidir con la del registro.
    `indexContentIdentity` arma las mismas líneas `<mode> <blob>\t<path>\0` desde `git ls-files -s
    -z`. No acepta etapas ≠ 0 y salta gitlinks e `IDENTITY_EXCLUDES`.
  - `--clean`, para el hook gestionado, que corre antes de `git commit` y no conoce el índice final
    (`-a`, pathspecs): el índice, el árbol de trabajo y el registro deben coincidir. Así, cualquier
    forma de `git commit` commitea esos mismos bytes.
  - **Entorno.** Ambos hooks invocan el probe con todos los `GIT_*` depurados, salvo
    `GIT_INDEX_FILE`, que el hook convierte a ruta absoluta contra la raíz. Se usa `if probe; then
    skip; fi`, de modo que 126/127 (bun ausente) o un crash corren el gate.
  - **En este repo**, el hook de git invoca `bun packages/cli/src/index.ts gate probe --index` (~150
    ms medidos). El hook gestionado usa `navori` del PATH.
- **Por qué es seguro, a diferencia de lo que #365 quitó.** La clave son los bytes exactos que se
  commitean, y hoy `check:fast` ni siquiera mira el índice. Todo error significa correr.
- **Límite declarado: archivos sin trackear.** La huella del gate los incluye y la del índice no, así
  que un archivo sin trackear deja el probe en miss (seguro pero sin ahorro). Lo mismo vale con
  `core.autocrlf` o filtros. M4 mide la tasa de hits y el costo de la identidad por commit.
- **R15 (decisión del usuario).** El reviewer puede firmar `--gate-ran full` sobre un `cached PASS`
  del mismo árbol. Su tabla del pase 2 registra `cached`, la fecha ISO y el `logSha256`. El cierre no
  fuerza `--force`.
  - `signReceipt`, `checkReceipt` y la validación de `--gate-ran` nunca leen `results.json`.
  - `receiptOutcomeOf` agrega `gateSource: "cached" | "ran"` cuando el reviewer pasa
    `--gate-source cached`, para que la auditoría lo vea.

### D2 — Huella y sello de `dist/` (R5, R6, R18)

- **Entradas:**
  - `git ls-files -z --cached --others --exclude-standard` sobre `packages/cli/src` (sin
    `__tests__`), `packages/core` y `packages/plugins`;
  - `packages/cli/{package.json,tsconfig*.json,tsdown.config.ts,scripts/copy-assets.mjs,scripts/bundle-comments.ts,scripts/bundle-render-data.ts}`; (`bundle-render-data.ts` añadido en M2);
  - en la raíz: `package.json`, `tsconfig*.json`, `bunfig.toml` y el lockfile;
  - las versiones de bun y node, y la de `tsdown` declarada.

  Un archivo listado pero borrado entra al hash como `deleted\t<path>`, y no rompe el hasheo. Se
  hashea con `git hash-object --no-filters --stdin-paths`, que no escribe objetos. Desviación de M2: el contenido se hashea en proceso con sha256. `tsdown.config.ts`
  no inyecta `define` ni variables de entorno (verificado).
- **Sello.** La huella se calcula **antes** del build. Después de un build con exit 0 y
  `dist/index.js` presente, se recalcula: solo si coincide se escribe `dist/.build-fingerprint`. Si
  no, queda sin sello y la próxima corrida recompila. `clean: true` borra el sello al empezar el
  build.
- **Lock.** `ensureDist({ packageRoot, lockHeld })` nunca vuelve a tomar el lock. El llamador lo
  tiene durante el build y durante todo uso de `dist/` (`globalSetup`, `check-render-locked`). El
  lock no es reentrante, así que esto evita el autobloqueo de 10 minutos.
  - **Reclamo:** solo con `ESRCH` en el mismo host. Una reutilización del pid lo deja tomado, que es
    la dirección segura.
- **Costo:** M2 lo mide en una corrida de un solo archivo.

### D3 — `test:affected` (R11)

- **Cambiados:** `git diff --name-only --no-renames $(git merge-base HEAD origin/dev)` (o `dev`; si
  no hay ninguno, suite completa) más `git ls-files -m -o -d --exclude-standard`.
- **Ruteo:**
  - fuentes `.ts` existentes → `vitest related --run`;
  - tests cambiados → directo, salvo los borrados;
  - borrados → no van a `related`; corren los tests cuyo texto contiene su ruta o su nombre base;
  - otros archivos fuera de `core-assets` → los tests cuyo texto contiene la ruta (`git grep -l
    -F`);
  - **cualquier cambio bajo `packages/core/core-assets/**`** → además los tests de render y golden
    (`src/lib/render/__tests__/**`, `golden-*`), por regla de directorio;
  - entrada de `dist/` (D2) → los specs que contienen el literal `dist/index.js`;
  - `vitest.*`, `tsconfig*`, `package.json`, lockfile → suite completa.
- **Salida.** Abre con `test:affected: affected subset, not a gate`. Lo respaldan el gate full de
  cierre y CI `quality`, que ahora corre en `dev` (R18).

### D4 — Reescrituras sin perder cobertura (R7, R8, R9)

- **Plantilla de repo** (`slice`, `escalation`):
  - en `beforeAll`, cada fixture se arma una vez y cada test la copia con `cpSync`;
  - la plantilla tiene solo el estado anterior a cualquier ruta absoluta grabada;
  - un test verifica que el `.git/config` de la plantilla no tenga rutas absolutas;
  - descartados: `git worktree` (comparte refs) y un repo mutable compartido.
- **Lote de hook** (`guard-destructive`, `audit-hooks`, `implementer-no-markdown`):
  - un solo `bash -c '<driver>' <ruta-del-hook>` corre cada caso en un subshell, sin
    `set -e`/`trap` heredados, y emite delimitadores con el id del caso;
  - si falta el delimitador de un caso, el lote falla;
  - `$0` es la ruta del hook;
  - cada hook conserva un spawn real (R9).
- **Equivalencia:**
  - antes de reescribir, se exporta la tabla `id → entrada → exit/stdout esperado` de cada archivo
    viejo; el nuevo afirma el mismo número de casos y los mismos ids;
  - por cada archivo reescrito hay un smoke de mutación: copia temporal del hook o fixture con una
    guardia invertida ⇒ el lote falla;
  - R8: `doctrine-literal-diff.mjs` extrae en la base los literales de `toContain`, `toMatch`,
    `not.toContain` y los de orden de sección de los cuatro archivos viejos, y exige igualdad de
    conjuntos con las tablas nuevas. Las tablas expresan `tokens`, `absent` y `order`.
  - Todo `// Covers: R<n>` previo sigue presente.

### D5 — Evidencia: `HEAD` libre solo para runners puros (R19, R20)

- **`PURE_EVIDENCE_RUNNERS`** es una constante declarada en `evidence.ts` con los runners `bun run
  test`, `bun run test <args>`, `bun x vitest run <args>` y `bun run test:golden`.
  - El comando se tokeniza.
  - Se admiten prefijos `cd <ruta-relativa> &&`.
  - Cualquier otro `&&`, `|`, `;`, `$`, backtick o redirección lo deja fuera.
  - Fuera de la lista, `HEAD` sigue atando la evidencia. Ahí caen `classify --diff`,
    `check:blame-ignore` y `receipt check`.
- **Exclusiones.** `FINGERPRINT_EXCLUDES` pasa a ser `IDENTITY_EXCLUDES` (`PROGRESS_DIRS` más
  `.claude/worktrees`), en TS y en shell.
- **Compatibilidad de huella.** Una línea con `fp: 2` se compara con la huella v2, y una sin `fp`
  con la legacy (sin `progress/`). El validador calcula cada una a lo sumo una vez por árbol
  (`current` pasa a ser un mapa por versión).

### D6 — Re-firma con docs (R21)

- **Cambios.** El CLI arma la unión de `uncovered`, `drift[].path` (todos los `kind`: `changed`,
  `missing`, `reappeared`) y las rutas de `state.paths` cuyo blob difiere del recibo, más los
  borrados.
- **Condiciones.** Cada ruta tiene que casar `^(specs|docs)/[^\0]*\.md$` (sensible a mayúsculas).
  Cada ruta existente tiene que ser un archivo regular y no un symlink. Además se exigen
  `qualityGate.docs` declarado y un recibo v2 vigente con `gate=` de `full`. Si algo falla, rechaza
  y pide el gate full.
- **Firma.** Reescribe blobs y conserva `gate=`/`inputs=`.
- **Qué lee `check:links`.** Recorre todo `git ls-files "*.md"`, así que una ruta movida en `docs/`
  se caza desde cualquier archivo. `format:check` no cubre Markdown (encabezado de
  `scripts/js/check-links.mjs`). Ambos datos están verificados.

### D7 — `managed-drift-watch` por `mtime` (R23)

- Antes de hashear se hace `touch "$mark"`. Si después `find $roots -newer "$mark" -print -quit` no
  imprime nada, el hook sale `clean`.
- Cuando sí hashea, compara contra el baseline de hashes guardado, no contra la corrida previa. Un
  cambio perdido por `mtime` aparece en el siguiente hasheo.
- Límite declarado: una edición que preserva `mtime`.

### D8 — Spool de auditoría, un archivo por evento (R26)

- **Directorio.** `audit --start` (o el consumo del arm) crea `<auditsRoot>/<repo>/spool-<session>/`
  con modo `0700`, validado con las mismas reglas de dueño y padres que `auditParents`.
- **Hook:**
  - actúa solo si `[ -d dir ] && [ ! -L dir ] && [ -O dir ]`;
  - arma el JSON con **un** `jq -cn --arg …`: `{"v":1,"host":…,"metadata":{…}}`;
  - lo escribe con `set -C; umask 077; printf … > "$dir/<tsMs>-<pid>-<RANDOM>.json"`;
  - noclobber abre con `O_EXCL`: no pisa un archivo ni sigue un symlink con ese nombre;
  - sin directorio de spool cae al puente actual (`navori audit --record-metadata`).
- **`consolidateSpool`:**
  - lee cada archivo con `readPrivateAuditFile` y lo re-valida con el validador de
    `recordAuditMetadata`: categorías cerradas, 2 KiB y `host` contra la cabecera del log;
  - descarta los inválidos uno por uno, sin abortar el lote. Un archivo ilegible de menos de 5 s se
    deja para la próxima pasada, porque puede estar a medio escribir;
  - deriva `eventId = uuidFromSha256(rootSessionId, nombre)`, hace un solo
    `appendPrivateAuditFile` y después borra los consumidos;
  - un crash entre el append y el borrado re-agrega los mismos `eventId`, y el lector deduplica
    (`lib/audit/model.ts`). No hay rename-claim, así que no hay carrera con un escritor en vuelo.
- **Huérfanos.** Archivos de una sesión cerrada sin consolidar: los consolida el próximo `--stop` o
  lector de esa sesión. Los lectores fusionan el spool en memoria sin borrar.
- **Invariante enmendado.** El encabezado de `audit-log.sh` pasa de "The CLI is the single
  private-FD writer… No shell redirects" a: "The CLI is the single writer of the session log. The
  only shell write is one noclobber event file inside the CLI-created 0700 spool dir. The CLI
  re-validates every file before it reaches the log." Un drift test lo fija.

### D9 — Carril del reviewer (R16)

- **No-cierre** (`receipt gate` → `scoped`): `qualityGate.scoped`, después `qualityGate.affected` y
  después los `A<n>`. Firma con `--gate-ran scoped`.
- **Cierre:** `navori gate full`, sujeto a R13 y a D1 (R15).

### D10 — `payload_fields` sin corrimiento (R22)

- **Extracción.** Un `jq -j` emite cada campo (`tostring` para no-strings, como `-r` hoy) seguido de
  NUL y cierra con el centinela `\u0000END\u0000`. La condición es que ningún valor contenga `\u0000`
  (`select(all(…; contains("\u0000") | not))`). Si no se cumple, no emite nada.
- **Validación en shell.** Lee exactamente N campos más el centinela. Si sobra o falta algo, o la
  salida está vacía con un payload no vacío, descarta todo y repite con la extracción campo por campo
  de hoy. Nunca deja variables vacías que se lean como "permitido".
- **Fallback a `node`.** Usa la misma regla.

### D11 — Vía rápida de `plan-gate` (R24)

- **Lectura.** `IFS= read -r -d '' payload` (builtin, en lugar de `$(cat)`).
- **Condiciones.** El payload no contiene `\u` y la clave (`"subagent_type"`, `"agent_type"` o
  `"role"`, escapada o no) aparece **una sola vez**. El valor se normaliza como `normalizeRole`:
  `${v#*:}` y `nocasematch`, coherente con el `toLowerCase` del CLI. Un valor con espacios no entra.
- **Decisión.** Si el valor está en la lista renderizada, decide `allow`. En cualquier otro caso
  sigue el camino actual, al CLI.

### D12 — `session-context` todo o nada (R25)

- El subcomando calcula las dos secciones en memoria y las imprime solo si las dos salieron bien.
  Si no, sale con ≠ 0 y no imprime nada.
- El hook, ante ≠ 0 o un comando desconocido, cae a las dos llamadas de hoy.

## Contracts

- **`navori gate <fast|full> [--force]`.**
  - Hit: exit 0 y primera línea
    `navori gate <kind>: PASS (cached <ISO> · from <kind> · log <ruta> · sha256 <logSha256>)`.
  - `--force` no consulta, pero graba.
- **`navori gate probe [--index|--clean]`:** exit 0 si hay hit y 1 si no. Nunca corre la cadena.
- **`results.json`:**
  `{ v: 1, entries: [{ kind, fingerprint, commandHash, lockHash, navoriVersion, bunVersion,
  nodeVersion, ts, log, logSha256 }] }`. Una versión desconocida, o un JSON inválido, es miss.
- **Línea de evidencia:** `fp?: 2`. **Config:** `qualityGate.affected?` y `qualityGate.docs?`.
- **`receipt sign --gate-ran docs`** según D6, y **`--gate-source cached|ran`** (opcional; va solo
  al outcome).
- **Spool:** `spool-<session>/<tsMs>-<pid>-<rand>.json` con `{ v: 1, host, metadata }`, de 2 KiB como
  máximo.
- **`test-budget.json`:** `defaultMs` y `exceptions[]` con `file`, `ms` y `reason` no vacía. Se
  lee `NAVORI_TEST_BUDGET_FACTOR`.
- **`navori tools session-context`:** dos secciones centinela, todo o nada.
- **`navori handoff render <feature>`** (0045 D13):
  - el feature pasa por `validateFeatureSlug`;
  - lee y escribe solo dentro del state root (`resolveStateRoot` + `ensureStateDirectory`);
  - `impl_<feature>.md` se escribe con `writeStateFileAtomic`, que no sigue symlinks;
  - rechaza un `impl_<feature>.json` de otra feature o con `scribeOwnsMarkdown` en `false`.

## Failure modes

| Falla | Contención |
|---|---|
| Deriva de `node_modules` o de binarios globales fuera de la clave | Lockfile y versiones de navori, bun y node en la clave. `--force` y CI `quality` (`dev` y `main`) cubren el resto. Residual declarado. |
| Entrada falsificada o vieja en `results.json` | Hit solo con log presente, `logSha256` igual y centinela de éxito. |
| Una edición solo bajo `PROGRESS_DIRS` no invalida (R12) | CI la caza. |
| Edición durante el gate | Huella antes ≠ después ⇒ no graba. |
| Archivo sin trackear, filtros o `core.fileMode` | El probe da miss y se corre el gate. Medido en M4. |
| `git commit -a` o con rutas desde el hook gestionado | `--clean` exige índice = árbol de trabajo = registro. |
| CLI viejo frente al probe | `unknown kind` ⇒ exit 2 ⇒ corre el gate. |
| Hook nuevo con CLI viejo (evidencia) | El CLI viejo ignora `fp` y calcula legacy. Si `progress/` está trackeado y cambió, la evidencia no valida y pide re-correr (fail-closed). Se resuelve con `navori update` más `render --apply`. |
| Línea vieja sin `fp` con CLI nuevo | Se valida con la huella legacy. |
| Lock de `dist/` huérfano tras un SIGKILL | Se reclama con `ESRCH` en el mismo host. Si no, el mensaje nombra la ruta del lock. |
| `test:affected` no ve un test | Solo es carril no-cierre. Respaldan el gate de cierre y CI. |
| Payload con `\u0000` o salida de `jq` deforme | Extracción campo por campo de hoy (D10). |
| Clave duplicada o `\u` en el payload de `plan-gate` | Decide el CLI. |
| Spool: archivo a medio escribir, inválido o huérfano | Espera de 5 s, descarte individual y consolidación en la próxima pasada. |
| Hook nuevo con CLI viejo (auditoría) | El CLI viejo no crea el spool, así que el hook usa el puente actual. Si el spool existe y lee un CLI viejo, los eventos quedan como archivos hasta que un CLI nuevo consolide (declarado). |
| Presupuesto de tests flaky en el runner | `NAVORI_TEST_BUDGET_FACTOR` en CI. |
| `EMFILE` | Tope por `ulimit -n` medido en M2, más override. |

## Migration

- **Enmienda del contrato de identidad de evidencia** (0038 D2, segundo bullet; 0042 D5).
  - "`git -C tree rev-parse HEAD` = `head` registrado" pasa a decir: "la huella `worktreeTree`
    coincide (v2 o legacy según `fp`). `head` ata solo si el `command` no está en
    `PURE_EVIDENCE_RUNNERS`".
  - Se agrega una nota en `specs/0038-aprendizajes-curso-harness/design.md` § D2 y en
    `specs/0042-auditoria-accionable-codex/design.md` § D5, con puntero a 0054 R19/R20.
- **Invariante del escritor de auditoría.** Se enmienda según D8, en el encabezado de
  `audit-log.sh`, con su drift test.
- **Hooks renderizados.** Llegan con `navori render --apply`. Combinaciones de binarios: ver
  Failure modes.
  Desviación de M4: el render regeneró, además del hook de M4, `.claude/agents/reviewer.md`,
  `.claude/context/10-orquestacion.md` y `.claude/skills/resolve-ticket/SKILL.md`, y revirtió
  `.pi/extensions/navori.ts` a la fuente. Los cuatro estaban desfasados respecto a `core-assets`.
- **Config.** Claves nuevas opcionales; sin ellas, todo queda como hoy (la re-firma docs pide full).
  `check:fast` de este repo cambia a pasos raíz.
- **Recibos.** La cabecera no cambia.

## Testing strategy

- `gate/cache`:
  - hit; miss por cada campo de la clave;
  - log ausente, con otro hash o sin centinela ⇒ miss;
  - `fastCoveredByFull` con pasos iguales, faltantes y con `cd` distinto;
  - edición durante la corrida ⇒ no graba; escritura concurrente.
- Probe (repo real):
  - `--index` con `git commit <path>`, `-a` y desde un worktree;
  - `--clean` con un archivo sin trackear ⇒ miss;
  - `core.autocrlf` ⇒ miss sin excepción;
  - `PATH` sin bun ⇒ corre el gate;
  - CLI viejo simulado ⇒ corre el gate.
- `evidence`:
  - runner puro con `HEAD` movido ⇒ válida;
  - `classify --diff` o `check:blame-ignore` ⇒ atada;
  - `cd x && bun run test` ⇒ puro; `bun run test | tee` ⇒ no;
  - línea sin `fp` y edición en `progress/` ⇒ legacy válida.
- `ensure-dist`:
  - sello igual ⇒ no compila;
  - entrada cambiada, borrada o sin sello ⇒ compila;
  - edición durante el build ⇒ sin sello;
  - `lockHeld` no se autobloquea; reclamo con `ESRCH`.
- `receipt --gate-ran docs`:
  - `.md` en `docs/` ⇒ ok;
  - `.ts` nuevo con `.md`, `.ts` borrado, `docs/x.ts`, `docs/X.MD` o un symlink ⇒ rechazo;
  - `qualityGate.docs` ausente ⇒ rechazo.
- Hooks:
  - `payload_fields` con `\u0000`, saltos de línea y comillas, en jq y en node, para los dos
    engines;
  - `plan-gate` con clave duplicada o `\u` ⇒ CLI;
  - spool con nombre preexistente o symlink ⇒ no escribe;
  - consolidación con un archivo inválido ⇒ descarta solo ese, e idempotente;
  - `session-context` con una sección fallida ⇒ nada impreso;
  - `managed-drift` limpio sin hashear.
- Reescrituras: conteo e ids de casos, smoke de mutación y `doctrine-literal-diff` (D4).
  Desviación de M3: el smoke de mutación existe solo en `implementer-no-markdown` (M3b). El script
  `check-test-preservation.mjs` no lo implementa por archivo. Su conteo de casos es estático (`it`/`test`;
  filas de tabla por `id:`), así que un `it.each` cuenta una vez.
- `bench:hooks` verifica R23, R24 y R27, y `bench:tests` contra la línea base verifica R4. Son
  criterios `A<n>`, no tests de la suite.

## Línea base

**Preliminar.** Se midió con la máquina bajo carga (load ~2.5–3.5, 10 cores, `maxWorkers: 4`) y se
vuelve a medir en M1. La única cifra no preliminar es el probe (~150 ms, medido el 2026-10-15).

| Métrica | Preliminar | Medida M1 (bajo carga; loadavg ~9-17 en 10 cores; `ulimit -n 1048576`; mediana de 2, NO de 3, NO con máquina libre) | Objetivo |
|---|---|---|---|
| Suite completa, pared | ~490 s | 534 s (mediana de 2: A 573.8 s con loadavg 8.57 al inicio, exit 1; B 494.7 s con loadavg 4.78, exit 0, 437 archivos, 9 146 tests) | ≤ 50 % de M1 (R4) |
| Suma por archivo | 1 822 s (433 archivos, 8 928 tests) | A 2 138 s (9 201 tests); B 1 856 s | — |
| `slice.test.ts` | 171 s | A 146.9 s / B 176.4 s | presupuesto R2 |
| `guard-destructive` | 99 s | A 90.4 s / B 109.0 s | presupuesto R2 |
| `audit-hooks` | 89 s | A 68.2 s / B 82.0 s | presupuesto R2 |
| `implementer-no-markdown` | 75 s | A 111.3 s / B 85.3 s | presupuesto R2 |
| `cli.e2e` | 71 s | A 71.8 s / B 81.3 s | presupuesto R2 |
| `plan/escalation` | 58 s | B 50.1 s (A no capturado) | presupuesto R2 |
| Bash sin audit (Claude, 8 hooks) | ~0.7 s proceso / 0.33 s pared | 328 ms proceso (mediana de 3, corrida B; 358 ms en una corrida previa); presupuesto excedido | ≤ 300 ms proceso (R27) |
| Bash sin audit (Codex, 7 hooks) | — | 395 ms proceso (corrida B; 398 ms en una corrida previa); presupuesto excedido | ≤ 300 ms proceso (R27) |
| Eventos Claude/Codex (corrida B) | — | Edit 208 / 327 ms; Agent 347 / 351 ms; SessionStart 411 / 746 ms; UserPromptSubmit 273 / 291 ms | — |
| `plan-gate` | 349 ms Claude / 526 ms Codex | por hook en `.navori/state/bench/hooks-latest.json` (`measurements[]`) | < 60 ms en la vía rápida (R24) |
| Probe `bun …/src/index.ts` (arranque) | ~150 ms | M4: 112 ms miss / 119 ms hit (ver «Medición M4») | — |
| `ensureDist` con hit, 1 archivo | — | M2: hit ~65 ms pared vía bun (0.03 s user); corrida de un archivo con `dist/` sellado ~0.6–0.9 s total; primera compilación: ~1.1 s de overhead de `ensure-dist` aparte del build | — |

M1 llena la tabla con `bench:tests` y `bench:hooks`, y registra `loadavg` y `ulimit -n`.

**Cifras de M1 bajo carga, no válidas para R4.** La corrida A no es línea base válida: vitest salió con
exit 1 porque cuatro archivos de render del engine superaron el timeout de 15 s bajo carga; pasan
aislados. Las cifras son mediana de 2 corridas, no de 3, y no se midieron con la máquina libre. R4 no
se cierra con estos números.

**Medición M3 (bajo carga, tras la reescritura; no comparable con la columna M1).** `slice.test.ts`
~130 s (loadavg 9–16); `escalation.test.ts` 28–72 s; `cli.e2e.test.ts` ~118 s. Antes y después no se
midieron con la misma carga, así que esta revisión no tiene un par válido antes/después. T43 lo mide
en reposo.

**Medición M4 (2026-10-15, loadavg 3.5, clon scratch, 1 436 archivos trackeados).**
`indexContentIdentity` mediana 13 ms (7 corridas); huella del árbol de trabajo mediana 104 ms;
`gate probe --index` 112 ms miss y 119 ms hit (incluye los spawns de `bun --version` y
`node --version`); gate rápido ~1.2–1.6 s en caliente. Commit con hit 0.1–0.2 s frente a miss
1.4–1.9 s. Tasa de hits del probe: 6 de 9 ciclos reales (gate→add→commit 3/3, `commit -a` 1/1,
`add -A` 1/1 y un ciclo extra, todos hit). Los 3 misses: commit sin gate previo, archivo sin trackear
presente y `git commit <path>` con otro archivo editado. Con HEAD sin nacer (unborn) la caché queda
deshabilitada.

**Nota de carga (wave 1).** `bench:tests` con `maxWorkers` 8, bajo loadavg 6–9, dio pared 568 s y suma
por archivo 3 833 s, frente a 1 822 s con 4 workers. No hubo ganancia neta de pared. `CAP` se revalida
en M8 con la máquina libre. Enmienda: `WORKER_CAP` queda en 4 (`packages/cli/vitest.workers.ts`). Con CAP=8 bajo carga, la pared fue 545–568 s frente a 495–574 s con 4 workers; el tiempo por archivo fue 1.3–1.8× (suma 3 833–4 072 s), con timeouts en `slice`, `escalation` y `role-guard` y 28 archivos sobre presupuesto.

**`defaultMs` = 20000 ms** (ya escrito en `packages/cli/test-budget.json`). Se justifica con la
distribución por archivo de la corrida de 495 s, bajo carga: p50 215 ms, p90 10.2 s, p95 16.9 s,
p99 50.1 s; 79 archivos > 5 s, 45 > 10 s, 20 > 20 s. 20 s queda justo arriba del p95. Los ~20
archivos que lo superan (los seis objetivos de R7–R9 y otros) requieren excepción con razón o
reescritura en M3. Se re-ajusta tras la línea base en reposo de M8, porque las cifras cargadas están
infladas.

**Forma del reporte JSON de vitest 5.0.1 (fijada en M1).** No hay duración total. `testResults[]`
contiene `name` (ruta absoluta), `startTime`, `endTime` (epoch ms), `status` y `assertionResults[]`.
La duración por archivo es `endTime - startTime`. La pared la mide `bench-tests.mjs` alrededor del
proceso.

**M8 re-mide.** M8 mide la línea base (checkout del merge-base) y la final bajo las mismas
condiciones de máquina libre para evaluar R4 (T43).

## Casos e2e borrados (R9)

Cada fila: caso borrado → caso unit que afirma lo mismo. Total: 100 casos antes; 94 existentes tras el
borrado, más 1 caso nuevo (95).

| Caso e2e borrado | Contraparte unit (`archivo::caso`) |
|---|---|
| `render --workspace acota la operación a un solo workspace` | `packages/cli/src/commands/__tests__/render-monorepo.test.ts`::"renders only the matched workspace, skips root" |
| `render --workspace falla con mensaje claro cuando el nombre no matchea` | `render-monorepo.test.ts`::"returns ok:false when the workspace name does not match" (afirma el nombre y la lista de workspaces conocidos) |
| `scan --yes agrega un workspace nuevo creado tras init` | `packages/cli/src/commands/__tests__/scan.test.ts`::"detects new workspaces and writes them to config when yes=true" |
| `scan --yes no hace nada si init ya pobló los workspaces` | `scan.test.ts`::"classifies existing workspaces and skips them" (afirma `wrote=false`) |
| `init --recommended: un runner CON suite deriva always (#529)` | `packages/cli/src/lib/diagnose/__tests__/tests-policy.test.ts`::"derives always when the runner has a suite behind it" |
| `doctor no reporta drift por un marker de agente anterior al CLI` (con `// Covers: A3`) | `packages/cli/src/lib/__tests__/health.test.ts`::"does not report a marker older than the CLI: its version is the last change, not staleness" (también `// Covers: A3`; A3 sigue en `cli.e2e` en otros dos casos) |

Se conservan los casos e2e «sin suite» y «sin runner» de `init --recommended`, que afirman el cableado
de init. El caso nuevo es `cli.e2e.test.ts`::"cada subcomando conserva un caso de código de salida real" (T13).

## Orden de implementación

Una entrega: un PR a `dev`, un commit atómico por milestone. M8 es el cierre y corre `navori gate
full` (R16).

1. **M1 — Medición (A):** R1, R2, R27 y la línea base de R4.
2. **M2 — Infra de suite (B):** R5, R6, R10, R11 y R18 (más `quality` en `dev`).
3. **M3 — Reescrituras (B):** R7, R8, R9 y el enforcement de R3.
4. **M4 — Caché de gate (C):** R12–R15 y R17, en los dos hooks, con la alineación de `check:fast` y
   la medición de hits.
5. **M5 — Evidencia y recibos (D):** R19–R21, `test:docs` y la enmienda.
6. **M6 — Hooks (E):** R22–R26, verificados con `bench:hooks`.
7. **M7 — Ciclo proporcional (F):** R28–R31 en código.
8. **M8 — Doctrina y cierre (G):** R16, R32, R33 y la medición final de R4.

## Decisiones del usuario (antes preguntas abiertas)

1. El reviewer puede firmar `--gate-ran full` sobre un `cached PASS` del mismo árbol. Reporta
   `cached`, la fecha y el `logSha256`, y el cierre no fuerza `--force` (D1).
2. El probe también va en `quality-gate-pre-commit.sh`, en modo `--clean` (D1).
3. El job `quality` corre en PRs y pushes a `dev` (R18).
4. Los tests que leen `docs/` o `specs/` se suman a `qualityGate.docs` vía `test:docs`:
   `direction-doc`, `direction-claude-first` y `command-docs-inventory`, más los lectores de
   `specs/` del repo que M5 confirme (D6).

## NOT in scope

- **0045 E3:** diferida, porque agrega verificación y no velocidad.
- **Migrar a `bun test`:** descartado por el usuario.
- **Caché o `dist/` compartidos entre worktrees o máquinas:** `node_modules` difiere.
- **Caché por paso del gate:** ningún requisito la pide.
- **Autenticar `results.json` frente a un agente hostil:** el modelo de confianza ya permite
  escribir estado; el `logSha256` es endurecimiento, no una frontera.

## Durable knowledge

- "La caché del gate es un atajo de tiempo, nunca evidencia de review" → invariante en
  `docs/DIRECTION.md`.
- Presupuesto por archivo, `bench:tests`, `test:affected`, `test:docs` y la regla de specs que lanzan
  `dist/` → `CONTRIBUTING.md`.
- Hooks sin procesos en el camino común, y el invariante enmendado del escritor de auditoría →
  encabezados de `_partials/extract-cmd.sh` y `_partials/audit-log.sh`.

## Fuentes

- Vitest CLI (`vitest related`, `--changed`, `outputFile`), https://vitest.dev/guide/cli,
  consultada el 2026-10-15. Versión instalada: 5.0.1. La forma del JSON del reporter
  (`testResults[].startTime/endTime`) está **[SIN VERIFICAR]**; M1 la fija contra la salida real.
