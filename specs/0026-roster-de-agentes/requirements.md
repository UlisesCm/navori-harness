# Roster de agentes y skills — Requirements

**Status:** proposed · **Fecha:** 2026-09-16 · **Base revisada:** `fbd4450f` (revalidar contra
`origin/main`, incluido #854 `7da709df`, antes de implementar)

- **Origen:** propuesta en `docs/research/propuesta-simplificacion-agentes.md` (sin versionar),
  su evaluación y las decisiones del usuario del 2026-09-16.
- **Revisión:** dos challenges en contexto fresco; cómo cambió la spec está en `design.md`,
  "Veredicto".
- **Fuentes, citas literales y comandos para reproducir cada dato:**
  [`references.md`](./references.md).

## Context

El harness tiene ocho agentes (`leader`, `explorer`, `researcher`, `auditor`, `ticket-audit`,
`implementer`, `reviewer`, `commit-pr-pilot`) y once skills core escritas para ese roster.
Esta spec resuelve cinco problemas medidos, suma dos capacidades que el usuario decidió
incorporar, y lo hace con un reset del harness en lugar de una migración.

### 1. Los nombres chocan y no dicen cuándo usar cada agente o skill

| Nombre | Problema |
|---|---|
| `explorer` | Codex trae un agente integrado `explorer` y el custom lo reemplaza (*"If a custom agent name matches a built-in agent such as `explorer`, your custom agent takes precedence."*). Claude Code trae `Explore` |
| `leader` | El mismo rol tiene dos nombres: `leader` aparece 48 veces en `core-assets` y `orchestrator` 41; el log de audit ya atribuye el hilo principal a `ORCHESTRATOR_OWNER = "orchestrator"` (`lib/audit/parse.ts:1444`) |
| `researcher` / `explorer` | Ninguno de los dos dice cuál es el barato y cuál el profundo, que es el criterio real de ruteo |
| `ticket-audit` | Nombra la entrada (un ticket), no el rol, y comparte método con `auditor` |
| `commit-pr-pilot` | Nombra el mecanismo (commit + PR), no el rol |
| `structural-search` | Su propia `description` aclara *"Not the entry point for relationships or impact"*: sirve para ubicar código antes de leerlo |
| `security-guidance` | "Guidance" no dice qué contiene: los invariantes de seguridad de negocio |
| `babysit-prs` | Metáfora; la skill lee una vez y prohíbe esperar (*"Never `gh pr checks --watch`"*) |
| `ticket-intake` | Cubre del ticket a su cierre, no solo la entrada |

**Descartados por colisión:**
- `planner`: se descarta por cercanía semántica con el built-in `Plan` de Claude; no es una colisión literal.
- `worker`: integrado de Codex.
- `operator`: en el harness significa "el humano" (`managed/orquestacion.md:64`).
- `debug`, `verify`, `review` y `code-review`: skills integradas de Claude Code. Una skill de
  proyecto con ese nombre *"replaces the bundled command"*.
- `plan`: skill de sistema de Codex.

### 2. Uso real

Transcripts de Claude Code de 8 proyectos, últimos 90 días al 2026-09-16:

| Agente | Invocaciones |
|---|---:|
| `implementer` | 328 |
| `reviewer` | 221 |
| `commit-pr-pilot` | 174 |
| `researcher` | 107 |
| `auditor` | 55 |
| `ticket-audit` | 42 |
| `explorer` | **2** |

| Skill | Tool `Skill` | Lecturas de `SKILL.md` |
|---|---:|---:|
| `spec-bootstrap` | 19 | 3 |
| `ticket-intake` | 6 | 2 |
| `dominio` | 4 | 0 |
| `solution-design` | 3 | 2 |
| `review-diff` | 1 | 5 |
| `structural-search` | 0 | 11 |
| `verify-before-done` | 0 | 8 |
| `debug-error` | 0 | 6 |
| `security-guidance` | 0 | 5 |
| `babysit-prs` | 0 | 3 |
| `loop-back-debug` | 0 | 2 |

Solo existen 3 artefactos `solution_*.md` en los repos locales (efímeros: es un piso).

### 3. Prosa que en realidad es código

- **Tamaño:** `agents/commit-pr-pilot.md` mide 4,001 palabras y `agents/reviewer.md`, 2,401.
- **Qué describen en shell:** el conjunto a publicar, los hashes del receipt, la cobertura y el
  drift (`reviewer.md:87-126`, `commit-pr-pilot.md:50-132`).
- **Pruebas que fijan el texto:** `commit-pr-pilot-drift-loop.test.ts` extrae ese shell del
  Markdown para ejecutarlo.
- **Historial:** unos 26 commits mencionan receipt, drift, pilot o preflight (#148, #202, #341,
  #342, #344, #352, #354, #365, #785 y #793, entre otros).

### 4. Doctrina que se contradice o está mal

| Dónde | Defecto |
|---|---|
| `agents/leader.md:77` | "Fix a minor finding yourself", contra "todo cambio a source pasa por `implementer` → `reviewer`" |
| `agents/leader.md:169-170` | Permite editar `docs/`, `CLAUDE.md` y `.claude/`, y saltarse una "single trivial line", contra la misma regla y su "no threshold" |
| `agents/leader.md:26-31` | "Brainstorm gate" con el usuario como dueño del enfoque, contra `solution-design` con el orquestador como dueño del veredicto |
| `skills/ticket-intake.md:37` | "Phase 2 is not skipped on a non-trivial task", contra la tabla de orquestación; en bonum-webapp hubo 25 `ticket-audit` por 33 `implementer` |
| `skills/verify-before-done.md:9` | `maxWords: 1050`, sin la regla de atribución por ubicación del archivo en el diff (única contradicción de línea base que sigue viva; ver R31) |
| `skills/review-diff.md:106` | Exige `{{qualityGate.fast}}`; el `reviewer` que la aplica exige `{{qualityGate.full}}` (`reviewer.md:75`) |
| `skills/review-diff.md:66` y `skills/security-guidance.md:21` | La misma regla de cobertura de entry points de un guard, escrita dos veces |
| `skills/loop-back-debug.md:60` | Manda preguntar al usuario desde `implementer`, un subagente sin `AskUserQuestion` |
| `agents/auditor.md:56-62` | Eje de seguridad propio que repite a medias `security-guidance` |
| `skills/spec-bootstrap.md:15` | Scaffolding de la spec al agente principal "or the `researcher`" |
| `skills/ticket-intake.md:24` | Fase de "2-3 `explorer` agents", un agente con 2 invocaciones en 90 días |
| `skills/review-diff.md:36`, `agents/auditor.md:57`, `agents/ticket-audit.md:51-52`, `agents/researcher.md:42` | Recetan búsqueda por shell (`grep -rn`, "grep for the URL", `git grep`) contra el bloque `code-discovery-routing`, que manda la búsqueda textual al proveedor habilitado |
| `docs/DIRECTION.md:76-81`, `:152-153` | Declara tgrep y codegraph retirados; `91e5fa52` (#838) los reintrodujo |

**Ya resuelto, no re-litigar:** la línea base con `git stash`/`git stash pop` en
`agents/implementer.md:47`/`:81` y `skills/verify-before-done.md:52` que citaba una versión previa
de esta tabla ya no existe en `origin/main`. `agents/implementer.md:48` prohíbe explícitamente
stashear o descartar el working tree compartido ("hit the `ask` permission rule... destroy other
parallel agents' work"), y `agents/reviewer.md:189` trae la misma prohibición. `grep -n stash` sobre
`skills/verify-before-done.md` no devuelve nada. El alcance real que queda de R31 sobre este punto
es exclusivamente `maxWords` (hoy 1050, baja a 600) y la regla de atribución por ubicación del
archivo en el diff — ver la fila de arriba y R31.

### 5. tgrep y codegraph no se pueden medir ni están en todos los flujos

- **Estado de search v2:** `91e5fa52` (#838) reintrodujo codegraph (MCP, carga desde el primer
  turno) y tgrep v2 (`tgrep search` con permiso exacto) el **2026-09-16 a las 10:22**. Desde
  entonces no hay llamadas a `tgrep search` en los transcripts, pero la ventana es de horas y no
  prueba nada.
- **Métrica pre-registrada:** `search-v2.md` §9.5 (D19) registró la hipótesis de que la adopción
  sube **sin guard**. La valida con dos semanas de uso en navori-harness y un umbral de ≥ 25% de
  búsquedas reales por la vía v2; *"si el umbral no se cumple, D11 se reabre con una spec nueva …
  no se reabre antes, ni por intuición"*.
- **La medición hoy no puede correr:**
  - `navori.config.json` de navori-harness no habilita `tgrep` ni `codegraph`.
  - `scripts/mine-search-routing.py:113` solo cuenta el wrapper v1 (`WRAPPER = "tgrep-search.sh"`).
- **codegraph en el parque:** está habilitado en 21 repos locales y tuvo 105 llamadas a
  `codegraph_explore` en 30 días. Hoy lo reciben:
  - por inyección de plugin: `leader`, `implementer`, `reviewer`, `auditor` y `ticket-audit`;
  - por nombre exacto en su asset: `researcher` y `explorer`.
- **Guía oficial de codegraph** (README): *"CodeGraph only helps when queried directly … rather
  than delegate exploration to file-reading sub-agents"*.

### Hechos del host y las herramientas

Fuentes oficiales en `references.md` §1.

- **Claude Code, hooks:**
  - Para `"ask"`, `permissionDecisionReason` es *"shown to the user but not Claude"*.
  - *"A hook's `"ask"` also forces a permission prompt in auto mode"*.
  - Los hooks corren dentro de subagentes con `agent_id` y `agent_type`.
- **Claude Code, subagentes:**
  - No tienen `AskUserQuestion`.
  - `model` se sobrescribe por invocación; `effort`, solo en el frontmatter.
  - Un asset sin `Agent` en `tools` no puede lanzar subagentes.
- **Claude Code, skills integradas:** `/doctor`, `/code-review` (alias `/review`), `/batch`,
  `/debug`, `/loop`, `/claude-api`, `/run`, `/verify` y `/run-skill-generator`.
- **Codex, agentes:**
  - Integrados: `default`, `worker` y `explorer`.
  - El `model` y el `model_reasoning_effort` del archivo del agente ganan sobre el spawn.
- **Codex, hooks:**
  - `permissionDecision: "ask"` en `PreToolUse` está *"parsed but not supported yet"* y la
    llamada continúa.
  - *"new or changed hooks are marked for review and skipped until trusted"* (se confían con
    `/hooks`).
- **Codex, skills:** si dos se llaman igual, *"Codex doesn't merge them"*; las de sistema incluyen
  `skill-creator` y `plan`.
- **tgrep 1.0.8:**
  - Invocación: `tgrep search [OPTIONS] <PATTERN> [PATH]...`.
  - `-n` es default solo en terminal.
  - Sin índice listo, cae a escaneo del sistema de archivos.
  - Con `-q` sale 0 si hay coincidencia y 1 si no.
- **codegraph 1.6.0:**
  - `codegraph init` una vez por proyecto.
  - `codegraph serve --mcp` expone la tool.
  - La guía del servidor MCP *"only reaches the main agent"*.

### Decisiones del usuario (2026-09-16)

| Tema | Decisión |
|---|---|
| Agentes | `leader` → `orchestrator`; `explorer` + `researcher` → `scout`; `ticket-audit` dentro de `auditor`; `commit-pr-pilot` → `publisher`; nuevo `architect`; `implementer` y `reviewer` se quedan |
| `publisher` | Además de commits, push y PRs, publica comentarios informativos en Jira y GitHub, siempre con borrador previo; Slack fuera |
| Reset | Todos los repos son locales y del usuario: el harness se resetea en lugar de migrarse |
| Skills | `debug-error` + `loop-back-debug` → `debug-failure` (absorbe y retira la skill personal `systematic-debug`); `structural-search` → `locate-code`; `security-guidance` → `security-invariants`; `babysit-prs` → `follow-up-prs`; `ticket-intake` → `resolve-ticket` |
| `spec-bootstrap` | Challenge en contexto fresco antes de entregar una spec que toca áreas críticas |
| Hook | `pr-pilot-confirm` → `pr-publisher-confirm`, con alias en audit |
| Búsqueda | tgrep y codegraph se incorporan a los flujos; menos tokens, más velocidad y código de más calidad |

### Relación con decisiones previas

- **Principio de esta spec:** ningún cambio se justifica por un aumento esperado de activación de
  agentes o skills. La moratoria de doctrina que lo sostenía vivía en `progress/current.md` hasta
  `3f0fceb0`; #845 reescribió ese archivo y hoy solo se registra en `progress/history.md` y en las
  specs 0023 y 0024. Dos requisitos agregan delegación explícita por decisión del usuario, no por
  activación esperada: R35 (challenge en `spec-bootstrap`) y R49 (`architect`). El criterio 2 los
  mide.
- **Spec 0012:** rechazó `solution-architect`; F la enmienda (`design.md`).
- **`search-v2.md`:** D02 y M03 prohíben hooks y scripts en el plugin `tgrep`, y D19 difiere
  cualquier guard hasta medir. Esta spec **no restaura el guard**: hace medible D19 (R14, R15) y
  deja escrito el guard como siguiente paso si D19 falla.
- **Specs 0015, 0019, 0020 y 0023:** se respetan.
  - 0015: contenido de subagente en su asset.
  - 0019: techo de 6,500 caracteres del bloque de orquestación, que hoy mide 6,324.
  - 0020: `description` + `when` por agente.
  - 0023: su texto nombra `commit-pr-pilot.md`.

Público: el operador del harness. Áreas críticas tocadas:
- Escrituras y borrados de render en el repo (R).
- Permisos y hooks (B, E1, R).
- Marcadores managed (R).

## Requirements (EARS)

### B · `navori receipt`

- **R1** — El sistema SHALL proveer `navori receipt sign`, que:
  - Calcula el conjunto a publicar contra `origin/<target>` tras `git fetch` (target por default
    `prTarget` y, sin él, `branchBase`).
  - Usa diff de dos puntos más archivos no rastreados.
  - Excluye `.claude/progress/`, `.codex/progress/` y `progress/`.
  - No detecta renombres, separa las rutas por NUL, no usa drivers externos de diff ni textconv,
    y no toma locks opcionales de git.
  - Escribe `receipt.txt` en el directorio de progreso, con un blob almacenado por archivo vivo y
    un marcador `deleted` por archivo borrado. V1 admite únicamente archivos regulares: SHALL usar
    `lstat`, rechazar symlinks válidos o rotos, gitlinks/submódulos y cualquier otro tipo no regular
    como `ERROR`, sin dereferenciarlos ni representarlos como `deleted`. Un diff solo de modo SHALL
    terminar en `ERROR`/código 1, sin `DRIFT` y sin sobrescribir el receipt; V1 no firma modos.
- **R2** — El sistema SHALL proveer `navori receipt check`, que reporta por archivo `UNCOVERED` y
  `DRIFT`, con salida `--json` que incluye `formatVersion`, el target, su SHA, el SHA de `HEAD` y
  un `status` que es `ok`, `findings` o `error`, y SHALL salir con código 0 sin hallazgos y 2 con
  al menos uno. `sign --json` y `check --json` SHALL usar el mismo schema: en éxito incluyen
  `formatVersion`, `target`, `targetSha`, `headSha` y `status`; en error temprano los SHA pueden ser
  `null` y SHALL incluir `error`. `check` ausente es `ERROR`; `sign` inicial crea el receipt.
- **R3** — IF git falla, el receipt no existe en `check`, un archivo no se puede hashear, su lectura
  falla, su tipo no es regular, hay un diff solo de modo o una ruta no se puede representar en el formato de línea, THEN
  `sign` y `check` SHALL salir con código 1 y reportar `ERROR`; un `ERROR` SHALL NOT reportarse como
  `DRIFT`. Un `sign` fallido SHALL preservar el receipt anterior.
- **R4** — IF la rama está detrás de `origin/<target>`, THEN `sign` y `check` SHALL salir con
  código 1 sin escribir ni validar el receipt.
- **R5** — WHEN `check` reporta `DRIFT` sobre un archivo vivo, SHALL imprimir el blob aprobado y el
  comando exacto para inspeccionar la diferencia.
- **R6** — Los assets que firman y verifican receipts SHALL invocar `navori receipt` con `--feature`, `--target`
  y `--json`, y SHALL NOT contener el algoritmo en shell.
- **R7** — Esos assets SHALL continuar solo ante un JSON con `"status": "ok"`, y ante cualquier otra
  salida, incluido un `navori` ausente o sin `receipt`, SHALL detenerse.
- **R8** — Los settings generados SHALL preaprobar `Bash(navori receipt:*)`.
- **R9** — La fila de `verify-before-done` para publicar un PR SHALL exigir `navori receipt check`
  con `"status": "ok"`.

### E1 · Borrador previo de comentarios

- **R10** — WHEN una llamada Bash publica un comentario, el hook SHALL devolver `ask` en Claude
  Code sin importar qué agente la emite, y SHALL emitirse y registrarse en ambos engines sin
  depender de qué plugins están habilitados. Las llamadas cubiertas son:
  - `gh pr comment` y `gh issue comment`.
  - `gh pr review` con cuerpo.
  - `gh api` con escritura sobre un endpoint de comentarios o reviews, o sobre `graphql` con una
    mutación de creación o edición de comentario o review: `addComment`, `addDiscussionComment`,
    `addPullRequestReview`, `addPullRequestReviewComment`, `addPullRequestReviewThread`,
    `addPullRequestReviewThreadReply`, `updateIssueComment`, `updateDiscussionComment`,
    `updatePullRequestReview` o `updatePullRequestReviewComment`. Borrados quedan fuera de alcance.
  - `acli jira workitem comment create|update`.
- **R11** — WHEN el cuerpo viene de un archivo (`--body-file`, `-F <archivo>`, `--body-adf`,
  `--input`, o un campo `-F clave=@archivo` de `gh api`), el hook SHALL mostrar su texto (el de sus
  nodos si es ADF) truncado a 1,500 caracteres, con el conteo de lo omitido y la ruta del archivo;
  WHEN va en línea, la razón SHALL decir que el cuerpo está en el comando del prompt. Para GraphQL
  SHALL mostrar la variable o campo `body` extraído, nunca confundir el documento `query` con el cuerpo.
- **R12** — IF el hook no puede leer el cuerpo o no hay herramienta para construir su JSON, THEN
  SHALL devolver `ask` con una razón que diga que no pudo mostrar el borrador, sin ejecutar shell ni
  leer stdin. Este fallback prevalece sobre cualquier parser parcial.
- **R13** — WHEN el hook corre instalado en `.codex/hooks/`, SHALL devolver `deny` con una razón
  que nombre el archivo del borrador si existe; para cuerpo inline o stdin SHALL indicar que no hay
  archivo y repetir el comando/flag de publicación. El `deny` prevalece aun sin `jq` o `node`; la
  garantía de `ask` de Claude requiere versión auto >= 2.1.211, y Codex requiere confiar la capa
  de proyecto y el hash del hook en `/hooks`.

### G · tgrep y codegraph en los flujos

- **R14** — El `navori.config.json` de navori-harness SHALL habilitar los plugins `tgrep` y
  `codegraph`, para que corra la métrica de campo D19 de `search-v2.md`.
- **R15** — `scripts/mine-search-routing.py` SHALL contar `tgrep search` y `codegraph_explore` como
  la vía v2, y `Grep` nativo, `rg`, `grep -r` y `git grep` como escape, según el instrumento de D19.
  SHALL incluir transcripts de subagentes vinculados a la sesión auditada, deduplicar eventos por
  identidad consistente y distinguir `unavailable`/malformed de conteo cero. El alcance medido es
  Claude mientras el minero no soporte otro engine.
- **R16** — Los assets distribuidos SHALL NOT recetar búsqueda por shell (`grep -r`, `rg`,
  `git grep`) como método de descubrimiento, y SHALL referirse a descubrimiento textual o
  estructural según Code discovery routing.
- **R17** — WHEN el plugin `codegraph` está habilitado, `orchestrator`, `scout`, `auditor`,
  `implementer` y `reviewer` SHALL recibir `codegraph_explore` (`scout` por nombre exacto en su
  asset, el resto por inyección de plugin), y `publisher` SHALL NOT recibirlo.
- **R18** — `locate-code` SHALL delegar el carril textual y el estructural en el proveedor
  habilitado según Code discovery routing, y SHALL presentar `Grep` nativo y la lectura manual solo
  como respaldo cuando no hay proveedor.

### R · Roster, skills y reset

#### Agentes

- **R19** — El roster core SHALL ser exactamente `orchestrator`, `scout`, `auditor`,
  `implementer`, `reviewer` y `publisher`, con `orchestrator` encarnado por el agente principal.
- **R20** — Los settings generados SHALL denegar `Agent(orchestrator)` y SHALL NOT contener
  `Agent(leader)`.
- **R21** — Cada agente del roster SHALL declarar qué hace y cuándo usarlo en la `description` de
  su asset y en `agentsIndex.when` en español y en inglés, y ningún subagente SHALL declarar la
  tool `Agent`.
- **R22** — `scout` SHALL cubrir dos encargos, mapa de un área y pregunta acotada, SHALL escribir
  `explore_<area>.md` o `research_<slug>.md` según el encargo, y su `description` SHALL reservarlo
  para sub-preguntas en paralelo o lecturas que conviene aislar.
- **R23** — `auditor` SHALL cubrir tres encargos con su contrato de salida:
  - Área: `audit_deep_<scope>.md` + `plan_<scope>.md`.
  - Ticket: `audit_ticket_<ID>.md`.
  - Challenge: `solution_review_<scope>.md`, sin emitir veredicto.

  Su eje de seguridad SHALL cargar `security-invariants`.
- **R24** — El playbook del orquestador SHALL NOT contener ninguna regla por la que el orquestador
  edite source él mismo.
- **R25** — El harness SHALL tener una sola compuerta de diseño, definida en el bloque de
  orquestación y en `solution-design`.
- **R26** — El bloque de orquestación renderizado SHALL medir como máximo 6,500 caracteres.
- **R27** — El hook `pr-publisher-confirm` SHALL nombrar a `publisher` y SHALL emitirse y
  registrarse según `harness.publisher`.
- **R28** — Un plugin SHALL NOT inyectar más de un sub-bloque en el mismo archivo de agente, y los
  ids de sus sub-bloques y los archivos fuente que inyecta SHALL usar el id del agente destino.

#### Skills

- **R29** — Las skills core SHALL ser exactamente `spec-bootstrap`, `resolve-ticket`,
  `solution-design`, `dominio`, `follow-up-prs`, `locate-code`, `verify-before-done`,
  `debug-failure`, `review-diff` y `security-invariants`.
- **R30** — `debug-failure` SHALL definir un ciclo único:
  1. Ver el error sin filtrar.
  2. Reproducirlo.
  3. Encontrar la causa raíz con `file:line`, con instrumentación por capa cuando cruza
     componentes.
  4. Aplicar un solo fix.
  5. Si el fix falla, revalidar la hipótesis.
  6. Tras dos intentos fallidos, reportar `BLOCKED` si corre en un subagente o preguntar al
     usuario si corre en el agente principal.
- **R31** — `verify-before-done` SHALL declarar `maxWords: 600`, SHALL NOT recetar `git stash`, y
  SHALL usar la ubicación solo como triage: los de archivos del conjunto a publicar cuentan como
  introducidos; fuera del diff sin baseline comparable son de origen no determinado; solo evidencia
  comparable permite llamarlos previos. Sin ubicación la línea base no está medida. Esta
  clasificación no exime el gate verde ni la revisión.
- **R32** — `review-diff` SHALL:
  - Exigir `{{qualityGate.full}}`.
  - Remitir la seguridad a `security-invariants`.
  - Exigir para cada hallazgo HIGH o CRITICAL el `file:line`, el escenario de falla y por qué
    ningún guard existente lo atrapa; sin los tres, el hallazgo baja a MEDIUM o se descarta.
  - Declarar que cero hallazgos es un veredicto válido.

  El asset `reviewer` SHALL NOT repetir su checklist.
- **R33** — `security-invariants` SHALL ser la única fuente de la checklist de seguridad que usan
  `reviewer` y `auditor`, con los invariantes de negocio y una lista compacta de patrones de
  escáner para cuando no hay escáner instalado, y el plugin `semgrep` SHALL inyectar en ella.
- **R34** — `resolve-ticket` SHALL recorrer:
  1. Triage.
  2. Auditoría con `auditor`, solo ante los disparadores de la tabla de orquestación.
  3. Diseño, solo ante señal arquitectónica.
  4. Implementación.
  5. Revisión.
  6. Publicación con `publisher`, que redacta un comentario en el tracker solo cuando el usuario
     lo pide.
- **R35** — `spec-bootstrap` SHALL asignar el scaffolding al orquestador, y WHEN la spec toca
  `project.criticalAreas`, SHALL exigir un challenge de `auditor` en contexto fresco antes de
  entregarla.
- **R36** — `solution-design` SHALL ser la única fuente de las dimensiones de diseño
  condicionales, y la plantilla de `design.md` de `spec-bootstrap` SHALL remitir a ella.
- **R37** — `follow-up-prs` SHALL remitir a `publisher` la respuesta a un comentario de PR, y SHALL
  NOT publicarla.

#### Reset

- **R38** — El sistema SHALL mantener registros append-only de ids retirados, cada uno con su
  sucesor (o sin sucesor) y el id de marcador por destino que navori estampó: Claude usa `<id>-base`;
  Codex usa `<id>-codex-base` para assets base. Los registros o contrato de cada adapter SHALL
  distinguirlos explícitamente, sin asumir que el orphan scan actual tenga un bug:
  - Agentes: `leader`, `explorer`, `researcher`, `ticket-audit` y `commit-pr-pilot`.
  - Skills: `debug-error`, `loop-back-debug`, `structural-search`, `security-guidance`,
    `babysit-prs` y `ticket-intake`.
  - Hooks: `pr-pilot-confirm`.
- **R39** — WHEN `render --apply` encuentra un archivo de un id retirado con el marcador registrado
  y versión no más nueva que la CLI, SHALL borrarlo con backup previo en los destinos de Claude y
  de Codex, incluidos los workspaces con `monorepo.workspaceHarness: "full"`; IF el archivo no es de
  navori o es más nuevo, THEN SHALL conservarlo y reportar el motivo.
- **R40** — IF `navori.config.json` trae claves retiradas bajo `harness`, `models` o `effort`, THEN
  la lectura del config SHALL fallar con un `ConfigError` que nombre cada clave, su reemplazo y,
  cuando dos claves retiradas van al mismo reemplazo con valores distintos, los dos valores.
- **R41** — `navori doctor` y `render --apply` SHALL reportar cada archivo de agente, skill o hook
  retirado que siga en disco, nombrando su sucesor.
- **R42** — Toda lista de ids activos de agentes, skills o hooks del código SHALL coincidir con su
  catálogo canónico, y una prueba SHALL fallar si alguna diverge.
- **R43** — El análisis de logs de `navori audit` y los mineros de `scripts/` SHALL clasificar los
  ids retirados de agentes y el hook `pr-pilot-confirm` como su sucesor.
- **R44** — Los assets distribuidos SHALL NOT nombrar ids retirados, ni en su contenido ni en sus
  rutas, fuera de los registros de R38, y una prueba SHALL fallar si alguno lo hace.

### E2 · Canales de `publisher`

- **R45** — El asset `publisher` SHALL escribir el cuerpo de un comentario en un archivo del
  directorio de progreso, publicarlo por canal file-backed: `gh pr/issue comment` y `gh pr review` con `--body-file`; `gh api`
  con `--input` o `-F body=@archivo` (o campo GraphQL equivalente); `acli` con `--body-file` y
  `--body-adf` en update ADF. SHALL prohibir cuerpos inline. En Codex SHALL entregar borrador y
  comando para el humano, sin declarar URL o id no publicado; en una publicación ejecutada SHALL
  reportar la URL o id resultante, y SHALL NOT incluir
  contenido técnico que no provenga de un artefacto de handoff existente.
- **R46** — Los plugins `acli` y `gh` SHALL inyectar en `publisher` el protocolo de su canal, y el
  de `acli` SHALL prohibir escribir en Jira por el MCP de Atlassian.

### F · `architect` (enmienda la spec 0012)

- **R47** — WHEN F se entrega, el roster core SHALL incluir `architect`, y WHEN el plugin
  `codegraph` está habilitado, `architect` SHALL recibir `codegraph_explore` por inyección.
- **R48** — `architect` SHALL producir `solution_<scope>.md` con el método de `solution-design`, y
  SHALL NOT emitir veredicto, descomponer en tareas ni preguntar al usuario.
- **R49** — WHEN `architect` está habilitado, el bloque de orquestación SHALL definir el paso
  arquitectónico como propuesta de `architect`, challenge de `auditor` en contexto fresco y
  veredicto READY / CONCERNS / BLOCKED del orquestador.
- **R50** — IF `harness.architect` vale `false`, THEN el paso arquitectónico SHALL seguir el flujo
  de la spec 0012 (el orquestador aplica la skill) con el challenge en `auditor`.

### Q · Presupuestos y controles de medición

- **R51** — Cada asset de agente del roster SHALL declarar un techo de palabras sobre su cuerpo,
  fijado al tamaño con el que aterriza la reescritura (y `architect` como máximo 400), y una prueba
  SHALL fallar si un asset lo excede o si un asset presupuestado no existe.
- **R52** — Cada minero o consulta de log que decide un criterio pre-registrado SHALL tener fixtures
  positivos con conteos exactos y negativos, malformed y unavailable; una falta de datos SHALL NOT
  ser cero ni habilitar una conclusión.
- **R53** — Cada ejecución del `qualityGate.full` del reviewer SHALL tener un único owner y un handle
  estable correlacionado al diff, emitido por el owner; el monitor SHALL observar solo ese handle,
  no `pgrep`/`ps` global. Un timeout no equivale a exit 0; sin handle async del host SHALL ejecutar
  foreground con terminal observable o reportar `BLOCKED`.
- **R54** — La auditoría SHALL extender `lib/audit/{model,report,signals}.ts` para medir, sin PII,
  duración total del reviewer, gate, espera y número de reviews/ejecuciones correlacionadas; SHALL
  distinguir intervalos solapados, duplicate/unknown/timeout y datos faltantes, sin atribuir el
  resto a razonamiento. Todo criterio de latencia SHALL usar mínimo 10 gates completados sobre >=3
  ramas de git distintas (`gitBranch` de `SessionAudit`) y tratar datos incompletos como
  inconclusos; no cambia `qualityGate.full` ni la revisión independiente.

  > **Enmienda (#870).** El texto original decía "sobre >=3 diffs". La implementación
  > (`reviewerGateLifecycle()` en `lib/audit/signals.ts`) usaba `sessions.length` como proxy,
  > porque `SessionAudit` no tiene identidad de diff — el par (base, head) del receipt es efímero
  > (el publisher lo borra tras commitear) y nunca se persiste, y de 45 audits grabados ninguno
  > tiene receipt asociado. Contar sesiones cuenta unidades de trabajo repetidas (implementer,
  > reviewer, implementer otra vez sobre EL MISMO diff) como si fueran diffs distintos, dejando el
  > piso más laxo que lo que R54 pretende proteger — que la muestra abarque varias unidades de
  > trabajo independientes, no una sola repetida 10 veces.
  >
  > Se evaluaron tres rutas (`.claude/progress/research_870_diff_identity.md` y
  > `challenge_870_diff_identity.md`): (1) capturar el par (base, head) en el propio audit —
  > descartada, el challenge encontró 3 BLOCKERs: HEAD es mutable dentro de una sesión, un rebase
  > cambia el par sin que sea "un diff nuevo", y no hay un momento limpio del ciclo de vida del
  > hook para capturarlo sin la ceremonia deliberada que hoy solo tiene el receipt; (2) contar
  > tipos de agente distintos (>=2) en el rango — descartada, 10 gates de implementer+reviewer
  > dentro de UNA sola sesión ya cumplen ese criterio sin que la muestra deje de ser una sola
  > unidad de trabajo; (3) dejar el código igual y solo cambiar el texto a "sesiones" — descartada
  > por bajar el piso formalmente en vez de corregir la discrepancia.
  >
  > La ruta elegida cuenta ramas de git distintas (`gitBranch`, ya presente en `SessionAudit`):
  > dos sesiones sobre la misma rama son el mismo ciclo de revisión; ramas distintas se asumen
  > unidades independientes. Tiene fallas conocidas y aceptadas — trabajo directo sobre `main`
  > (trunk-based) o una rama larga con varios cambios no relacionados colapsan a menos unidades de
  > las reales — pero ambas solo pueden hacer el piso MÁS difícil de alcanzar, nunca más laxo, que
  > es la dirección que R54 exige. Una sesión sin `gitBranch` se agrupa junto con las demás sin
  > rama en un único bucket "desconocido", por la misma razón: subcontar es seguro, sobrecontar no.
