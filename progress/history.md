# Historia de sesiones

<!--
Entradas más recientes arriba. Formato sugerido (no obligatorio):

## YYYY-MM-DD HH:MM — <agente> — <resumen breve>
- Cambios: <archivos / áreas tocadas>
- Quality gate: ✅ (quality gate sin configurar — corre 'navori configure quality-gate') verde | ❌ <razón>
- Notas: <decisiones no obvias, blockers, deuda>
- Commit / PR: <hash / URL>
-->

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
