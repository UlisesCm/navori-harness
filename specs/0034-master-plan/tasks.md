# Plan maestro de proyecto — Tasks

Esta spec se publica sola en su propio PR, solo con documentos. La implementación va en un solo PR
para el issue que se abra con ella (regla del repo: un PR por issue). Cada lote termina en un commit
con el gate completo en verde, para que el PR se pueda revisar lote por lote. Después de cada lote
que toque assets, corre `navori render --apply` y `bun run check:render`.

Orden de los lotes:

- **A** va primero: los esquemas, el registro de etapas e `init` son la base de todo el CLI.
- **B** depende de A: las comprobaciones leen `index.json` y `state.json`.
- **C** depende de B: `status` reusa el parser de `tasks.md` de `check --part`, y `close` reusa
  `check --stage` para validar la etapa que cierra.
- **D** depende de A para la clave de config. No comparte archivos con B ni con C, así que puede
  correr en paralelo con ellos.
- **E** depende de B, C y D: la prosa de las skills nombra los subcomandos, las plantillas y el
  hook.
- **F** cierra el PR: el eval necesita el flujo completo renderizado.

## Lote A — Esquemas, etapas e `init`

- [x] **T1** (R6, R16, R48, R54, R59) — Esquemas y bandera.
  - `lib/master/schema.ts`: `MasterIndexSchema`, `MasterStateSchema` y `PartsSchema` con
    `version: 1`, según "Contracts" de `design.md`. La fase `closed` reemplaza a `done`.
    `PartsSchema` valida ids `P<n>` únicos y consecutivos, `dependsOn` sin ciclos y solo hacia ids
    que existen, y exige `reason` en las partes `descartada` y `diferida`. `acceptance` lleva ids
    `A<m>`, `method` (`test` | `comando` | `manual`) con su detalle y `evidence` según D12.
  - Una `version` desconocida falla con un mensaje que nombra la versión de navori necesaria.
  - `harness.masterPlan` en `HarnessSchema` (`lib/config/schema.ts`), default `false`, y en
    `CONFIG_KEY_RULE.children.harness.keys` (`lib/config/config.ts`).
  - Test: `lib/master/__tests__/schema.test.ts`, con `// Covers: R6, R16, R48, R54, R59`. Cubre las
    fases válidas, una fase inválida, el modo `null` antes de elegirlo, ids duplicados o salteados,
    un ciclo en `dependsOn`, una parte `diferida` sin razón, un criterio sin método o con un
    detalle que no corresponde a su método, los cuatro estados de etapa y una versión
    desconocida. `lib/config/__tests__/schema.test.ts` fija el default `false`.
- [x] **T2** (R3, R5, R50, R52, R53, R54) — Registro de etapas.
  - `lib/master/stages.ts` según D11: lee y valida `index.json` (a lo sumo una etapa `activa`,
    carpetas y entradas en correspondencia, números crecientes), resuelve la etapa activa para
    todos los subcomandos, calcula `<NN>` como el número más alto registrado más uno (sin reusar
    huecos), valida el slug en kebab-case y renderiza `INDEX.md` de forma determinista, con la
    primera línea fija de D5.
  - `contextForArchitects`: la lista de lectura de R52. Completos el `MASTER.md`, el
    `DECISIONS.md` y el `CLOSURE.md` de la última etapa `cerrada`; el `DECISIONS.md` y el
    `CLOSURE.md` de las `convertida` o `abandonada` posteriores; de las anteriores, solo su
    `CLOSURE.md` e `INDEX.md`.
  - Test: `lib/master/__tests__/stages.test.ts`, con `// Covers: R3, R5, R50, R52, R53, R54`.
    Cubre la numeración `01`, `02` y `04` con hueco; el slug inválido; dos `activa`; una carpeta
    sin entrada; una entrada cerrada sin carpeta; `dir` distinto de `number`/`slug`; `INDEX.md`
    igual byte a byte en dos corridas; y el fixture de cuatro etapas de la fila R52 de "Testing
    strategy".
- [x] **T3** (R3, R4, R5, R15, R16, R19) — `navori master init` y `mode`, con la señal de modo.
  - `lib/master/signal.ts`: número de commits, fecha del primer commit y archivos modificados
    después de él (desde `git`), más framework y librerías desde `detectProject(cwd).stack`. Sin
    git o sin código devuelve `null` en esos campos. Los umbrales de la sugerencia (`template`
    con ≤5 commits y ≤20 archivos modificados; si no, `en-curso`) viven solo aquí.
  - `lib/master/init.ts`: `init <slug>` en el orden de Components de `design.md`: primero
    `index.json`, luego la carpeta de la etapa con `context/raw/.gitignore` (`*` y `!.gitignore`) y
    `state.json` en fase `context`, después `INDEX.md`, la bandera con `writeConfig` y `runRender`.
    Todo con creación exclusiva. En etapa ≥2 registra `mode: "en-curso"`. Con una etapa ya activa
    no crea otra: completa lo que le falte a la activa (incluidas la bandera y el render), reporta
    etapa y fase, y sale con 1 si se pidió un slug. Falla con `sdd.enabled: false`, nombrando la
    clave. Si `raw/` ya tenía archivos rastreados por git, lo advierte y no los saca del índice.
  - `commands/master.ts` con `init` (imprime la señal y la sugerencia) y `mode
    <template|en-curso>` (falla después de `context` y en etapa ≥2), registrado en `subCommands` de
    `index.ts`.
  - Test: `lib/master/__tests__/init.test.ts`, con `// Covers: R3, R4, R5, R16`, en un repo
    temporal. Cubre las filas `init` y `raw/` de "Testing strategy": la estructura, `git
    check-ignore` positivo con `gitignoreHarness: "off"` y después de `close`, el corte después de
    cada paso del 1 al 4 reparado por una segunda corrida, la bandera apagada a mano con la etapa
    completa, el `.gitignore` de `raw/` borrado y recreado sin tocar otro byte, la etapa ≥2 en
    `en-curso` y el error con `sdd.enabled: false`. `lib/master/__tests__/signal.test.ts`, con
    `// Covers: R15, R19`, cubre un repo sin git, uno con un commit, uno con historia y uno sin
    código fuente.

## Lote B — Plantillas y comprobaciones

- [ ] **T4** (R11, R12, R18, R21, R29, R30, R31, R42, R55, R59) — Plantillas y `navori master template`.
  - `packages/core/core-assets/master-plan/{plan,master,decisions,intake,digest,tasks,issue}.md`
    en español, más la traducción en `master-plan/en/` con el fallback de `resolveAssetPath`.
  - La plantilla `plan` trae las 18 secciones de D3. La sección 3 ("Estado actual vs. objetivo")
    solo aparece en modo `en-curso`. La plantilla `digest` trae las ocho secciones contables que
    usa D9. La sección 15 de `plan` y `master`, y las plantillas `tasks` e `issue`, usan los ids
    `P<n>.A<m>` y el método de cada criterio.
  - `lib/master/templates.ts`: imprime la plantilla en el idioma del repo y extrae la lista de
    encabezados que usan `checks.ts` y `fit.ts`. `template issue --part P<n>` la imprime ya llena
    desde `parts.json`, con la etapa en el título.
  - Test: `lib/master/__tests__/templates.test.ts`, con `// Covers: R12, R18, R21, R29, R30, R31,
    R42, R55, R59`. Los encabezados se leen del archivo (no hay lista literal en TS); `en-curso` exige
    la sección 3 y `template` no; `digest` trae sus ocho secciones; `issue --part` trae objetivo,
    alcance, fuera de alcance, dependencias, criterio de aceptación y la ruta de `MASTER.md`.
- [ ] **T5** (R8, R10, R11, R12, R14, R16, R21, R22, R23, R29, R30, R31, R32, R50, R52) — `check`
  y `advance`.
  - `lib/master/checks.ts` implementa la tabla "Comprobaciones de `advance`" de `design.md`, más
    la comprobación de `context/raw/.gitignore` en toda fase y `check --stage <NN-slug>` para una
    etapa cerrada, con los hashes de "Integridad" de `CLOSURE.md` calculados sobre contenido
    normalizado a `\n`.
  - `advance` escribe la fase siguiente y la agrega al historial solo si todo pasa; si no, sale
    con 1 y la lista de fallas. Nunca salta una fase ni sale de `executing`. En etapa ≥2,
    `questioned` exige un `D<n>` por cada parte diferida de la última etapa cerrada.
  - `check` corre lo mismo sin escribir, compara la región de partes y `STATUS.md` contra su
    render, y valida que el historial de `state.json` sea una cadena de fases consecutivas.
  - Test: `lib/master/__tests__/checks.test.ts`, con `// Covers: R8, R10, R11, R12, R14, R16,
    R21, R22, R23, R29, R30, R31, R32, R50, R52`. Un fixture inválido por fila de la tabla y uno
    válido; una cabecera `markitdown` sin versión rechazada; `advance` nunca salta; `mode` falla
    después de `context`; `Origen: 01-mvp/D3` validado contra el `DECISIONS.md` de esa etapa; y
    los casos de `check --stage` de la fila de cierre de "Testing strategy", incluido CRLF.
- [ ] **T6** (R35, R60) — `navori master check --part P<n>`.
  - Valida cada tarea del `tasks.md` de la parte: `Archivos`, `Interfaces` (cada una nombrada en
    `design.md`), `Patrón` (un archivo que existe), `Lectura`, `Librerías` (versión exacta, sin
    `^` ni `~`), `Done` (comando, resultado esperado y casos de test con nombre) y `Fuera de
    alcance`.
  - Valida el mapeo en los dos sentidos: cada `P<n>.A<m>` aparece en al menos un `R<n>` del
    `requirements.md` de la spec, y ningún `R<n>` cita un criterio que no existe.
  - Solo se exige con `harness.masterPlan` encendido y para specs enlazadas desde `parts.json`.
  - Test: `lib/master/__tests__/check-part.test.ts`, con `// Covers: R35, R60`. Un fixture por
    campo faltante, uno con versión `^1.2.0`, uno con un criterio sin `R<n>`, uno con un `R<n>` que
    cita un criterio inexistente y uno válido.
- [ ] **T7** (R55) — `navori master check --fit`.
  - `lib/master/fit.ts`: cuenta los criterios V1–V7 de D9 sobre `DIGEST.md` y `CODEBASE.md`, con
    sus umbrales solo en este módulo, y lista J1–J3 como criterios de juicio. `--json` con la
    forma de "Contracts".
  - Test: `lib/master/__tests__/fit.test.ts`, con `// Covers: R55`. Un fixture por criterio justo
    en el umbral y otro por encima; `CODEBASE.md` con stack abierto hace fallar V6; la salida
    lista J1–J3 como juicio.

## Lote C — Avance, partes y cierre

- [ ] **T8** (R31, R33, R36, R40, R44, R46, R47, R48, R54, R59, R61, R62) — `status`, `part` y
  evidencia de aceptación.
  - `lib/master/status.ts`: estado efectivo por las reglas de D2 y D12 (`hecho` exige tareas
    completas y evidencia de cada criterio; si no, `parcial` con los criterios pendientes en
    `blockers`), `commitsBehind` y `orphan` por criterio como aviso que no bloquea, parte activa,
    discrepancias, `closable` y `blockers`, y el render determinista (sin fecha) de `STATUS.md`,
    de la región `navori:master-parts` de `MASTER.md` y de `INDEX.md`. `STATUS.md` nombra la etapa.
    `--json` trae `stage`, `phase`, `nextPhase`, `mode`, `activePart`, `parts`, `discrepancies`,
    `allDone`, `closable`, `blockers` y `lastClosed`. `--line` produce la línea de R38 con la etapa
    y el título de la parte limpio (una línea, sin caracteres de control, máximo 60 caracteres,
    entre comillas). Sin `index.json` sale con 1; sin etapa activa sale con 0 y `stage: null`.
  - `part P<n> [--state] [--reason] [--spec] [--issue]`: `--issue` falla si la parte ya tiene
    issue, `--spec` falla si la ruta no existe y `--state descartada|diferida` exige `--reason`.
  - `part P<n> --accept A<m>` con las validaciones de D12: `--command` y `--result` para `test` y
    `comando`, solo `--approved-by user` para `manual`, árbol limpio fuera de `<specsDir>/`, y
    commit y fecha puestos por navori. Falla con `harness.masterPlan: false`.
  - `settings-base.json`: `allow` gana `Bash(navori master status:*)`, `Bash(navori master
    check:*)` y `Bash(navori master template:*)`, y nada más de `navori master`.
  - Test: `lib/master/__tests__/status.test.ts`, con `// Covers: R31, R36, R40, R44, R46, R47,
    R54, R61`, según la fila de `STATUS.md`/`INDEX.md` de "Testing strategy": los mismos bytes en dos
    corridas, el estado efectivo con `descartada` y `diferida`, la discrepancia, la parte activa,
    `allDone`, `closable`, `blockers`, `nextPhase`, `lastClosed`, los códigos de salida y el título
    con caracteres de control, más una parte con tareas completas y un criterio sin evidencia
    (`parcial`, con el criterio en `blockers`) y una evidencia huérfana que no bloquea.
    `lib/master/__tests__/part.test.ts`, con `// Covers: R33, R44, R48, R59, R61, R62`, cubre el
    issue duplicado, la spec inexistente, la razón obligatoria y cada validación de `--accept`
    (método equivocado, árbol sucio, `manual` con `--command`, bandera apagada).
- [ ] **T9** (R47, R49, R50, R57, R58, R63) — `close`, `close --convert` y `close --abandon`.
  - `lib/master/close.ts` con la secuencia reanudable de 6 pasos de D10: validar, escribir
    `CLOSURE.md` determinista (con "Integridad" y cada criterio con su método, evidencia, fecha,
    `commitsBehind` y `orphan`; los de partes `descartada` o `diferida`, como no verificados), pasar la etapa a `closed`, marcarla en
    `index.json`, apagar la bandera y aplicar el render. `close` sin etapa activa y con la bandera
    encendida completa solo el paso 6 y sale con 0.
  - `--convert <ruta> --reason` solo antes de `mastered`, con la ruta libre, y deja la etapa
    `convertida`. `--abandon --reason` solo de `context` a `questioned`, con un `CLOSURE.md` corto,
    y deja la etapa `abandonada`. Las dos opciones son excluyentes, y ninguna borra archivos.
  - Los mutadores (`part`, `advance`, `mode`, `close`) rechazan una etapa cerrada.
  - Test: `lib/master/__tests__/close.test.ts`, con `// Covers: R47, R49, R50, R57, R58, R63`. Cubre
    las filas de cierre, desincronización, conversión y abandono de "Testing strategy": una parte
    `parcial` bloquea y se lista; `CLOSURE.md` igual byte a byte en dos corridas; el corte después
    de cada uno de los 6 pasos; el corte entre el paso 5 y el 6; `--convert` en `mastered` y con
    ruta ocupada; `--abandon` en `mastered`, sin razón y combinado con `--convert`; y la misma
    lista de archivos antes y después de abandonar; los criterios en `CLOSURE.md` con evidencia y
    los de una parte `diferida` como no verificados.
- [ ] **T10** (R4, R49, R50) — Fila de `doctor`.
  - `lib/diagnose/master-plan.ts`: corre siempre que exista `<specsDir>/_master/index.json`, con la
    bandera encendida o no (cuarta excepción del principio 3). Da `warn`, nunca error, en los tres
    casos de Components: `index.json` inválido, `raw/.gitignore` faltante (nombra `navori master
    init` o `git checkout`), y bandera y registro desincronizados (nombra `close` o `init`).
  - Test: `lib/diagnose/__tests__/master-plan.test.ts`, con `// Covers: R4, R49, R50`. Cada caso
    da `warn` sin exit 2 y nombra su comando; un estado coherente no da fila, y un repo sin
    `_master/` tampoco.

## Lote D — Render y hooks

- [ ] **T11** (R37, R39) — Bloque managed `plan-maestro`.
  - `packages/core/core-assets/managed/plan-maestro.md` en inglés, unas 80 palabras, con el
    contenido del borrador de D5.
  - Entrada en `CORE_MANAGED_ASSETS` (`render-plan.ts`) con `condition: "harness.masterPlan"`,
    `audience: "orchestrator"` y `rootOnly: true`. Orden `7` en `ORCHESTRATOR_CONTEXT_ORDER`
    (`engines/claude/index.ts`). Techo de 90 palabras en `DOC_BUDGETS` (`doc-budgets.ts`).
  - Test: golden de render con la bandera en `false` (sin `07-plan-maestro.md`) y en `true` (con
    él), y el golden que vuelve al de `false` después de `close`, con `// Covers: R37, R39`. Otro
    test con `simulateContextDelivery` sobre `planTiers` y `masterPlan` encendidos fija que
    `plan-maestro` llega `inline`.
- [ ] **T12** (R38, R39, R54) — Hook `master-plan-context.sh`.
  - `packages/core/core-assets/hooks/master-plan-context.sh` sigue la estructura de `plan-gate.sh`:
    fail-open, parciales de auditoría y `command -v navori`. Emite `navori master status --line`
    si sale con 0 y cabe en `NAVORI_MASTER_LINE_BUDGET=600`. En cualquier otro caso emite el
    respaldo, que lee la ruta de la primera línea de `INDEX.md` según D5.
  - Registro en `buildClaudeSettings` (`build-settings.ts`) solo con `config.harness?.masterPlan`,
    como `plan-gate.sh` con `planTiers`.
  - Test: `engines/claude/__tests__/master-plan-context.test.ts`, con `// Covers: R38, R39, R54`,
    en bash y zsh, según la fila de la línea de arranque de "Testing strategy". El golden de
    `settings.json` tiene el hook solo con la bandera.
- [ ] **T13** (R43) — Confirmación de toda creación de issue.
  - `comment-draft-confirm.sh` gana las tres formas de D6: `gh issue create`, `gh api` REST contra
    `…/issues` como último segmento (escritura por `-X POST` o por campos sin `-X`) y la mutación
    GraphQL `createIssue`. `BOUND` pasa a ``(^|[;&|(`]|[[:space:]])``, y `TRIGGER_TOKENS` gana
    `create`.
  - La respuesta es `ask` en todos los modos de permisos; Codex conserva su `deny`.
  - Test: `comment-draft-confirm.test.ts`, con `// Covers: R43`, con los 18 casos de la fila R43
    de "Testing strategy", más la suite diferencial bash×zsh con las mismas entradas.
- [ ] **T14** (R62) — Hook `master-accept-confirm.sh`.
  - `packages/core/core-assets/hooks/master-accept-confirm.sh` según D12: reusa los parciales
    compartidos, filtra con `TRIGGER_TOKENS='approved-by'`, detecta `navori master part` con
    `--approved-by` usando el `BOUND` de D6 y responde `ask` en todos los modos, con una razón fija
    sin contenido del repo.
  - Registro en `buildClaudeSettings` solo con `config.harness?.masterPlan`, como `plan-gate.sh`.
    No se registra en Codex.
  - Test: `master-accept-confirm.test.ts`, con `// Covers: R62`, con los 13 casos con nombre de la
    fila R62 de "Testing strategy", más la suite diferencial bash×zsh y el golden de
    `settings.json`.

## Lote E — Agentes, skills y engines

- [ ] **T15** (R14, R23, R24, R25) — `architect` y `scout`.
  - `architect.md`: `tools` gana `WebFetch, WebSearch`; párrafo "Sources"; entrada "master-plan"
    en "When you're called"; `maxWords` de 660 a 700, con la razón en el frontmatter. Las
    oraciones que fija `agents-assets.test.ts` no se tocan.
  - `scout.md`: una oración en el formato Map para escribir en la ruta que nombre el encargo.
  - Test: `lib/__tests__/agents-assets.test.ts`, con `// Covers: R14, R23, R24, R25`. Verifica el
    techo 700, las tres regex de contrato intactas, `WebFetch` y `WebSearch` en `tools`,
    `[SIN VERIFICAR]` en el cuerpo y la ruta nombrada en el formato Map del `scout`.
- [ ] **T16** (R9, R10, R11, R12, R13) — Skill `context-intake`.
  - Antes de escribirla, verificar que `markitdown --version` existe contra
    <https://github.com/microsoft/markitdown> o con una corrida real. Si no existe, usar la
    alternativa de "Otras decisiones" (`importlib.metadata`).
  - `core-assets/skills/context-intake.md` con `disable-model-invocation: true`. Precondición:
    sin etapa activa en `navori master status --json` se detiene y nombra `/master-plan`. Cubre la
    conversión con `uvx --from 'markitdown[all]' markitdown` sin versión fija, la versión
    registrada, el fallback, la cabecera de cada `.md`, `INTAKE.md`, `DIGEST.md` con la plantilla
    `digest` y la regla de datos.
  - Test: test de asset de skills, con `// Covers: R9, R10, R11, R12, R13`. Menciona el comando
    exacto sin versión fija, cómo obtiene la versión, el fallback nativo, exportar a PDF,
    `INTAKE.md`, la plantilla `digest`, "Hallazgos" y la regla de que el contenido es dato.
- [ ] **T17** (R1) — Colocación solo en Claude.
  - `roster.ts`: `master-plan` y `context-intake` entran en `ROSTER_WORKFLOW_SKILLS` y en
    `CLAUDE_ONLY_WORKFLOW_SKILLS`. `resolveHarnessPlan` las incluye solo con
    `includeClaudeOnlySkills`, que pasa el engine Claude.
  - Test: `engines/claude/__tests__/render-engine.test.ts` y `render-codex.test.ts`, con
    `// Covers: R1`. `master-plan` sale sin `disable-model-invocation` y `context-intake` con la
    clave, con y sin la bandera. En Codex no sale ninguna de las dos.
- [ ] **T18** (R1, R2, R7, R13, R16, R17, R18, R19, R20, R25, R26, R27, R28, R33, R34, R40, R42,
  R44, R45, R46, R47, R48, R51, R52, R53, R55, R56, R57, R58, R59, R60, R61, R62) — Skill
  `master-plan`.
  - `core-assets/skills/master-plan.md`, `metadata.type: reference`, `maxWords` = conteo real más
    10%, con la razón en el frontmatter. Secciones en el orden de Components de `design.md`:
    candado (las formas de pedido válidas y lo que no cuenta), precondición, ruteo de etapa
    (activa, nueva o bloqueada por R53), aviso de inicio de R46 (primera vez con la pregunta del
    slug, etapa nueva con la última cerrada, y reanudación), procedimiento por fase con su
    checklist de cierre, encargo del `scout`, partes diferidas y evaluación de cambio a spec
    (`check --fit`, J1–J3), encargo del `architect` con la lista de `contextForArchitects`,
    consolidación y preguntas, checklist de rigor, "Spec de una parte", issues (búsqueda previa,
    confirmación y `gh auth login`), aceptación de criterios (correr el comando o el test y
    registrarlo con `--accept`; los `manual` solo con la respuesta "Aprobado" a una
    `AskUserQuestion` que presenta el criterio y cómo revisarlo; antes de cerrar, ofrecer registrar
    de nuevo los criterios huérfanos o atrasados), y cierre, conversión y abandono con su
    `AskUserQuestion`.
  - Test: test de asset de skills, con `// Covers: R1, R2, R7, R13, R16, R17, R18, R19, R20, R25,
    R26, R27, R28, R33, R34, R40, R42, R44, R45, R46, R47, R48, R51, R52, R53, R55, R56, R57,
    R58, R59, R60, R61, R62`. Cubre las filas de prosa de "Testing strategy": el candado es la primera sección y
    excluye la línea de `SessionStart`; el aviso va antes de la primera mención de `navori master
    init`, con los ocho elementos de R46, la advertencia de tiempo y tokens, sus tres variantes y
    `AskUserQuestion`; R53 sin `init`; la pregunta parte por parte de R48; la pregunta de entrega
    de R47; la oferta de diferidas como `D<n>`; "Cambiar a spec" y "Seguir con el plan maestro";
    `close --convert` antes de `spec-bootstrap`; la confirmación antes de `close --abandon`; `D<n>`;
    la checklist de rigor; "solo GitHub"; `gh issue list --search`; `gh auth login`; la regla de
    que el agente nunca registra un `manual` sin la respuesta del usuario; y el mapeo
    `P<n>.A<m>` → `R<n>` en "Spec de una parte".
- [ ] **T19** (R41) — Registro de controles.
  - `engine-capabilities.ts`: `ControlId` gana `"master-plan"` y `ControlCondition` gana
    `"masterPlan"`. Claude lo declara `enforced` con evidencia `hook`; los otros cuatro engines,
    `unsupported` con la razón de D7.
  - Test: `engine-capabilities.test.ts` y `control-gaps.test.ts`, con `// Covers: R41`. El control
    está en los cinco engines; `warn` en Codex con la bandera encendida; sin fila con la bandera
    apagada.

## Lote F — Eval y documentación

- [ ] **T20** (R1, R38, R46) — `specs/0034-master-plan/evals.md`.
  - Escenario RED/GREEN en un repo fixture con la etapa `01-mvp` en fase `executing`. Sesión 1: el
    usuario pide una tarea ajena; la respuesta la hace y agrega una línea de oferta, sin comandos
    de `navori master`. Turno 2: "sí, continúa" produce la llamada a Skill `master-plan`, el aviso
    corto de R46 con la etapa y `AskUserQuestion` antes de cualquier escritura. Control RED: la
    misma skill con `disable-model-invocation: true` no produce la llamada.
  - La tabla guarda los resultados como salieron, incluidos los invertidos.
- [ ] **T21** — Documentación durable.
  - `docs/architecture.md`, sección nueva "Plan maestro": etapas, fases, cierre y por qué JSON +
    Markdown.
  - Comentario en `ORCHESTRATOR_CONTEXT_ORDER` sobre el presupuesto de `SessionStart` agotado.
  - Regenerar los goldens de render. Con la bandera apagada, `settings.json` y `.claude/context/`
    quedan iguales byte a byte, salvo el hook de R43 y las dos skills nuevas.
  - Ampliar el `CommandDoc` de `master` en `apps/website/src/content/commands.ts` con los
    subcomandos que agregan los Lotes B y C (`status`, `check`, `advance`, `part`, `template`,
    `close`): la entrada del Lote A solo documenta `init` y `mode`.
