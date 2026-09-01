# Historia de sesiones

<!--
Entradas más recientes arriba. Formato sugerido (no obligatorio):

## YYYY-MM-DD HH:MM — <agente> — <resumen breve>
- Cambios: <archivos / áreas tocadas>
- Quality gate: ✅ (quality gate sin configurar — corre 'navori configure quality-gate') verde | ❌ <razón>
- Notas: <decisiones no obvias, blockers, deuda>
- Commit / PR: <hash / URL>
-->

## 2026-08-31 22:55 — claude — Harness global: auditoría del F1, plan por fases y 3 de las 5 unidades de FA cerradas

- **Cambios:** `specs/0010-global-harness.md` (§8 rehecha), `engines/claude/global-render.ts`,
  `commands/global.ts`, `lib/global-config.ts`, `lib/render-plan.ts`, `lib/i18n.ts`,
  `core-assets/managed/idioma-rol.md`, +2 suites nuevas. Tests 2873 → 2902.
- **Quality gate:** ✅ verde en los 3 PRs; CI verde en los 3 (#549 1m57s, #550 2m36s, #551 1m51s).
- **PRs mergeados:** #549 (#542, #543) · #550 (#541) · #551 (#544). Issues abiertos: #545, #546,
  #547, #548 (nuevos, de este plan) y #538.

### Qué se auditó y qué salió

La pregunta de arranque fue qué existe del harness global (`navori global`). F1 está implementado
desde 2026-07-30 pero **nunca se corrió en esta máquina**: sin `~/.navori/global.json`, huella cero.
La auditoría del F1 en disco contra la spec encontró 9 huecos → 8 issues (#541–#548) y la §8 rehecha
en fases FA/FB/FC/FD.

### Decisiones que no se re-litigan

- **La ex-F2 (omisión opt-in de bloques en el repo) queda DESCARTADA.** El ahorro que perseguía ya lo
  da el gate de F1 por construcción; lo que quedaría es romper que el repo sea autocontenido. Con
  ella se va `scope: both`, que era el falso-positivo que bloqueaba FC.
- **FB cambia de diseño por un spike verificado:** la precedencia de Claude Code NO es uniforme. En
  subagentes el proyecto gana al usuario; en skills **personal gana a project**. Instalar las 12
  skills sueltas en `~/.claude/skills/` habría eclipsado en silencio las del repo, user-sections
  incluidas, en los 15+ repos Bonum. La salida es empaquetar todo como plugin `@skills-dir`, que
  namespacea las skills y hace que los agentes hereden la semántica de defer sin walk-up.
- **Se retira el follow-up de "partir `orquestacion`"**: existía solo mientras la única salida fuera
  la pureza de interpolación; con el modo `globalFallback` el bloque entra completo.

### Notas

- **El test de #541 encontró un defecto real en su primera corrida:** `idioma-rol`, que sí está en el
  baseline enviado, mandaba seguir el idioma "configurado en `navori.config.json`" — un archivo que
  por diseño no existe donde ese baseline se inyecta. Arreglado conservando la doctrina.
- **Error propio:** el squash de #549 se tragó dos commits locales sin pushear (el release 0.6.5 y su
  cierre de jornada) porque branché de un `main` adelantado que `progress/current.md` advertía.
  Contenido intacto (verificado con `git diff`); historia menos granular. Resuelto con Ulises:
  tag `v0.6.5` pusheado apuntando a `2f46add` (lo que npm sirve de verdad) y `main` local reseteado
  a `origin/main`.
- **El guard de aislamiento de `~/.navori` (#404/#424) da falso positivo en local**, verificado y no
  asumido: sesiones de Claude Code concurrentes en `alertaciudadana_backend` y `navori-health`
  escriben sus logs de auditoría durante la corrida (un log creció 34→36 KB en 55 s **sin correr
  nada**, con `agentId` de otro repo). En CI pasa siempre.

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

## 2026-08-26 17:48 leader — cierra los 17 issues de la auditoría a ciegas en 4 PRs

**Alcance.** #495–#511, los 17 hallazgos de la auditoría a ciegas del 2026-08-26, en 4 bloques:
seguridad (#513), pérdida de datos (#514), contrato de agentes (#515) y config (#516). Los cuatro
mergeados con CI en verde. Tests **2124 → 2642**. Tablero de issues en **0**.

**El patrón, que vale más que los parches.** Las defensas describían el peligro por su **forma
textual** —`-rf`, un nombre de binario, un mapa de rutas— en vez de por su **semántica**, y ninguna
verificaba que pudo hacer su trabajo. Un guard que no llegó a evaluar, un gate que salió 1, un
backup vacío y un parser ciego producen **la misma señal visible que el éxito**.

**Lo que se arregló, por bloque.**
- **Seguridad.** `Bash(sg:*)` pre-aprobaba ejecución arbitraria en Linux (shadow-utils, no ast-grep)
  — y `doctor` reportaba ast-grep *instalado* ahí por la misma confusión. El guard destructivo se
  esquivaba por **tres ejes ciegos**: flags (`-R`, `--recursive`), posición del operando
  (`rm -rf node_modules ~/` pasaba; GNU permuta argv) y comillas (`rm -rf "/"` pasaba, mientras
  `rm -rf "~/"` bloqueaba **por accidente**). Los gates de semgrep/jscpd salían 1 y `PreToolUse`
  bloquea solo con 2. El guard tardaba **83 849 ms** con timeout de 10 s → 66 ms tras matar una
  sustitución cuadrática de bash 3.2.
- **Pérdida de datos.** `global init` destruía `~/.claude/settings.json` corrupto sin backup y
  reportando éxito (el bug estaba escrito como contrato en el JSDoc). `--prune` borraba `.cursor/`
  y `AGENTS.md` escritos a mano. Un fence impar duplicaba todos los bloques en cada render (22→44→66
  marcadores) con `doctor` diciendo OK, porque el detector camina el mismo parser roto. **Y el fix
  de `--prune` introdujo una regresión peor**: `statSync` sigue symlinks, así que borraba archivos
  del usuario **fuera del repositorio** — lo atrapó el review.
- **Contrato de agentes.** Ningún asset ordenaba `git push`, así que el paso terminal del ciclo no
  podía ejecutarse. El host prohíbe escribir archivos de reporte y el harness entero depende de
  ellos (resuelto por la excepción del propio host). `non-trivial` —el término del que cuelga la
  excepción R1— no estaba definido, y el comando que lo mide usaba `...HEAD`, que **lee cero** en el
  caso del árbol sin commitear.
- **Config.** El `$schema` apuntaba a `navori.dev`, NXDOMAIN, con un test protegiéndolo.
  `criticalAreas` heredaba un placeholder sin relación con el producto — por eso un cambio en
  `render.ts` que borraba archivos del usuario **no contaba como área crítica**. `audit --start`
  escribía fuera de la raíz que el propio comando declara.

**Un "no procede" con evidencia.** #508.3 afirmaba que el guard anti-retroceso compara escalas
distintas. **Falso, verificado dos veces**: los 6 sitios que estampan `version=` usan
`readCliVersion()`; `$navori.version` es otro campo write-only que nadie lee. Documentado en vez de
"arreglado" — habría ensuciado 5 goldens en cada release por un campo que nadie consume.

**Seis guards nuevos que atacan clases.** `removal-parity` (declara los 12 puntos de borrado y falla
si aparece uno nuevo), `hook-claims-vs-scripts` (cruza lo que la prosa afirma contra lo que el script
hace), `asset-command-permissions`, `cited-paths-exist` ensanchado a **encabezados**,
`check-coverage-floor`, y `repo-config-gate` derivado de `ci.yml`.

**La patología de tests, seis veces.** Un test que congela la forma de la implementación en vez de
verificar la regla; en tres casos **protegía el bug**. Y produje una séptima yo mismo, con el patrón
fresco: sembré el directorio intermedio en lugar del archivo destino, y quitar el guard dejaba 56/56
verde. Lo atrapó el reviewer mutando producción. **Razonar sobre el fixture no basta.**

**Gate.** `format:check` ✓ · `check:render` ✓ · `check:assets` ✓ · website build ✓ · `lint` ✓ ·
`typecheck` ✓ · `check:size` ✓ · **2642/2642 tests** ✓ — y CI en verde en los 4 PRs.

**Queda abierto.** Descongelar el rollout exige **publicar primero**: el fix de `Bash(sg:*)` no llega
a ningún repo onboardeado hasta que se publique. Y el límite de #440 (un `render` no actualiza las
zonas de usuario ya escritas) obliga a ir **per-repo, nunca `--all`**.

## 2026-08-26 22:40 leader — cierra 22 issues, publica 0.6.2 y hace el rollout a los 3 repos de /navori

**Alcance.** Los 17 de la auditoría a ciegas (#495–#511) + el release 0.6.2 + el rollout uno a uno a
`alertaciudadana_app`, `alertaciudadana_backend` y `navori-dashboard-template` + los 5 defectos que ese
rollout destapó (#519–#523). **6 PRs en navori, 5 en los repos de Ulises, todos con CI verde.**
Tests **2124 → 2716**. Tablero en **0 issues / 0 PRs**.

**El patrón transversal.** Las defensas describían el peligro por su **forma textual** —`-rf`, un nombre
de binario, un mapa de rutas, un conteo de apóstrofos— en vez de por su **semántica**, y ninguna
verificaba que pudo hacer su trabajo. Un guard que no llegó a evaluar, un gate que salió 1, un backup
vacío y un parser ciego producen **la misma señal visible que el éxito**.

**Lo más caro de cada bloque.** El guard destructivo se esquivaba por **tres ejes ciegos** (flags,
posición del operando, comillas) y tardaba **83 849 ms** con timeout de 10 s → lo mataban antes de
evaluar una regla. Los gates de semgrep/jscpd salían 1 y `PreToolUse` bloquea solo con 2. `global init`
destruía `~/.claude/settings.json` corrupto sin backup — y el bug estaba escrito como contrato en el
JSDoc. Un fence impar duplicaba todos los bloques en cada render con `doctor` diciendo OK. **Y el fix de
`--prune` introdujo una pérdida de datos peor que la que arreglaba**: `statSync` sigue symlinks, así que
borraba archivos del usuario **fuera del repositorio** — lo atrapó el review.

**La patología de tests, OCHO apariciones**, cuatro de ellas protegiendo el bug (corregir el código
rompía el test). Dos las produje yo, con el patrón fresco y en tests escritos para no caer en él. Las
atrapó lo único que las atrapa: **mutar producción y comprobar el rojo**.

**El rollout encontró lo que ninguna auditoría podía ver**, porque solo existe cuando el harness se
topa con un repo real: prettier congelaba un harness entero invalidando el hash de sus 19 bloques; los
worktrees anidados rompen eslint, así que ningún agente podía commitear desde ellos (3 abandonados,
**2,6 GB**, 3 ramas sin publicar); `doctor` pedía un `name` que el esquema prohíbe — y la causa raíz era
que **`init` ya normalizaba con esa misma cadena**, así que doctor regañaba por lo que init escribió.

**Tres hallazgos solo existen por cruzar repos**: la zona (la app confía en el backend, el backend no
valida); el voto (parecía vulnerable desde la app, **refutado** — protegido en tres capas); y el
anonimato, **protegido en la escritura y expuesto en la lectura**. Desde cada repo por separado la
invariante parece cumplida.

**Gate.** `format:check` ✓ · `check:render` ✓ · `check:assets` ✓ · `lint` ✓ · `typecheck` ✓ ·
`check:size` ✓ · **2716/2716 tests** ✓ — y CI verde en los 6 PRs.

**Queda abierto.** Publicar **0.6.3**: los 5 fixes están en `main` pero no en npm, y el de
`.prettierignore` en `init` **solo actúa al onboardear**. Y 3 issues de seguridad en los repos de
Ulises (`alertaciudadana_app#113`, `alertaciudadana_backend#148`, `navori-dashboard-template#53`), el
más caro PII y CURP en logs de un build release.

## 2026-08-26 20:10 claude — release 0.6.3 y el follow-up de #523: la prevención alcanza a los repos ya onboardeados

**Publicado `navori@0.6.3`** (PR #526, CI verde, squash en `8e88efb`). Lleva a npm los 5 fixes del
rollout (#519–#523), que llevaban en `main` desde ayer y por eso **no estaban en ningún repo**. El
diff del release fue 33 archivos / 53 líneas, **todas bumps de versión**: ningún hash ni contenido de
asset cambió. Deploy del website verde.

**El tag `v0.6.2` nunca se había creado, y no era cosmético.** `check:assets` resuelve la versión
publicada con `latestTag()` (`scripts/check-asset-commands.mjs:84`) — lee **tags de git, no npm**, así
que llevaba un día avisando que los assets citan `navori audit` contra "v0.6.1", un subcomando que
0.6.2 ya había publicado. Creados `v0.6.2` (sobre `833b55a`) y `v0.6.3`; el aviso se apagó solo.

**El hueco de #523 (PR #528).** Ese fix le enseñó al formateador a saltarse el harness pero cableó la
prevención **solo en `init`** — que corre una vez. Nunca alcanzó a un repo existente, y **el repo que
motivó el issue era uno de esos**. Inventario del parque: **19 instalaciones** expuestas hoy igual que
antes del fix, sin que nada lo reportara. `ensurePrettierIgnore` ya estaba lista (`dryRun`, `force`,
escribe por `commitWrites`); faltaban los dos consumidores que su hermano `gitignore-harness` tiene
desde #313: `render` la invoca en la raíz (y como `update` termina en un render, cada instalación
cierra el hueco en su próximo ciclo) y `doctor` gana `scanPrettierIgnore` como advisory.

**La paridad scan ↔ escritor es el invariante, no un detalle.** Los dos comparten el criterio de "ya
cubierto": si el usuario ya lista las rutas del harness en sus propias reglas, doctor calla y render no
escribe. Si divergieran, doctor avisaría de un hueco que render se niega a cerrar y **el aviso no se
iría nunca** — que es exactamente como un advisory se degrada a ruido. Hay un test dedicado.

**Verificado por mutación.** Al quitar la llamada de `render.ts`, **7 de los 8 tests nuevos se ponen
rojos**; el único que sobrevive es el que afirma que un repo sin prettier no se toca, y es correcto que
sobreviva. Razonar sobre el fixture no habría distinguido las dos cosas.

**El inventario del parque, que vale más que el fix.** 15 repos Bonum (+14 worktrees de webapp), moonar
y navori-health están en **0.5.1**: se saltaron 0.6.0→0.6.3, o sea los 22 fixes de la auditoría a
ciegas (4 de seguridad, 4 de pérdida de datos) más los 5 del rollout. Los 3 de `/navori` están en
0.6.2. Solo este repo está al día.

**Gate.** `format:check` ✓ · `check:render` ✓ (0 pending) · `check:assets` ✓ · website build ✓ ·
`check:size` ✓ (837.1KB/900KB) · **2730/2730 tests** ✓ (2716 → 2730) · `lint` ✓ · `typecheck` ✓ — y CI
verde en #526 y #528.

**Tres issues abiertos desde el chat de Ulises**: #527 (un hook que reclame el worktree del agente al
terminar — hoy la limpieza depende de que un agente se acuerde), #529 (`testsForNewCode` derivado de la
detección, y poder excluir una suite: quiere unitarios sí y los flows de Maestro no), #530 (el harness
asume las tools nativas; en auto mode todo pasa por Bash y `guard-destructive` no cubre `sed -i`, `>`
ni `tee` sobre archivos managed).

## 2026-08-26 21:45 claude — release 0.6.3 y 0.6.4, el follow-up de #523 y los tres issues del chat

**Dos releases publicados.** `0.6.3` llevó a npm los 5 fixes del rollout (#519–#523), que llevaban un
día en `main` sin llegar a ningún repo. `0.6.4` publica el follow-up de #523 y los tres issues de la
jornada. Tags `v0.6.2` (retroactivo), `v0.6.3` y `v0.6.4`; deploy del website verde en ambos.

**El tag `v0.6.2` faltante no era cosmético.** `check:assets` resuelve la versión publicada con
`latestTag()` (`scripts/check-asset-commands.mjs:84`) — lee **tags de git, no npm**. Sin el tag llevaba
un día avisando que los assets citan `navori audit` contra "v0.6.1", un subcomando que 0.6.2 ya había
publicado. El paso "tag" del release le da la verdad a un gate; no es ceremonia.

**#528 — la prevención de #523 no alcanzaba a nadie.** Ese fix cableó `ensurePrettierIgnore` solo en
`init`, que corre una vez: nunca llegó a un repo existente, **y el repo que motivó el issue era uno de
esos**. 19 instalaciones seguían igual de expuestas. Lo delató la **asimetría con el módulo hermano**:
`gitignore-harness` tiene dos consumidores (`doctor.ts:19` escanea, `render.ts:21` aplica) y
`prettierignore-harness` tenía cero. Esa es la pregunta de review que generaliza: cuando un módulo
mantiene un archivo del usuario, ¿quién lo aplica cada ciclo y quién lo detecta?

**Los tres issues salieron del chat, no de una auditoría** (#527, #529, #530), y los tres se cerraron el
mismo día en #532, #533 y #534.

**#530 — dos capas para el auto mode.** En auto mode toda edición llega como comando de shell: `Edit`
aborta cuando el texto viejo no coincide, `sed -i` sale 0 y un `>` mal dirigido trunca. La regla 6 del
guard es el cinturón (bloquea `>`, `sed -i`, `tee` sobre outputs marker-managed); el watcher
`PostToolUse` —el primero del harness— es la red: **no lee el comando**, compara los hashes managed
después, así que cubre `python`, `perl`, `awk` y formateadores. Lo que NO bloquea pesa más: 12 casos
cotidianos fijados en la tabla, `cat > .claude/progress/impl_x.md` entre ellos.

**Tres bugs los encontraron los tests o CI, no yo:**
- `.codex/` entero como ruta protegida se tragaba `.codex/progress/` — el handoff de todo subagente de
  Codex. Lo destapó la regla #389 del propio repo.
- El watcher usaba `find -newer`, y la resolución de mtime es de **1 segundo** en el filesystem del
  runner: perdía la segunda escritura dentro del mismo segundo, justo el fallo que existe para prevenir.
  Pasaba en macOS por suerte del filesystem. Ahora compara **contenido** (~25ms, sin reloj de por medio).
- El hook de worktrees comparaba rutas con symlink contra las **físicas** que imprime `git worktree
  list`. Nunca coincidían: inoperante y callado, en cualquier repo bajo un symlink.

**Y uno de proceso:** `navori render --apply` y `navori sync` no estaban pre-aprobados, así que el
mensaje del guard ordenaba comandos que el circuit-breaker detiene — la instrucción nacía muerta (#506).
Documentados como prompts intencionales: escriben en el repo del usuario.

**#529 — la política de tests se deriva, y admite excepciones.** `testsForNewCode` era preguntado y
terminaba ausente (este repo ni lo declaraba). Ahora: runner+suite → `always`, runner sin suite →
`when-applicable`, sin runner → nada. Es un DEFAULT, no un campo derivado: `update` no pisa una decisión.
Nuevo `project.testsExclude` para el caso real de `alertaciudadana_app`, donde jest y Maestro conviven y
los flows de dispositivo se mantienen a mano.

**#527 — el hook de worktrees borra solo con las tres condiciones**: limpio, pusheado, y PR mergeado
según `gh`. El squash merge hace que `--is-ancestor` mienta, así que `gh` es la única fuente barata de
verdad — y sin `gh` no borra. 6 de sus 9 tests verifican que NO borra.

**Un hallazgo del auto mode que vale registrar:** un heredoc a un intérprete NO es inerte para el guard
(python podría ejecutarlo), así que un archivo de tests que cite `> CLAUDE.md` no se puede escribir con
`python3 - <<PY`. Es la misma clase que #462. La salida es la tool nativa `Edit`, que es exactamente el
caso de "Bash no puede hacerlo".

**Gate.** `format:check` ✓ · `check:render` ✓ (0 pending) · `check:assets` ✓ · website build ✓ ·
`check:size` ✓ (839.2KB/900KB) · **2787/2787 tests** ✓ (2716 → 2787) · `lint` ✓ · `typecheck` ✓ — y CI
verde en los 6 PRs (#526, #528, #531, #532, #533, #534, #535).

**Queda abierto.** El rollout: 15 repos Bonum + 14 worktrees de webapp + moonar + navori-health siguen
en **0.5.1** (dos releases atrás), y los 3 de `/navori` en 0.6.2. Y los críticos del backend de Ulises
(`alertaciudadana_backend#151`, `#150`).

## 2026-08-27 19:32 claude — limpieza de 30 GB en worktrees, rollout del harness a bonum-webapp y dos tickets de QA (BT-1427, BT-1425)

Jornada operativa **fuera de navori**: no se tocó código de `packages/cli`. El trabajo fue en
`bonum-webapp` (3 PRs) y en la máquina de Ulises. Cierra con **0 issues / 0 PRs** en navori.

**1. Limpieza de worktrees — ~30.7 GB liberados.** El censo real eran **53**, no 34: el patrón `wt-*`
solo ve uno de tres layouts. Los otros 19 vivían ocultos en `.wt-services-users/` (en DOS ubicaciones
distintas) y en `bonum-dashboard/.claude/worktrees/`. El único inventario confiable es
`git worktree list` por repo padre. Se eliminaron 18 (PR mergeado, `ahead=0`) y los `node_modules` de
los 32 restantes: `/bonum` pasó de ~50 GB a 19 GB. Criterio: los PRs de Bonum mergean con **squash**, así
que `--is-ancestor` no sirve — hay que preguntar `gh pr list --head <branch> --state all`.

**2. La ruta de los repos Bonum estaba mal en el `~/.claude/CLAUDE.md` global.** Apuntaba a
`/Users/ulisescm/Documents/dev/bonum/`, que no existe; los repos están en
`/Users/ulisescm/Documents/Dev - Docs/bonum`. Corregidas las 16 rutas, verificadas con `-d`.

**3. Rollout a bonum-webapp (PR #651).** De **0.5.1 a 0.6.4** (43 bloques en drift), engine `codex`
eliminado (`.codex/` y `AGENTS.md` quedaron huérfanos en v0.2.23, y `AGENTS.md` ni siquiera estaba
versionado). `doctor` cierra en drift 0. Dos hallazgos de navori que **merecen issue**:

- **`navori update` propone pisar configuración declarada**: truncaba el `qualityGate` (se comía `lint` y
  `test:unit`) y **reactivaba engines desactivados a propósito**. No distingue un valor detectado de uno
  escrito por el usuario. Es interactivo, así que nunca contestar "Yes" a ciegas.
- **El `doctor` no detecta skills project-local desalineadas.** Un bloque managed desalineado se detecta
  por hash; una skill local no tiene detector alguno. `typescript-first` llevaba 16 días afirmando que
  `compile` fallaba y que había un import roto de Chakra — ambas cosas las había arreglado el propio
  commit que la dejó mintiendo. Su regla dura #5 ordenaba **descartar errores de compile como ajenos**.
  Feature barata: que el doctor verifique las rutas `src/...` que citan las skills locales.

**4. Flujo `main-harness` / `develop-harness`.** Branch local (sin upstream, para que un push no empuje
el harness) = base + los commits del harness. Se trabaja encima y antes de pushear:
`git rebase --onto origin/<base> <base>-harness <ticket>`. Probado dos veces con trabajo real: 49→3
archivos en BT-1427 y 44→1 en BT-1425.

**5. BT-1427 (PR #653) y BT-1425 (PR #654).** Ambos comentados en Jira con mención en ADF y movidos a
`CODE REVIEW`. El patrón común de los dos: **medir en el navegador, no leer el CSS**.

- BT-1427: el CSS del dropdown de idiomas **nunca aplicó** — Mantine lo monta en un portal fuera del
  root, así que la regla anidada no lo alcanzaba y las opciones se quedaron en 8.75px. El PR anterior
  editó un número dentro de una regla muerta. La primera corrección propia habría sido igual de inerte;
  lo destapó medir con `getComputedStyle`. En Inicio, `Home.scss` nunca se editó y aun así creció: su
  label estaba en `em` colgando del root que fija el theme.
- BT-1425: **nadie agrandó la leyenda**. `Advice.scss` es idéntico antes y después del PR anterior; lo
  que se fue fue su contrapeso (la columna del calendario dejó de estirarse hasta ~768px alrededor de un
  calendario que siempre midió 498px). Pasó del 27% al 36% del ancho sin moverse un píxel.

**El patrón transversal, para ticket propio:** en webapp, **todo default de Mantine expresado en `rem`
sale al 62.5%** — su helper divide entre 16 y la app fija la raíz al 62.5%. Van tres apariciones
confirmadas (`rem(15.4)` en el theme, `0.875rem` de la opción, `13.75rem` de `maxDropdownHeight`).

**Gate.** No se editó código de navori; el gate de webapp cerró verde en los dos ciclos:
`compile` ✓ · `lint` 0 errores ✓ · **146 tests** ✓.

**Queda abierto.** Los 3 PRs de webapp **no pueden mergear**: SonarCloud falla con
`Could not find the pullrequest with key` en todos los PRs del repo — el rebind pendiente es hoy lo único
entre este trabajo y producción. Y el rollout al resto: 14 repos Bonum + moonar + navori-health en
**0.5.1**, los 3 de `/navori` en 0.6.2.

## 2026-08-28 13:10 orchestrator — release 0.6.5 (commit + tag) y rollout a los 3 repos de `/navori`

**Qué se hizo.** Bump de `packages/cli/package.json` a **0.6.5** + `render --apply` en el propio repo
(36 archivos: `CLAUDE.md` y `.claude/**` reestampados a `version="0.6.5"`, sin un solo cambio de
contenido — el diff es 56 inserciones / 56 borrados, todas de marcador). Commit `2f46add`
`chore(release): navori 0.6.5` y tag anotado **`v0.6.5`**. Después, rollout a los 3 repos con harness de
`/navori` vía `npx navori@0.6.5`, uno a uno con `doctor → render → doctor`.

**Hallazgo del release: el paquete ya estaba publicado en npm ANTES de existir el commit y el tag.**
`npm view navori dist-tags` daba `{ latest: '0.6.5' }` mientras `git log` seguía en `d3a0f80` y el último
tag era `v0.6.4`, con el bump sin commitear. No es cosmético: `scripts/check-asset-commands.mjs` (el paso
`check:assets`) no lee `package.json` — resuelve `latestTag()` con `git tag --sort=-creatordate` y lee
`git show <tag>:src/index.ts`. Sin el tag, el check medía los assets contra **v0.6.4**, o sea contra una
versión más vieja que la que los usuarios ya estaban instalando, invirtiendo justo el propósito de #490.
Verificado en ambos sentidos: antes del tag imprimía `existe en v0.6.4`; después, `existe en v0.6.5`.

**Rollout.** Los 3 quedaron en `doctor` "Todo al día" con **0 marcadores por debajo de 0.6.5**:

- `alertaciudadana_app` — 0.6.2 → 0.6.5 · 2 created, 59 updated · 61 marcadores
- `alertaciudadana_backend` — 0.6.2 → 0.6.5 · 2 created, 59 updated · 62 marcadores
- `navori-dashboard-template` — 0.6.4 → 0.6.5 · 59 updated · 60 marcadores

Los 2 archivos creados en los que venían de 0.6.2 son los hooks que entraron en 0.6.4:
`managed-drift-watch.sh` y `worktree-reclaim.sh`. Backup por repo en `~/.navori/backups/`.

**Se abortó el commit del harness en 2 de los 3 repos: había otra sesión de Claude Code haciendo el
MISMO rollout en paralelo.** Se detectó por evidencia, no por sospecha: `progress/ignite-update-plan.md`
pasó de staged a estar en `HEAD` entre dos verificaciones mías; el `.gitignore` de `app` y `backend`
apareció modificado con mtime 13:06/13:07 (minutos después de mis renders de las 12:22) agregando
`.claude/.managed-drift-stamp`; y `alertaciudadana_app` terminó con `85d2dc9 chore(harness): actualiza
navori de 0.6.2 a 0.6.5`, commit que no hice yo. Se dejó el index de `backend` como estaba en vez de
revertirlo: lo que yo había staged es idéntico a lo que esa sesión va a commitear.

**Pendientes que quedan abiertos.**
- `navori-harness`: `2f46add` y `v0.6.5` son **locales** — falta `git push` + `git push --tags` y
  `gh workflow run deploy-website.yml`.
- `alertaciudadana_backend` y `navori-dashboard-template`: harness renderizado pero **sin commitear**
  (43 y 42 archivos), a la espera de que cierre la sesión paralela.
- `alertaciudadana_backend`: `.codex/` huérfano de un engine que ya no está en `config.engines`.
  `render --prune --apply` lo borraría, pero arrastra el bug conocido de dejar atrás `.codex/hooks.json`.
- `alertaciudadana_app`: `name: "alertaciudadana"` no coincide con el directorio; doctor sugiere
  `alertaciudadana-app`. No se tocó por si es intencional.
- `navori-dashboard-template`: `.claude/progress/` y `.claude/.managed-drift-stamp` sin ignorar, y 4
  skills con la user-section sin llenar (`apollo-client`, `react-hook-form`, `zod-validation`, `zustand`).

**Gate.** Verde sobre el diff que se commiteó: `format:check` (292 archivos) · `check:render`
(0 pendientes) · `check:assets` · build del website (22 páginas) · `check:size` (848.5KB/900KB) ·
`test:coverage` (floor ok, 60 módulos, 2 excepciones) · `lint` · `typecheck`.
