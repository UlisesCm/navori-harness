# Historia de sesiones

<!--
Entradas más recientes arriba. Formato sugerido (no obligatorio):

## YYYY-MM-DD HH:MM — <agente> — <resumen breve>
- Cambios: <archivos / áreas tocadas>
- Quality gate: ✅ (quality gate sin configurar — corre 'navori configure quality-gate') verde | ❌ <razón>
- Notas: <decisiones no obvias, blockers, deuda>
- Commit / PR: <hash / URL>
-->

## 2026-08-26 00:40 — claude — Auditoría a ciegas con 5 agentes sin contexto: 17 issues, 4 de seguridad

- **Cambios:** ninguno en código. 17 issues abiertos (#495–#511) + `progress/`.
- **Quality gate:** ✅ sin cambios de código desde el verde de la sesión anterior (2124 tests);
  `check:render` re-verificado en verde al cerrar.
- **Método:** 5 `auditor` en paralelo (assets / hooks / CLI / config / tests), cada uno con
  prohibición explícita de leer `progress/`, usar engram o mirar `git log`, y con obligación de
  **demostrar** cada hallazgo (repro, comando, o la mutación que debería romper un test y no lo
  hace). Verifiqué a mano los load-bearing antes de abrir issues y ajusté severidades donde el
  auditor se quedó corto (el `sg` venía como ALTO y es de seguridad).
- **Notas:**
  - **El patrón es uno solo, no 17 bugs sueltos:** las defensas del harness describen el peligro por
    su **forma textual** (`-rf`, un nombre de binario, una lista de rutas) en vez de por su
    semántica, y **ninguna verifica que pudo hacer su trabajo**. Un guard que no evaluó, un gate que
    salió 1, un backup vacío y un parser ciego dan la misma señal visible que el éxito.
  - **Seguridad (4):** #509 el guard se esquiva con `rm -R` y flags largas (incluido
    `--no-preserve-root /`); #495 `Bash(sg:*)` pre-aprueba ejecución arbitraria en Linux; #510 los
    gates de semgrep/jscpd salen `exit 1` y `PreToolUse` solo bloquea con `2`; #511 el guard se
    satura (46,9 s vs timeout de 10 s) y muere sin evaluar.
  - **Pérdida de datos (3):** #497 `global init` destruye `~/.claude/settings.json` sin backup;
    #496 `--prune` borra archivos ajenos; #498 un fence sin cerrar duplica todos los bloques.
  - **Cruce que ningún auditor vio solo:** el de CLI citó el backup del `--prune` como mitigación;
    el de tests lo mutó a `createBackup(cwd, [])` y la suite siguió **2124/2124 verde**.
  - **Hallazgo sobre código del mismo día:** #503, `audit --start` escribe fuera de su raíz
    declarada. El test que afirma ese contrato prueba la mitad que no puede romperlo.
- **Commit / PR:** sin PR de código. Reportes completos en `.claude/progress/audit_ciego_*.md`
  (**gitignored**: no se versionan; la sustancia vive en los issues).

## 2026-08-25 23:05 — claude — Los 3 issues del audit, cerrados: uno refutó su propia premisa

- **Cambios:** `commands/{audit,global}.ts` + `index.ts` (una sola `readCliVersion`),
  `scripts/check-asset-commands.mjs` (nuevo) + `ci.yml` (`fetch-depth: 0`),
  `lib/audit/{parse,model,report,discovery}.ts`, `audit-mode-trigger.sh` (graba `transcript_path`),
  suites nuevas de versión y del check, espejo renderizado y golden snapshots.
- **Quality gate:** ✅ `pnpm format:check` · 2124 tests · `pnpm lint` · `pnpm typecheck` ·
  `pnpm check:render`. (`check:assets` avisa por `audit`, que es correcto hasta publicar 0.7.0.)
- **Notas:**
  - **#488** no era un typo de versión: había **cuatro** implementaciones de "leer mi propia
    versión". La de `audit` usaba `process.env.npm_package_version`, que solo existe bajo un script
    de npm — como binario el fallback `"0.0.0"` disparaba el **100%** de las veces.
  - **Mi propio guard de #488 nació como falso verde** y lo destapó su test de sanidad:
    `url.pathname` queda percent-encoded, y bajo `Dev - Docs` daba `Dev%20-%20Docs` → grep fallaba →
    el `catch` lo reportaba como "sin coincidencias". Ahora `fileURLToPath`, y solo el exit 1 cuenta
    como vacío.
  - **#490** generaliza el bloqueador de #486 a un check. Compara contra el **último tag de git**
    (sin red, determinista). Detalle que casi lo vuelve inútil: `actions/checkout` no trae tags por
    defecto → `fetch-depth: 0`, o se saltaría a sí mismo en silencio (punto ciego de #421).
  - **#489 refutó su premisa, que era mía.** El log no perdía prompts: lo que el humano escribe
    mientras el agente trabaja se encola (`queue-operation`) y se entrega dentro del turno, sin
    disparar `UserPromptSubmit`. El hook no puede verlo. El fix lee del transcript y el reporte
    **declara** su cobertura (19 = 12 de turno + 7 encolados) en vez de aparentarla.
  - **`user_prompt` nunca existió**: la clave del payload es `prompt`. Y `transcript_path` estaba
    ahí sin usarse, mientras `discovery.ts` adivinaba la ruta con una heurística.
- **Commit / PR:** #491, #492, #493 — todos mergeados. Tablero: **0 issues, 0 PRs**.

## 2026-08-25 21:33 — claude — Primer uso real del modo audit: destapó su propio bloqueador y 4 hallazgos más

- **Cambios:** `audit-mode-trigger.sh` (introspección del subcomando + clave del prompt + copy a inglés),
  `engines/claude/agent-mcp-tools.ts` (nuevo) + `index.ts`, `codegraph-protocol.md` → puntero,
  `codegraph-rung.md` condensada, `commit-pr-pilot.md` + `orquestacion.md` (reclamo de worktrees),
  suites de hooks y del módulo nuevo, golden snapshots por engine, espejo renderizado.
- **Quality gate:** ✅ `pnpm format:check` · 2107 tests · `pnpm lint` · `pnpm typecheck` · `pnpm check:render`.
- **Notas:**
  - El modo audit quedó inoperante tras #485: el hook ordena `navori audit --start`, que resuelve el
    binario PUBLICADO, y `audit` entró después del tag `v0.6.1`. Citty imprime el help y **sale 0**,
    así que fallaba en silencio pareciendo éxito.
  - El log registraba **prompts vacíos** (`.user_prompt` no viene en el payload; el `// ""` lo volvía
    un vacío plausible). Los 70 tests de hooks no lo vieron porque sus payloads sintéticos cargaban
    la misma suposición equivocada que el hook. Lo encontró el dogfood.
  - **Cableado MCP:** son 3 capas (servidor en `.mcp.json`, permiso en settings, tool en `tools:`) y
    el esquema de plugins era dueño de 2. `tools:` es una allowlist que cubre MCP y acepta patrones
    a nivel servidor (verificado en doc oficial) → se deriva `mcp__<pluginId>__*`.
  - Derivar de `invariants` era **incorrecto** (son substrings load-bearing, no tools) y se corrigió
    a mitad de camino.
  - Limpieza fuera del PR: **27 worktrees / 7.6 GB** borrados; el repo pasó de ~8 GB a 347 MB.
- **Commit / PR:** `5c3658a` — https://github.com/UlisesCm/navori-harness/pull/486

## 2026-08-24 23:59 — claude — investigación + plan del "modo audit" (sin código)

- Cambios: solo artefactos de handoff — 4 reportes de investigación y el plan en
  `.claude/progress/` (`plan_audit_mode.md` + `research_*.md`); actualiza `progress/current.md`.
  Cero código de producción tocado, cero commits.
- Quality gate: N/A (no se editó código; nada que correr ni citar).
- Notas: 4 researchers en paralelo (anatomía JSONL, ecosistema, doc oficial, integración navori).
  Hallazgo mayor verificado: los transcripts de Claude Code ya graban ~95% del reporte soñado
  (jsonl + meta.json por subagente, con correlación padre↔hijo directa). Decisión de Ulises:
  v1 = comando `navori audit` post-hoc, tokens-only, salida en `~/.navori/audits/`, ruta directa
  (sin SDD), ejecución pendiente para otra sesión. Memoria: `navori-audit-mode-research` y
  `navori-audit-mode-plan`.
- Commit / PR: ninguno.

## 2026-08-21 11:30 — claude — cierra los 2 ciclos en vuelo, re-renderiza el espejo y abre 5 issues

- Mergeados (squash, CI verde los tres): #419 (#404, aislamiento del store de backups),
  #418 (tablero), #420 (re-render del espejo del harness, 15 archivos), #426 (#402, caché
  del scan de semgrep por huella de contenido). Issues cerrados: #404 y #402.
- Cambios: `.claude/` + `CLAUDE.md` completos vía `navori render --apply` (dos pasadas: una
  por los 6 PRs de ayer, otra por el script cacheado de #402);
  `packages/plugins/semgrep/scripts/check-semgrep.sh`;
  `packages/cli/src/lib/__tests__/semgrep-cache.test.ts` (nuevo, 7 casos).
- Quality gate: ✅ verde en cada ciclo. Baseline pasó de `1679` a `1686` tests.
- Notas:
  - **El render dejó de ser cosmético.** Los scripts renderizados de ESTE repo seguían en la
    versión previa a #391/#413 — sin el `nl=$'\n'` pre-expandido —, así que los hooks locales
    corrían con el fail-open de zsh que ya estaba arreglado en el core. Ningún check de CI lo
    detecta: es el issue #421.
  - **El fix de #404 quedó verificado sobre datos reales**: la corrida de 1679 tests del día
    creó **cero** backups fixture en `~/.navori/backups`; la única entrada nueva fue la
    legítima del `render --apply`. Antes cada suite goteaba decenas.
  - **#402 necesitó dos rondas.** La primera traía un TOCTOU real: la huella se tomaba antes
    del scan y se escribía después sin re-verificar, así que un writer que ganara esa ventana
    (format-on-save, watch build, otro agente en el mismo worktree) dejaba contenido nunca
    escaneado con marcador verde por una hora. El reviewer lo reprodujo. Se cierra
    re-tomando la huella después del scan (~16 ms contra ~3.3 s) y publicando solo si
    coincide.
  - **Dos trampas de shell que descubrió la ronda de fix**: en zsh `$0` dentro de una función
    es el NOMBRE de la función, así que leerlo ahí habría apagado el caché en silencio bajo
    zsh; y el `||` del llamador suprime errexit dentro de la función, así que cada
    `git hash-object` necesita `|| exit 1` o una huella incompleta pasaría por buena.
  - Limpieza de `~/.navori/backups` (1865 entradas, 193 MB, solo 9 reales) **pendiente de
    decisión de Ulises** — el filtro seguro es por prefijo, no por edad.
- Issues abiertos en la sesión: #421 (CI no detecta el drift del espejo), #424 (los otros 5
  directorios bajo `~/.navori` sin guard de suite), #422 (strings de runtime en español),
  #423 (jscpd sin caché — medir antes), #425 (falta test del marcador por worktree).
- PRs: #419, #418, #420, #426.

## 2026-08-20 21:30 — claude — release 0.6.0 cerrado + 6 issues en dos tandas paralelas

- Release: tag `v0.6.0` creado y pusheado sobre `5866441` (npm ya servía 0.6.0, publicado
  por Ulises; el website se había desplegado post-bump). El tag fue lightweight sobre HEAD,
  no sobre un commit `chore(release)` como en v0.5.1.
- Mergeados (squash, todos con CI verde): #411 (#393 disco), #412 (#392 rutas citadas),
  #413 (#391 zsh), #410 (tablero previo), #414 (#398 closeout), #415 (#400
  verify-before-done), #416 (#399 CLAUDE.md condicional, 2 commits).
- Quality gate: ✅ CI `quality` verde en los 6 PRs; cada ciclo con Pass-2 del reviewer y
  receipt sin drift.
- Notas:
  - **#391 destapó dos fail-open REALES**, no solo cobertura: bajo zsh `${var//pat/$'\n'}`
    no expande el reemplazo, así que los comandos compuestos nunca se segmentaban y el
    guard dejaba pasar un borrado recursivo encadenado; y `shopt` no existe en zsh, así
    que el validador de handoff moría con exit 127. Tercera incidencia de la clase.
  - **#399 no quedó completo a la primera.** Tras aprobarse, se detectó que
    `skills/ticket-intake.md:25` seguía ordenando leer CLAUDE.md. La causa era doble: el
    guard iteraba solo `agents/` **y** su regex exigía backticks. Se reemplazó por un
    barrido de todo `core-assets/**/*.md` que distingue mandato de referencia; cerrado con
    delta re-sign (subsunción verificada por mutación; aritmética 1667 − 9 + 2 = 1660).
  - **#404 (en vuelo) destapó pérdida de datos real**: la suite borra backups reales >30
    días del `~/.navori` del usuario vía la pasada por edad de `purgeOldBackups` — desde
    antes de #411, que solo agregó el segundo modo (tamaño).
  - Gotcha: reescribir el body de un PR puede tirar la línea `Closes #N` y romper el
    auto-cierre del issue (pasó con #399).
  - Worktrees: se limpiaron los 6 ya mergeados (`.claude/worktrees` bajó de ~4 GB a 575 MB,
    lo que queda son los 2 en vuelo).
- Commit / PR: #410–#416 · issues cerrados #391, #392, #393, #398, #399, #400 · issue
  nuevo #417.

## 2026-08-20 17:40 — claude — cierre: render 0.6.0, #389, las 6 decisiones y 6 issues nuevos

- Cambios:
  - `chore/self-host-render-0.6.0` (#388) — render completo del espejo: 45 líneas de
    marcador en 24 archivos, cero contenido. `name` → `navori-harness` (decía
    `navori-monorepo` y doctor lo leía como harness copiado).
  - `fix/389-hooks-rutas-codex` (#390) — `subagent-stop-handoff.sh` sondea también
    `.codex/progress` y escanea TODOS los dirs existentes (array, no word-splitting);
    `session-start-context.sh` igual para `current.md`; el ejemplo de la user-section
    del hook del gate ya no apunta a un script de plugin.
- Quality gate: ✅ 1641 tests · lint · format · CI verde en los 2 PRs.
- Notas:
  - **La decisión de #389 estaba escrita en el repo**: los hooks no se adaptan en
    render, **sondean en runtime**. Lo decía el backstop del receipt antes de que
    #365 lo retirara. Un `transform` reescribiría rutas a ciegas dentro de un
    script, donde eso rompe semántica — no es prosa.
  - **Las 6 decisiones de la tanda de optimización quedaron tomadas** (cuestionario
    1x1) y registradas como comentario en cada issue. Dos cambiaron el issue en vez
    de aceptarlo: #378 (la condición "sin hallazgo durable" la juzga el propio
    agente → se ata al diff) y #379-A (se rechaza con evidencia de esta sesión).
    #376 se cerró: su premisa era falsa, medido.
  - **6 issues nuevos**: #391-#392 (testing barato con reincidencia comprobada),
    #393 (disco), #394-#396 (testing caro, con sus trade-offs escritos).
  - **`.claude/worktrees/`: 4.2 GB → 0.** 15 worktrees, `dirty=0` en todos, los 15
    con contenido ya en `main`. Ojo con el método: `git merge-base --is-ancestor`
    daba `NO-MERGED` en los 15 —falso negativo del squash-merge— y la verificación
    que sirvió fue cruzar cada branch contra su PR. Las 15 branches locales siguen
    existiendo (son refs, no pesan).
- Commit / PR: #388, #390.

## 2026-08-20 13:15 — claude — 11 issues cerrados, 8 PRs mergeados (todo lo previo al release)

- Cambios:
  - `guard-destructive.sh` — split en segmentos compartido por las 3 reglas: cierra
    el bypass del `rm -rf` compuesto y el falso positivo de `-n` cruzando `&&`.
    Tabla de veredictos de 31 filas que EJECUTA el hook (antes ninguna lo corría).
  - `engines/codex/` — `transform` en `PlacementRequest`: las skills pasan por el
    adaptador. Compat cubre la forma directorio, el prefijo suelto, los agents
    distintos de leader, `.claude/progress` sin barra y la mención pelada. Test de
    cableado que barre toda superficie de prosa buscando `.claude/`.
  - `quality-gate-pre-commit.sh` — fuera `check_content_receipt` (−103 líneas).
  - `commands/doctor.ts` + `lib/gate-readiness.ts` + `lib/skill-user-section.ts` —
    dos chequeos nuevos (gate ejecutable, user-section sin llenar).
  - `lib/skill-meta.ts`, `lib/workspace-drift.ts`, `engines/claude/adapter.ts`,
    `commands/render.ts` — los cuatro defectos menores.
  - 8 `lib-skills` sin fuga de workspace; specs, website, READMEs y DIRECTION al día.
- Quality gate: ✅ 1638 tests · lint · format · CI verde en los 8 PRs.
- Notas:
  - **#365 se decidió por remoción, no por parche** (opción c de las tres del issue):
    5 caminos fail-open, cero capturas documentadas y un modo de fallo que bloqueó
    todos los PRs. El receipt sobrevive como handoff reviewer→pilot.
  - El guard nuevo bloquea un mensaje de commit por heredoc que mencione un borrado
    recursivo de HOME. La salida es `git commit -F <archivo>`.
  - `#370` y `#375`-`#379` (la tanda de optimización) quedan para DESPUÉS del
    release 0.6.0, por decisión de Ulises: no mezclar un rediseño del contexto
    always-on con un release que ya arrastra un fix de seguridad.
- Commit / PR: #380, #381, #382, #383, #384, #385, #386 (+ #362 que ya estaba abierto).

## 2026-08-18 13:30 — claude — 6 issues cerrados + capa de solutioning (spec 0012)

- Cambios:
  - `packages/core/core-assets/` — skill `solution-design` (nueva), bloque
    `intake-tickets` (nuevo), `orquestacion` (señales R2-architectural, +117
    palabras), `ticket-intake` (fase 4 real + gate de veredicto), `spec-bootstrap`
    (dimensiones condicionales, anti-placeholder), `ticket-audit` (veredicto,
    problema vs solución propuesta, tamaño verificado), `implementer`/`reviewer`/
    `researcher` (eslabones de consumo), `cierre-sesion` (dominio).
  - `packages/core/core-assets/lib-skills/` — 27 skills con user-section, `cypress`,
    `drizzle-orm`, `react-navigation`, `i18next` nuevas, `socketio` partido en
    server/client, `jest` reescrita sin el leak de Medusa.
  - `packages/cli/` — `scanGitHygiene` + `scanWorkspaceDrift` (doctor), description
    de skills project-local en el índice, registros y conteos, 3 tests nuevos.
  - `packages/plugins/codegraph/` — inyección en `researcher` y `explorer`.
  - `specs/0012-solutioning/` — requirements (21 EARS), design, plan, tasks, evals.
- Quality gate: ✅ 1501 tests · lint · format · CI verde en los 4 PRs.
- Notas:
  - Los 4 evals corrieron sobre casos reales. E y F dieron resultados INVERTIDOS
    respecto a lo esperado y se registraron tal cual — en ambos el escenario estaba
    mal diseñado, no la capa. Los tres veredictos quedaron ejercitados igual.
  - Método adoptado (superpowers): el baseline RED se corre ANTES de escribir una
    skill. La skill ataca fallos observados, no imaginados.
  - Auditoría de cableado: 3 skills del core tenían CERO citas (`security-guidance`,
    `debug-error`, `dominio`) y el `reviewer` no leía el diseño acordado. Cerrado y
    protegido por `solutioning-wiring.test.ts`.
  - Deuda detectada al cerrar: `.claude/progress/` no estaba en `.gitignore` pese a
    estar en el CUBO_A de navori — 8 artefactos efímeros se habían colado al índice.
    Corregido a mano; queda pendiente evaluar activar `gitignoreHarness: "local"`
    en este repo para que la regla la gestione el render.
- Commit / PR: #328, #329, #330, #332, #339 (mergeados) · issues #331, #340 abiertos.

## 2026-08-18 23:30 claude — los 8 issues abiertos, resueltos; 6 defectos del harness descubiertos al usarlo

- Objetivo: auditar a profundidad los 8 issues abiertos (#331, #333-#338, #340) para
  decidir cuáles aplican y cómo, y resolverlos. Ulises encuadró los issues como
  PROPUESTAS, no como especificaciones: el análisis decide si proceden.
- Método: 5 auditorías en paralelo agrupadas por naturaleza, veredicto por issue
  (`proceed` / `proceed-differently` / `split` / `doesn't apply` / `blocked`), y
  síntesis no delegada. **Ninguno de los 8 procedía tal como estaba escrito**: uno
  pasó limpio (#334), cinco se reformularon y de dos hubo que cortar la parte
  principal.
- Cambios (6 PRs mergeados, todos con CI verde):
  - **#343 → #340** — `render --all` ya no muere ante un config corrupto. El fix va
    una capa adentro (`runRender` devuelve `{ok:false, reasonCode:"config-invalid"}`),
    no un try/catch por loop: cubre los dos call sites con un solo cambio.
  - **#346** — cierre de la sesión previa + `.claude/progress/` al `.gitignore`. Estaba
    atascado en una branch sin PR, y por eso cada branch nueva volvía a filtrar los
    efímeros.
  - **#347 → #331** — campo `paths` en `LibrarySkill` + `detectLibrarySkills(deps, cwd?)`
    con `cwd` OPCIONAL (las 46 llamadas de tests quedaron intactas) + skill `maestro`.
  - **#349 → #344 + #348** — los dos bugs del harness (abajo).
  - **#351 → #334 + #335** — cinco reglas nuevas en `review-diff` (1129/1200 palabras),
    el invariante de guards en `security-guidance`, regla condicional en `implementer`,
    `no-duplicate-imports` en los dos presets, y un test de invariantes de contenido.
  - **#353 → #337 + #338** — skill `babysit-prs` (486/500, sin override) + lectura única
    de checks en el `commit-pr-pilot`.
  - **#321 cerrado** por obsoleto: contra `main` actual borraba 4437 líneas, incluida
    `specs/0012-solutioning/` entera.
- Quality gate: ✅ 1546 tests · lint · format · `doctor ok` · CI verde en los 6 PRs.
- Notas:
  - **Seis defectos nuevos, todos encontrados USANDO el harness, no auditándolo.**
    #344 (variable `path` es especial en zsh → `DRIFT` falso en todos los archivos,
    con un bucle sin salida: re-revisar nunca lo arregla), #348 (el backup no excluía
    `.claude/worktrees/` → 131 GB, disco al 97%, `render` fallando con `ENOSPC` dentro
    del propio paso de backup), #352 (el mismo backstop es ciego bajo Codex), y
    #341/#342/#345/#350 con análisis y recomendación ya comentados en cada uno.
  - **La capa de solutioning se estrenó en un caso real y funcionó como debía**: el
    diseño de #337/#338 salió BLOCKED con 4 BLOCKERs, dos de ellos errores propios —
    una defensa contra inyección que se creyó estructural y no lo era, y una mitigación
    de timeout imposible con la forma real del hook. El recorte que decidió Ulises
    eliminó cuatro clases de riesgo en vez de gestionarlas.
  - **Dato que cambia diseños futuros**: ningún patrón de permiso acotado de Bash sirve
    para restringir argumentos. `Bash(gh api --method GET *)` es sobre-inclusivo
    (pflag toma el último `--method`) y sub-inclusivo (`-X GET` no matchea). La única
    frontera real es un `PreToolUse` hook.
  - Al arreglar #348 aparecieron TRES copias de la lista de "efímeros que nunca se
    versionan" (gitignore CUBO_A, `backupExclude`, `EPHEMERAL_AGENT_PATHS` de doctor).
    Dos conocían `worktrees/` y la del backup no. Unificadas en `EPHEMERAL_HARNESS_PATHS`.
- Commit / PR: #343, #346, #347, #349, #351, #353 mergeados · #321 cerrado ·
  #352 en revisión · abiertos #333, #336, #341, #342, #345, #350.

## 2026-08-19 13:00 claude — cierre de los 6 issues restantes + créditos públicos

Continuación de la entrada anterior. El tablero quedó en **cero issues y cero PRs abiertos**.

- Objetivo: "quiero cerrar todo". Dos de los seis restantes se cerraron sin código —sus
  partes principales no aplicaban— y cuatro con fix.
- Cambios (3 PRs mergeados):
  - **#357 → #342 + #354 + #341** — el subsistema del content receipt, en un solo PR porque
    los tres tocan los mismos assets. El receipt ahora firma con `-w` y el pilot **emite el
    comando de diff** al reportar drift (sin eso el blob se escribía y nadie lo usaba); el
    hook verifica **todos** los receipts presentes en vez del primero (un stale en `.claude/`
    eclipsaba al vigente en `.codex/` y el drift pasaba); y la Regla A quedó reescrita para
    prometer lo que la maquinaria sí permite, con el **delta re-sign** formalizado como modo
    de primera clase del `reviewer`.
  - **#358 → #345 + #350** — `project.libraries` documentado como campo **derivado** (no era
    un bug: la asimetría con `libraryMigrations` es deliberada) con el test que faltaba para
    fijar la semántica; y la segunda frontera escrita en §7 de `review-diff`, que resuelve el
    caso mixto nombrando la acción por hallazgo.
  - **#359** — créditos públicos a los 11 proyectos de referencia.
  - **#333 y #336 cerrados** con la evidencia de por qué sus partes principales no proceden.
- Quality gate: ✅ 1558 tests · lint · format · build del sitio (22 páginas) · CI verde en los 3 PRs.
- Notas:
  - **`docs/inspiration.md` restaurado**: se había borrado del repo; se recuperó del historial
    y se actualizó con una verificación de los 11 proyectos hecha hoy. Los 11 enlaces vivos,
    ninguno archivado. Ajustes obligados: **codegraph retiró sus propias métricas** (control
    contaminado) y publica una contraparte que el doc omitía —~80% más contexto residual en
    sesión multi-turno, que toca las specs 0005/0006—; **caveman** cambió de licencia
    (BSL-1.1), congeló dos repos, pasó de Node a Go, y su "46% menos tokens" ya no existe en
    la fuente.
  - **Dos correcciones de inventario que llevaban un mes publicadas**: la web acreditaba
    `eslint-plugin-sonarjs`, que navori dejó de usar en #130, y **no** acreditaba `codegraph`,
    que sí integra como plugin. El README listaba `cognitive` (retirado) y omitía `codegraph`.
  - **El delta re-sign se estrenó dos veces el mismo día que se formalizó**, en los dos casos
    por un hallazgo del reviewer que valía aplicar sin re-revisar un diff ya aprobado.
  - **Disco recuperado**: Ulises borró `~/.navori/backups` a mano. De 131 GB / 6873 backups a
    32 MB / 310, todos post-fix y ninguno con `worktrees/`. El más pesado pasó de 15 GB a
    368 KB. `registry.json` y `workspaces/` intactos.
- Commit / PR: #357, #358, #359 mergeados · #333 y #336 cerrados con justificación.

## 2026-08-20 19:11 claude — Auditoría de cableado+reprocesos → 12 issues (#398–#409)

- Encargo de Ulises: auditar que todo esté cableado correctamente, detectar reprocesos
  sin justificación y acelerar el ciclo prompt→solución **sin perder calidad**.
- Método: 4 agentes de solo lectura en paralelo (cableado del harness, reprocesos del
  pipeline, costo medido de hooks/permisos, cableado+reprocesos del CLI), instruidos para
  reutilizar los reportes del 19-ago y la lista de issues abiertos en vez de re-derivar.
  Reportes en `.claude/progress/`: `audit_wiring.md`, `audit_reprocesos.md`,
  `research_hooks_costo.md`, `research_cli_reprocesos.md`. Claims load-bearing
  verificados a mano contra el código antes de sintetizar.
- Veredicto: **cableado estructural sano, 0 críticos** (hooks↔settings, agentes, skills,
  render sin drift, doctor OK; los fixes de 0e1e53b y la paridad Codex se sostienen).
  El costo real está en reprocesos del protocolo y fricción de permisos.
- Hallazgos → 12 issues, cada uno con problema/justificación/solución/test anti-regresión:
  - Reprocesos: #398 gate full duplicado en el closeout (~42s), #399 "Read CLAUDE.md" ya
    inyectado (~8K tokens/spawn), #400 verify-before-done vs criterio load-bearing,
    #401 ceremonia de memoria duplicada (mem_context + triple redacción), #402 semgrep
    escanea el mismo diff hasta 6× (~20–24s/ciclo).
  - Permisos: #403 derivar el allowlist del `qualityGate` del config + filtros puros
    (772 entradas en settings.local, 619 one-shot).
  - CLI: #404 la suite de tests escribe/purga backups en el `~/.navori` REAL (99% de los
    125 MB), #405 backup full-tree en el restamp de release, #406 `core/src/index.ts`
    muerto y drifteado.
  - Cableado: #407 ruta `scripts/check-semgrep.sh` inexistente (5ª instancia clase #392),
    #408 bloque managed fantasma «?» en doctor (regex laxa `health.ts:35`), #409
    `solution_*` fuera del contrato de handoffs.
- Cross-links: comentario en #392 (el test de clase debe cubrir assets de plugins; #407 es
  la instancia 5) y en #393 (**#404 va antes que la purga por tamaño** — si no, correr
  tests borraría backups legítimos).
- Qué NO recortar (confirmado con evidencia): Pass-2 del reviewer, hook pre-commit fast,
  receipt+delta re-sign, challenge de solution-design, cadena de 4 hooks por Bash
  (40–50 ms en paralelo).
- Quality gate: ✅ corrido al cierre sobre main limpio (sin edits de código en la sesión).

## 2026-08-24 00:45 claude — #375 prosa→mecanismo + el placeholder vacío que rompía la prosa (#441)

- Encargo: "sigue con lo pendiente". Se abrió mergeando **#438** (docs de #435, verde) y se
  siguió con **#375**, el único `priority:high` del tablero.
- **Dos de los cinco casos ya estaban hechos** y se cerraron con evidencia en vez de código:
  el caso 2 (quality gate en 4 lugares) ya derivaba de `{{qualityGate.*}}` sin un hardcode, y
  el caso 5 ("gates ready") ya lo cubría `scanQualityGateReadiness` (`doctor.ts:134`).
- **Hallazgo principal, mayor que el issue**: un placeholder que resolvía a vacío dejaba prosa
  rota. `project.criticalAreas` es `.default([])`, el interpolador serializa arrays con
  `join(", ")` → `""`, y `""` no es `null`, así que el `placeholderFallback` nunca disparaba.
  `CLAUDE.md:72` renderizaba ``a `` area`` en TODO repo sin el campo declarado. Fix en dos
  mitades (regla de valor vacío en `resolvePath` + soft fallbacks), ambas load-bearing:
  revirtiendo una a la vez → 3 failed / 5 failed / 11 passed.
- **Addendum destapado a mitad de camino**: `engines/codex/compat.ts` tenía dos bytes NUL
  crudos en el literal del sentinel. `file(1)` lo daba como `data`, grep lo trataba como
  binario ocultando sus líneas, y `git log -p` imprimía `Binary files … differ` — **ningún
  cambio a ese archivo mostró diff legible jamás**, ni en la CLI ni en la vista de PR. Eso es
  lo que había impedido localizar la reescritura que busca #428 (está en `compat.ts:48`).
  Fix: escapes en vez de bytes crudos, runtime idéntico, shield #209 intacto a propósito.
- **Mecanismos nuevos, no prosa**: `empty-placeholder-render.test.ts` (renderiza claude+codex
  con config mínima y falla si se filtra `<not configured:` o un span de código vacío) y
  `no-nul-bytes.test.ts` (barre `packages/**`). Los dos verificados fallando sin su fix.
- Ruta: R2 — 1 `implementer` → 1 `reviewer` (APPROVED) → 2 hallazgos informativos aplicados
  por el orquestador → **delta re-sign** (drift medido contra el receipt: 3 archivos, cero sin
  firmar) → `commit-pr-pilot`. El reviewer validó la corrección a mano de las zonas de usuario
  renderizando el repo desde cero en un tmpdir: **byte-idénticas** al render fresco.
- Issues abiertos: **#439** (los `{{}}` literales que devora el interpolador — la lib-skill de
  i18next desinforma sobre su propia sintaxis) y **#440** (chequeo de `doctor` para tokens
  congelados en zona de usuario, porque `rerender` no re-interpola esa zona). Comentario con
  la evidencia de la reescritura dejado en **#428**, que queda desbloqueado.
- Quality gate: ✅ `format:check` 227 archivos · **1750 tests** / 127 files (baseline `main`
  1734, Δ+16 reconciliado) · oxlint · `check:render` al día · CI `quality` verde en #441.
- Commit / PR: **#441 mergeado** (2 commits, 26 archivos), **#438 mergeado**. #375 y #435
  cerrados.

## 2026-08-24 16:18 claude — 15 issues cerrados: dos rutas de corrupción, un gate que no corría, y una regla nueva para el tablero

- Encargo: "sigue con lo pendiente" → derivó en la jornada más larga del repo. Cerró **15**
  issues (#435, #375, #439, #440, #428, #447, #403, #405, #432, #423, #445, #443, #452, #454)
  con **14 PRs mergeados**, todos con CI verde.
- **Dos rutas de corrupción de archivos de usuario, ambas reproducidas end-to-end:**
  - **#452** — `findMarker` no era fence-aware en la **ruta de escritura**. Un doble
    `render --apply` sobre `main` **destruyó el ejemplo documentado** (`grep` de la línea → 0) y
    dejó el bloque duplicado, en silencio y permanente. Segundo vector: `stripOrphanMarkers`
    emparejaba una apertura CITADA con el cierre REAL y borraba la apertura real de la salida
    devuelta — vivo en el engine Codex (`codex/index.ts:158` propaga `output` sin importar el
    status), descartado sin escribir en la ruta Claude. Evidencia anti-sobre-apriete: paridad
    **49/49** sobre los bloques reales del repo (SHA del cuerpo, longitud, status de inject y
    span de removal), reproducida por el reviewer.
  - **#375** — un placeholder que resolvía a vacío dejaba prosa rota (``a `` area``) en TODO repo
    sin el campo declarado. `.default([])` → `join(", ")` → `""`, y `""` no es `null`.
- **#454 — el gate que no corría.** Los hooks de semgrep/jscpd/pre-commit **pasaban en verde sin
  escanear** desde un worktree de agente: `settings.json` los invoca con cwd = repo principal y el
  script hacía `cd "$(git rev-parse --show-toplevel)"`. Todos los commits del flujo multi-agente
  quedaban sin gatear por los dos escáneres que CI no corre. La primera ronda del fix introdujo un
  **bypass peor que `main`** (el candidato del comando pisaba el `.cwd` correcto y podía escanear un
  árbol vacío); el reviewer lo cazó con 5 repros y se cerró con una restricción de mismo
  repositorio por **igualdad exacta** de `--git-common-dir` (un prefijo habría aceptado el
  submódulo, que reporta `<main>/.git/modules/<name>`).
- **Los bytes NUL de `compat.ts`**: `file(1)` lo daba como `data`, grep ocultaba sus líneas y
  `git log -p` imprimía `Binary files … differ` — **ningún cambio a ese archivo mostró diff legible
  jamás**. Es lo que había frenado a #428 en dos investigaciones distintas.
- **Cambio de proceso, a señalamiento de Ulises.** El tablero llevaba 3 días clavado en 16. Se
  midió: no crecía, estaba en un punto fijo (cada ciclo cerraba ~3 y abría ~3). Regla nueva: un
  hallazgo se vuelve issue solo si necesita decisión ajena, no cabe en el ciclo, o se va a olvidar
  y duele; si no, se arregla en el diff y se cuenta en el cuerpo del PR. **#447** quedó como caso
  testigo de lo que NO debió abrirse — y su análisis además era incorrecto: decía "no explotable"
  mirando solo `resolvePath` cuando la fuga estaba en `placeholderFallback`; lo destapó el test al
  fallar. **#423 se cerró sin código**, con la medición que probó que el caché saldría 1.3 s peor.
- **Cuestionario 1x1 con Ulises** → 5 decisiones registradas como issues (#458–#462): limpiar los
  209 errores de tipos ANTES de activar `typecheck`; acotar el `guard-destructive` a lo que se
  ejecuta; y los tres hallazgos anotados en PRs pasan a ticket.
- **Rollout 0.6.0: sigue CONGELADO, ahora con criterio de salida** — tablero en cero + versión
  estable. Se le ofreció descongelar el mismo día en que entraron los fixes grandes y eligió
  esperar.
- Quality gate: ✅ en los 14 PRs. Suite **1804 → 1852 tests**. `check:render` al día al cierre.
- Método: R2-fan con hasta 5 agentes en paralelo sobre worktrees aislados y exclusiones cruzadas
  de archivos. Los reviewers fueron el eslabón que más valor agregó: cazaron el bypass de #454,
  el sobreventa de #452, un test cuyo nombre afirmaba lo contrario de su aserción (#439), y una
  verificación de tipos que el gate estructuralmente no puede hacer (#445).

## 2026-08-25 13:30 claude — Modo audit: diseño cerrado en cuestionario 1x1 + implementación (PR #485)

**Objetivo.** Ulises pidió implementar el "modo audit" que quedó en plan el 24-ago. Antes de codear
preguntó cuál sería el funcionamiento esperado, y de ahí salió un rediseño completo: el plan v1 era
post-hoc puro y terminó siendo activación por frase, con confirmación humana y log por sesión.

**Decisiones (cuestionario 1x1, todas de Ulises).**
1. Alcance **completo e independiente** — se evaluó y descartó apoyarse en **AgentSight** (CLI Rust
   MIT/Apache que ya parsea estos transcripts y detecta cache churning / retry loops / subagent
   sprawl). Se prefiere un solo reporte sin dependencia externa.
2. **Solo sesiones marcadas**; sin auditoría retroactiva (descartó explícitamente auditar agosto).
3. **Confirmación humana en ambos extremos**: el hook no activa, inyecta `additionalContext` y el
   agente pregunta. Un falso positivo muere en la pregunta sin dejar estado en disco.
4. Distribución global (`packages/core`), activación por sesión.
5. **Log append-only inmutable** — descartó el `.json` de documento único al ver que los subagentes
   corren en paralelo y read-modify-write se corrompe.
6. **"Si no cuesta tokens, se omite"** — regla suya. Deja fuera latencia de hooks, gates y routing.
7. Hooks solo en `UserPromptSubmit` + `SessionEnd`, nunca `PostToolUse`.
8. Primero el audit, después el fix del cableado MCP (ese bug es el caso de validación).

**Descubrimientos.**
- **Ningún subagente puede usar codegraph ni engram**, y aun así reciben el CLAUDE.md que se los
  ordena. Confirmado en doc oficial: los subagentes reciben la jerarquía completa de CLAUDE.md, y
  `tools:` es una allowlist que **incluye MCP**. Costo medido: **~107k tokens/sesión** en órdenes
  imposibles. El reporte lo destapó solo, como ALTO — que era el criterio de calibración pactado.
- **El contexto inicial NO se persiste en el transcript**, solo su tamaño (`cache_creation`). Por
  eso un grep del bloque orchestrator en un transcript de subagente da 0 y eso NO prueba ausencia;
  me equivoqué al leerlo así y la doc lo zanjó. Consecuencia de diseño: desglosar QUÉ compone el
  arranque exige leer el harness del repo — lo que ninguna herramienta externa puede hacer.
- **Arranque real: 22-28k tokens por subagente** (~1.9M en una sesión de 88). El encargo son ~1.6k.
- **Gotcha de interpretación, casi acuso en falso:** 4141 Bash contra 131 Read y cero Grep/Glob en
  los subagentes parecía violación del CLAUDE.md — hasta ver **153 registros `permission-mode: auto`**,
  que instruye justamente usar Bash. El reporte ahora registra el permission-mode por eso.
- **Las skills se leen con `cat`, no con la tool `Skill`**: 0 invocaciones contra 34 `SKILL.md`
  abiertos. Contar solo la tool reportaría "ninguna skill usada" — falso.
- **Ningún hook expone tokens** (doc oficial). El transcript es la única fuente.
- El campo de `UserPromptSubmit` es **`user_prompt`**, no `prompt` (el research del 24-ago lo tenía mal).
- Existe campo **`skills:`** en la definición de agente que precarga una skill completa — mejora
  pendiente del harness, hoy los agentes la leen a media tarea.
- **bash vs zsh:** con `HOME` fuera del entorno, **zsh lo repuebla desde passwd y bash no**. El mismo
  hook hace bail-out silencioso en bash y sigue en zsh. Ambos cumplen el contrato; el test afirma el
  contrato (exit 0, cero escrituras), no el output.

**Hecho.** `lib/audit/{paths,model,parse,harness,signals,discovery,report}.ts`, `commands/audit.ts`,
los hooks `audit-mode-{trigger,close}.sh` cableados en `harness-plan.ts` y `build-settings.ts`, y 70
tests nuevos (40 unit + 30 de hooks en bash **y** zsh). Golden snapshots regenerados: el diff son
solo los contadores (34→36, 28→30) y los dos hooks. Validado contra la sesión real `ec30221a`: 0
parseErrors en 4427 líneas.

**Colateral.** `check:size` 800 → 900KB. Medido 792KB sin el feature y 816KB con él: el headroom que
el guard promete ya estaba gastado por crecimiento de primera parte, así que iba a dispararse justo
en el caso que dice no vigilar. `audit` agrega ~24KB y cero dependencias.

**Ruido de concurrencia.** Otra sesión mergeó el release 0.6.1 (#483) y el PR #484 mientras esta
corría, y su `navori render` sobre el repo raíz movió `HEAD` a `main` — mi commit quedó ahí encima.
Se preservó en `feat/audit-mode-impl` (creación de branch, nada destructivo) y se rebasó dos veces
sobre el `origin/main` móvil. **`main` local quedó con ese commit encima; hay que apuntarlo a
`origin/main` cuando la otra sesión no esté trabajando.** También disparó el guard de aislamiento
(#424) como falso positivo — que su propio mensaje contempla.

**Gate.** `format:check` ✓ · `pnpm test` **2084/2084** ✓ · `lint` ✓ · `typecheck` ✓ · `check:size`
815.4KB/900 ✓ — corrido tras el rebase final sobre `e931b2e`.

**Queda abierto.** Test de integración end-to-end del comando; el copy de las dos preguntas está
hardcodeado en español dentro del `.sh` y debería pasar por el i18n del render; la ruta completa
gatillo → log → reporte no se ha ejercitado sobre una sesión marcada real (no existe ninguna aún).
