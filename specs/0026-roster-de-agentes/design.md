# Roster de agentes y skills — Design

**Status:** proposed · **Requirements:** [`requirements.md`](./requirements.md) · **Tareas:**
[`tasks.md`](./tasks.md) · **Referencias:** [`references.md`](./references.md) · **Base:**
`5a0bbc34`

## Approach

Seis partes, cada una en su PR:

```text
B  · navori receipt ──────────┐
E1 · borrador de comentarios ─┤ (independientes; cualquier release)
G  · tgrep y codegraph ───────┘
                              ▼
R · roster + skills + reset (un release, luego reset del parque) ─┬─▶ E2 · canales de publisher
                                                                   └─▶ F  · architect
```

- **B, E1 y G van antes de R.** Son mecanismo o corrección y no dependen de los nombres nuevos.
  - E1 y la mitad de G no tocan archivos que R reescribe.
  - B edita `commit-pr-pilot.md` y G edita `ticket-audit.md` y `structural-search.md`, que R
    renombra o fusiona: R lleva esos diffs a los archivos nuevos.
- **R es un solo release**, seguido del reset de cada repo ("Reset del parque"). No hay
  migración:
  - Registros de retirados para limpiar restos.
  - Un error claro en el config.
  - Alias en audit para los logs históricos.
- **E2 y F van después de R.** E2 necesita a `publisher` y F necesita que `auditor` haga el
  challenge.
- **Q no es una fase propia.** R51 viaja con R y F; R52 con E1, G y R.
- **F es separable.** Si la enmienda a la spec 0012 no convence, se corta F y el resto no
  cambia: el bloque de orquestación usa `navori:if architect`, y sin él queda el flujo de R50.
- **La rama `refactor/814-engram-protocol-to-skill` ya está mergeada** (`faff0324`, #841).

### Por qué reset y no migración

La primera versión de esta spec diseñó una migración sin pérdida. Su challenge en contexto fresco
encontró tres bloqueos:
- Contenido de plugins copiado como si fuera del usuario.
- Claves que `render` nunca escribe.
- CLIs viejas que borrarían claves nuevas.

Todo eso protege repos ajenos. Los datos dicen que aquí no hace falta:
- **Repos:** todos son locales y del usuario, y él decidió resetear.
- **Agentes:** ningún archivo de agente renderizado tiene contenido de usuario después de sus
  bloques managed, en ningún repo local.
- **Skills:** las que tienen contenido de usuario (350 a 736 palabras en
  `navori-dashboard-template`, `alertaciudadana_backend` y `alertaciudadana_app`) están
  versionadas en git: 19, 25 y 39 `SKILL.md` rastreados.
- **Configs:** los 28 `navori.config.json` locales se corrigen una vez, guiados por el error de
  R40.

Lo que queda es lo barato:
- **Registros de retirados.** Siguen el patrón de `RETIRED_SKILLS` y `RETIRED_HOOKS`
  (`engines/shared/harness-assets.ts`, reconciliados en `engines/claude/index.ts:1104-1143`), con
  el id de marcador registrado (ver "Registros de retirados").
- **Error explícito en el config.** Hoy el schema descarta claves desconocidas
  (`lib/schema.ts:158-167`), y un `harness.explorer: false` se volvería un `scout` encendido sin
  aviso.

## Components

### B · `navori receipt`

- `packages/cli/src/lib/receipt.ts` — conjunto a publicar, `sign` y `check` sobre un runner de git
  inyectable — R1–R5.
- `packages/cli/src/commands/receipt.ts` — subcomando registrado en `packages/cli/src/index.ts`,
  con su `CommandDoc` es y en en `apps/website/src/content/commands.ts`
  (`__tests__/command-docs-inventory.test.ts` lo exige) — R1, R2.
- `agents/reviewer.md`, `agents/commit-pr-pilot.md` — invocación en lugar de shell — R6, R7.
- `settings/settings-base.json` — `Bash(navori receipt:*)` — R8.
- `skills/verify-before-done.md:57` — fila de PR — R9.

### E1 · Borrador de comentarios

- `packages/core/core-assets/hooks/comment-draft-confirm.sh` (nuevo) — R10–R13.
- `engines/shared/harness-plan.ts` (hooks core sin condición, como los de
  `harness-plan.ts:117-185`), `engines/claude/build-settings.ts` y
  `engines/codex/build-config-toml.ts` (registro) — R10.

### G · tgrep y codegraph

- `navori.config.json` del repo — plugins `tgrep` y `codegraph` — R14.
- `scripts/mine-search-routing.py:113` — `tgrep search` y `codegraph_explore` como vía v2 — R15.
- Assets que recetan búsqueda por shell — R16:
  - `skills/review-diff.md:36`.
  - `agents/auditor.md:57`.
  - `agents/ticket-audit.md:51-52`.
  - `agents/researcher.md:42`.
- `packages/plugins/codegraph/plugin.json` — inyecciones del roster; `scout.md` conserva
  `mcp__codegraph__codegraph_explore` por nombre exacto (#761) — R17.
- `skills/structural-search.md`, luego `locate-code` — carriles delegados al proveedor — R18.
- `docs/DIRECTION.md:76-81`, `:152-153` — deja de declarar tgrep y codegraph como retirados.

### R · Roster, skills y reset

- **Agentes** (`packages/core/core-assets/agents/`):
  - `orchestrator.md` desde `leader.md`, sin `:26-31`, `:77` ni `:169-170` — R24, R25.
  - `scout.md`, fusión de `researcher.md` y `explorer.md` — R22.
  - `auditor.md`, que absorbe `ticket-audit.md` y el brief de challenge — R23.
  - `publisher.md`, desde `commit-pr-pilot.md` — R19.

  — R19, R21.
- **Casos especiales del rol encarnado:**
  - `engines/claude/index.ts:239`, `:1804` y `:1813`.
  - `engines/shared/harness-plan.ts:68` (`includeLeader`).
  - `engines/claude/build-settings.ts:98-100`.
  - `engines/codex/index.ts:109` y `:329`.
  - `engines/codex/compat.ts:79-96` y `:124-130`.
  - `engines/claude/global-plugin.ts:151` (`includeLeader: true`).

  Más `settings-base.json:115` — R19, R20.
- **Doctrina:** `managed/orquestacion.md` + `lib/render-plan.ts:251-280` (la rama
  `analyticalParallelism` y sus reemplazos literales se reducen a `navori:if scout`) — R25, R26.
- **Hook:** `hooks/pr-pilot-confirm.sh` → `hooks/pr-publisher-confirm.sh`;
  `engines/claude/build-settings.ts:73` y `:126`; `engines/shared/harness-plan.ts:194` — R27.
- **Plugins** — R28, R33:
  - `engram`: `skills/engram-leader.md` → `skills/engram-orchestrator.md`, con ids de sub-bloque
    por agente destino.
  - `codegraph`: una inyección por agente.
  - `semgrep`: inyecta en `security-invariants`.
  - `gh`: `recommendedAgent: publisher`.
  - `acli`: `recommendedAgent: scout`.
- **Skills** (catálogo en `harness-assets.ts:35-49`):
  - `debug-failure.md` — R30.
  - `locate-code.md` — R18.
  - `security-invariants.md` — R33.
  - `follow-up-prs.md` — R37.
  - `resolve-ticket.md` — R34.
  - Reescritura de `verify-before-done.md` (R31), `review-diff.md` (R32), `spec-bootstrap.md`
    (R35) y `solution-design.md` (R36).
  - `commands/doctor.ts:1421` (`id: "structural-search"` en `scanMissingOptionalTools`).
  - `presets/express-mongoose.json:44` (invariante `"ticket-intake"`).

  — R29.
- **Registros y limpieza:**
  - `RETIRED_AGENTS` (nuevo); `RETIRED_SKILLS` y `RETIRED_HOOKS` con `{ id, successor, markerId }`
    — R38.
  - Reconciliación en §8.7b y §8.7c de `engines/claude/index.ts` y en los orphan scans de Codex,
    con reporte de lo conservado mediante `KeepReason` (`lib/removable.ts:157-166`) — R39, R41.
  - Error de claves retiradas en `lib/config.ts`, impreso por `lib/cli-config.ts:13` — R40.
  - `lib/health.ts` y `commands/doctor.ts` — R41.
- **Catálogos:** `CORE_AGENTS`, `CORE_SKILLS`, `AGENT_ROLE_KEYS` (`lib/config.ts:24`),
  `AGENT_ROLES` (`lib/plugins.ts:12`), `CANONICAL_HARNESS_KEY` y `LEGACY_AGENT_ALIASES`
  (`lib/legacy-agents.ts:13-34`), `RECOMMENDED_MODELS` y `RECOMMENDED_EFFORT`
  (`lib/recommended.ts:83`, `:103`), `agentsIndex.when` (`lib/i18n.ts:2224`, `:3355`) — R42.
- **Continuidad de medición:** `lib/audit/signals.ts:18` (`READ_ONLY_AGENTS`),
  `scripts/mine-activation.py` y los mineros que leen nombres de hook — R43.
- **Nombres muertos:** `lib/__tests__/retired-names.test.ts` (nuevo) — R44.

### E2 · Canales de `publisher`

- `agents/publisher.md` — contrato de comentarios — R45.
- `packages/plugins/acli/` y `packages/plugins/gh/` — sub-bloque en `publisher.md` — R46.

### F · Architect

- `agents/architect.md` (nuevo, ≤ 400 palabras), catálogo canónico, i18n, schema, recomendados e
  inyección de `codegraph` — R47, R48, R51.
- `managed/orquestacion.md` (ramas `navori:if architect` / `navori:if-not architect`),
  `skills/solution-design.md` — R49, R50.
- `specs/0012-solutioning/design.md` — nota de enmienda.

## Decisions

### Nombres

| Rol o skill | Nombre | Por qué |
|---|---|---|
| Rol encarnado | `orchestrator` | Ya es el nombre del bloque managed y del owner del log de audit |
| Lector aislado o paralelo | `scout` | Dice "reconocimiento", su criterio frente a `auditor`; `explorer` choca con Codex y `Explore` |
| Análisis con veredicto | `auditor` | Los tres encargos (área, ticket, diseño) verifican afirmaciones contra evidencia |
| Publicación | `publisher` | Todo lo que hace sale del workspace; `operator` ya es "el humano" |
| Diseño | `architect` | Sin colisión en los engines; Claude trae un subagente `Plan` para investigar en plan mode, así que su `description` dice "qué construir y por qué" |
| Skill de debug | `debug-failure` | `debug` reemplazaría el `/debug` integrado |
| Ubicar código | `locate-code` | Lo que la skill hace según su propia `description` |
| Seguridad | `security-invariants` | Invariantes de negocio que un escáner no infiere, más una lista de respaldo para cuando no hay escáner |
| Seguimiento de PRs | `follow-up-prs` | Sin metáfora |
| Tickets | `resolve-ticket` | Cubre del ticket a su cierre, incluido cerrar sin PR |

**Se quedan:**
- **`spec-bootstrap`:** la skill más invocada por nombre (19).
- **`solution-design`, `review-diff` y `verify-before-done`:** sus nombres ya dicen lo que hacen y
  no chocan.
- **`dominio`:** es el nombre de `navori dominio`.
- **Prefijos de handoff:** nombran artefactos, no agentes.

### `navori receipt` como subcomando

- **Elegido:** subcomando de la CLI en TypeScript con vitest.
- **Descartado, script distribuido:** Codex no emite `.codex/scripts/`
  (`engines/codex/compat.ts:24-32`, #428), y la lógica en shell mantiene viva la clase de bugs de
  #344.
- **Precedente:** `hooks/audit-mode-trigger.sh:103` ya ejecuta `navori audit --start`, y
  `settings-base.json:74-79` preaprueba subcomandos de navori. El invariante 9 ("navori genera, no
  ejecuta") habla de las herramientas del proyecto; `receipt` es soporte del harness.
- **Git inerte y paralelo-seguro (R1).** Tomado de `scripts/change-scope.ts` de deepseek-harness:
  - `-z`, `--no-ext-diff`, `--no-textconv` y `--no-renames`.
  - `-c core.fsmonitor=false` y `GIT_OPTIONAL_LOCKS=0`.
  - Sin detección de renombres, el borrado de la ruta vieja de un `git mv` sí se firma, un hueco
    latente del shell actual (`agents/reviewer.md:99`).
- **Contra el remoto (R1, R4).** Siempre contra `origin/<target>` tras `git fetch`, como el shell
  de hoy. Contra una rama local vieja, "rama detrás" no vería que el remoto avanzó, la clase de bug
  de #771, #785 y #793.
- **Evidencia positiva, no código de salida (R7).** En el build de #485, citty respondía a un
  subcomando desconocido con la ayuda y código 0 (`scripts/check-asset-commands.mjs:15-17`).
- **Target visible (R2).** deepseek-harness se niega a inferir el base (*"The command never
  guesses or fetches a base"*), porque en un PR apilado el base no es la rama principal. navori
  conserva el default por config, pero el JSON expone target y SHA para que un base equivocado
  sea visible, y `publisher` pasa el base real del PR cuando no coincide con `prTarget`.
- **Formato de `receipt.txt` sin cambios.** Una ruta con salto de línea no cabe en él y da
  `ERROR` (R3); la limpieza sigue inline (`rm -f`).

### Borrador previo por hook

- **Elegido:** `PreToolUse(Bash)` con `ask` y el texto del comentario en la razón. Garantiza las
  dos mitades:
  - Clic humano: el `ask` de hook fuerza el prompt en modo auto.
  - Contenido visible: la razón se le muestra al usuario.

  Aplica a cualquier agente, incluido el orquestador, y se registra siempre.
- **Descartado, `ask` en permisos:** con `--body-file`, el prompt no muestra el contenido.
- **Descartado, handoff de dos pasos:** `tools:` no limita subcomandos de Bash, y un subagente no
  puede preguntar al usuario.
- **Solo se renderiza el cuerpo en archivo (R11).** El parser de hooks
  (`hooks/_partials/gate-trigger.sh:83-88`) no respeta comillas, así que un `--body "…"` en línea
  se mostraría truncado. En línea ya aparece entero en el comando del prompt, y R45 obliga a
  `publisher` a usar archivo.
  - **`gh api`:** `-F clave=@archivo` lee el valor de un archivo (`gh api --help`), así que cuenta
    como cuerpo en archivo.
  - **`gh api graphql`:** se detecta por las mutaciones de comentario o review en el cuerpo de la
    llamada.
- **Sin `jq` no se calla (R12).** `pr-pilot-confirm.sh:117` sale en silencio sin `jq`. Este hook
  intenta `jq`, luego `node` (como `extract-cmd.sh:22-28`), y si falta todo emite un `ask` con
  razón fija escrita con `printf`.
- **Ruta rápida sin forks:** para comandos que no pueden contener un comentario (ECC mide unos
  50–100 ms por proceso evitado; es cifra declarada, no benchmark).
- **Codex (R13).**
  - `placeHook` no transforma (`engines/codex/index.ts:254-261`), así que el hook decide por `$0`.
  - `ask` fallaría abierto, así que devuelve `deny`.
  - Codex salta todo hook nuevo o cambiado hasta que el usuario lo confía en `/hooks`, lo que
    agrega un paso al reset.

### Búsqueda: medir D19 antes de cualquier guard

- **Por qué no se restaura el guard.** `search-v2.md` es la decisión vigente:
  - D02: *"No recuperar wrappers, hooks, tests ni protocolos de la integración retirada"*.
  - M03: el plugin `tgrep` no lleva hooks ni scripts (lo fija `search-v2-manifests.test.ts`).
  - D19 pre-registró que v2 sube la adopción sin guard y que D11 solo se reabre si falla el umbral
    tras dos semanas.

  #838 entró hace horas; no hay datos que justifiquen reabrirlo, y hacerlo sería exactamente "por
  intuición".
- **Lo que sí hace G:** que la medición pueda correr y que los flujos no contradigan el ruteo.
  - **Dogfood de navori-harness (R14):** hoy no tiene los plugins habilitados.
  - **Minero (R15):** hoy cuenta solo el wrapper v1.
  - **Assets (R16):** dejan de recetar `grep` por shell.
  - **Agentes (R17):** reciben `codegraph_explore`.
  - **`locate-code` (R18):** delega los carriles.
- **Siguiente paso escrito si D19 falla.** Una spec nueva restaura el guard de v1 adaptado a
  `tgrep search`, con sus heurísticas medidas:
  - Segmentar respetando comillas.
  - Detectar archivos nombrados.
  - Pelar `VAR=value`.
  - Fallar abierto ante heredoc o comandos de más de 20,000 caracteres.
  - Nunca bloquear pipes ni extracciones.

  Fuentes: `docs/research/tgrep-como-funcionaba.md` §4 y
  `git show 7c6930dc^:packages/plugins/tgrep/scripts/guard-search-routing.sh`.
- **Recetas de shell (R16).** La prueba prohíbe `grep -r`, `rg` y `git grep` como método de
  descubrimiento, no como texto: la advertencia de seguridad de `managed/operaciones-seguras.md:7`
  (*"`rg` is NOT (`rg --pre <cmd>` runs arbitrary code)"*) se conserva.

### codegraph por rol; `scout` para aislar o paralelizar

| Agente | Acceso a `codegraph_explore` | Por qué |
|---|---|---|
| `scout` | Nombre exacto en su asset | Decisión #761: los agentes de lectura reciben tools MCP por nombre exacto, porque la inyección ensancha a la familia |
| `orchestrator`, `implementer`, `reviewer`, `auditor` | Inyección de `codegraph-access-v2` | Mecanismo actual de `leader`, `implementer`, `reviewer` y `auditor` |
| `architect` (F) | Inyección | Necesita "qué ya existe" antes de proponer |
| `publisher` | Ninguno | Redacta desde artefactos de handoff |

El README de codegraph advierte que la herramienta *"only helps when queried directly"*:
- **Pregunta estructural que una llamada contesta:** la consulta directo quien la necesita. Es la
  regla que el playbook ya tiene (`agents/leader.md:73`: *"Don't delegate merely to wrap a
  lookup"*).
- **`scout` queda para** sub-preguntas independientes en paralelo o lecturas que conviene aislar
  del contexto de quien coordina (R22).

### `debug-failure`

| Fuente | Qué aporta |
|---|---|
| `debug-error` | Ver el error sin filtrar (`2>/dev/null` y `\| tail` esconden la línea que importa); clasificar el tipo |
| `systematic-debug` (personal) | Reproducción antes del fix; instrumentación por capa cuando cruza componentes |
| `loop-back-debug` | Tras un fix fallido, releer el síntoma y replantear la hipótesis |

- **Escalamiento según quién corre la skill:** desde un subagente, `BLOCKED` en el handoff; desde
  el agente principal, preguntar al usuario.
- **Lo que no entra:** las tablas "claim → evidencia", que ya viven en `verify-before-done`.
- **La skill personal se borra** en el reset.

### Dueños de las checklists

| Checklist | Dueño único | Quién remite |
|---|---|---|
| Revisión de código, con prueba de tres partes para HIGH o CRITICAL (ECC `code-reviewer.md`) | `review-diff` | `reviewer.md` (#844 ya quitó su resumen) |
| Seguridad: invariantes de negocio más una lista de respaldo sin escáner (los 8 patrones de ECC) | `security-invariants`, con la inyección de `semgrep` | `review-diff` §4, `auditor.md` |
| Dimensiones de diseño | `solution-design` | `spec-bootstrap` |
| Evidencia de "hecho" y atribución de errores | `verify-before-done` | `implementer.md` |

**Por qué `security-invariants` guarda también patrones de escáner.** Hoy `security-guidance`
los excluye porque *"are already covered by semgrep"* (`skills/security-guidance.md:11`), pero
`semgrep` es un plugin opcional. La lista va en una sección condicionada a que no haya escáner,
para que el nombre siga describiendo el contenido principal. El tope compuesto con la inyección de
`semgrep` (`skill-caps-composed.test.ts`) se vuelve a medir.

### Línea base por atribución de archivo, no por worktree ni stash

- **Elegido (R31):** los errores del gate se atribuyen por archivo.
  - Los de archivos del conjunto a publicar cuentan como introducidos.
  - Los demás se listan como previos, advirtiendo que un cambio de tipos puede causarlos.
  - Sin ubicación por archivo, la línea base se declara no medida.

  No toca el árbol ni el stash compartidos, no pide permisos y no cuesta una segunda corrida del
  gate.
- **Descartado, worktree desprendido:** sin `node_modules`, el gate no corre en ningún repo JS o TS
  del parque, y `git worktree add` no está preaprobado. Cambiaría una medición riesgosa por
  ninguna.
- **Descartado, `git stash push -u` con `apply <sha>`:** protege el stash, pero vacía el árbol
  mientras otro agente lo lee.
- **Límite aceptado:** un error nuevo en un archivo no tocado, causado por un cambio de tipos, se
  lista como previo con advertencia. El `reviewer` decide.

### `resolve-ticket`

- **De 8 fases a 6.**
  - EXPLORE deja de ser fase: `scout` se usa a demanda.
  - VERIFY vive en implementar.
- **Auditoría condicionada** a los disparadores de la tabla de orquestación.
- **Comentario de tracker solo a pedido.** Un borrador por ticket sería un prompt en cada ciclo.

### `spec-bootstrap` con challenge en áreas críticas

Los dos challenges de esta misma spec encontraron bloqueos verificados en el código (3 y 2). Se
exige solo cuando la spec toca `project.criticalAreas`, en una ronda y sin veredicto del
`auditor`.

### Config: error explícito, y es intencional que bloquee

- **Qué pasa:** con claves retiradas, `readConfig` falla en todos los comandos (`configure`,
  `update`, `sync`, `doctor`, `status`).
- **Por qué es intencional:** la corrección es editar el JSON, y el mensaje trae todo lo necesario:
  cada clave, su reemplazo y, cuando dos claves van al mismo reemplazo con valores distintos
  (21 de 28 configs traen `researcher` y `explorer` con valores diferentes), los dos valores para
  que el usuario elija.
- **Recomendados de las claves nuevas:**
  - `orchestrator` hereda los de `leader`.
  - `scout`, los de `researcher` (carga el 98% del uso medido).
  - `auditor` conserva los suyos.
  - `publisher` hereda los de `commitPrPilot`.
- **Ojo con `effort.orchestrator`:** alimenta `effortLevel` de la sesión
  (`build-settings.ts:93-101`); el mensaje lo señala.

### `architect`: enmienda a la spec 0012

| Razón de 0012 (`design.md:14-17`) | Qué cambió |
|---|---|
| Costo: `CORE_AGENTS` + tres schemas + i18n + paridad Codex "sin implementar" | La paridad de Codex existe (spec 0004), y esta spec construye el catálogo canónico (R42) |
| "Compite con el orquestador, que ya posee la síntesis" | `architect` redacta la propuesta; el veredicto y la descomposición siguen en el orquestador (R48). En 0012, el orquestador redacta y juzga su propio diseño |

**Razones nuevas:**
- **Tier:** `models.leader` no controla el modelo de la sesión (`build-settings.ts:93-98`).
- **Contexto:** diseñar lee mucho código.

**Tamaño:** ≤ 400 palabras que remiten a `solution-design`. La referencia es `code-architect.md`
de ECC, con 366 palabras; se rechaza su sección "Build Sequence".

**Lo que no cambió:** el paso de diseño se usa poco, y esta spec no espera que `architect` lo
active más. Por eso lo decide el criterio 2. El tier por default es `opus` / `high`.

### Tier de `publisher`

Hereda `haiku` / `low` (`lib/recommended.ts:91`, `:112`). Todo borrador pasa por el usuario (R10)
y el contenido técnico sale de artefactos existentes (R45). Si no alcanza, se sube por config.

### Lecciones de ECC y deepseek-harness

Revisadas contra el repo oficial: ECC en `8321021` y deepseek-harness en `0d1f500`. El orden es
calidad, tokens y velocidad. Las fuentes están en [`references.md`](./references.md) §7.

| Lección | Origen | Veredicto | Dónde |
|---|---|---|---|
| Conjunto a publicar por script: NUL, sin drivers, sin locks, refs resueltas en el JSON | dsh `scripts/change-scope.ts` | ADAPT, calidad | R1, R2, R3 |
| Techo de palabras que también falla si el asset no existe; relocate → condense → raise | dsh `scripts/verify-doc-budgets.ts` | ADAPT, tokens | R31, R51 |
| Barrido que revisa rutas, normaliza, no se atrapa a sí mismo y falla con corpus angosto | dsh `scripts/verify-concrete-terms.ts` | ADAPT, calidad | R44 |
| Cada prueba de paridad o barrido rechaza un caso inválido sembrado | dsh `AGENTS.md` | ADAPT, calidad | Tareas de R42 y R44 |
| HIGH o CRITICAL solo con `file:line`, escenario de falla y brecha de guard; cero hallazgos es válido | ECC `agents/code-reviewer.md` | ADAPT, calidad | R32 |
| Lista compacta de 8 patrones de seguridad | ECC `agents/code-reviewer.md` | ADAPT, calidad a bajo costo | R33 |
| Arquitecto corto que remite al método | ECC `agents/code-architect.md` | ADAPT, tokens | R51 |
| Cada id retirado nombra a su sucesor | ECC `docs/legacy-artifact-inventory.md` | ADAPT, calidad | R38, R41 |
| Control positivo de cada medición que decide un criterio | ECC issue #2463 | ADAPT, calidad | R52 |
| Renombrar sin aliases; el config viejo falla claro | dsh ledger de renombres | ALREADY | R39, R40 |

**Descartadas:**
- **Solo la evidencia más angosta, y la suite completa para CI** (dsh). Choca con R32: calidad
  primero.
- **Activar agentes por prosa y comentar en Jira en cada paso** (ECC). Sin evidencia; ECC documenta
  tareas zombi (#2471).
- **Arquitecto que descompone en tareas** (ECC). Choca con R48.
- **Un despachador único de hooks de Bash** (ECC). Es un cambio de arquitectura de hooks.
- **Prefijo `dsh-` en skills.** No hay razón escrita; R29 usa la tabla de colisiones.
- **`verification-loop`, `planner`, `build-error-resolver` y `security-review`** (ECC). Filtran la
  salida con `| tail`, chocan con `Plan`, o son tokens de más.

**Colisión externa de `architect`:** si se instala ECC a mano, su `~/.claude/agents/architect.md`
tiene más precedencia que el agente de plugin del harness global. En esta máquina ese directorio
está vacío; dentro de un repo con navori, `.claude/agents/` gana. Se acepta y se documenta.

### Fuentes

Cada afirmación sobre herramientas externas sale de su documentación oficial o del binario
instalado: [`references.md`](./references.md).
- §1: URLs, sección y cita literal.
- §5: comandos de medición.
- §7: ECC y deepseek-harness.

## Contracts

### `navori receipt`

```text
navori receipt sign  --feature <id> [--target <ref>] [--dir <path>]
navori receipt check --feature <id> [--target <ref>] [--dir <path>] [--json]
```

| Código | Significado |
|---|---|
| 0 | Sin hallazgos (`sign`: receipt escrito) |
| 2 | Al menos un `UNCOVERED` o `DRIFT` |
| 1 | `ERROR`: git falla, rama detrás de `origin/<target>`, receipt ausente, archivo no hasheable, ruta no representable |

**`check --json`:**
`{ "formatVersion": 1, "target": string, "targetSha": string, "headSha": string, "status": "ok" | "findings" | "error", "uncovered": string[], "drift": [{ "path": string, "blob": string | null, "kind": "changed" | "missing" | "reappeared" }], "error": string | null }`.

### Hook `comment-draft-confirm`

| Comando | Cuerpo que se renderiza |
|---|---|
| `gh pr comment`, `gh issue comment` (incluido `--edit-last`) | `--body-file` / `-F` |
| `gh pr review` con `-c`, `-a` o `-r` y cuerpo | `--body-file` / `-F` |
| `gh api` con `-X`/`--method` `POST\|PATCH\|PUT`, o con `-f`, `-F` o `--input`, sobre una ruta con `/comments` o `/reviews` | `--input <archivo>` o `-F clave=@archivo` |
| `gh api graphql` con mutación `addComment`, `addDiscussionComment`, `addPullRequestReview`, `addPullRequestReviewComment`, `addPullRequestReviewThread` o `addPullRequestReviewThreadReply` (nombres del schema de GitHub, verificados por introspección) | `-F query=@archivo` o `--input` |
| `acli jira workitem comment create` (incluidos `--jql` y `--filter`) | `--body-file` / `-F` (texto o ADF) |
| `acli jira workitem comment update` | `--body-adf` (ADF) o `--body-file` / `-F` (texto) |

- **Sin cuerpo en el comando** (`--editor`, `--web`, `-F -`): aplica R12.
- **Ruta rápida:** si el comando no puede contener un comentario, sale sin forks ni registro.

### Registros de retirados

```ts
type Retired = {
  readonly id: string;
  readonly successor: string | null;
  readonly markerId: string; // el que navori estampó: "<id>-base" en agentes y skills core, el id pelado en workflow, preset y plugin
};
export const RETIRED_AGENTS: ReadonlyArray<Retired & { readonly harnessKey: string }>;
export const RETIRED_SKILLS: ReadonlyArray<Retired>; // existente: pasa de string a Retired
export const RETIRED_HOOKS: ReadonlyArray<Retired>;  // existente: ídem
```

**Por qué `markerId`:** §8.7b llama `planFlatSkillRemoval(cwd, id, id)` con el id pelado
(`engines/claude/index.ts:1120`). Las skills core llevan `id="debug-error-base"`
(`.claude/skills/debug-error/SKILL.md`), y `openingTagFor` busca la coincidencia exacta
(`lib/removable.ts:141`). Sin el marcador registrado, cuatro de las seis skills retiradas quedarían
como ajenas y se conservarían en silencio.

## Failure modes

| Falla | Comportamiento |
|---|---|
| Config con claves retiradas | `ConfigError` con cada reemplazo y los valores en conflicto; ningún comando continúa hasta editar el JSON (R40) |
| Archivo retirado ajeno, más nuevo o con otro marcador | Se conserva y se reporta con su motivo (R39, R41) |
| Codex con preset que no carga | Sus orphan scans no corren (`engines/codex/index.ts:124-126`); `doctor` sigue listando los retirados (R41) |
| Contenido de usuario en una skill retirada | Se recupera desde git o desde el backup del render, en el paso 3 del reset |
| `navori` ausente o viejo al firmar o verificar | Sin `"status": "ok"` no se publica (R7) |
| Sin `jq` ni `node` en el hook de comentarios | `ask` con razón fija (R12) |
| Hook nuevo en Codex sin confiar | Codex lo salta hasta confiarlo en `/hooks`; paso 5 del reset |
| Comentario desde Codex | `deny`; lo publica el usuario (R13) |
| Error del gate en un archivo no tocado, causado por el diff | Se lista como previo con advertencia; el `reviewer` decide (R31) |

## Reset del parque

**Una vez por máquina, antes de los repos:**

1. Actualizar la CLI.
2. **Solo si existe harness global** (`~/.navori/global.json`):
   1. Respaldar primero, porque `navori global uninstall` borra sin backup:
      ```bash
      cp ~/.navori/global.json ~/.navori/global.json.bak
      cp -R ~/.claude/skills/navori ~/.claude/skills/navori.bak
      ```
   2. `navori global uninstall`.
   3. `navori global init --apply`.
3. Borrar `~/.claude/skills/systematic-debug/`.

**En cada repo:**

1. `navori render --apply`. Si falla por claves retiradas (R40), editar `navori.config.json` según
   el mensaje y repetir. El render borra los archivos retirados de navori (R39).
2. Habilitar la búsqueda donde falte: `navori add codegraph`, `navori add tgrep` y
   `codegraph init`.
3. Recuperar el contenido de usuario de las skills renombradas o fusionadas (solo
   `navori-dashboard-template`, `alertaciudadana_backend` y `alertaciudadana_app`):
   - Si el render no se commiteó: `git show HEAD:.claude/skills/debug-error/SKILL.md`.
   - Si ya se commiteó: el commit anterior.
   - En repos `/bonum`, donde `.claude/` es gitignored: el backup del render en
     `~/.navori/backups/`.
4. `navori doctor`, que debe reportar 0 retirados (R41).
5. En repos con Codex: abrir Codex y confiar los hooks nuevos o cambiados con `/hooks`.

## Testing strategy

| Riesgo | Prueba |
|---|---|
| `receipt` calcula otro conjunto que el firmado (#202, #785) | `receipt.test.ts`: nuevos, borrados, renombrados (ruta vieja como `deleted`), no rastreados, espacios y no ASCII, progreso excluido, `diff.external` configurado |
| `ERROR` leído como `DRIFT` (#344) | `receipt.test.ts`: git fuera de `PATH`, archivo ilegible, receipt ausente, ruta con salto de línea → código 1 sin `DRIFT` |
| Rama vieja firma borrados fantasma (#771, #793) | `receipt.test.ts`: rama detrás de `origin/<target>` → código 1 |
| Un asset avanza sin evidencia positiva (#485) | `receipt-wiring.test.ts` |
| Comentario sin prompt o con borrador distinto | `comment-draft-confirm.test.ts`: cada fila del contrato (incluidos `-F body=@archivo` y `graphql`), cuerpo en línea con `;`/`\|`/saltos, ADF, archivo ilegible, sin `jq` ni `node`, más de 1,500 caracteres, instalado en `.codex/hooks/`, comando ajeno |
| D19 no se puede medir | `search-v2-manifests.test.ts` y config del repo con ambos plugins; fixture de `mine-search-routing.py` con `tgrep search` y `codegraph_explore` que cuenta distinto de cero |
| Un asset receta búsqueda por shell | `search-v2-policy.test.ts`: ningún asset distribuido receta `grep -r`, `rg` o `git grep` para descubrir; la advertencia de `operaciones-seguras` pasa |
| Un agente del roster sin `codegraph_explore`, o con `Agent` | `mcp-capability-wiring.test.ts` y `agents-assets.test.ts` |
| Skills core retiradas conservadas por marcador (hallazgo B1 del challenge v2) | `retired-assets.test.ts` con fixtures `id="<id>-base"` para agentes y skills core, e id pelado para `babysit-prs` y `ticket-intake` |
| Lo conservado no se reporta | `retired-assets.test.ts`: ajeno, más nuevo y otro marcador → conservado con motivo en la salida de `render` |
| Config viejo aceptado en silencio | `config.test.ts`: `ConfigError` nombra cada clave, su reemplazo y los dos valores en conflicto |
| Catálogos divergen | `roster-parity.test.ts`, con lista divergente sembrada |
| Nombres muertos en contenido o rutas | `retired-names.test.ts`, con violación sembrada en contenido y en ruta, guarda de áreas y JSON de presets |
| Revisor que inventa hallazgos | `protocol-coherence.test.ts`: `review-diff` exige la prueba de tres partes y acepta cero hallazgos |
| Checklist duplicada | `protocol-coherence.test.ts`: cobertura de entry points solo en `security-invariants`; dimensiones de diseño solo en `solution-design` |
| Doctrina contradictoria o receta de stash de vuelta | `protocol-coherence.test.ts` |
| Asset que crece sin control | `agents-assets.test.ts` (R51), `skill-caps.test.ts` (`verify-before-done` en 600) y `skill-caps-composed.test.ts` (`security-invariants` con `semgrep`) |
| Bloque de orquestación rebasa su techo | `session-start-budget.test.ts` (hoy 6,324 de 6,500) |
| Un criterio se decide con un minero roto (ECC #2463) | Fixtures de R52 |

## Criterios pre-registrados

Se escriben antes de implementar y no se mueven después de ver los datos.

1. **Reset.** Tras el procedimiento, `navori doctor` reporta 0 retirados en cada repo, o cada resto
   aparece conservado con motivo (R39). Cualquier otro caso es un bug del release.
2. **`architect`.** A los 60 días del release de F, contando `subagent_type` en los transcripts:
   - 0 invocaciones → se retira por `RETIRED_AGENTS`.
   - Más de la mitad de los ciclos que llegan a `implementer` → el disparador es demasiado amplio
     y se abre un issue.
3. **Comentarios.** En Claude Code, cada comando de la tabla del hook presente en el log de audit
   tiene un veredicto del hook, y un comentario sin veredicto es un bug. En Codex el criterio aplica
   solo a hooks ya confiados.
4. **Búsqueda.** Es el de `search-v2.md` D19, no uno nuevo: ≥ 25% de búsquedas reales por
   `tgrep search` o `codegraph_explore`, tras dos semanas de dogfood en navori-harness contadas
   desde que R14 y R15 están en `main`. Si falla, la spec del guard (ver "Búsqueda: medir D19
   antes de cualquier guard") es el siguiente paso.

## Veredicto

**CONCERNS**, tras dos challenges en contexto fresco:

| Revisión | Hallazgos | Qué cambió |
|---|---|---|
| v1 (`.claude/progress/solution_review_0026.md`) | 3 BLOCKER, 12 CONCERN, 10 NOTE | La migración se reemplazó por reset |
| v2 (`.claude/progress/solution_review_0026_v2.md`) | 2 BLOCKER, 15 CONCERN, 10 NOTE | B1: `markerId` en los registros. B2: el guard de búsqueda sale y queda condicionado a D19. Además: config con valores en conflicto, reset global con `--apply` y backup, reporte de lo conservado, confianza de hooks en Codex, `gh api` con `@archivo` y `graphql`, `architect` movido a F, `security-invariants` con lista de respaldo, base actualizada a `5a0bbc34`, línea base por atribución de archivo, target contra `origin/`, recetas de shell completas, tests y docs que faltaban |

Riesgos abiertos, registrados y sin bloquear:
- La enmienda a 0012 y el challenge obligatorio en `spec-bootstrap` agregan delegación por
  decisión del usuario; el criterio 2 mide `architect`.
- En Codex, "borrador primero" se cumple negando y exige confiar el hook.
- La línea base por atribución puede listar como previo un error causado en otro archivo.
- El hook de comentarios no ve herramientas MCP, `curl` directo ni comandos envueltos en `sh -c`.

## NOT in scope

- **Slack.** Plugin propio en otra spec.
- **Transiciones de Jira y escrituras que no son comentarios.**
- **Herramientas MCP de comentarios y `curl` o `wget` directo a la REST** de Jira o GitHub.
- **Restaurar el guard de búsqueda.** Condicionado a D19.
- **Implementar la spec 0023 o endurecer `pr-publisher-confirm` con `agent_type`.**
- **Un despachador único de hooks de Bash.**
- **Skills de presets, librerías y plugins de stack**, salvo lo que barre R44.
- **Memorias de engram y documentos de `docs/research/`** con nombres viejos: son registros
  históricos.
- **Cursor, Copilot y AGENTS.md universal:** solo renderizan el catálogo, que se reconstruye.
