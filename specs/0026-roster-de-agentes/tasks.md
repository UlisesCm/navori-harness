# Roster de agentes y skills — Tasks

**Status:** proposed · **Requirements:** [`requirements.md`](./requirements.md) · **Design:**
[`design.md`](./design.md) · **Referencias:** [`references.md`](./references.md) · **Base:**
`fbd4450f` (revalidar contra `origin/main`, incluido #854 `7da709df`, antes de ejecutar)

Un PR por fase, en el orden de `design.md` (Approach): B, E1 y G antes de R; R en un release
seguido del reset del parque; E2 y F después. Antes de implementar cada fase, se sincroniza la
rama con `origin/main` y se re-verifican las anclas `file:line` que cita su tarea.

Cada PR cierra con `pnpm check` verde. Si cambia lo renderizado, el golden se regenera con
`pnpm --filter navori test:golden` y se revisa a mano, y el espejo del repo se actualiza con
`navori render --apply`. Salvo que se indique, las rutas de prueba cuelgan de
`packages/cli/src/`.

## Fase B · `navori receipt` (PR 1)

- [ ] **T1** (R1, R3, R4) — Cálculo del conjunto a publicar y `sign`.
  - **`lib/receipt.ts`:**
    - `git fetch origin <target>`.
    - `git diff --name-only --no-renames -z --no-ext-diff --no-textconv origin/<target>`.
    - `git ls-files --others --exclude-standard -z`.
    - Git corre con `-c core.fsmonitor=false`, `-c core.quotepath=false` y
      `GIT_OPTIONAL_LOCKS=0`.
  - **`commands/receipt.ts`:** registrado en `index.ts`, con su `CommandDoc` es y en en
    `apps/website/src/content/commands.ts`.
  - **Formato de `receipt.txt`:** idéntico al actual; `lstat` acepta solo regular. Tipos no
    soportados, incluidos symlink válido/roto, cambio a symlink y gitlink, fallan `ERROR` sin
    dereferenciar ni convertir a `deleted`; un `sign` fallido preserva el receipt anterior.

  · test: `lib/__tests__/receipt.test.ts::sign`, con estos casos:
  - Archivos nuevos, borrados y renombrados (la ruta vieja queda como `deleted`).
  - No rastreados.
  - Rutas con espacios y no ASCII.
  - Progreso excluido.
  - Default `prTarget` y luego `branchBase`.
  - Rama detrás de `origin/<target>` → 1 sin receipt.
  - git fuera de `PATH` → 1.
  - Ruta con salto de línea → 1.
  - Un `diff.external` configurado no altera el conjunto.
  - Symlink válido/roto, cambio de regular a symlink, gitlink y diff solo de modo → 1/`ERROR`,
    sin `DRIFT` ni receipt mutado.

  Además, `__tests__/command-docs-inventory.test.ts`, con `// Covers: R1, R3, R4`
- [ ] **T2** (R2, R3, R5) — `sign --json` y `check --json` comparten schema (`formatVersion`,
  target, SHA nullable en error temprano, `status`, findings y `error`) y `check` conserva salida de
  texto y códigos 0, 2 y 1. · test: `lib/__tests__/receipt.test.ts::sign and check json`, con éxito y
  error temprano (SHA nullable y `error`), y `::check`, con estos casos:
  - Sin cambios → 0 y `"status": "ok"` con los campos del contrato.
  - Modificado, desaparecido o borrado que vuelve → 2 con `DRIFT` y su `kind`.
  - Fuera del receipt → 2 con `UNCOVERED`.
  - Receipt ausente, archivo ilegible o diff solo de modo → 1 sin `DRIFT`, preservando receipt.
  - El comando de inspección impreso produce el diff.

  con `// Covers: R2, R3, R5`
- [ ] **T3** (R6, R7, R8, R9) — `agents/reviewer.md` y `agents/commit-pr-pilot.md` invocan
  `navori receipt sign|check --feature <feature> --target {{prTarget}} --dir .claude/progress --json`,
  donde `<feature>` es el id recibido en el handoff de implementer/reviewer, y conservan solo el
  juicio:
  - Firmar solo en `APPROVED`.
  - Rutear un `DRIFT` explicado a delta re-sign y uno inexplicado a revisión completa.
  - Continuar solo con `"status": "ok"`.
  - Pasar el base real del PR cuando no coincide con `prTarget`.

  Además:
  - La fila de PR de `skills/verify-before-done.md:57` exige `navori receipt check` con
    `"status": "ok"`.
  - `settings/settings-base.json` suma `Bash(navori receipt:*)`.
  - Se reescriben `lib/__tests__/receipt-wiring.test.ts`,
    `lib/__tests__/commit-pr-pilot-contract.test.ts` y el caso F9 de
    `lib/__tests__/protocol-coherence.test.ts`.
  - Se retira `lib/__tests__/commit-pr-pilot-drift-loop.test.ts`.

  · test:
  `lib/__tests__/receipt-wiring.test.ts::assets invoke navori receipt with --json, gate on status ok and carry no receipt shell`
  y `::verify-before-done PR row requires receipt check ok`, con `// Covers: R6, R7, R8, R9`

## Fase E1 · Borrador de comentarios (PR 2)

- [ ] **T4** (R10, R11, R12, R52) — `packages/core/core-assets/hooks/comment-draft-confirm.sh`:
  - Ruta rápida sin forks.
  - Detección de las filas del contrato de `design.md`, incluidos `gh api -F clave=@archivo` y
    los `add*` y `update*` de GraphQL; extrae variable/campo `body`, no el `query`.
  - Cuerpo desde archivo con la ruta en la razón; texto de nodos para ADF; truncado a 1,500
    caracteres con conteo.
  - Razón de cuerpo en línea.
  - `ask` con razón fija sin cuerpo, lectura fallida o parser ausente, sin ejecutar shell ni leer
    stdin.
  - JSON con `jq`, luego `node`, luego `printf`.
  - Registro en audit.
  - Alta sin condición en `engines/shared/harness-plan.ts` y registro en
    `engines/claude/build-settings.ts`.

  · test: `lib/__tests__/comment-draft-confirm.test.ts`, con estos casos:
  - Una fila del contrato por payload, incluidos creación y edición GraphQL, `--edit-last` y
    `acli … create --jql`.
  - Cuerpo en línea con `;`, `|` y saltos de línea.
  - ADF por `-F` y por `--body-adf`.
  - Archivo ilegible.
  - `PATH` sin `jq` ni `node`.
  - Más de 1,500 caracteres.
  - Comando ajeno sin salida.
  - Un log de audit fixture con un comentario produce un veredicto contado por la consulta del
    criterio 3.

  Además, `engines/__tests__/harness-plan-id.test.ts::comment-draft-confirm is planned without plugin conditions`
  y `lib/__tests__/hook-claims-vs-scripts.test.ts`, con `// Covers: R10, R11, R12, R52`
- [ ] **T5** (R10, R13) — Registro en `engines/codex/build-config-toml.ts`; el hook decide por `$0`
  y bajo `.codex/hooks/` devuelve `deny`: nombra archivo solo si existe, para inline/stdin indica
  que no existe y entrega el comando. El fallback `deny` aplica aun sin `jq`/`node`; se prueban
  Claude `ask` (auto >=2.1.211) y Codex como render/registro vs capa+hash confiados, sin simular
  una garantía que el host no expone. · test:
  `lib/__tests__/comment-draft-confirm.test.ts::installed under .codex/hooks it denies with draft path and command`
  y `engines/codex/__tests__/render-codex.test.ts::registers comment-draft-confirm as PreToolUse`
  con `// Covers: R10, R13`

## Fase G · tgrep y codegraph (PR 3)

- [x] **T6** (R14, R15, R52) — Medición D19.
  - **`navori.config.json` del repo:** habilita `tgrep` y `codegraph` con `navori add`; el
    espejo se re-renderiza.
  - **`scripts/mine-search-routing.py`:** cuenta `tgrep search` y `codegraph_explore` como vía v2
    y `Grep` nativo, `rg`, `grep -r` y `git grep` como escape; incluye subagents vinculados al
    transcript padre, deduplica por identidad y separa unavailable/malformed de cero. Conserva
    `tgrep-search.sh` para transcripts v1.
  - **`docs/DIRECTION.md`:** elimina la afirmación ya corregida por #852; no lista como pendiente
    que tgrep/codegraph estén retirados.

  · test: fixtures padre+hijo con `tgrep search -n -F -- foo src` y `codegraph_explore`, conteos
  exactos y negativos, malformed y unavailable, más
  `lib/__tests__/search-v2-manifests.test.ts` sin cambios (el plugin `tgrep` sigue sin hooks ni
  scripts), con `// Covers: R14, R15, R52`
- [x] **T7** (R16, R18) — Assets sin recetas de búsqueda por shell:
  - `skills/review-diff.md:36`.
  - `agents/auditor.md:57`.
  - `agents/ticket-audit.md:51-52`.
  - `agents/researcher.md:42`.
  - `skills/structural-search.md` delega los carriles textual y estructural en el proveedor
    habilitado, con `Grep` nativo y lectura manual solo como respaldo.
  - `managed/operaciones-seguras.md:7` conserva su advertencia sobre `rg --pre` dentro de su tope
    de 2,000 bytes.

  · test:
  `lib/__tests__/search-v2-policy.test.ts::no distributed asset prescribes shell search as discovery`
  (con la advertencia de `operaciones-seguras` como caso que debe pasar) y
  `::structural-search defers both lanes to the enabled provider`, con `// Covers: R16, R18`

## Fase R · Roster, skills y reset (PR 4, un release)

### Lote 1 · Registros, config y reconciliación

- [ ] **T8** (R38, R42) — Registros y catálogos.
  - **Registros de retirados:** `RETIRED_AGENTS` (nuevo) y `RETIRED_SKILLS` / `RETIRED_HOOKS` pasan
    a `{ id, successor, markerIdByAdapter }`.
    - `markerIdByAdapter` declara el marcador real por clase y adapter: agentes Claude
      `<id>-base` y Codex `<id>-codex-base`; skills/workflow conservan el suyo explícito. No se
      presupone falla del orphan scan genérico.
    - Es el id sin sufijo para `babysit-prs`, `ticket-intake`, `pr-pilot-confirm` y los retirados
      previos (`pr-create`, `precompact-session-summary`, sin sucesor).
  - **Catálogo canónico:** `engines/shared/roster.ts`. Se derivan de él o se verifican contra él
    `CORE_AGENTS`, `CORE_SKILLS`, `AGENT_ROLE_KEYS`, `AGENT_ROLES`, `CANONICAL_HARNESS_KEY`, los
    valores de `LEGACY_AGENT_ALIASES`, `RECOMMENDED_MODELS`, `RECOMMENDED_EFFORT` y las claves de
    `agentsIndex.when`.
  - **Config/golden:** actualizar el `navori.config.json` raíz y golden en este release antes del
    reset del parque. `orchestrator` hereda `leader`, `publisher` `commitPrPilot`; para `scout`,
    elegir y documentar valores concretos si `researcher`/`explorer` difieren, sin herencia muda.

  · test:
  `engines/shared/__tests__/roster-parity.test.ts::every active id list matches its canonical catalog`,
  con una lista divergente sembrada que debe rechazar, más `lib/__tests__/legacy-agents.test.ts` y
  `lib/__tests__/recommended.test.ts`, con `// Covers: R38, R42`
- [ ] **T9** (R40, R42) — `lib/config.ts`: con claves retiradas bajo `harness`, `models` o `effort`,
  `readConfig` lanza `ConfigError`. El mensaje trae una línea por clave con su reemplazo, los dos
  valores cuando dos claves van al mismo reemplazo con valores distintos, y una nota de que
  `effort.orchestrator` define el effort de la sesión. · test:
  `lib/__tests__/config.test.ts::retired agent keys fail with replacement and conflicting values`
  con `// Covers: R40, R42`
- [ ] **T10** (R39, R41) — Reconciliación.
  - **Claude y Codex:** extienden sus patrones existentes con el marcador real por adapter;
    Claude en raíz y workspaces `full`, Codex mediante su contrato de orphan scan, sin afirmar
    regresión existente.
  - **Reporte:** lo conservado se reporta con su `KeepReason` (`lib/removable.ts:157-166`) en la
    salida de `render`. Codex reporta igual en sus orphan scans.
  - **Doctor:** `lib/health.ts` y `commands/doctor.ts` listan los retirados en disco con su
    sucesor.
  - **Paridad de borrado:** las rutas nuevas se declaran en `lib/__tests__/removal-parity.test.ts`.

  · test: `engines/claude/__tests__/retired-assets.test.ts`, con estos casos:
  - Fixtures reales por adapter: Claude `id="<id>-base"`, Codex `id="<id>-codex-base"`, e id
    sin sufijo donde aplica; raíz y workspace `full` se borran con backup.
  - Ajeno, más nuevo y con otro marcador: se conservan con motivo reportado.

  Además:
  - `engines/claude/__tests__/retired-skills.test.ts` y `retired-hooks.test.ts`, con fixtures del
    marcador real.
  - `lib/__tests__/health.test.ts::reports retired files with successor`.
  - `lib/__tests__/removal-parity.test.ts`.

  con `// Covers: R39, R41`

### Lote 2 · Agentes

- [ ] **T11** (R19, R20) — `CORE_AGENTS` con los seis ids, y casos especiales del rol encarnado
  movidos a `orchestrator`:
  - `engines/claude/index.ts:239`, `:1804` y `:1813`.
  - `engines/shared/harness-plan.ts:68`.
  - `engines/claude/build-settings.ts:98-100`.
  - `engines/codex/index.ts:109` y `:329`.
  - `engines/codex/compat.ts:79-96` y `:124-130`.
  - `engines/claude/global-plugin.ts:151`.

  `settings-base.json` deniega `Agent(orchestrator)` y deja de listar `Agent(leader)`, y
  `engines/__tests__/engine-parity.test.ts` cambia `AGENT_KNOWN_DIFFS`. · test:
  `engines/shared/__tests__/roster-parity.test.ts::core roster is the six agents`,
  `engines/claude/__tests__/build-settings.test.ts::denies Agent(orchestrator) and not Agent(leader)`
  y `engines/claude/__tests__/global-plugin.test.ts`, con `// Covers: R19, R20`
- [ ] **T12** (R17, R21, R22, R23, R24, R25, R51) — Assets de agentes:
  - **`orchestrator.md`** desde `leader.md`, sin `:26-31`, `:77` ni `:169-170`.
  - **`scout.md`** con los encargos de mapa y pregunta. Su `description` lo reserva para
    sub-preguntas en paralelo o lecturas que conviene aislar, y conserva
    `mcp__codegraph__codegraph_explore` y las tools de engram por nombre exacto.
  - **`auditor.md`** con los encargos de área, ticket y challenge; su eje de seguridad carga
    `security-invariants`.
  - **`publisher.md`** desde `commit-pr-pilot.md`.
  - **Handoffs:** cada asset conserva sus cláusulas de handoff (spec 0015, R5).
  - **i18n:** `agentsIndex.when` en es y en.
  - **Plugin `codegraph`:** inyecta en `orchestrator`, `implementer`, `reviewer` y `auditor`.
  - **Techos:** cada asset declara su techo de palabras al tamaño con el que aterriza.
  - **Se borran** los cinco assets retirados.

  · test:
  - `lib/__tests__/agent-descriptions.test.ts`.
  - `lib/__tests__/handoff-contract.test.ts` y `lib/__tests__/handoff-namespaces.test.ts`.
  - `lib/__tests__/agents-assets.test.ts`, casos:
    - `::scout and auditor declare each brief with its output file`.
    - `::no subagent of the roster declares the Agent tool`.
    - `::every roster agent has a word cap, stays under it, and a missing budgeted asset fails`.
  - `lib/__tests__/mcp-capability-wiring.test.ts::codegraph reaches the reading roster and not publisher`.
  - `engines/claude/__tests__/agent-mcp-tools.test.ts`.
  - `lib/__tests__/memory-ceremony-wiring.test.ts` y `lib/__tests__/r1-lean-close-wiring.test.ts`.
  - `lib/__tests__/protocol-coherence.test.ts::orchestrator playbook has no inline-edit route and one design gate`.

  con `// Covers: R17, R21, R22, R23, R24, R25, R51`
- [ ] **T13** (R26, R27, R28) — Doctrina, hook y plugins:
  - **Orquestación:** `managed/orquestacion.md` y `lib/render-plan.ts:251-280`
    (`analyticalParallelism` → `navori:if scout`), dentro de 6,500 caracteres.
  - **Hook:** `hooks/pr-pilot-confirm.sh` pasa a `hooks/pr-publisher-confirm.sh`;
    `engines/claude/build-settings.ts:73` y `:126`, y `engines/shared/harness-plan.ts:194` leen
    `harness.publisher`.
  - **Plugins:**
    - `engram`: `skills/engram-leader.md` pasa a `skills/engram-orchestrator.md`, con una
      inyección por agente e ids de sub-bloque del agente destino.
    - `codegraph`: una inyección por agente.
    - `gh`: `recommendedAgent: publisher`.
    - `acli`: `recommendedAgent: scout`.
  - **Spec 0023:** su texto nombra `publisher.md` y `pr-publisher-confirm`.

  · test:
  - `engines/claude/__tests__/session-start-budget.test.ts`.
  - `__tests__/orquestacion-doctrina.test.ts`.
  - `lib/__tests__/pr-pilot-confirm.test.ts`, renombrado a `pr-publisher-confirm.test.ts`.
  - `lib/__tests__/plugins.test.ts::one sub-block per agent file, id and source named after its target`.

  con `// Covers: R26, R27, R28`

### Lote 3 · Skills

- [ ] **T14** (R29, R30) — Catálogo de skills.
  - **`skills/debug-failure.md`:** el ciclo de R30, fusionando `debug-error.md`,
    `loop-back-debug.md` y `~/.claude/skills/systematic-debug/SKILL.md` según la tabla de
    `design.md`.
  - **Renombres:** `structural-search` → `locate-code`, `security-guidance` →
    `security-invariants`, `babysit-prs` → `follow-up-prs`, `ticket-intake` → `resolve-ticket`.
    Las descripciones conservan "Use when…".
  - **Referencias al nombre viejo:**
    - `CORE_SKILLS`.
    - `commands/doctor.ts:1421`.
    - `presets/express-mongoose.json:44` (invariante).
    - `packages/plugins/semgrep/plugin.json:46` (`injectInto`).

  · test:
  - `engines/shared/__tests__/roster-parity.test.ts::core skills are exactly the catalog`.
  - `lib/__tests__/protocol-coherence.test.ts::debug-failure escalates through BLOCKED inside a subagent`.
  - `engines/shared/__tests__/skills-index.test.ts`, `lib/__tests__/babysit-wiring.test.ts`,
    `engines/claude/__tests__/preset-extras.test.ts` y
    `lib/__tests__/global-safe-inventory.test.ts` actualizados.

  con `// Covers: R29, R30`
- [ ] **T15** (R31, R32, R33) — Checklists con dueño único:
  - **`verify-before-done.md`:**
    - Se condensa y baja `maxWords` de 1050 a 600 en el mismo PR.
    - Atribución: archivo en diff = introducido; fuera sin baseline comparable = origen no
      determinado; no usa `git stash` ni exime el gate verde.
    - `agents/implementer.md:47` y `:81` remiten a ella.
  - **`review-diff.md`:**
    - Exige `{{qualityGate.full}}`.
    - Su §4 remite a `security-invariants`.
    - Suma la prueba de tres partes para HIGH o CRITICAL y "cero hallazgos es válido", dentro de
      `maxWords: 1200`.
  - **`security-invariants.md`:** invariantes de negocio más una sección de respaldo "si no hay
    escáner instalado" con los 8 patrones (credenciales, inyección SQL, XSS, path traversal,
    CSRF, auth bypass, dependencias vulnerables, secretos en logs) y sesión o tokens en el
    cliente.

  · test: `lib/__tests__/protocol-coherence.test.ts`, casos:
  - `::no distributed asset measures the baseline with git stash`.
  - `::review-diff and reviewer require the same gate`.
  - `::guard entry-point coverage lives only in security-invariants`.
  - `::review-diff requires file-line, failure scenario and guard gap for HIGH and CRITICAL`.

  Además:
  - `lib/__tests__/verify-before-done-asset.test.ts` y
    `lib/__tests__/review-checklist-invariants.test.ts` actualizados.
  - `lib/__tests__/skill-caps.test.ts`, con `verify-before-done` en 600.
  - `lib/__tests__/skill-caps-composed.test.ts`, con `security-invariants` y la inyección de
    `semgrep`.

  con `// Covers: R31, R32, R33`
- [ ] **T16** (R34, R35, R36, R37) — Dueños de fases:
  - **`resolve-ticket.md`:** las seis fases de R34.
  - **`spec-bootstrap.md`:** scaffolding del orquestador y challenge de `auditor` en áreas
    críticas; su plantilla de `design.md` remite a `solution-design`.
  - **`solution-design.md`:** dueño de las dimensiones de diseño, con el challenge en `auditor`.
  - **`follow-up-prs.md`:** remite a `publisher` las respuestas a comentarios.

  · test:
  - `lib/__tests__/protocol-coherence.test.ts`, casos
    `::resolve-ticket phases map to the roster`,
    `::spec-bootstrap requires a fresh challenge on critical areas`,
    `::design dimensions live only in solution-design` y
    `::follow-up-prs hands replies to publisher`.
  - `lib/__tests__/solutioning-wiring.test.ts` actualizado.

  con `// Covers: R34, R35, R36, R37`

### Lote 4 · Continuidad, nombres muertos y documentación

- [ ] **T17** (R43, R44, R52) — Continuidad, nombres muertos y documentación.
  - **Clasificación de logs:** `lib/audit/signals.ts` clasifica los agentes retirados como su
    sucesor.
  - **Mineros de `scripts/`:** cuentan `commit-pr-pilot` y `publisher`, y `pr-pilot-confirm` y
    `pr-publisher-confirm`, como el mismo rol.
  - **Fixture del criterio 2:** `scripts/mine-activation.py` tiene un fixture con `subagent_type`
    `architect` que produce un conteo distinto de cero.
  - **Barrido de ids retirados:** cubre contenido y rutas de `core-assets/agents`,
    `core-assets/skills`, `core-assets/managed`, `packages/plugins` y presets (incluidos los JSON).
    - Normaliza con NFKC.
    - Excluye los registros de R38.
    - Falla si no recorrió esas áreas.
  - **Documentación vigente:** `docs/architecture.md`, `docs/EXTENDING.md`,
    `docs/recipes/model-tiering.md` y `docs/recipes/skill-authoring.md`.
  - **Sitio:** `apps/website` (`HarnessGraph.astro`, `Flow.astro`, `src/content/commands.ts`,
    `src/i18n/ui.ts`, `deep-dive.astro` es y en).
  - **Pruebas que nombran ids retirados:** se actualizan todas las que falten; hay que listarlas
    con `grep -rlE "leader|explorer|researcher|ticket-audit|commit-pr-pilot|structural-search|security-guidance|babysit-prs|ticket-intake|debug-error|loop-back-debug" packages/cli/src --include='*.test.ts'`.
  - **Golden y espejo:** golden regenerado y revisado; espejo del repo con el reset.

  · test:
  - `lib/audit/__tests__/signals.test.ts::historical logs with retired ids keep their classification`.
  - `lib/__tests__/retired-names.test.ts::distributed assets name no retired id`, con violaciones
    sembradas en contenido y en ruta.
  - Fixture de `mine-activation.py` con conteo distinto de cero.
  - `engines/__tests__/cited-paths-exist.test.ts`, `engines/__tests__/search-v2-compat.test.ts` y
    `engines/__tests__/golden-render-tree.test.ts`.

  con `// Covers: R43, R44, R52`

## Fase E2 · Canales de `publisher` (PR 5)

- [ ] **T18** (R45, R46) — `agents/publisher.md` suma el contrato de comentarios:
  - Cuerpo en un archivo del directorio de progreso.
  - Por canal: `gh pr/issue comment` y review con `--body-file`; `gh api` con `--input` o
    `-F body=@archivo`/campo GraphQL; `acli` con `--body-file` o `--body-adf` ADF.
  - En Codex entrega borrador y comando para humano, sin URL/id no publicado; de ejecutar, reporta
    URL o id.
  - Contenido tomado solo de artefactos de handoff.

  Los plugins `acli` y `gh` suman un sub-bloque `injectInto: .claude/agents/publisher.md`; el de
  `acli` exige ADF para menciones y prohíbe escribir en Jira por el MCP de Atlassian. · test:
  `lib/__tests__/publisher-contract.test.ts::comment contract and channel sub-blocks` con
  `// Covers: R45, R46`

## Fase F · Architect (PR 6)

- [ ] **T19** (R47, R48, R51) — `packages/core/core-assets/agents/architect.md` (≤ 400 palabras):
  - Aplica `solution-design` y escribe `solution_<scope>.md`.
  - No emite veredicto, no descompone y no pregunta al usuario.
  - Su `description` dice "qué construir y por qué".

  Alta en el catálogo canónico, `agentsIndex.when` en es y en, schema (`harness`, `models`,
  `effort`), recomendados `opus` / `high` e inyección de `codegraph`. · test:
  - `lib/__tests__/agent-descriptions.test.ts`.
  - `engines/shared/__tests__/roster-parity.test.ts::core roster is exactly the seven agents`
    (reemplaza el caso de T11).
  - `lib/__tests__/agents-assets.test.ts::architect never issues a verdict nor decomposes and stays under 400 words`.
  - `lib/__tests__/mcp-capability-wiring.test.ts::codegraph reaches architect`.

  con `// Covers: R47, R48, R51`
- [ ] **T20** (R49, R50) — Wiring del paso arquitectónico y nota de enmienda.
  - `managed/orquestacion.md`: ramas `navori:if architect` y `navori:if-not architect`, dentro de
    6,500 caracteres.
  - `skills/solution-design.md`: quién propone, quién desafía y quién decide.
  - `lib/render-plan.ts`: resuelve la condición.
  - Nota de enmienda en `specs/0012-solutioning/design.md`.

  · test:
  - `__tests__/orquestacion-doctrina.test.ts::architectural pass with and without architect`.
  - `lib/__tests__/solutioning-wiring.test.ts`.
  - `engines/claude/__tests__/session-start-budget.test.ts`.

  con `// Covers: R49, R50`

## Fase R · Lifecycle y medición del reviewer (dentro del PR 4)

- [ ] **T21** (R53, R54) — Reutilizar #854 (`7da709df`) tras verificar si ya está en la base; no
  duplicar su fix. `reviewer.md` define un owner único y handle estable por ejecución de gate/diff,
  sin reintento mientras vive, sin `pgrep`/`ps` global; timeout no es éxito y host sin handle async
  usa foreground observable o `BLOCKED`. Extender `lib/audit/model.ts`, `report.ts` y `signals.ts`
  para correlacionar reviewer, gate, espera y re-reviews sin PII; reportar solapes y ausencia de
  datos sin atribuir el remanente a razonamiento.

  · test: `lib/audit/__tests__/reviewer-lifecycle.test.ts` con estados terminales, handle/diff
  correlacionado, duplicate/unknown/timeout, solapes y datos faltantes, y
  `lib/__tests__/reviewer-gate-ownership.test.ts`; detectan/reportan violaciones sin afirmar que
  previenen tool calls. Los criterios usan >=10 gates completados sobre >=3 diffs.
  `// Covers: R53, R54`
