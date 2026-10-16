# DX del ciclo de desarrollo: menos re-procesos, suite más rápida, hooks más baratos — Requirements

**Estado:** borrador · **Fecha:** 2026-10-15 · **Base:** `dev` (incluye 0052 y 0053). El PR de esta
spec apunta a `dev`.

## Contexto

Desarrollar con el harness es cada vez más lento. El costo no está en un solo gate, sino en cómo se
suman la suite de tests, las re-corridas sobre el mismo árbol y los hooks que corren en cada tool
call, tanto en este repo como en los proyectos donde navori instala el harness. Los mecanismos de
garantía se robustecieron sin un presupuesto de tiempo y la DX quedó de lado.

Evidencia (2026-10-08, 2026-10-14 y 2026-10-15, reconocimientos de solo lectura y mediciones locales):

- **La suite es el gate.** `test:coverage` es el 97–98 % de `qualityGate.full`; el resto de los pasos
  suma unos 12 s. Sin carga, la suite tarda ~490 s en una máquina de 10 cores con `maxWorkers: 4`
  (294 % de CPU). 433 archivos y 8 928 tests. 85 archivos de más de 5 s suman 1 572 s de los 1 822 s
  acumulados. Los más lentos: `slice.test.ts` (171 s, git init + fixture por test),
  `guard-destructive` (99 s, 612 spawns de bash), `audit-hooks` (89 s), `implementer-no-markdown`
  (75 s), `cli.e2e` (71 s) y `plan/escalation` (58 s).
- **Builds repetidos.** `vitest.globalSetup.ts` corre `bun run build` en cada corrida, incluso de un
  solo archivo. `check:render` vuelve a compilar. Un gate full compila dos veces y el job `quality`
  de CI tres.
- **El set rápido corre 3–4 veces sobre los mismos bytes por ciclo.** Lo corren el implementer
  (`navori gate fast`), el hook de git `pre-commit` (`check:fast`), el reviewer (dentro de `full`) y
  CI `fast`. Ningún resultado se cachea: `lib/gate/run.ts` siempre ejecuta la cadena.
- **La evidencia caduca sin cambio de bytes.** La evidencia de un `A<n>` fuera de entrega muere con
  cualquier movimiento de `HEAD` (`evidence.ts` `candidateProblem`). `progress/` está en
  `PROGRESS_DIRS` pero no en `FINGERPRINT_EXCLUDES`. Una edición de Markdown posterior a `APPROVED`
  obliga a re-firmar con gate full.
- **Hooks instalados.** Una llamada Bash en Claude dispara 8 hooks: ~0.7 s de proceso y ~0.33 s de
  pared. Con audit-mode activo y log presente la suma sube a ~1.9 s, porque el trigger arranca el CLI
  `navori` en cada evento. `managed-drift-watch` hashea las raíces gestionadas en cada Bash/Edit
  (0.2–0.3 s) aunque nada haya cambiado. `plan-gate` cuesta 349 ms (Claude) y 526 ms (Codex) por
  spawn. `SessionStart` arranca el CLI dos veces. Cada hook forkea `jq` una vez por campo.

Decisiones del usuario (2026-10-15):
- **CI es la autoridad final de la suite completa**, más una caché de resultado por árbol. En local,
  el reviewer corre los checks estáticos, los tests afectados y los `A<n>`. La suite completa local
  corre solo al cierre (milestone de cierre de spec, o PR de un workplan) y se omite si ese mismo
  árbol ya tiene un resultado verde.
- **Tests: presupuesto más reescritura.** Habrá un presupuesto de tiempo por archivo. Los archivos más
  lentos se reescriben con fixtures compartidos y los tests de prosa de doctrina se fusionan. Un
  duplicado e2e/unit se borra solo después de verificar que ambos afirman lo mismo. Vitest se queda:
  migrar a `bun test` queda descartado (118 `vi.mock`, 63 `vi.hoisted`, `json-summary` del piso de
  cobertura).
- **0045:** esta spec absorbe la entrega E4 (nivel 0 proporcional, handoff determinista, nits
  posteriores a `APPROVED`) y E3 queda diferida, porque agrega verificación y no velocidad.
- Una sola entrega: un PR contra `dev` con commits atómicos por milestone.

## Requirements (EARS)

### A — Medición y presupuesto

- **R1** — The system SHALL ofrecer `bun run bench:tests`, que corre la suite con el reporter JSON de
  vitest y escribe en `.navori/state/bench/` la duración de pared total, la duración por archivo y
  los 25 archivos más lentos.
- **R2** — The system SHALL declarar en un solo archivo versionado el presupuesto de tiempo por
  archivo de test y la lista de excepciones, cada una con su razón.
- **R3** — WHEN CI corre la suite completa, the system SHALL fallar si un archivo excede su
  presupuesto (multiplicado por `NAVORI_TEST_BUDGET_FACTOR`, para absorber el ruido del runner) y
  no está en la lista de excepciones, nombrando el archivo, su duración y el presupuesto.
- **R4** — The suite completa SHALL tardar, en pared y con la máquina libre, como máximo el 50 % de
  la línea base medida al inicio de esta entrega con `bench:tests` y registrada en `design.md`.

### B — Suite de tests

- **R5** — WHEN arranca una corrida de vitest, the `globalSetup` SHALL reutilizar `dist/` si su huella
  de entradas (fuentes del CLI, `core-assets`, configuración del bundler y lockfile) coincide con la
  de la última compilación, y SHALL compilar solo si difiere o falta.
- **R6** — `check:render` SHALL usar la misma decisión de compilación que R5, en lugar de compilar
  incondicionalmente.
- **R7** — The archivos `slice.test.ts`, `guard-destructive`, `audit-hooks`,
  `implementer-no-markdown`, `cli.e2e` y `plan/escalation` SHALL quedar dentro del presupuesto de R2
  sin reducir los requisitos que cubren: cada `// Covers: R<n>` previo sigue cubierto por algún caso.
- **R8** — The tests de prosa de doctrina (`orquestacion-doctrina`,
  `scribe-owns-markdown-contracts`, `plan-tiers-contracts`, `claude-md-diet`) SHALL fusionarse en un
  solo archivo de contratos, que conserva cada token que hoy se afirma.
- **R9** — The system SHALL borrar un caso e2e (spawn del CLI o de un hook) solo cuando un caso unit
  afirme el mismo comportamiento. `design.md` SHALL listar cada caso borrado junto a su contraparte.
  The suite SHALL conservar al menos un caso de borde de proceso (código de salida o hook real) por
  subcomando y por hook.
- **R10** — The configuración de vitest SHALL derivar `maxWorkers` del número de CPUs con un tope
  validado por medición y acotado por `ulimit -n`, sin reaparecer el `EMFILE` de #281, y SHALL
  permitir sobrescribirlo con `NAVORI_TEST_WORKERS`.
- **R11** — The system SHALL ofrecer `bun run test:affected`, que corre los tests relacionados con
  los archivos cambiados respecto del merge-base con `dev` (más los cambios sin commitear y los
  borrados). Si cambió alguna entrada de `dist/`, también corre los specs que lanzan
  `dist/index.js`. Si cambió algo bajo `core-assets`, también corre los tests de render y golden.

### C — Caché de gate y autoridad de la suite

- **R12** — WHEN `navori gate fast|full` termina en verde, the system SHALL registrar el resultado
  con una clave formada por la huella del árbol de trabajo (sin las rutas de `PROGRESS_DIRS` ni
  `.navori/state`), el hash del comando del gate, el hash de los lockfiles y las versiones de navori,
  bun y node. El registro guarda el sha256 del log, y un hit exige que el log exista con ese hash y
  con el centinela de éxito.
- **R13** — WHEN se invoca `navori gate fast|full` y existe un resultado verde con la misma clave,
  the system SHALL omitir la corrida e informar el resultado previo con su fecha. `--force` SHALL
  correrla siempre. Un resultado `full` verde satisface `fast` solo si cada paso `&&` de
  `qualityGate.fast` aparece literal en `qualityGate.full`.
- **R14** — IF la clave no se puede calcular o el registro no se puede leer THEN the system SHALL
  correr el gate.
- **R15** — The system SHALL tratar el resultado cacheado como un atajo de tiempo, no como evidencia
  de review: ni el recibo ni `--gate-ran` se infieren de la caché. El reviewer MAY firmar
  `--gate-ran full` sobre un PASS cacheado del mismo árbol (decisión del usuario), y SHALL reportar
  en su tabla del pase 2 que fue cacheado, con su fecha y el hash del log.
- **R16** — WHILE un milestone no es de cierre, the `reviewer` SHALL aprobar con `qualityGate.scoped`,
  `test:affected` y los `A<n>` del milestone. WHEN el milestone es de cierre (o es el PR de un
  workplan sin spec), the `reviewer` SHALL correr `navori gate full`, sujeto a R13.
- **R17** — WHEN el hook de git `pre-commit` de este repo o el hook gestionado
  `quality-gate-pre-commit.sh` de los proyectos instalados corre, the system SHALL omitir el gate
  rápido si existe un resultado verde (`fast` o `full`) cuya clave coincide con el contenido del
  índice que se va a commitear. La consulta es un subcomando propio con el entorno `GIT_*` depurado
  (salvo `GIT_INDEX_FILE`). Si no coincide, o si la consulta falla o el CLI no la conoce, lo corre
  como hoy.
- **R18** — The job `quality` de CI SHALL correr también en PRs y pushes hacia `dev` (decisión del
  usuario: CI es la autoridad de la suite completa en `dev` y en `main`), y SHALL compilar `dist/`
  una sola vez y reutilizarlo en `check:render` y en la suite mediante R5.

### D — Evidencia y recibos

- **R19** — WHEN `HEAD` se mueve sin cambiar la huella del árbol y el `command` del `A<n>` es de un
  runner puro de la lista declarada (tests y checks que no leen la historia de Git), the system SHALL
  conservar válida su evidencia. Cualquier otro comando sigue atado a `HEAD`. Las líneas de evidencia
  anteriores a esta spec siguen validándose con su huella original. Esto modifica el contrato de
  identidad de evidencia de 0038/0042, que `design.md` enmienda.
- **R20** — The `FINGERPRINT_EXCLUDES` de la evidencia SHALL incluir las rutas de `PROGRESS_DIRS`.
- **R21** — WHEN el conjunto de cambios posterior a `APPROVED` (deriva, archivos nuevos no cubiertos,
  faltantes, reaparecidos y borrados, calculado por el CLI) son solo `*.md` bajo `specs/` o `docs/`,
  the re-firma delta SHALL correr `qualityGate.docs` (`check:links`, `check:doc-budgets` y los tests
  que leen `docs/` o `specs/`) en lugar del gate full. IF `qualityGate.docs` no está declarado o algún
  cambio sale de ese conjunto THEN SHALL exigir el gate full.

- **R35** — The `fingerprintTree` de la evidencia SHALL calcular la huella con un número de procesos
  de git acotado e independiente del número de archivos (una lectura del índice y del árbol, hash en
  proceso), y SHALL producir exactamente la misma huella que la implementación previa para el mismo
  árbol. Evidencia: 2026-10-15, ~700 spawns de git por llamada en los tests pesados de
  `slice.test.ts`, el mismo costo que paga `plan update` en uso real.

### E — Hooks instalados

- **R22** — WHEN un hook necesita varios campos del payload, the system SHALL extraerlos con una sola
  invocación de `jq` (o un solo fallback a `node`). IF algún campo contiene un byte NUL o la salida
  no tiene la forma esperada THEN SHALL volver a la extracción campo por campo de hoy.
- **R23** — The `managed-drift-watch` SHALL omitir el hasheo cuando ningún archivo ni directorio de
  las raíces gestionadas tiene un `mtime` más nuevo que su sello. En el camino limpio SHALL terminar
  en menos de 60 ms medianos. Una edición que preserva el `mtime` queda como límite declarado (el hook
  es advisory).
- **R24** — WHEN el `subagent_type` o el rol del spawn aparece una sola vez, sin escapes `\u`, y es
  un rol conocido que no es implementer, the `plan-gate` SHALL decidir `allow` antes de cualquier
  proceso que no sea el shell, en menos de 60 ms medianos. En cualquier otro caso decide el CLI, como
  hoy.
- **R25** — The `session-start-context` SHALL invocar el CLI `navori` una sola vez, con un
  subcomando que entrega en una sola salida, todo o nada, lo que hoy entregan `tools notice` y
  `dominio inject`. IF el subcomando falla o no existe THEN el hook SHALL caer a las dos llamadas de
  hoy.
- **R26** — WHILE audit-mode está activo, the `audit-mode-trigger` SHALL registrar cada evento sin
  arrancar el CLI `navori`, creando un archivo por evento (sin sobrescribir, sin seguir symlinks) en
  un directorio privado `0700` que el CLI crea al iniciar el modo. El CLI SHALL consolidar los
  eventos al cerrar la sesión (`audit-mode-close`) o al leer el log, re-validando cada uno y
  descartando los inválidos, de forma idempotente.
- **R27** — The system SHALL ofrecer `bun run bench:hooks`, que mide la mediana de 3 corridas por
  hook, para Claude y Codex, con payloads representativos. Reporta la suma por evento (Bash, Edit,
  Agent, SessionStart, UserPromptSubmit) y sale con código distinto de cero si una llamada Bash sin
  audit supera 300 ms de proceso sumado.

### F — Ciclo proporcional (absorbido de 0045 E4)

- **R28** (antes 0045 R12) — WHEN el encargo abre con `nivel-0:`, the system SHALL exigir en esa
  línea un criterio `| verify: \`<cmd>\` → <expected>`, y el plan-gate SHALL negar el despacho del
  `implementer` si falta.
- **R29** (antes 0045 R13, R14) — WHILE el nivel es 0 y el diff no toca `project.criticalAreas`, the
  `reviewer` SHALL limitar el pase 2 al checklist de `review-diff` y a `verify`. IF el diff toca un
  área crítica THEN SHALL aplicar el review completo, sin importar el nivel.
- **R30** (antes 0045 R21) — The system SHALL producir `impl_<feature>.md` desde
  `impl_<feature>.json` con `navori handoff render <feature>`, y el orquestador SHALL despachar al
  `scribe` solo cuando `markdownRequests` no esté vacío.
- **R31** (antes 0045 R22) — The doctrina del orquestador SHALL indicar que una observación
  informativa (score menor a 80) posterior a `APPROVED` se reporta en el PR y no reabre el ciclo.

- **R34** — IF `navori plan gate` niega un despacho y la versión del CLI que ejecuta el hook es menor
  que `harnessVersion` de `navori.config.json` THEN the `plan-gate` SHALL agregar al motivo que el CLI
  está desactualizado, las dos versiones y la ruta para actualizarlo. La consulta de versión ocurre
  solo en el camino de negación, sin costo en un `allow` (R24). Evidencia: 2026-10-15 un encargo
  `spec: 0054-dx-ciclo-desarrollo E1 M1` se negó con un motivo que no nombra la apertura `spec:`,
  porque el `navori` global era 0.12.0 y la apertura entró en 0.12.1.

### G — Doctrina y cierre

- **R32** — The prosa de R13, R16, R17, R21 y R28–R31 SHALL renderizarse para Claude y Codex en
  `reviewer`, `publisher`, `implementer`, `orchestrator`, `verify-before-done` y `planificacion`.
- **R33** — The `tasks.md` de 0045 SHALL marcar E3 como diferida y E4 como absorbida por 0054.
