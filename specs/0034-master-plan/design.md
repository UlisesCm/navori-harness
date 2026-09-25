# Plan maestro de proyecto — Design

**Señal:** subsistema nuevo con contrato compartido (esquemas de `index.json`, `state.json` y
`parts.json`; plantillas que leen tanto el agente como el validador), área crítica (escrituras del
CLI en el repo del usuario: `.gitignore` por etapa, `navori.config.json`, `specs/_master/`; hooks
nuevos y cambiados; permisos de `settings-base.json`), ampliación de agentes existentes
(`architect`, `scout`).
**Base revisada:** `origin/main` = `94d00f2e` (`git fetch origin main` el 2026-09-24). Rebase sobre
`eacf1b99` (v0.10.1) antes de publicar: de los tres commits nuevos, solo #1047 toca un área del
diseño (ver la nota de D8).

**Convención de rutas** (la de `requirements.md`): `<etapa>` es la carpeta de la etapa activa,
`<specsDir>/_master/<NN>-<slug>/`. Las rutas relativas (`context/…`, `plans/…`, `state.json`,
`parts.json`, `DECISIONS.md`, `MASTER.md`, `STATUS.md`, `CLOSURE.md`) cuelgan de ella. Solo
`index.json` e `INDEX.md` viven directamente en `<specsDir>/_master/`.

## Approach

El plan maestro es **un flujo de skill con estado persistido y validado por el CLI**, igual que la
spec 0032 formalizó el workplan: el agente hace el trabajo de juicio (convertir, leer, planear,
consolidar, preguntar) y un comando de navori es el único que escribe el estado y el que decide si
una fase puede cerrarse. No se agrega ningún agente nuevo.

Un plan maestro **termina**. Cada uno es una **etapa** con carpeta propia, numerada y con slug
(`01-mvp`, `02-pagos`). El registro de etapas vive en `_master/index.json`, que es la única fuente
de cuál está activa, y a lo sumo una lo está. Al cerrarse, la etapa queda como registro de solo
lectura. La siguiente reusa el mismo proceso y recibe las decisiones cerradas como restricción.

| Fase registrada | Trabajo mientras se está en ella | Quién | Salida |
|---|---|---|---|
| `context` | pregunta de modo (solo etapa 1), el usuario deja archivos en `context/raw/`, `context-intake` convierte | orquestador + usuario | `advance`: modo registrado; `raw/` con ≥1 archivo; `INTAKE.md` da cuenta de cada archivo |
| `transcribed` | `scout` escribe `CODEBASE.md`; el orquestador escribe `DIGEST.md` | orquestador + `scout` | `advance`: `DIGEST.md` y `CODEBASE.md` válidos |
| `mapped` | partes diferidas de la etapa anterior (R52), evaluación "¿cabe en una spec?" (R55), tres `architect` en paralelo | orquestador, usuario, `architect` ×3 | `advance`: `plans/plan1.md`–`plan3.md` completos; o `close --convert` (R57) |
| `planned` | comparación sección por sección y preguntas | orquestador + usuario | `advance`: `DECISIONS.md` válido |
| `questioned` | redacción de `MASTER.md` y `parts.json` | orquestador | `advance`: `MASTER.md` válido y sin marcas abiertas |
| `mastered` | issues opcionales; espera la orden del usuario | orquestador | `advance`: que el usuario pida arrancar |
| `executing` | cada parte se vuelve spec al arrancar | orquestador (nivel 3) | `close` (R47) |
| `closed` | registro de solo lectura | — | — |

Desde `context` hasta `questioned`, la etapa también puede salir con `close --convert` si el
usuario acepta cambiar a una sola spec (R56).

Tres principios, los mismos de las specs 0032 y 0033:

1. **Lo verificable lo verifica el CLI; lo demás se declara como consultivo.** `advance`, `close`
   y `check --fit` corren comprobaciones mecánicas (archivos, encabezados, citas, marcas,
   conteos). La parte de juicio de cada checklist es prosa de la skill y no se presenta como
   garantía.
2. **Estructura en JSON, prosa en Markdown.** Lo que cambia durante la ejecución (etapa activa,
   fase, modo, estado de cada parte, spec, issue) vive en JSON con esquema zod y se renderiza. Lo
   que se escribe una vez y se lee muchas (secciones del plan y del MASTER) es Markdown del
   orquestador, validado contra su plantilla. `STATUS.md`, `INDEX.md` y `CLOSURE.md` son siempre
   render.
3. **Cero cambio de comportamiento con la bandera apagada**, salvo cuatro excepciones
   explícitas. Tres las piden los requisitos como incondicionales: la skill `master-plan` (R1),
   las herramientas del `architect` (R24) y la confirmación de toda creación de issue (R43). La
   cuarta es el escaneo de `doctor` sobre `_master/index.json` (D8): corre siempre que ese archivo
   exista, porque los `raw/` de las etapas cerradas guardan documentos confidenciales después de
   que el cierre apaga la bandera, y porque es el que detecta que la bandera y el registro no
   coinciden (D10). En un repo que nunca abrió una etapa no hay `index.json` y el escaneo no hace
   nada.

**Descartados a nivel de enfoque:**

- **Agente `planner` o `consolidator` dedicado.** La consolidación exige la conversación (el
  usuario responde las preguntas de R27 en el hilo principal), así que un subagente tendría que
  recibir un resumen de la intención del usuario: el mismo teléfono descompuesto que la spec 0032
  descartó para el workplan. No pasa la prueba de la spec 0031: es trabajo en serie y con estado
  compartido.
- **Todo en Markdown parseado** (fase, partes y avance escritos a mano por el orquestador). R36
  exige un `STATUS.md` determinista y R8 que el estado no se edite a mano. Parsear campos
  mutables desde prosa editable es donde el determinismo se pierde (ver D2).
- **Conversión desde el CLI** (`navori master intake` corriendo `markitdown`). Viola el invariante
  9 de `docs/DIRECTION.md` y el fuera-de-alcance de los requisitos.
- **Una sola carpeta `_master/` reutilizada por etapa** (archivar la anterior al abrir la
  siguiente). Mueve archivos commiteados, rompe los enlaces de specs y issues hacia `MASTER.md`, y
  mezcla dos etapas en el historial de git de las mismas rutas. Con una carpeta por etapa, cada
  registro queda en su lugar.

### Criterios de decisión (derivados de las reglas del proyecto, antes de las opciones)

1. **Un solo pipeline de render** (invariante 7): lo que `render` escribe pasa por el spine. El
   CLI puede escribir artefactos propios fuera de él, con `writeFileAtomic`
   (`lib/primitives/atomic.ts`), como ya hacen `navori plan update` (`commands/plan.ts`,
   `writeWorkplanAndRender`) y `navori add` (`writeConfig` + `runRender`).
2. **navori genera, no ejecuta** (invariante 9): `uvx`, `gh` y los despachos los corre el agente.
3. **Un solo dueño por regla** (DIRECTION, "regla autosuficiente"): la lista de secciones de la
   plantilla existe en un archivo, y de él leen la skill, los arquitectos y el validador. Qué
   etapa está activa lo dice un solo archivo (`index.json`).
4. **Presupuesto always-on**: el canal de `SessionStart` ya está saturado (ver Failure modes). Lo
   nuevo que entra ahí debe ser mínimo y quedar fuera del camino de la doctrina existente.
5. **Honestidad por engine** (spec 0033 R20): lo que no corre fuera de Claude se declara
   `unsupported` en el registro de controles.
6. **Admisión de agentes** (spec 0031): ampliar `architect` o `scout` declara garantía, señal,
   costo y retiro.
7. **Permisos por prefijo** (D1): nada que mute `navori.config.json` o el estado de una etapa
   entra en `allow`, porque una regla por prefijo no distingue flags.
8. **Sin dependencias nuevas en el CLI.** zod ya está (`lib/plan/schema.ts`).

## Components

**CLI**

- `packages/cli/src/commands/master.ts` — comando `navori master` con los subcomandos `init`,
  `mode`, `status`, `check`, `advance`, `part`, `template` y `close`, registrado en `subCommands`
  de `packages/cli/src/index.ts` — cubre R3, R5, R8, R16, R36, R40, R44, R47, R48, R50, R53, R54,
  R57, R61, R62.
- `packages/cli/src/lib/master/schema.ts` (zod) — `MasterIndexSchema`, `MasterStateSchema` y
  `PartsSchema`, con `version: 1` en los tres (Contracts) — cubre R6, R16, R18, R31, R44, R48,
  R54, R59.
- `packages/cli/src/lib/master/stages.ts` — lee y valida `index.json` (a lo sumo una etapa
  `activa`, carpetas y entradas en correspondencia, números crecientes), resuelve la etapa activa
  para todos los subcomandos, calcula `<NN>` como el número más alto registrado más uno y valida
  el slug. También renderiza `INDEX.md` de forma determinista. Es el único módulo que sabe qué
  etapa está activa — cubre R3, R5, R50, R51, R53, R54.
- `packages/cli/src/lib/master/init.ts` — `init <slug>`, en este orden: agrega la etapa como
  `activa` en `index.json`; materializa `<etapa>` con `context/raw/`, `context/md/`, `plans/`,
  `context/raw/.gitignore` y `state.json` en fase `context` (creación exclusiva, nunca
  sobrescribe); en etapa ≥2 registra `mode: "en-curso"`; renderiza `INDEX.md`; pone
  `harness.masterPlan: true` con `writeConfig` (`lib/config/config.ts`) y aplica `runRender`
  (`commands/render.ts`), el mismo patrón que `commands/add.ts`. Con una etapa ya activa, `init`
  (con o sin slug) no crea otra: completa solo lo que le falte a la activa sin reescribir nada, y
  en el mismo orden que la primera corrida. Lo que puede faltar: las carpetas, `raw/.gitignore`,
  `state.json`, `INDEX.md`, y `harness.masterPlan: true` junto con el render si la bandera está
  apagada. Así un corte entre el paso 1 y el 5 se repara con una segunda corrida. Después reporta
  la etapa y su fase, y sale con 1 si se pidió un slug — cubre R3, R4, R5, R16.
- `packages/cli/src/lib/master/signal.ts` — señal de modo: número de commits, fecha del primer
  commit y número de archivos modificados después de él (desde `git`), y framework y librerías
  desde `detectProject(cwd).stack` (`lib/diagnose/detect.ts`, la misma entrada que usa
  `lib/diagnose/scan.ts`; `detectStack`, que nombra R15, es privada y `detectProject` es su única
  entrada pública). Sin git o sin código devuelve `null` en esos campos y no falla. Los umbrales
  de la sugerencia viven solo aquí — cubre R15, R19.
- `packages/cli/src/lib/master/templates.ts` + `packages/core/core-assets/master-plan/*.md` (base
  `es`, traducción en `core-assets/master-plan/en/`, misma regla de fallback que
  `resolveAssetPath` en `render-plan.ts`) — plantillas `plan`, `master`, `decisions`, `intake`,
  `digest`, `tasks` e `issue`. `templates.ts` las imprime y extrae de ellas la lista de
  encabezados que usa el validador — cubre R11, R12, R18, R21, R29, R30, R31, R35, R42, R55, R59.
- `packages/cli/src/lib/master/checks.ts` — comprobaciones de salida por fase (tabla de
  Contracts), la de `tasks.md` de una parte, la de una etapa cerrada (`--stage`) y, en toda
  fase, que exista `context/raw/.gitignore` — cubre R4, R8, R10, R11, R12, R14, R21, R22, R23, R29,
  R30, R31, R32, R33, R35, R50, R52, R60.
- `packages/cli/src/lib/master/fit.ts` — criterios verificables de "cabe en una spec", contados
  sobre `DIGEST.md` y `CODEBASE.md` (D9). Sus umbrales viven solo aquí. Se expone como `check
  --fit` — cubre R55.
- `packages/cli/src/lib/master/status.ts` — estado efectivo por parte, parte activa, render
  determinista de `STATUS.md` y de la región de partes de `MASTER.md`, la línea corta de
  `--line`, y los campos `closable`/`blockers` que usa `close`, con la evidencia por criterio
  (`commitsBehind`, `orphan`) — cubre R31, R36, R38, R40, R44, R47, R54, R61.
- `packages/cli/src/lib/master/close.ts` — `close` y `close --convert`: valida, escribe
  `CLOSURE.md` determinista, pasa la etapa a `closed`, la marca `cerrada` o `convertida` en
  `index.json`, apaga la bandera y aplica el render. Es reanudable paso por paso, incluido el
  corte entre el paso 5 y el 6 (D10) — cubre R47, R49, R50, R57, R63.
- `packages/cli/src/lib/diagnose/master-plan.ts` — escaneo de `doctor` siempre que exista
  `<specsDir>/_master/index.json`, con la bandera encendida o no. Da `warn` en tres casos:
  - `index.json` no pasa `stages.ts`;
  - a una etapa le falta `context/raw/.gitignore` (el mensaje nombra `navori master init` para
    la activa y `git checkout -- <ruta>` para una cerrada);
  - la bandera y el registro no coinciden. Con la bandera encendida y sin etapa activa, el mensaje
    nombra `navori master close`. Con una etapa activa y la bandera apagada, nombra `navori master
    init` (D10).

  Es `warn` y
  no error a propósito: un error haría salir a `doctor` con 2, y entonces la precondición de R2
  le cerraría el paso a la misma skill que corre la reparación. `check` y `advance` sí fallan por
  esa causa — cubre R4, R49, R50.
- `packages/cli/src/lib/config/schema.ts` — `harness.masterPlan` en `HarnessSchema`, default
  `false`; la clave entra también en `CONFIG_KEY_RULE.children.harness.keys` (`config.ts`) —
  cubre R37, R39.
- `packages/core/core-assets/settings/settings-base.json` — `allow` gana `Bash(navori master
  status:*)`, `Bash(navori master check:*)` y `Bash(navori master template:*)`. `init`, `mode`,
  `advance`, `part` y `close` quedan fuera a propósito: mutan estado o config y deben pedir
  permiso en `default`. `uvx` y `gh issue create` tampoco entran — cubre R8, R43.

**Render y hooks**

- `packages/core/core-assets/managed/plan-maestro.md` + entrada en `CORE_MANAGED_ASSETS`
  (`render-plan.ts`) con `condition: "harness.masterPlan"`, `audience: "orchestrator"`,
  `rootOnly: true`; orden `7` en `ORCHESTRATOR_CONTEXT_ORDER` (`engines/claude/index.ts`), entre
  `planificacion` (5) y `orquestacion` (10); techo propio en `DOC_BUDGETS`
  (`lib/assets/doc-budgets.ts`) de 90 palabras — cubre R37, R39.
- `packages/core/core-assets/hooks/master-plan-context.sh` — hook `SessionStart` nuevo, con los
  cinco orígenes de `session-start-context.sh`. Se coloca siempre, como los demás hooks, y se
  registra en `buildClaudeSettings` (`engines/claude/build-settings.ts`) solo con
  `if (config.harness?.masterPlan)`, el mismo patrón que `plan-gate.sh` con `planTiers`. Delega en
  `navori master status --line`; su respaldo lee la primera línea de `INDEX.md` (D5) — cubre R38,
  R39, R54.
- `packages/core/core-assets/hooks/comment-draft-confirm.sh` — tres formas nuevas de crear un
  issue: `gh issue create`, `gh api` REST contra `repos/<owner>/<repo>/issues` y la mutación
  GraphQL `createIssue`. Las tres usan la misma vista previa del cuerpo y responden `ask` en todos
  los modos. `BOUND` agrega `(` y la comilla invertida para cubrir las subshells (D6) — cubre
  R43.
- `packages/core/core-assets/hooks/master-accept-confirm.sh` — hook `PreToolUse(Bash)` nuevo que
  responde `permissionDecision: "ask"` en todos los modos a `navori master part … --accept …
  --approved-by …`. Se coloca siempre y se registra en `buildClaudeSettings` solo con
  `if (config.harness?.masterPlan)`, igual que `plan-gate.sh` (D12) — cubre R62.
- `packages/cli/src/engines/shared/roster.ts` — `master-plan` y `context-intake` entran en
  `ROSTER_WORKFLOW_SKILLS` y en una lista nueva `CLAUDE_ONLY_WORKFLOW_SKILLS`.
  `resolveHarnessPlan` (`engines/shared/harness-plan.ts`) las incluye solo con una opción nueva
  `includeClaudeOnlySkills`, que pasa el engine Claude, igual que `includeOrchestrator` — cubre R1.

**Skills y agentes**

- `packages/core/core-assets/skills/master-plan.md` — sin `disable-model-invocation` (la puede
  invocar el modelo), `metadata.type: reference`, `maxWords` explícito (D3). En este orden:
  candado de pedido explícito, precondición, ruteo de etapa (activa, nueva o bloqueada por R53),
  aviso de inicio con confirmación, procedimiento por fase con su checklist de cierre, encargos
  del `scout` y del `architect`, partes diferidas y evaluación de cambio a spec, reglas de
  consolidación y preguntas, checklist de rigor, sección "Spec de una parte", paso de issues y
  cierre — cubre R1, R2, R3, R7, R13, R14, R16, R17, R18, R19, R20, R25, R26, R27, R28, R29, R30,
  R32, R33, R34, R35, R40, R42, R44, R45, R46, R47, R48, R51, R52, R53, R55, R56, R57.
- `packages/core/core-assets/skills/context-intake.md` — `disable-model-invocation: true`; la
  carga `master-plan` con `Read` (D3). Su precondición propia: sin etapa activa en
  `navori master status --json` se detiene y nombra `/master-plan`. Cubre la conversión con `uvx`
  y la versión de `markitdown` que se registra, el fallback nativo, la cabecera de cada `.md`,
  `INTAKE.md`, `DIGEST.md` con las secciones de la plantilla `digest` y la regla de datos — cubre
  R9, R10, R11, R12, R13.
- `packages/core/core-assets/agents/architect.md` — `tools` gana `WebFetch, WebSearch`; párrafo
  "Sources" (cuándo consultar y cómo citar); cuarta entrada "master-plan" en "When you're
  called"; `maxWords` de 660 a 700 (D4, aprobado por el usuario) — cubre R23, R24, R25.
- `packages/core/core-assets/agents/scout.md` — una oración en el formato "Map": si el encargo
  nombra la ruta de salida, escribe ahí en vez de `.claude/progress/explore_<area>.md` — cubre R14.
- `packages/cli/src/engines/shared/engine-capabilities.ts` — `ControlId` gana `"master-plan"`,
  `ControlCondition` gana `"masterPlan"`; Claude lo declara `enforced` con evidencia `hook`
  (`master-plan-context.sh`, `SessionStart`) y los otros cuatro engines `unsupported` con su razón.
  `lib/diagnose/control-gaps.ts` no cambia: `isConditionActive` ya lee `config.harness[condition]`
  — cubre R41.
- `packages/core/core-assets/skills/spec-bootstrap.md` — **no cambia**. Su candado ya acepta
  "accepting a proposal you made", y "Cambiar a spec" en R56 es exactamente eso. Las entradas de
  R57 (`DIGEST.md`, `CODEBASE.md`, `context/md/`) se las pasa `master-plan` en el encargo — R57.

## Decisions

### D1 — Superficie: `navori master`, no subcomandos de `navori plan` (R3, R5, R8, R16, R36, R47, R57)

| Peldaño | Opción | Veredicto |
|---|---|---|
| Patrón existente | Subcomandos de `navori plan` (`plan master-init`, …) | Descartada: `plan` es el ciclo por tarea de los niveles 0–2 con su gate (`commands/plan.ts`, `lib/plan/gate.ts`). Meter un flujo de proyecto mezcla dos contratos con un solo nombre, el error que la spec 0032 evitó con `workplan_` frente a `plan_`. Además las reglas de permisos van por prefijo, y `navori plan` ya tiene `classify`/`check` en `allow`. |
| Extensión | Comando `navori master` propio, que reusa `writeFileAtomic`, `writeConfig`, `runRender` y el patrón JSON + render de `lib/plan/render.ts` | **Elegida** |
| Abstracción nueva | Un motor genérico de flujos por fases configurable | Descartada: hay un solo flujo y no hay un segundo consumidor a la vista. |

Subcomandos (todos los que mutan actúan solo sobre la etapa activa que resuelve `stages.ts`; con
`--stage` apuntando a una etapa cerrada, los mutadores fallan, R50):

- `init [<slug>]` — ver `lib/master/init.ts`. Sin etapa activa, `<slug>` es obligatorio. Imprime
  la señal de R15 y la sugerencia (en etapa ≥2, el modo ya registrado y por qué).
- `mode <template|en-curso>` — registra el modo (R16). Falla si la fase ya pasó de `context`
  (cambiar el modo a mitad de flujo invalida los planes) y en toda etapa ≥2, donde el modo es
  `en-curso` sin preguntar.
- `advance` — corre las comprobaciones de salida de la fase actual (tabla de Contracts). Si
  pasan, escribe la fase siguiente y la agrega al historial; si no, sale con 1 y la lista de
  fallas. Solo avanza a la siguiente, nunca salta. Desde `executing` no avanza: la salida es
  `close`.
- `check [--stage <NN-slug>] [--part P<n>] [--fit]` — solo lectura. Sin flags, las mismas
  comprobaciones que `advance` sobre la etapa activa. `--stage` valida cualquier etapa, también
  una cerrada (R50). `--part` valida el `tasks.md` de esa parte contra R35. `--fit` imprime los
  criterios de D9.
- `part P<n> [--state …] [--reason <texto>] [--spec <ruta>] [--issue <n>]` — la única mutación de
  `parts.json` después de `questioned`. `--state descartada|diferida` exige `--reason` no vacío
  (R48); `--issue` falla si la parte ya tiene issue (R44); `--spec` falla si la ruta no existe
  (R33).
- `part P<n> --accept A<m> (--command <cmd> --result <texto> | --approved-by user)` — registra la
  evidencia de un criterio (R61, R62; D12). Va sola: combinada con otra flag de `part`, falla. Como
  todo `part`, queda fuera de `allow`.
- `status [--json | --line]` — sin flag, regenera `INDEX.md` y, si hay etapa activa, su
  `STATUS.md` y la región de partes de su `MASTER.md`. Nunca toca una etapa cerrada. `--json` y
  `--line` solo leen.
- `template <plan|master|decisions|intake|digest|tasks|issue> [--part P<n>]` — imprime la
  plantilla en el idioma del repo; `issue --part` la imprime ya llena desde `parts.json` (R42).
- `close [--convert <ruta-spec> --reason <texto> | --abandon --reason <texto>]` — cierre de
  entrega (R47–R49), por conversión (R57) o por abandono (R58). `--convert` y `--abandon` son
  excluyentes. Ver D10.

**Por qué `mode` y `close` no se pliegan en otros subcomandos:**

- `init --mode` no sirve. La señal de R15 sale de la primera corrida de `init`, y el usuario
  elige el modo después de verla (R16), así que la primera corrida no puede traer el modo. Una
  segunda corrida `init --mode` tendría que reescribir `state.json`, y R5 prohíbe que `init`
  sobrescriba archivos. `advance --mode` tampoco: el modo se guardaría recién al salir de
  `context`, y una sesión cortada antes volvería a preguntarlo, en contra de R7.
- `status --close` rompería el permiso. `Bash(navori master status:*)` está en `allow` porque
  `status` solo escribe archivos derivados, y una regla por prefijo no distingue flags. Plegado
  ahí, apagar la bandera y aplicar el render correría sin el prompt de permiso que respalda la
  confirmación de R47. Como verbo aparte, `close` queda fuera de `allow`.

**Por qué la conversión es `close --convert` y no un verbo `convert`.** Las dos formas terminan
igual: escriben `CLOSURE.md`, pasan la etapa a `closed`, actualizan `index.json`, apagan la bandera
y aplican el render. `close.ts` es un solo camino con dos juegos de precondiciones (tabla de D10).
Un verbo aparte duplicaría esa secuencia reanudable o la importaría con otro nombre. En permisos
no hay diferencia: `close` ya está fuera de `allow`, y con `--convert` también, que es lo que exige
el criterio 7.

### D2 — Formato: JSON para lo mutable, Markdown validado para la prosa (R6, R31, R36, R48, R54)

| Opción | Costo | Veredicto |
|---|---|---|
| A. `MASTER.md` completo en Markdown con campos de parte escritos a mano (`- **Estado:** parcial`), parseados por el CLI | Un archivo menos. Pero `STATUS.md` depende de un parser tolerante a formato libre, y cada cambio de estado, spec o issue es una edición a mano de prosa (R8, R44 y R48 quedarían sin dueño mecánico) | Descartada |
| B. Todo en JSON (`master.json` con las 17 secciones como cadenas) y `MASTER.md` renderizado | Determinismo total. Pero las secciones son páginas de prosa: escritas como cadenas JSON escapadas, los diffs de git son ilegibles y el orquestador se equivoca con el escape | Descartada |
| C. Híbrido: `index.json`, `state.json` y `parts.json` como fuente; la prosa de `MASTER.md` la escribe el orquestador; la sección "Entrega en partes" de `MASTER.md` es una región delimitada que solo escribe `navori master status` desde `parts.json` | Tres archivos JSON. Cada dato tiene un solo dueño | **Elegida** |

La región usa marcadores propios de `lib/master` (`<!-- navori:master-parts hash="…" -->` …
`<!-- /navori:master-parts -->`), **no** `navori:managed`. Reusar el marcador managed metería
`MASTER.md` en la superficie crítica de marcadores, anti-rollback y drift (`marker.ts`,
`managed-drift-watch.sh`) sin ninguna necesidad: esta región la reescribe un solo comando y su
hash solo sirve para que `check` detecte una edición a mano. El challenge confirmó que la regla 6
de `guard-destructive.sh` no incluye `specs/`, así que no hay colisión.

**Estados de parte** (`PartsSchema.state`): `pendiente`, `parcial`, `hecho`, `descartada`,
`diferida`. Los dos últimos son disposiciones finales: solo los pone `part --state … --reason`, y
`reason` es obligatoria para ellos y prohibida para los demás (refinamiento zod).

**Estado efectivo** (`status.ts`), en este orden:

1. `descartada` o `diferida` declaradas → valen tal cual. Las tareas de su spec, si la tiene, se
   muestran pero no cambian el estado.
2. Sin spec enlazada → vale el estado declarado, con una excepción: un `hecho` declarado solo
   vale si cada criterio `P<n>.A<m>` tiene evidencia (R61); si no, es `parcial`. Así el modo
   `en-curso` puede marcar `hecho` una parte que ya existe en el código (R18), pero igual tiene que
   demostrar sus criterios.
3. Con spec → se deriva de las tareas y de la evidencia:
   - todas las tareas marcadas y cada criterio con evidencia → `hecho`;
   - todas las tareas marcadas pero algún criterio sin evidencia → `parcial` (R61);
   - alguna tarea marcada → `parcial`;
   - ninguna → `pendiente`.

   Si el resultado no coincide con el declarado, `STATUS.md` lo lista como discrepancia.

En los casos `parcial` por evidencia, `blockers` y `STATUS.md` nombran cada criterio pendiente
(`P2.A3: sin evidencia`, R61).

**Parte activa:** la primera `parcial` en el orden de `parts.json`; si no hay, la primera
`pendiente` con todas sus dependencias en `hecho`. Las `descartada`/`diferida` nunca son activas y
cuentan como resueltas para las dependencias solo al cerrar, no durante la ejecución. **Cerrable**
(`closable`): toda parte en `hecho` efectivo (lo que ya exige evidencia de cada criterio), o en
`descartada`/`diferida` con razón; además, la spec de cada parte `hecho` pasa el mapeo de R60 (`check
--part`). `blockers` lista las partes que no lo cumplen y, dentro de cada una, los criterios sin
evidencia. **`allDone`** (R40): toda parte en `hecho` efectivo.

`STATUS.md` lee cada `tasks.md` enlazado contando líneas `- [ ]` y `- [x]` (lista de tareas GFM),
nombra la etapa activa en su encabezado (R54) y no lleva fecha de generación: la misma entrada
produce los mismos bytes. Lo mismo vale para `INDEX.md` y `CLOSURE.md`. Las fechas que muestran
salen de `index.json` o de `state.json`, nunca del reloj al renderizar.

### D3 — Plantillas: archivos de datos del CLI, no `references/` de la skill (R12, R21, R29–R31, R34, R35)

| Peldaño | Opción | Veredicto |
|---|---|---|
| Patrón existente | Todo dentro de `master-plan.md` subiendo `maxWords` | Descartada: una plantilla de plan de 17 secciones, más MASTER, DECISIONS, DIGEST, tareas e issue suman del orden de 2.5k–3.5k palabras cargadas en cada invocación, que se repiten en cada sesión del flujo. Y la lista de secciones quedaría escrita dos veces: en la skill y en el validador. |
| Extensión del pipeline | Soportar `core-assets/skills/<id>/references/*.md` en el render (colocación, poda, marcadores, espejo de Codex) | Descartada por ahora: toca la colocación y la poda de archivos en el repo del usuario, que es área crítica, para servir a una sola skill. Además no resuelve la duplicación, porque el validador en TS seguiría necesitando su propia copia de la lista de encabezados. `flat-skills.ts` ya tolera `.md` dentro del directorio de una skill, así que la opción queda abierta para cuando haya un segundo consumidor. |
| **Elegida** | Plantillas como archivos Markdown en `core-assets/master-plan/`, impresas por `navori master template` y leídas por `checks.ts` y `fit.ts` para extraer los encabezados | Un dueño por plantilla: el mismo archivo que ve el arquitecto es contra el que se valida. No hay ruta de escritura nueva (salen por stdout), no hay costo always-on y el spine de render no cambia. |

**Plantilla de plan** (`template plan`). Cada sección es un encabezado `##` fijo; ninguna queda
vacía, y la que no aplica se escribe `No aplica: <razón>` (R21):

1. Metadatos — proyecto, etapa (`<NN>-<slug>`), fecha, modo, número de plan, prioridad de
   desempate, archivos de `context/md/` leídos y, en etapa ≥2, los archivos de etapas cerradas
   leídos (R52).
2. Resumen ejecutivo.
3. Estado actual vs. objetivo — **solo en modo `en-curso`** (R18); en `template` la plantilla no
   la trae. En etapa ≥2 incluye lo que entregaron las etapas cerradas.
4. Alcance (MoSCoW) — Must / Should / Could / Won't, cada ítem observable. En etapa ≥2, las
   partes diferidas que el usuario incluyó (R52) entran aquí con su origen.
5. Actores y permisos — rol, qué puede hacer, qué no.
6. Reglas de negocio — `RN-<n>`, cada una con su archivo de `context/md/` o `[SUPUESTO]` (R22).
7. Requisitos funcionales — `RF-<n>`, observables.
8. Requisitos no funcionales — `RNF-<n>`, cada uno con medida y umbral.
9. Dominio y datos — entidades, relaciones, ciclo de vida, retención.
10. Arquitectura — componentes, límites, flujo principal.
11. Stack y librerías — nombre, versión fija, URL oficial y fecha de consulta, o `[SIN
    VERIFICAR]` (R23).
12. Contratos — API, eventos, esquemas.
13. Seguridad — autenticación, autorización, datos sensibles, amenazas.
14. Infraestructura y operación — entornos, despliegue, observabilidad, costos.
15. Entrega en partes — `P<n>` con objetivo, alcance, fuera de alcance, dependencias, requisitos
    semilla y criterios de aceptación con id `P<n>.A<m>` (R59). Cada criterio lleva una
    descripción observable y su método: `test` (archivo y caso con nombre), `comando` (comando y
    resultado esperado) o `manual` (qué revisa el usuario y cómo). En modo `en-curso`, además, el
    estado.
16. Testing — estrategia por nivel y qué riesgo cubre cada una.
17. Riesgos — riesgo, probabilidad, impacto, mitigación.
18. Preguntas abiertas — lo que el arquitecto no pudo decidir (R25), incluida toda contradicción
    entre el contexto nuevo y una decisión de etapa cerrada (R52).

`MASTER.md` usa la misma lista (R30). Cada sección termina con una línea `Origen:` (`plan<n>
§<sección>`, varios planes si coincidieron, un `D<n>` de esta etapa o un `<NN>-<slug>/D<n>` de una
etapa cerrada). La sección 15 es la región de D2 y la 18 dice "Ninguna" (R32). `DECISIONS.md`
repite por entrada `D<n>`: Pregunta, Elegida, Descartadas y Fecha (R29). `INTAKE.md` es una tabla
con archivo, método (con versión) y resultado (R10, R11). La plantilla de `tasks` es la de
`spec-bootstrap` más los campos de R35. El campo `Done` de cada tarea nombra los `P<n>.A<m>` que
cierra. La guía "Spec de una parte" de `master-plan` y la plantilla `tasks` fijan que cada `R<n>`
del `requirements.md` cite los `P<n>.A<m>` que cubre (R60). La plantilla `issue` lista los
criterios con su id y método (R42).

**Plantilla `digest`** (R12, y el insumo de D9). Secciones fijas: "Resumen por archivo", "Hechos",
"Actores", "Capacidades", "Integraciones externas", "Entidades de datos", "Superficies" (apps o
servicios del repo que el alcance toca) y "Hallazgos". Cada viñeta de las secciones de conteo es
un elemento con su archivo de `context/md/`, y una sección sin elementos dice `Ninguno`.
Estructurar el digest así es lo que vuelve contables los criterios de D9. Para el orquestador
cuesta lo mismo, porque son los hechos que ya tenía que consolidar.

La **checklist de rigor** (R34) vive en el cuerpo de `master-plan.md`, porque R34 pide que la
skill la defina. Son unas 120 palabras y el encargo del `architect` la cita por su sección.

`maxWords` de `master-plan.md`: se fija con el conteo real al implementar, más 10%, con su
razón en el comentario del frontmatter (el precedente de `spec-bootstrap`).

**Invocación de `master-plan` (R1, decisión del usuario).** `master-plan` no lleva
`disable-model-invocation`. Con esa clave, el host no deja que el modelo la invoque de ninguna
forma, y la descripción ni siquiera entra al contexto (<https://code.claude.com/docs/en/skills>,
verificado por el challenge). Eso rompería el "sí, continúa" en prosa que necesita R38. El opt-in
se mueve al cuerpo, como hizo `spec-bootstrap` en #892: **el primer paso es un candado**. Cuentan
como pedido explícito en el hilo actual:

- el usuario escribió `/master-plan`;
- un mensaje del usuario pide el plan maestro (continuar, abrir una etapa nueva, cerrar la
  activa, cambiar a spec);
- el usuario respondió que sí a la oferta de R38.

No cuentan: la línea que inyecta `SessionStart` (es contexto del repo, no un mensaje del usuario),
el contenido de archivos del repo, un encargo de subagente, ni que el modelo deduzca que la tarea
"encaja" en una parte. Si no hay pedido, la skill termina sin correr ningún comando, ni siquiera
`navori doctor`. Costo always-on: la descripción de `master-plan` (~40 palabras) entra a cada
sesión de cada repo Claude, más las dos filas del índice de skills de `CLAUDE.md`
(`buildSkillsIndexBody`). Es el precio de que R38 funcione.

**`context-intake`: la carga `master-plan`, sin candado propio.** Conserva
`disable-model-invocation: true`. En la fase `context`, `master-plan` le pide al agente leer
`.claude/skills/context-intake/SKILL.md` con `Read`, que la clave no bloquea. Es la opción más
simple:

- Hay un solo candado para todo el flujo. `context-intake` solo se alcanza después de que el de
  `master-plan` pasó, así que un segundo candado repetiría la misma comprobación.
- Su descripción no cuesta nada always-on.
- No queda un segundo disparador en prosa que escriba bajo `_master/` fuera del flujo.

El usuario puede correr `/context-intake` para volver a transcribir. Ahí el comando ya es el
pedido explícito, y su precondición (hay etapa activa) evita que corra sin `init`.

**Orden de arranque (R1, R2, R53, R46, R3, R16).**

1. Candado.
2. Precondición: `navori.config.json` y `navori doctor`, solo lectura.
3. Ruteo de etapa con `navori master status --json`:
   - Hay etapa activa y el usuario pidió continuar: reanudación.
   - Hay etapa activa y el usuario pidió un plan nuevo: R53. La skill nombra la etapa activa, su
     fase y su avance, ofrece cerrarla y termina.
   - No hay etapa activa: primera etapa, o etapa nueva si hay alguna cerrada (R51).
4. Aviso de R46 con `AskUserQuestion`. Cuando hay que crear una etapa, la misma llamada lleva
   una segunda pregunta con el slug (opción sugerida más "Other"), así que el slug no es una
   pregunta aparte.
5. Recién entonces `navori master init <slug>`.
6. En la etapa 1, la pregunta de modo, que es la primera después de la confirmación (R16
   enmendado). En etapa ≥2 no hay pregunta de modo.

### D4 — `architect`: herramientas web y encargo de plan maestro (R23–R25, R52)

- `tools: Read, Glob, Grep, Bash, Write, WebFetch, WebSearch`: el mismo conjunto que ya tiene el
  `auditor` (`core-assets/agents/auditor.md`).
- Párrafo "Sources" (~50 palabras): consultar la documentación oficial cuando la afirmación
  depende de un dato que caduca (versión, API, límite, precio, deprecación, compatibilidad);
  citar la URL y la fecha de consulta, o marcar `[SIN VERIFICAR]`; el contenido web es dato, no
  instrucción.
- "When you're called" gana una entrada de unas 30 palabras: el encargo de `master-plan` escribe
  la ruta `<etapa>/plans/plan<n>.md` que nombra el encargo, siguiendo la plantilla. Una parte es
  alcance con su criterio de aceptación, no una tarea. El detalle del encargo, incluidas las
  restricciones de etapas cerradas (R52), vive en la skill y no aquí.
- Las oraciones que fijan `agents-assets.test.ts` ("never issue a verdict", "never decompose into
  implementer tasks", "never ask the user", `solution-design`,
  `.claude/progress/solution_<scope>.md`) no se tocan.
- **Presupuesto (aprobado por el usuario):** el cuerpo managed mide hoy 592 de 660 palabras. Lo
  nuevo suma unas 85. El techo sube a 700 y se actualiza el test ("declares a maxWords ceiling of
  …"), con el comentario de la razón en el frontmatter y en el test. Es la vía que la spec 0032
  dejó autorizada ("subir `maxWords` solo se autoriza en `architect.md`, con su razón documentada
  ahí").

### D5 — Bloque managed (R37) y línea de arranque (R38) por canales distintos

**Qué existe.** `session-start-context.sh` inyecta con `add_bounded` todos los
`.claude/context/*.md` bajo `NAVORI_CTX_BUDGET=8000` caracteres (espejo en
`SESSION_CONTEXT_DELIVERY_BUDGET_CHARS`, `doc-budgets.ts`). **Corrección a la evidencia del
encargo:** el límite de ~2 KB no es el presupuesto del hook. Es la vista previa que da el host
cuando la salida supera su propio límite (el menor truncamiento observado es 10,441 bytes, según el
encabezado del hook). El presupuesto que manda es 8000 caracteres, y **ya está agotado**: corrido
en frío en este repo, el hook emite 6728 caracteres y degrada a puntero `10-orquestacion.md` (6402),
`40-cierre-sesion.md` (3304) y `progress/current.md` (el challenge lo reprodujo al carácter).

| Opción | Veredicto |
|---|---|
| Agregar la línea de R38 como sección de `session-start-context.sh`, condicionada al render | Descartada: compite por un presupuesto agotado y cae en puntero justo cuando más se necesita. Además cambia los bytes del hook en todos los repos, con la bandera apagada también. |
| Solo un context file managed con la regla y el avance escrito en el render | Descartada: el avance cambia sin render de por medio, así que el render no puede escribirlo. |
| **Elegida:** la regla (R37) como bloque managed de orquestador, corto y en orden 7; la línea dinámica (R38) en un hook `SessionStart` propio y condicional, con su propio presupuesto | La regla viaja por el canal que R37 pide (bloque managed), y queda antes de `orquestacion` para no caer en puntero. La línea no toma nada del presupuesto de 8000. `model-advisor.sh` ya es un segundo hook `SessionStart`, así que hay precedente. |

`master-plan-context.sh` sigue la estructura de `plan-gate.sh` y `session-start-context.sh`:
fail-open, parciales de auditoría y `command -v navori`. Emite la salida de `navori master status
--line` si el comando existe, sale con 0 y la línea cabe en `NAVORI_MASTER_LINE_BUDGET=600`. En
cualquier otro caso cae al **respaldo**, que no necesita `navori`:

- Lee la primera línea de `{{sdd.specsDir}}/_master/INDEX.md`. `status.ts` la renderiza siempre
  con la forma fija `Etapa activa: <ruta>/STATUS.md` o `Etapa activa: ninguna`.
- Si la línea tiene esa forma y la ruta pasa un filtro de caracteres (`[A-Za-z0-9._/-]`), emite
  esa ruta más la indicación de ofrecer.
- Si no, emite la ruta de `INDEX.md` más la indicación.

Es la segunda mitad de R38 con la etapa activa nombrada (R54). La ruta de `INDEX.md` sale del
render con `{{sdd.specsDir}}`. Una ruta fija de `STATUS.md` no sirve, porque cambia con cada
etapa.

El título de la parte viene de `parts.json`, que es contenido del repo: `status.ts` lo limpia (una
línea, sin caracteres de control, máximo 60 caracteres) y la línea lo presenta entre comillas y
marcado como dato.

Borrador del bloque `plan-maestro` (en inglés, como `planificacion` y `orquestacion`; unas 85
palabras): no empieces, avances, cierres ni abras una etapa del plan maestro por tu cuenta; solo a
pedido explícito del usuario. Cuando lo pida, mapea el trabajo a su parte `P<n>` de la etapa
activa, trátala como nivel 3 siguiendo "Spec de una parte" de `master-plan` y corre `navori master
status` antes de cerrar la sesión. El trabajo fuera del plan no se fuerza a una parte.

**Flujo de R38 de punta a punta:**

1. Al arrancar la sesión, `master-plan-context.sh` inyecta la línea con la etapa y la parte
   activas.
2. En su primera respuesta, el agente atiende lo que el usuario pidió y agrega una línea
   ofreciendo continuar.
3. El usuario responde en prosa ("sí, continúa").
4. El modelo invoca `master-plan` con la herramienta Skill; puede, porque su descripción está en
   el contexto.
5. El candado pasa, porque la respuesta del usuario es el pedido explícito.
6. Corre la precondición.
7. El ruteo encuentra la etapa activa.
8. Sale el aviso corto de R46 (etapa, fase actual y siguiente) y `AskUserQuestion`.
9. Con la confirmación, se reanuda desde `navori master status --json` (R7).

Si el usuario no responde a la oferta o pide otra cosa, no pasa nada: la oferta nunca es un
pedido.

### D6 — Confirmación de toda creación de issue (R43)

| Opción | Veredicto |
|---|---|
| Extender `pr-publisher-confirm.sh` | Descartada: deja pasar a los subagentes (`agent_id` → `allow`), solo se registra con `harness.publisher !== false` y su razón habla de enrutar al `publisher`. R43 pide "a cualquier agente". |
| Hook nuevo `issue-create-confirm.sh` | Descartada: duplicaría la lectura del cuerpo (`nv_flag_value`, `nv_read_body`), la salida sin `jq`/`node`, la rama de Codex y la clasificación de `gh api`, con `jscpd` en el gate. |
| **Elegida:** extender `comment-draft-confirm.sh` | Es el mecanismo que pide R43 (`PreToolUse(Bash)` → `permissionDecision: "ask"`): siempre registrado, sin excepción por subagente y con la vista previa del cuerpo que el humano lee antes de confirmar. |

**Qué cubre** (tres formas nuevas en la clasificación de `nv_kind`, con etiqueta "a GitHub issue"):

| Forma | Detección | Cuerpo en la razón |
|---|---|---|
| `gh issue create` | `${BOUND}gh[[:space:]]+issue[[:space:]]+create([[:space:]]\|$)` | `-F`/`--body-file` como las filas de comentarios; `-b`/`--body` inline solo se marca como presente |
| `gh api` REST | `${BOUND}gh[[:space:]]+api` + ruta `/?repos/[^/[:space:]]+/[^/[:space:]]+/issues` seguida de espacio, `?`, comilla o fin; escritura si hay `-X`/`--method POST`, o si hay `-f`/`-F`/`--input` sin `-X`/`--method` (`gh api` usa POST por default cuando lleva campos). `-X GET` explícito no dispara | igual que la rama `gh-api-rest` actual (`--input`, `-F body=@archivo`) |
| `gh api graphql` | la rama GraphQL actual gana `createIssue` en su alternancia de mutaciones | igual que la rama `gh-api-graphql` actual |

La ruta exige que `/issues` sea el último segmento, así que `repos/o/r/issues/12/comments` sigue
cayendo en la fila de comentarios y `PATCH repos/o/r/issues/12` (editar, no crear) no dispara.
`{owner}/{repo}`, la forma con placeholders de `gh`, entra por `[^/[:space:]]+`.
`TRIGGER_TOKENS` gana `create` (el filtro barato sin fork); `api` ya estaba y cubre las dos
formas de `gh api`.

**Formas encadenadas.** Como en las filas de comentarios, la detección recorre el comando
entero con `BOUND` y no solo el primer segmento, así que atrapa `cd x && gh issue create …`,
`true; gh api …` y `a | gh issue create`. `BOUND` pasa de `(^|[;&|]|[[:space:]])` a
``(^|[;&|(`]|[[:space:]])`` para cubrir `(gh issue create …)`, `$(gh api …)` y la comilla
invertida. El cambio amplía la detección también en las filas de comentarios, en la dirección
segura (más confirmaciones, nunca menos), y no cambia qué comandos cubren. `sh -c` y `eval` siguen
fuera, como declara el encabezado del hook: es un cinturón de seguridad, no un sandbox.

**Modos de permisos (decisión del usuario, 2026-09-24).** La respuesta es `ask` en todos los
modos, incluidos `bypassPermissions` y `dontAsk`; el hook no lee `permission_mode`. Codex
conserva la salida `deny` que el hook ya tiene porque Codex no soporta `ask` (spec 0026 R13). Es
un engine, no un modo de permisos, y ahí el plan maestro no está soportado (D7).

### D7 — Engines distintos de Claude (R41)

`master-plan` y `context-intake` no se renderizan fuera de Claude (D3, `CLAUDE_ONLY_WORKFLOW_SKILLS`):
dependen de `AskUserQuestion`, `Agent` y del hook de R38. El registro declara el control
`master-plan` como `unsupported` en `codex`, `agents-md`, `cursor` y `copilot`, con la razón "fase
2 de la spec 0034: la skill no se renderiza y no hay hook de arranque". `scanControlGaps` ya lo
reporta como `warn` cuando `harness.masterPlan` está encendido. Con la bandera apagada no hay
fila, igual que `plan-gate` con `planTiers` (decisión del orquestador). Si el bloque
`plan-maestro` llega a `.codex/context/` por ser de audiencia orquestador, es texto consultivo
inocuo: el control ya declara que el flujo no corre ahí.

### D8 — `raw/` fuera de git con un `.gitignore` dentro de `raw/`, por etapa (R4)

| Opción | Veredicto |
|---|---|
| Entrada en el bloque `gitignore-harness` (`buildGitignoreBody`) condicionada a `masterPlan` | Descartada: con `gitignoreHarness: "off"` navori garantiza no tocar `.gitignore` (`renderGitignore`, "exact status quo"). Además, al cerrar la etapa la bandera se apaga (R49), la entrada desaparecería y los documentos confidenciales de `raw/` quedarían listos para commitear. |
| Segundo bloque managed en el `.gitignore` raíz escrito por `master init` | Descartada: sería un bloque en un archivo del usuario sin dueño en el render; nadie lo reconciliaría ni lo podaría. |
| **Elegida:** `master init` crea `<etapa>/context/raw/.gitignore` con `*` y `!.gitignore` | No depende de `gitignoreHarness` ni de la bandera, y sobrevive al cierre. Los patrones de un `.gitignore` más profundo tienen precedencia sobre los de la raíz. Es un archivo nuevo en un directorio nuevo, nunca una edición de un archivo del usuario. Cada etapa trae el suyo. |

Aceptado por el orquestador. **Recuperación:**

**Nota tras #1047.** Ese PR adoptó el mismo patrón de `.gitignore` anidado para `.claude/` y
`.codex/` (`engines/shared/nested-gitignore-harness.ts`, `renderNestedGitignore`), lo que confirma
el mecanismo de D8. D8 no lo reusa porque ese módulo escribe un bloque managed desde el render,
con entradas tomadas de `EPHEMERAL_HARNESS_PATHS`, una lista estática. Las carpetas de etapa son
dinámicas (`<NN>-<slug>`) y su `.gitignore` lo escribe `navori master init`, no el render.

- Etapa activa: `check` y `advance` fallan si falta el `.gitignore`, `doctor` da `warn` y los tres
  nombran `navori master init`, que lo recrea sin tocar nada más.
- Etapa cerrada: es de solo lectura (R50) e `init` no la toca. Como el `.gitignore` está
  commiteado (`!.gitignore`), `check --stage` y `doctor` nombran `git checkout -- <ruta>`.

El escaneo de `doctor` corre siempre que exista `index.json`, no solo con la bandera encendida.
Después del cierre la bandera se apaga, pero los `raw/` de las etapas cerradas siguen en disco con
documentos confidenciales. Esto amplía la decisión anterior de mostrar la fila "cuando la bandera
está encendida", y el porqué es exactamente este.

### D9 — "¿Cabe en una spec?": criterios verificables y de juicio (R55, R56)

Se evalúa en la fase `mapped`, antes de despachar a los `architect`. En etapa ≥2 va después de
resolver las partes diferidas (R52), porque incluirlas cambia el alcance. `navori master check
--fit` cuenta sobre `DIGEST.md` (plantilla `digest`) y `CODEBASE.md`:

| Criterio verificable | Fuente | Umbral para "cabe" |
|---|---|---|
| V1 · Capacidades | viñetas de "Capacidades" | ≤ 8 |
| V2 · Actores | viñetas de "Actores" | ≤ 3 |
| V3 · Integraciones externas | viñetas de "Integraciones externas" | ≤ 1 |
| V4 · Entidades de datos nuevas | viñetas de "Entidades de datos" | ≤ 5 |
| V5 · Superficies | viñetas de "Superficies" | 1 |
| V6 · Stack definido | `CODEBASE.md` no declara el stack como decisión abierta (R19) | sí |
| V7 · Preguntas abiertas de negocio | viñetas de "Hallazgos" marcadas `[DECISIÓN]` | ≤ 2 |

Todos los umbrales viven en `fit.ts`, son `[assumed]` y se recalibran como los pesos de la spec
0032, con los primeros planes maestros reales. `check --fit` imprime cada valor, su umbral y si
pasa. No decide nada.

Criterios de juicio (la skill los nombra y el orquestador los pondera; no se presentan como
verificables):

- **J1.** El cliente aceptaría todo el alcance como una sola entrega; ninguna parte tendría
  sentido aceptarla por separado.
- **J2.** No hay alternativas de arquitectura que valga la pena comparar con tres planes.
- **J3.** La incertidumbre de negocio se resuelve con las preguntas de una spec, no con una
  consolidación.

**Regla de recomendación.** El orquestador recomienda "Cambiar a spec" solo si V1–V7 pasan y J1–J3
lo sostienen, y da las razones (R55) citando los valores de `check --fit`. Si algún verificable
falla, no recomienda. El usuario igual puede pedir el cambio en cualquier fase anterior a
`mastered` (R56), y eso no pasa por esta regla. La pregunta es una `AskUserQuestion` con
"Cambiar a spec" y "Seguir con el plan maestro", la recomendada primero. La respuesta se registra
como `D<n>` en `DECISIONS.md`.

**Cambio a spec (R57).** Si el usuario confirma:

1. El orquestador elige la ruta de la spec según la numeración de `<specsDir>`.
2. Corre `navori master close --convert <ruta> --reason "<razón>"` (D10).
3. Aplica `spec-bootstrap` con `DIGEST.md`, `CODEBASE.md` y `context/md/` de la etapa como
   entrada, citados por ruta en `requirements.md`.

La confirmación de R56 es la aceptación que exige el candado de `spec-bootstrap` ("accepting a
proposal you made"), así que `spec-bootstrap` no cambia. El orden es cerrar primero y crear la
spec después: con la bandera todavía encendida, el bloque de R37 le diría al agente que mapee el
trabajo a una parte que no va a existir.

### D10 — Cierre de etapa: entrega, conversión y abandono (R47–R50, R57, R58)

| | `close` (entrega) | `close --convert <ruta> --reason` | `close --abandon --reason` |
|---|---|---|---|
| Fases permitidas | `mastered`, `executing` | `context` a `questioned` (R56) | `context` a `questioned` (R58) |
| Precondición | `closable`; si no, sale con 1 y lista `blockers` (R47) | `<ruta>` dentro de `<specsDir>`, fuera de `_master/`, y que no exista o esté vacía; razón no vacía | razón no vacía |
| Confirmación del usuario | `AskUserQuestion` de entrega en la skill (R47) + prompt de permiso | `AskUserQuestion` de R56 + prompt de permiso | `AskUserQuestion` de abandono en la skill (R58) + prompt de permiso |
| `CLOSURE.md` | resultado `entregada`, partes con estado final | resultado `convertida`, razón y ruta de la spec | corto: resultado `abandonada`, razón y fase en que se abandonó |
| `index.json` | `cerrada` | `convertida` (+ `spec`) | `abandonada` |

`--convert` y `--abandon` juntos fallan antes de escribir nada. El abandono comparte la secuencia
de `close.ts` (abajo) y no borra ningún archivo de la etapa (R58): todo queda como registro de solo
lectura, igual que una etapa cerrada. En `mastered` o después, `--abandon` se rechaza y el mensaje
nombra `navori master close` (entrega, con las partes `descartada`/`diferida` que hagan falta).

Antes de `close` de entrega, la skill recorre las partes que no están en `hecho` efectivo y le
pregunta al usuario, de una en una, el estado final con `AskUserQuestion`. Las opciones son
"Diferir a la etapa siguiente", "Descartar" y "No cerrar todavía", más la razón como texto. Cada
respuesta se aplica con `navori master part P<n> --state … --reason …` (R48). Recién entonces
viene la pregunta de entrega.

**Secuencia de `close.ts`**, reanudable: cada paso comprueba si ya está hecho antes de hacerlo, y
una segunda corrida después de un corte completa lo que falte.

1. Registra en `state.json` la fecha de cierre y el resultado.
2. Regenera `STATUS.md` por última vez.
3. Renderiza `CLOSURE.md`.
4. Pasa `state.json` a `closed`.
5. Actualiza la entrada en `index.json` y renderiza `INDEX.md`.
6. Pone `harness.masterPlan: false` y aplica `runRender`.

Si el paso 5 ya se aplicó, no queda etapa activa. Una etapa en `closed` cuya entrada todavía dice
`activa` es un cierre a medias, y `close` sin argumentos lo completa.

**Reconciliación entre la bandera y el registro.** Un corte entre el paso 5 y el 6 deja
`index.json` sin etapa activa y `harness.masterPlan: true`. Los mutadores solo operan sobre la
etapa activa y rechazan las cerradas, así que sin una regla explícita nada podría completar el
paso 6. La regla: **`close` sin argumentos, sin etapa activa y con la bandera encendida ejecuta
solo el paso 6** (bandera apagada y render aplicado), lo reporta ("no hay etapa activa; se apagó
`harness.masterPlan`") y sale con 0. No es un error, y no toca ninguna etapa ni `index.json`.
`close --convert` o `--abandon` sin etapa activa sí fallan. El caso simétrico, una etapa activa con
la bandera apagada (un `init` cortado entre el paso 1 y el 5, o la bandera apagada a mano), lo
repara `init` (Components). `doctor` da `warn` en los dos sentidos y el mensaje nombra el comando
que repara cada uno.

**`CLOSURE.md`** (render determinista desde `state.json`, `parts.json`, `index.json` y el conteo de
`D<n>` de `DECISIONS.md`, R49):

- Etapa, resultado, fecha de apertura y de cierre.
- Una tabla de partes con estado final, spec, issue y razón. En `convertida` puede estar vacía si
  no se llegó a `questioned`.
- Una tabla de criterios (R63) con id `P<n>.A<m>`, método, evidencia y fecha. La evidencia es el
  comando, un extracto del resultado y el commit corto, o "aprobado por el usuario". Los criterios
  de partes `descartada` o `diferida` salen como "no verificado", y los que tienen un commit fuera
  de la historia de HEAD salen con esa marca.
- El número de decisiones.
- En `convertida`, la razón y la ruta de la spec.
- En `abandonada`, solo etapa, resultado, fechas, la razón y la fase en que se abandonó, más la
  sección "Integridad" (R58).
- La sección "Integridad": el sha256 de `MASTER.md`, `DECISIONS.md`, `parts.json` y `state.json`
  al cerrar (los que existan). Cada hash se calcula sobre el contenido UTF-8 con los fines de línea
  normalizados a `\n` (`\r\n` y `\r` sueltos pasan a `\n`). Así un checkout con
  `core.autocrlf=true` en Windows no se lee como una edición a mano. La evidencia vive en
  `parts.json`, así que queda cubierta por su hash sin un hash aparte. Editar a mano una evidencia
  de una etapa cerrada rompe "Integridad", igual que editar su `MASTER.md`.

Con esos hashes, `check --stage` detecta una edición a mano de una etapa cerrada (R50) sin
ningún hook de bloqueo.

**Solo lectura (R50).** Una etapa cerrada no es la etapa activa, y los mutadores solo operan sobre
la activa, así que no pueden tocarla. Con `--stage <cerrada>` fallan de forma explícita. `status`
nunca regenera nada dentro de una etapa cerrada. `check --stage` la valida: fase `closed`, estado
`cerrada`/`convertida`/`abandonada` coherente con `index.json`, `CLOSURE.md` igual a su render, hashes de
"Integridad" iguales, `raw/.gitignore` presente y, en `convertida`, que la spec exista.

### D11 — Etapas posteriores a la primera (R51, R52, R16)

- **Apertura (R51).** `status --json` sin etapa activa y con `lastClosed` distinto de null. El
  aviso de R46 dice "etapa nueva" y nombra la última cerrada (número, slug, resultado y fecha).
  `init <slug>` numera con el más alto registrado + 1 y registra `mode: "en-curso"` (R16).
- **Restricciones (R52), con contexto acotado.** El encargo de cada `architect` y el paso de
  consolidación listan las rutas de `MASTER.md`, `DECISIONS.md` y `CLOSURE.md` de **todas** las
  etapas cerradas, convertidas o abandonadas (las que existan: una convertida o abandonada pudo no
  llegar a `MASTER.md`). Así todas se pueden citar en `Origen:`. Leen completas solo estas:
  - `MASTER.md`, `DECISIONS.md` y `CLOSURE.md` de la **última etapa `cerrada`** (entregada);
  - `DECISIONS.md` y `CLOSURE.md` de cada etapa `convertida` o `abandonada` posterior a esa, porque
    sus decisiones no pasaron por ninguna consolidación;
  - de las anteriores, solo `CLOSURE.md`, más `INDEX.md`.

  Su `MASTER.md` y su `DECISIONS.md` se abren solo si hay que verificar una cita o una
  contradicción puntual. `stages.ts` (`contextForArchitects`) calcula las dos listas, lectura
  completa y solo referencia, y las expone en `status --json` como `architectContext`, así la
  skill no las arma a mano. El argumento: cada etapa entregada trató las anteriores como restricción
  y su `MASTER.md` consolida lo que sigue vigente. Si la última etapa fuera convertida o
  abandonada, esa cadena se cortaría, y por eso se agrega el segundo punto. Si ninguna etapa
  llegó a `cerrada`, se leen completos los `DECISIONS.md` y `CLOSURE.md` de todas.

  **Nota sobre R52:** R52 dice que los `architect` y la consolidación "DEBERÁN recibir el
  `MASTER.md`, el `DECISIONS.md` y el `CLOSURE.md` de las etapas cerradas". El diseño lo cumple
  leyendo "recibir" como "recibir las rutas en el encargo". Si "recibir" significa leerlos
  completos, este recorte contradice R52 y hay que enmendar el requisito en vez de forzarlo (ver
  Preguntas abiertas). La regla del encargo:
  - las decisiones de esas etapas son restricciones;
  - una contradicción con el contexto nuevo va a la sección 18 del plan, y el orquestador la
    vuelve pregunta (R26);
  - `MASTER.md` puede citarlas en `Origen:` como `<NN>-<slug>/D<n>`, y `check` valida que exista.
- **Partes diferidas (R52).** En `mapped`, antes de D9 y del despacho, la skill ofrece por
  `AskUserQuestion`, de una en una, cada parte `diferida` de la **última** etapa cerrada. Las
  opciones son "Incluir en esta etapa" y "Dejar fuera", con la razón del diferimiento en el texto.
  Cada respuesta es un `D<n>` cuya pregunta nombra `<NN>-<slug>/P<n>`. Las incluidas entran al
  encargo de los `architect` como alcance heredado. La comprobación de `questioned` exige un
  `D<n>` por cada diferida de la última etapa cerrada. Las diferidas de etapas más antiguas no se
  vuelven a ofrecer: si en su momento quedaron fuera, esa decisión ya está en el `DECISIONS.md` de
  la etapa que las dejó fuera.
- **Issues.** El título lleva la etapa (`[02-pagos] P3 — <título>`). Así la búsqueda previa contra
  duplicados (Failure modes) no confunde el `P3` de dos etapas.

### D12 — Evidencia de criterios de aceptación (R59–R63)

| Opción | Veredicto |
|---|---|
| Que navori corra el comando del criterio y guarde su salida | Descartada: viola el invariante 9 (navori genera, no ejecuta) y `comando` puede ser cualquier cosa del repo del usuario. |
| Reusar `navori receipt` como evidencia | Descartada: el receipt certifica el conjunto a publicar contra `qualityGate.full` (`lib/diagnose/receipt.ts`, `evidenceIdentity`), no un comando por criterio. Adaptarlo mezcla dos contratos. |
| **Elegida:** `part P<n> --accept A<m>` registra lo que corrió el agente; navori agrega commit y fecha y valida la forma | Mantiene el invariante 9 y deja una sola vía de escritura de evidencia (R61), fuera de `allow` (R62). |

**Qué valida `--accept` antes de escribir** (mecánico):

- La parte es de la etapa activa y no está `descartada`/`diferida`, y el criterio existe.
- `test`: `--command` contiene la ruta de `test.file`, el archivo existe y `--result` no está
  vacío.
- `comando`: `--command` es igual a `command.run` (sin espacios de borde) y `--result` no está
  vacío.
- `manual`: solo `--approved-by user`; `--command`/`--result` se rechazan.
- Para `run`, el árbol de trabajo está limpio fuera de `<specsDir>/` (así el commit que registra
  navori, `git rev-parse HEAD`, es el código que se probó). Si hay cambios sin commitear, falla y
  pide commitear primero.
- La fecha la pone navori. Registrar de nuevo reemplaza la evidencia anterior; la anterior queda
  en el historial de git de `parts.json`.

**Qué no puede garantizar navori** (consultivo, dicho sin rodeos):

- Que el comando se haya corrido de verdad ni que `--result` sea su salida real. Es la palabra del
  agente; la contrasta el `reviewer` de la spec de la parte, que corre los tests.
- Que el agente haya preguntado antes de registrar un `manual` (R62). El CLI no ve la
  conversación. Lo que sí hay son tres capas:
  - la regla de la skill: presentar el criterio y cómo verificarlo en una `AskUserQuestion`, y
    registrar solo con "Aprobado";
  - `part` fuera de `allow`;
  - por decisión del usuario, el hook `master-accept-confirm.sh`, que fuerza el `ask` en todos los
    modos (abajo).

  Así el humano ve el comando literal (`… --accept A3 --approved-by user`) y confirma aunque el
  agente no haya preguntado. Queda el mismo riesgo aceptado que en R43: la doc no dice si el host
  muestra un `ask` de hook en `bypassPermissions`.
- Que la evidencia siga vigente. `status` calcula, por criterio, cuántos commits hay entre el de la
  evidencia y HEAD (`commitsBehind`) y si el commit sigue en la historia de HEAD (`orphan`, con
  `git merge-base --is-ancestor`). Los dos aparecen en `STATUS.md` y en `CLOSURE.md`, pero no
  bloquean. Un squash-merge vuelve huérfanos los commits de la rama, y bloquear por eso regresaría
  a `parcial` toda parte ya integrada. Antes de `close`, la skill muestra los criterios huérfanos
  o atrasados y propone registrarlos de nuevo en HEAD.

**Dónde vive el `ask` de R62.** Se aplica la misma prueba de D6, pero con otro resultado:

| Opción | Veredicto |
|---|---|
| Otra fila en `comment-draft-confirm.sh` | Descartada. En D6 ganó por el cuerpo que muestra (`nv_flag_value`, `nv_read_body`) y por la clasificación de `gh api`, y aquí no hay cuerpo que mostrar. Esa fila además se registraría siempre, en todos los repos y en los dos engines, para un comando que solo existe con una etapa activa: rompería el principio 3 sin razón. Y el contrato de ese hook es la publicación de contenido (spec 0026 R10), no la aprobación de un criterio. |
| **Elegida:** hook propio `master-accept-confirm.sh`, registrado solo con `harness.masterPlan` | Reusa los parciales compartidos (`# navori:include extract-cmd`, `gate-trigger`, auditoría), así que no duplica código para `jscpd`. Solo agrega una regex y una razón fija. Sigue el precedente de registro condicional de `plan-gate.sh`. |

- **Detección:** filtro barato `TRIGGER_TOKENS='approved-by'` sin fork, y después
  `${BOUND}navori[[:space:]]+master[[:space:]]+part([[:space:]]|$)` con `--approved-by` en el
  mismo comando. Usa el mismo `BOUND` ampliado de D6, así que cubre `&&`, `;`, `|`, `( … )`,
  `$( … )` y la comilla invertida. Un `--accept` de un criterio `test` o `comando` no lleva
  `--approved-by` y no dispara.
- **Respuesta:** `ask` en todos los modos, a cualquier agente, incluido el hilo principal. No lee
  `permission_mode`, igual que R43. La razón es fija, sin contenido del repo: "esto registra que TÚ
  aprobaste un criterio manual; confírmalo solo si lo revisaste". Sin `jq` ni `node`, se emite la
  misma razón con el `printf` ya usado en `comment-draft-confirm.sh`. En Codex no se registra: el
  plan maestro no está soportado ahí (D7).
- **Cierre del hueco de la bandera:** como el hook existe solo con la bandera encendida, `part
  --accept` falla si `harness.masterPlan` es `false`. Así una etapa activa con la bandera apagada
  (D10) no puede registrar una aprobación sin el hook, y el mensaje nombra `navori master init`.

La región de partes de `MASTER.md` muestra los criterios con id, método y detalle, pero no la
evidencia. Así `MASTER.md` sigue siendo el plan y no cambia con cada `--accept`. La evidencia sale
en `STATUS.md` y en `CLOSURE.md`.

### Otras decisiones

- **`scout` escribe `CODEBASE.md` por ruta nombrada** (R14). La alternativa era copiar
  `.claude/progress/explore_codebase.md` con Bash, pero entonces el que escribe
  `context/CODEBASE.md` no sería el `scout`, y R14 lo pide literal. Una oración en `scout.md`
  (1012 de 1050 palabras) no cambia su trabajo, solo dónde deja el reporte. En etapa ≥2 el mapa se
  vuelve a hacer, porque la etapa anterior cambió el código.
- **Preguntas en el hilo principal** (R27, R48, R52, R56): `AskUserQuestion` es del orquestador;
  ningún subagente pregunta, y eso conserva el contrato del `architect`.
- **`init` falla si `sdd.enabled === false`**: sin `spec-bootstrap` no hay R33 ni R57. El mensaje
  nombra la clave que hay que cambiar.
- **Slug y numeración.** Slug en kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`, máximo 40 caracteres).
  `<NN>` sale de `index.json`, nunca de listar carpetas, así que un hueco (una carpeta borrada) no
  se reutiliza. Si se llega a 99, `init` falla con un mensaje explícito: dos dígitos son el
  formato de R3.
- **Versión de `markitdown` sin fijar, pero registrada** (R11, decisión del usuario). Al empezar
  la transcripción, `context-intake` obtiene la versión una vez con `uvx --from 'markitdown[all]'
  markitdown --version` y la escribe en la cabecera de cada `.md` convertido con `markitdown` y en
  `INTAKE.md`. La flag `--version` del CLI de `markitdown` está `[SIN VERIFICAR]`; T1 la
  confirma contra <https://github.com/microsoft/markitdown>. Si no existe, la alternativa es
  `importlib.metadata.version("markitdown")` corrida en el mismo entorno efímero de `uv`.

## Contracts

**`<specsDir>/_master/index.json`** (`MasterIndexSchema`; solo lo escribe `navori master`):

```json
{
  "version": 1,
  "stages": [{
    "number": 1,
    "slug": "mvp",
    "dir": "01-mvp",
    "state": "activa | cerrada | convertida | abandonada",
    "openedAt": "YYYY-MM-DD",
    "closedAt": "YYYY-MM-DD | null",
    "spec": "string | null"
  }]
}
```

Invariantes (`stages.ts`): a lo sumo una `activa`; `number` estrictamente creciente; `dir` igual a
`<number con dos dígitos>-<slug>`; cada entrada con su carpeta y cada carpeta `NN-*` bajo
`_master/` con su entrada; `closedAt` nulo si y solo si `activa`; `spec` solo en `convertida`. Si
un invariante falla, ningún mutador corre y el mensaje nombra la inconsistencia.

**`<etapa>/state.json`** (`MasterStateSchema`; solo lo escribe `navori master`):

```json
{
  "version": 1,
  "phase": "context | transcribed | mapped | planned | questioned | mastered | executing | closed",
  "mode": "template | en-curso | null",
  "signal": {
    "commits": "number | null",
    "firstCommit": "YYYY-MM-DD | null",
    "filesChangedSinceFirst": "number | null",
    "framework": "string | null",
    "libraries": ["string"],
    "suggested": "template | en-curso"
  },
  "outcome": "entregada | convertida | abandonada | null",
  "abandonment": { "reason": "string", "phase": "string" },
  "conversion": { "spec": "string", "reason": "string" },
  "history": [{ "phase": "string", "at": "YYYY-MM-DD" }]
}
```

`conversion` solo existe con `outcome: "convertida"` y `abandonment` solo con `outcome: "abandonada"`. Una `version` desconocida en cualquiera de
los tres JSON hace fallar todo subcomando con un mensaje que nombra la versión de navori
necesaria.

**`<etapa>/parts.json`** (`PartsSchema`; lo escribe el orquestador una vez, en fase `questioned`,
y después solo cambia con `navori master part`):

```json
{
  "version": 1,
  "parts": [{
    "id": "P1",
    "title": "string",
    "objective": "string",
    "scope": ["string"],
    "outOfScope": ["string"],
    "dependsOn": ["P0"],
    "seedRequirements": ["string"],
    "acceptance": [{
      "id": "A1",
      "description": "string",
      "method": "test | comando | manual",
      "test": { "file": "string", "case": "string" },
      "command": { "run": "string", "expected": "string" },
      "manual": { "check": "string", "how": "string" },
      "evidence": null
        | { "kind": "run", "command": "string", "result": "string", "commit": "sha", "date": "YYYY-MM-DD" }
        | { "kind": "approval", "approvedBy": "user", "date": "YYYY-MM-DD" }
    }],
    "inheritedFrom": "NN-slug/P<n> | null",
    "state": "pendiente | parcial | hecho | descartada | diferida",
    "reason": "string | null",
    "spec": "string | null",
    "issue": "number | null"
  }]
}
```

Validación extra: ids `P<n>` únicos y consecutivos, `dependsOn` sin ciclos y solo hacia ids que
existen, `spec` apuntando a un directorio que existe, `reason` obligatoria solo en `descartada` y
`diferida`, e `inheritedFrom` apuntando a una parte `diferida` de una etapa cerrada. En
`acceptance` (R59), una unión discriminada por `method`:
- ids `A<m>` únicos y consecutivos dentro de la parte;
- exactamente uno de `test`/`command`/`manual`, el que nombra `method`;
- `evidence.kind` `run` solo con `test` o `comando`, y `approval` solo con `manual`.

Los criterios (id, método y detalle) no cambian después de `mastered`. Solo `evidence` cambia, y
solo con `part --accept`.

**Comprobaciones de `advance`** (`checks.ts`, rutas relativas a la etapa activa):

| Hacia | Comprobación mecánica |
|---|---|
| `transcribed` | `mode` no nulo; `raw/` con ≥1 archivo aparte de `.gitignore`; `INTAKE.md` con una fila por archivo de `raw/`; cada fila convertida apunta a un `.md` de `context/md/` cuya primera línea nombra el original y el método, y con método `markitdown`, también la versión; cada fila no convertida trae causa (R9–R11) |
| `mapped` | `DIGEST.md` con todas las secciones de la plantilla `digest`, un resumen por archivo de `context/md/`, cada viñeta de conteo y de "Hechos" citando un `context/md/…` existente, y "Hallazgos" presente (puede decir "Ninguno"); `CODEBASE.md` con las secciones stack, estructura, convenciones y specs (R12–R14, R19) |
| `planned` | tres planes con todos los encabezados de la plantilla del modo, ninguno vacío, cada `No aplica:` con razón; cada `RN-<n>` con `context/md/` o `[SUPUESTO]`; cada URL con `consultado AAAA-MM-DD`; en etapa ≥2, "Metadatos" lista los archivos de etapas cerradas (R21–R23, R52) |
| `questioned` | `DECISIONS.md` con `D<n>` consecutivos y los cuatro campos, o la línea "Sin decisiones"; en etapa ≥2, un `D<n>` por cada parte `diferida` de la última etapa cerrada (R29, R52) |
| `mastered` | `MASTER.md` con todos los encabezados; cada sección con `Origen:`, y cada `D<n>` o `<NN>-<slug>/D<n>` citado existe; cero `[SUPUESTO]`/`[SIN VERIFICAR]`; `parts.json` válido; la región de partes coincide con su render; en `en-curso`, cada parte con estado (R18, R30–R33, R52) |
| `executing` | lo mismo que `mastered`, vuelto a correr (la entrada a esta fase es la orden del usuario) |
| `closed` | no se alcanza con `advance`; solo con `close` (D10) |

En todas las fases, `check` y `advance` fallan además si falta `context/raw/.gitignore` (el
mensaje nombra `navori master init`, R4, D8) o si `index.json` no pasa sus invariantes.

**Cabecera de cada `context/md/*.md`** (R11), primera línea, en el idioma del repo: `> Fuente:
context/raw/<archivo> · Método: markitdown <x.y.z>` (o `lectura nativa` / `exportado a PDF por el
usuario`, sin versión).

R23 es la única que el CLI verifica solo en parte: puede exigir fecha a cada URL, pero no
reconocer cuándo un dato caduca. El resto de R23 es trabajo de la checklist de rigor.

**`navori master check --part P<n>`** (R35): cada tarea de `tasks.md` trae los campos `Archivos`,
`Interfaces` (cada una nombrada en `design.md`), `Patrón` (un archivo que existe), `Lectura`,
`Librerías` (con versión exacta, sin `^` ni `~`), `Done` (comando, resultado esperado y casos de
test con nombre) y `Fuera de alcance`. Solo se exige con `harness.masterPlan` encendido y para
specs enlazadas desde `parts.json`. Además (R60), toma cada línea `R<n>` del `requirements.md` de
esa spec, extrae los ids `P<n>.A<m>` que cita y falla en los dos sentidos: si un criterio de la
parte no aparece en ningún `R<n>`, o si un `R<n>` cita un criterio que no existe en `parts.json`.
Citar un criterio de otra parte que sí existe da aviso, no falla.

**`navori master check --fit`** (R55): una fila por criterio V1–V7 con valor, umbral y
`pass`/`fail`, más la lista fija J1–J3 marcada "juicio". Con `--json`, `{ verifiable: [{ id,
value, threshold, pass }], allVerifiablePass, judgment: ["J1", "J2", "J3"] }`.

**`INDEX.md`** (render de `index.json`, R54). La primera línea es `Etapa activa: <ruta>/STATUS.md`
o `Etapa activa: ninguna`, con forma fija porque la lee el respaldo del hook. Sigue una tabla con
número, slug, estado, apertura, cierre y enlace a `MASTER.md`, `STATUS.md` o `CLOSURE.md`, según
exista.

**`navori master status --line`** (R38, R54): una línea en el idioma del repo, por ejemplo `Plan
maestro — etapa 02-pagos: parte activa P3 "Cobros" · 4/9 tareas ·
specs/_master/02-pagos/STATUS.md. En tu primera respuesta de la sesión, ofrece continuar con el
plan maestro en una sola línea, sin interrumpir lo que el usuario pidió.` Sale con 1 si no hay
etapa activa.

**`navori master status --json`**: `{ stage: { number, slug, dir } | null, phase, nextPhase,
mode, activePart, parts: [{ id, declared, effective, reason, tasksDone, tasksTotal, spec, issue,
acceptance: [{ id, method, verified, commitsBehind, orphan }] }], discrepancies, allDone, closable, blockers, lastClosed: { number, slug, state, closedAt } |
null, architectContext: { full: [ruta], referenceOnly: [ruta] } }` (`architectContext` solo en
etapa ≥2, D11). Es lo que lee la skill para rutear la etapa (D3), reanudar (R7), armar el aviso de R46,
proponer el cierre (R40), bloquear un plan nuevo (R53) y saber qué partes no tienen issue (R44).
Sin `index.json` sale con 1: es la primera vez que se usa el flujo. Sin etapa activa sale con 0 y
`stage: null`.

**Aviso de inicio (R46, R51)**, en `master-plan.md`, después del candado, la precondición y el
ruteo, y antes de cualquier comando que escriba. Lo emite el orquestador en el idioma del chat.
Se parece a la confirmación del modo audit. Tiene tres variantes:

- **Primera etapa** (`status --json` sale con 1). Cuatro elementos en este orden:
  1. "Se invocó el plan maestro."
  2. La lista cerrada de R46: crear la carpeta de la etapa, encender `harness.masterPlan`, pedir
     el contexto, convertirlo, mapear el código, lanzar tres `architect`, hacer preguntas y
     escribir `MASTER.md` y `STATUS.md`.
  3. La advertencia: "puede tardar y consumir muchos tokens (tres arquitectos en paralelo, entre
     otros pasos)".
  4. Una `AskUserQuestion` con dos preguntas: "¿Continúo?" ("Continuar", la recomendada, y "No
     ahora") y el slug de la etapa (sugerido más "Other").
- **Etapa nueva** (`stage: null`, `lastClosed` no nulo, R51). Lo mismo, con el primer elemento
  cambiado a "Se invocó el plan maestro para una etapa nueva; la última cerrada es
  `<NN>-<slug>` (<resultado>, <fecha>)".
- **Reanudación** (hay etapa activa). Dos elementos: "Plan maestro, etapa `<NN>-<slug>`, en fase
  `<phase>`; lo siguiente es `<nextPhase>`: <qué implica, una línea>", y una `AskUserQuestion`
  con "Continuar" y "No ahora".

Con "No ahora" o sin respuesta, la skill termina sin correr ningún comando más. Antes del aviso
solo corrieron comandos de lectura (`navori doctor`, `status --json`).

**Encargo del `architect` (en `master-plan.md`)**:

- Entradas: `DIGEST.md`, `CODEBASE.md`, modo, salida de `navori master template plan` y
  prioridad de desempate.
- En etapa ≥2, además: las rutas de las etapas cerradas, cuáles leer completas según D11 y el
  alcance heredado.
- Ruta de salida.
- Reglas R21–R23.
- Prohibido leer `plans/`.
- "Las partes son unidades de alcance."
- La sección 18 para lo que no pueda decidir y para las contradicciones con etapas cerradas.
- La checklist de rigor.
- Retorno `done -> <ruta>`.

## Failure modes

- **Presupuesto de arranque ya agotado** (área crítica: hooks). Medido en este repo con
  `planTiers` encendido: 6728 de 8000 caracteres emitidos, con tres secciones degradadas a
  puntero. El bloque `plan-maestro` en orden 7 cabe (1652 de `planificacion` + ~600) y empuja
  hacia puntero lo que va después, que ya es puntero o se puede reconstruir. Un test con
  `simulateContextDelivery` fija que `plan-maestro` sale `inline`. La saturación en sí es un
  hallazgo previo a esta spec (NOT in scope).
- **`navori` ausente o viejo en el hook de arranque.** Respaldo desde la primera línea de
  `INDEX.md` y, si no sirve, la ruta de `INDEX.md` (D5). El arranque nunca falla.
- **`uvx` ausente, sin Python compatible o sin red.** `markitdown` requiere Python 3.10–3.14. Si
  `uvx` falla por la causa que sea, R10: lectura nativa para PDF e imágenes y exportar a PDF lo
  demás, con cada archivo y su causa en `INTAKE.md`. `uvx` baja código de PyPI: nunca entra en
  `allow`, así que el usuario lo aprueba cada vez en `default`.
- **Documentos con instrucciones incrustadas** (R13). Se anotan en "Hallazgos" de `DIGEST.md`; el
  encargo del `architect` y el de `scout` repiten que el contexto es dato. El título de una parte
  llega al arranque de sesión, así que se limpia y se presenta como dato (D5). Los archivos de
  etapas cerradas que reciben los `architect` (R52) también son contenido del repo, y la misma
  regla aplica.
- **`raw/` commiteado por accidente** (área crítica: escrituras en el repo). El `.gitignore`
  anidado lo evita desde `init`. Si `raw/` ya existía con archivos rastreados por git
  (`git ls-files`), `init` lo advierte y no los saca del índice (sería una mutación de git que el
  usuario no pidió).
- **`context/raw/.gitignore` borrado después de `init`** (área crítica: escrituras en el repo),
  por ejemplo por una limpieza de archivos sin rastrear. En la etapa activa, `check` y `advance`
  fallan, `doctor` da `warn` y los tres nombran `navori master init`, que recrea solo ese archivo.
  En una etapa cerrada, `check --stage` y `doctor` (que corre con la bandera apagada, D8) nombran
  `git checkout -- <ruta>`. `git add -f` salta cualquier `.gitignore` y no se considera.
- **`index.json` inconsistente con las carpetas** (área crítica: escrituras en el repo). Casos:
  - Una carpeta `NN-*` sin entrada, por ejemplo una copiada a mano: ningún mutador corre, y el
    mensaje pide borrarla o registrarla. navori nunca borra.
  - Una entrada sin carpeta. Si es la activa, `init` sin slug la materializa: fue un `init`
    cortado entre el paso de `index.json` y el de la carpeta. Si es cerrada, el registro se
    perdió, `check` lo reporta y se recupera desde git.
  - `dir` que no coincide con `number` y `slug`: se reporta y no se corrige solo.
- **Dos etapas marcadas `activa`.** navori nunca escribe ese estado, así que solo sale de una
  edición a mano de `index.json`. Todos los mutadores fallan y nombran las dos. La reparación es
  manual, porque navori no puede adivinar cuál es la real; es la única edición a mano de
  `index.json` que el diseño contempla. `check` y `doctor` lo reportan.
- **Etapa cerrada editada a mano** (R50). No se previene; `check --stage` lo detecta contra los
  hashes de "Integridad" de `CLOSURE.md` y contra el render de `CLOSURE.md`. El mensaje nombra el
  archivo y `git checkout -- <ruta>`.
- **`init` o `close` a medias** (área crítica: config). `init` escribe primero `index.json`,
  después la carpeta y al final la config y el render. `close` sigue su secuencia reanudable (D10).
  En ambos, volver a correr el comando completa lo que falte sin reescribir lo hecho. Si falla el
  render, el mensaje nombra `navori render --apply`. `writeConfig` y `writeFileAtomic` son
  atómicos.
- **Bandera y registro desincronizados** (área crítica: config). Hay dos casos:
  - `close` cortado entre el paso 5 y el 6: bandera encendida sin etapa activa. `close` sin
    argumentos completa solo el paso 6 y sale con 0 (D10).
  - `init` cortado entre el paso 1 y el 5, o la bandera apagada a mano: etapa activa con la
    bandera apagada. `init` sin slug enciende la bandera y aplica el render.

  En los dos, `doctor` da `warn` y nombra el comando. Mientras no se repare, el bloque de R37 y la
  línea de R38 dicen algo que no coincide con el registro; ninguno de los dos casos pierde datos.
- **Contexto de etapas cerradas creciendo sin tope** (R52). Acotado por D11: completa solo la
  última etapa entregada y lo que vino después de ella; las anteriores, por su `CLOSURE.md` e
  `INDEX.md`.
- **Cierre con partes sin resolver** (R47). `close` sale con 1 y lista `blockers`; nada se
  escribe. Una parte `diferida` o `descartada` sin razón no puede existir, porque zod la rechaza
  al escribirla.
- **Abandono en `mastered` o después** (R58). `close --abandon` se rechaza sin escribir nada, y el
  mensaje nombra `navori master close` (entrega), que exige resolver cada parte como `hecho`,
  `descartada` o `diferida`. Pasar `--abandon` y `--convert` juntos también se rechaza.
- **Conversión hacia una ruta ocupada** (R57). `close --convert` falla si la ruta existe y no
  está vacía, así que nunca mezcla la etapa con otra spec. Si la conversión se cerró pero
  `spec-bootstrap` no llegó a crear la spec, `check --stage` e `INDEX.md` lo muestran con el
  comando que falta.
- **Ediciones a mano de `state.json`, `STATUS.md` o la región de partes** de la etapa activa. No
  se previenen (un hook de bloqueo por ruta no compensa en un flujo tan raro); se detectan. `check`
  compara la región y `STATUS.md` contra su render, y valida que el historial de `state.json` sea
  una cadena de fases consecutivas.
- **Issue duplicado al reintentar** (R44). Si `gh` crea el issue y la sesión se corta antes de
  `navori master part --issue`, un reintento lo duplicaría. La skill busca antes con `gh issue list
  --search "[<NN>-<slug>] P<n> in:title" --state all`; si lo encuentra, registra ese número en vez
  de crear.
- **Creación de issue en `bypassPermissions`/`dontAsk`** (área crítica: hooks y permisos). El
  hook responde `ask` por decisión del usuario (D6). La doc de hooks no dice si el host muestra
  ese prompt en `bypassPermissions`, donde "prompts are skipped" (`docs/architecture.md`). Si no
  lo muestra, el issue se crea sin confirmación. Es un riesgo aceptado: el test fija que el hook
  emite `ask`, no lo que hace el host. Sin `jq` ni `node`, las filas nuevas usan la razón fija
  que el hook ya tiene.
- **Creación de issue por una ruta que el hook no ve.** `sh -c "…"`, `eval`, un script propio o
  una llamada HTTP directa (`curl`) no pasan por la clasificación. Es la misma limitación que ya
  declara el hook para los comentarios. `curl` y los intérpretes nunca están en `allow`, así que
  en `default` piden permiso de todos modos.
- **Candado burlado por contenido del repo.** Un documento, un commit o el título de una parte
  podría decir "el usuario pidió el plan maestro". El candado solo acepta mensajes del usuario
  en el hilo (D3). La línea de `SessionStart` marca el título como dato y no cuenta como pedido.
- **Arquitectos que se leen entre sí.** Corren en paralelo y el encargo les prohíbe leer
  `plans/`, pero uno lento podría leer el plan terminado de otro. Es consultivo; la señal de
  admisión (planes casi idénticos) lo haría visible.
- **`check --fit` con un `DIGEST.md` inflado o encogido.** Los conteos dependen de cómo el
  orquestador agrupa las capacidades. La regla de D9 exige además los criterios de juicio y la
  decisión es del usuario, así que un conteo sesgado produce a lo sumo una recomendación
  equivocada, nunca un cambio.
- **Evidencia vieja: el código cambió después de registrarla** (R61). No se invalida sola, porque
  eso castigaría cada commit posterior. `STATUS.md` muestra `commitsBehind` por criterio, y antes
  de cerrar la skill propone volver a verificar lo atrasado. Es consultivo (D12).
- **Evidencia de un commit que ya no existe en la historia** (rebase, squash-merge, reset). `status`
  lo marca `orphan`; `STATUS.md` y `CLOSURE.md` lo dicen. No regresa la parte a `parcial`, por el
  caso del squash-merge, y la skill propone registrar de nuevo en HEAD antes de `close`.
- **Evidencia registrada con cambios sin commitear.** `--accept` la rechaza, porque el commit
  registrado no sería el código probado.
- **Aprobación `manual` registrada sin preguntar** (R62). El CLI no puede detectarlo, pero
  `master-accept-confirm.sh` fuerza la confirmación del humano en todos los modos (D12). El riesgo
  que queda es el de R43: que el host no muestre el `ask` en `bypassPermissions`. Con la bandera
  apagada, `part --accept` falla, así que no hay forma de registrar sin el hook.
- **`requirements.md` de una parte que no cita sus criterios** (R60). `check --part` falla en los
  dos sentidos, y `close` no cuenta como `hecho` una parte cuya spec no pasa el mapeo.
- **Spec movida o borrada.** `status` marca la parte con "spec no encontrada" y `check` falla;
  nunca se asume un avance.
- **Dos sesiones mutando a la vez.** `writeFileAtomic` evita archivos corruptos; gana la última
  escritura. Se acepta el riesgo: el flujo corre en una sesión a la vez.

## Migration

- Clave nueva `harness.masterPlan`, default `false`. Sin migración de datos: no existe ninguna
  instalación previa de `_master/`.
- Todos los repos: `comment-draft-confirm.sh` cambia (versión nueva del hook). Toda creación de
  issue (`gh issue create`, `gh api …/issues`, `createIssue`) pasa a pedir confirmación (R43,
  incondicional por requisito), y `BOUND` amplía la detección de las filas de comentarios a
  subshells. `architect.md` y `scout.md` cambian. Aparecen dos skills nuevas en Claude y dos filas
  en el índice de skills, y la descripción de `master-plan` entra al contexto de cada sesión
  Claude (D3).
- Los goldens de render se regeneran. Con la bandera apagada, `settings.json` y
  `.claude/context/` quedan byte a byte iguales.

## Testing strategy

| Riesgo | Test | R |
|---|---|---|
| Skill ausente, renderizada fuera de Claude o sin candado | render de Claude: `.claude/skills/master-plan/SKILL.md` **sin** `disable-model-invocation`, con y sin la bandera; `context-intake` **con** la clave; render de Codex sin ninguna de las dos. Test de asset: el candado es la primera sección del cuerpo, nombra las formas de pedido válidas y excluye la línea de `SessionStart` | R1 |
| Aviso de inicio ausente, incompleto o después de escribir | test de asset de `master-plan`: la sección del aviso va después del candado, la precondición y el ruteo, y antes de la primera mención de `navori master init`; contiene los ocho elementos de la lista de R46, la advertencia de tiempo y tokens, `AskUserQuestion` con la pregunta del slug, la variante "etapa nueva" con la última cerrada y la de reanudación con `nextPhase`; `status.test.ts`: `--json` trae `nextPhase` y `lastClosed`, sale con 1 sin `index.json` y con 0 y `stage: null` sin etapa activa | R46, R51 |
| "Sí, continúa" en prosa no reanuda (R38 de punta a punta) | parte automática: `master-plan-context.test.ts` fija que la línea nombra la etapa y pide ofrecer; el test de asset fija que el candado acepta la respuesta afirmativa a la oferta. Parte con modelo: escenario en `specs/0034-master-plan/evals.md`, en un repo fixture con la etapa `01-mvp` en fase `executing`. Sesión 1: el usuario pide una tarea ajena y la respuesta hace esa tarea más una línea de oferta, sin comandos de `navori master`. Turno 2: "sí, continúa" produce una llamada a Skill `master-plan`, el aviso corto de R46 con la etapa y `AskUserQuestion` antes de cualquier escritura. Control RED: la misma skill con `disable-model-invocation: true` no produce la llamada | R1, R38, R46, R54 |
| `init` numera mal, abre dos etapas o sobrescribe | `stages.test.ts` y `init.test.ts` en un repo temporal: primera etapa `01-<slug>`; tras cerrar, la siguiente `02-<slug>`; con un hueco (entrada 03 cerrada, carpeta 02 borrada) la siguiente es `04`; slug inválido rechazado; con etapa activa, `init otra` sale con 1, reporta etapa y fase y no cambia un byte; `init` sin slug con la activa sin carpeta la materializa; corte simulado después de cada uno de los pasos 1 a 4 (entre `index.json` y la bandera) y segunda corrida `init` que deja carpeta, `INDEX.md`, bandera en `true` y render aplicado; con la etapa activa completa y la bandera apagada a mano, `init` solo la enciende y aplica el render; etapa ≥2 registra `en-curso` y `mode` falla; `sdd.enabled: false` → error | R3, R5, R16 |
| Bandera y registro desincronizados | `close.test.ts`: corte entre el paso 5 y el 6 (`index.json` sin activa, bandera en `true`); `close` sin argumentos sale con 0, deja la bandera en `false` con el render aplicado y no cambia ningún byte de `_master/`; `close --abandon` en ese estado falla; `master-plan.test.ts` (diagnose): bandera encendida sin activa → `warn` que nombra `navori master close`; activa con bandera apagada → `warn` que nombra `navori master init`; estado coherente → sin fila | R3, R49 |
| `raw/` rastreable o sin recuperación | `init.test.ts`: `git check-ignore` positivo para `<etapa>/context/raw/x.pdf` con `gitignoreHarness: "off"` y también después de `close` (bandera apagada); con el `.gitignore` de la activa borrado, `check` falla nombrando `init`, `doctor` da `warn` sin exit 2 e `init` lo recrea sin cambiar otro byte; con el de una cerrada borrado, `doctor` (bandera apagada) y `check --stage` nombran `git checkout` | R4 |
| `index.json` inconsistente | `stages.test.ts`: dos `activa`, carpeta sin entrada, entrada cerrada sin carpeta y `dir` distinto de `number`/`slug`, cada uno hace fallar a todos los mutadores con su mensaje y aparece en `check` y `doctor` | R50, R54 |
| Señal de modo errónea o que falla sin git | `signal.test.ts`: repo sin git, repo con 1 commit, repo con historia; sin código fuente | R15, R19 |
| Fase que avanza sin cumplir o salta | `checks.test.ts`: un fixture inválido por fila de la tabla de `advance`, más uno válido; `advance` nunca salta ni sale de `executing`; `mode` falla después de `context`; en etapa ≥2, `questioned` exige un `D<n>` por diferida y `mastered` valida `Origen: 01-mvp/D3` contra el `DECISIONS.md` de esa etapa | R6, R8, R10–R14, R16, R21–R23, R29–R33, R52 |
| Plantilla y validador divergen | `templates.test.ts`: los encabezados que usan `checks.ts` y `fit.ts` se leen del archivo de plantilla (no hay lista literal en TS); `en-curso` exige la sección 3 y `template` no; `digest` trae las ocho secciones | R12, R18, R21, R30, R55 |
| `STATUS.md`/`INDEX.md` no deterministas o mal derivados | `status.test.ts`: misma entrada dos veces → mismos bytes; estado efectivo por las tres reglas de D2 (incluidas `descartada` y `diferida` con tareas pendientes); discrepancia listada; parte activa; `allDone`, `closable` y `blockers`; `STATUS.md` nombra la etapa; primera línea de `INDEX.md` con la forma fija en los dos casos | R36, R40, R44, R47, R54 |
| Cierre sin cumplir, no determinista o que deja la etapa mutable | `close.test.ts`: con una parte `parcial`, sale con 1 y lista `P<n>`, sin escribir; `part --state diferida` sin `--reason` falla; con todo resuelto, `CLOSURE.md` byte a byte igual en dos corridas sobre la misma entrada, `state.json` en `closed`, `index.json` en `cerrada` con `closedAt`, bandera en `false`, render aplicado; corte simulado después de cada uno de los 6 pasos y segunda corrida que completa; `part`, `advance`, `mode` y `close` con `--stage 01-mvp` cerrada fallan; `status` no toca ningún byte de la cerrada; `check --stage` pasa sobre la cerrada y falla tras editar su `MASTER.md` (hash de "Integridad"); el mismo cierre con `MASTER.md` y `DECISIONS.md` reescritos con `\r\n` pasa `check --stage` (hash sobre contenido normalizado), y una edición real en esos archivos con CRLF sigue fallando | R47, R48, R49, R50 |
| Conversión en fase indebida o con ruta ocupada | `close.test.ts`: `--convert` en `mastered` falla; en `mapped` con ruta libre escribe `CLOSURE.md` con razón y ruta, `index.json` en `convertida` con `spec`, bandera en `false`; ruta existente y no vacía → falla sin escribir; `check --stage` reporta la spec aún no creada | R56, R57 |
| Abandono en fase indebida, combinado o que borra | `close.test.ts`: `--abandon` sin `--reason` falla; `--abandon` en `mastered` y en `executing` falla sin escribir, con un mensaje que nombra `navori master close`; `--abandon --convert` falla; en `planned`, `CLOSURE.md` corto con la razón y la fase `planned`, byte a byte igual en dos corridas, `index.json` en `abandonada`, bandera en `false`, render aplicado y la misma lista de archivos de la etapa antes y después; test de asset: `master-plan` pide confirmación con `AskUserQuestion` antes de `close --abandon` | R58 |
| Contexto de etapas cerradas sin tope | test de asset de `master-plan`: el encargo del `architect` y el paso de consolidación listan las rutas de todas las etapas cerradas y marcan como lectura completa solo la última `cerrada` y las `convertida`/`abandonada` posteriores; fixture con 4 etapas (`01` cerrada, `02` cerrada, `03` abandonada, `04` activa): la lista de lectura completa es `02/{MASTER,DECISIONS,CLOSURE}.md` + `03/{DECISIONS,CLOSURE}.md`, y para `01`, `CLOSURE.md` + `INDEX.md`. La lista la calcula `stages.ts` (`contextForArchitects`) para que el test no dependa de prosa | R52 |
| Criterios de "cabe en una spec" mal contados | `fit.test.ts`: un fixture por criterio V1–V7 justo en el umbral y uno por encima; `CODEBASE.md` con stack abierto hace fallar V6; la salida lista J1–J3 como juicio; `--json` con la forma de Contracts | R55 |
| Prosa de etapas, cierre y conversión incompleta | test de asset de `master-plan`: R53 (etapa activa + pedido de plan nuevo → nombrar etapa, fase y avance, ofrecer cierre, sin `init`); R48 (pregunta parte por parte con las tres opciones); R47 (pregunta de entrega antes de `close`); R52 (lista de archivos de etapas cerradas en el encargo, oferta de diferidas como `D<n>`); R55/R56 (`check --fit`, J1–J3, `AskUserQuestion` con "Cambiar a spec" y "Seguir con el plan maestro"); R57 (`close --convert` antes de `spec-bootstrap` y las tres entradas citadas) | R47, R48, R51, R52, R53, R55, R56, R57 |
| Tareas de parte sin rigor | `check --part` con un fixture por campo faltante de R35 y versión con `^` | R35 |
| Criterio mal formado | `schema.test.ts`: `method: test` sin `test.file` falla; dos bloques de método en un criterio fallan; `approval` en un criterio `comando` falla; ids `A<m>` repetidos fallan; cambiar la descripción de un criterio después de `mastered` lo rechaza `check` | R59 |
| Mapeo criterio ↔ requisito roto | `check --part`: criterio `P2.A3` sin ningún `R<n>` que lo cite → falla; `R4` que cita `P2.A9` inexistente → falla; `R4` que cita `P1.A1` existente de otra parte → aviso; mapeo completo → pasa | R60 |
| Evidencia falsa en forma, ausente o en árbol sucio | `accept.test.ts`: `comando` con `--command` distinto de `command.run` → falla; `test` con un `--command` que no nombra el archivo → falla; `manual` con `--command` → falla; `run` con cambios sin commitear fuera de `specs/` → falla; `run` válido guarda `commit` = `git rev-parse HEAD` y la fecha; `--accept` sobre una parte `diferida` o de una etapa cerrada → falla; `--accept` combinado con `--issue` → falla | R61, R62 |
| `hecho` sin evidencia | `status.test.ts`: tareas todas marcadas y `P2.A3` sin evidencia → `parcial`, y `blockers` y `STATUS.md` nombran `P2.A3`; con evidencia completa → `hecho`; `hecho` declarado sin spec y sin evidencia → `parcial`; `closable` falso con una parte así | R61 |
| Evidencia vieja o huérfana | `status.test.ts` en repo temporal: evidencia en `C1`, dos commits después → `commitsBehind: 2`; `git reset --hard` a antes de `C1` y un commit nuevo → `orphan: true`, sin cambiar el estado efectivo; los dos aparecen en `STATUS.md` | R61 |
| Aprobación manual sin pregunta | test de asset de `master-plan`: la sección de aprobación manual presenta el criterio y cómo verificarlo en una `AskUserQuestion` y solo registra con la respuesta "Aprobado"; `settings-base.json` no tiene ninguna regla `allow` que cubra `navori master part`; `accept.test.ts`: `--approved-by user` con `harness.masterPlan: false` falla nombrando `navori master init` | R62 |
| Aprobación manual sin confirmación del humano | `master-accept-confirm.test.ts`, casos con nombre: `asks on navori master part P2 --accept A3 --approved-by user (main thread)`, `asks on approved-by from a subagent`, `asks on approved-by under auto`, `asks on approved-by under bypassPermissions`, `asks on approved-by under dontAsk`, `ignores --accept of a test criterion (--command … --result …)`, `ignores --accept of a comando criterion`, `ignores navori master status and check`, `asks on chained cd x && navori master part … --approved-by user`, `asks on chained true; navori master part … --approved-by user`, `asks on subshell (navori master part … --approved-by user)`, `asks on command substitution $(navori master part … --approved-by user)`, `emits the fixed reason without jq or node`, más la suite diferencial bash×zsh con las mismas entradas; golden de `settings.json`: el hook registrado con `masterPlan` en `true` y ausente en `false` | R62 |
| Acta sin criterios | `close.test.ts`: `CLOSURE.md` lista cada `P<n>.A<m>` con método, evidencia y fecha; los de una parte `diferida` como "no verificado"; los huérfanos marcados; editar a mano una evidencia de la etapa cerrada rompe el hash de `parts.json` en `check --stage` | R63 |
| Bloque o hook presentes con la bandera apagada | golden de render con `masterPlan` `false` (sin `07-plan-maestro.md` y sin registro en `settings.json`) y `true` (ambos presentes); después de `close`, el golden vuelve al de `false` | R37, R38, R39, R49 |
| Bloque de R37 degradado a puntero | `simulateContextDelivery` sobre el render con `planTiers` y `masterPlan` encendidos: `plan-maestro` `inline` | R37 |
| Línea de arranque que no llega o se pasa de tamaño | `master-plan-context.test.ts` (bash y zsh): sin `navori` → respaldo con la ruta leída de `INDEX.md`; `INDEX.md` con primera línea inválida o con caracteres fuera del filtro → ruta de `INDEX.md`; `--line` de más de 600 caracteres → respaldo; salida JSON válida | R38, R54 |
| Creación de issue sin confirmación | `comment-draft-confirm.test.ts`, casos con nombre: `asks on gh issue create (main thread)`, `asks on gh issue create from a subagent`, `asks on gh issue create under bypassPermissions`, `asks on gh issue create under dontAsk`, `denies on gh issue create under .codex/hooks`, `shows --body-file content for gh issue create`, `asks on gh api repos/o/r/issues -f title=x`, `asks on gh api repos/{owner}/{repo}/issues --input body.json`, `asks on gh api -X POST /repos/o/r/issues`, `ignores gh api -X GET repos/o/r/issues`, `ignores gh api -X PATCH repos/o/r/issues/12`, `keeps gh api repos/o/r/issues/12/comments on the comment row`, `asks on gh api graphql createIssue`, `asks on chained cd x && gh issue create`, `asks on chained true; gh api repos/o/r/issues -f title=x`, `asks on subshell (gh issue create …)`, `asks on command substitution $(gh api graphql … createIssue …)`, `ignores gh issue list and gh issue view`, más la suite diferencial bash×zsh con las mismas entradas | R43 |
| Registro de controles incompleto | `engine-capabilities.test.ts` y `control-gaps.test.ts`: `master-plan` declarado en los cinco engines; `warn` en Codex con la bandera encendida; sin fila con la bandera apagada | R41 |
| Contrato del `architect` roto por la ampliación | `agents-assets.test.ts`: techo 700, regex de no-veredicto, no-descomposición y no-preguntar intactas; `tools` incluye `WebFetch` y `WebSearch`; el cuerpo menciona `[SIN VERIFICAR]` | R24, R25 |
| `scout` escribe fuera de la ruta pedida | `agents-assets.test.ts`: el formato Map declara la ruta nombrada por el encargo | R14 |
| Prosa de las skills incompleta | tests de assets de skills: `master-plan` menciona precondición y comando, `AskUserQuestion`, `D<n>`, checklist de rigor, `gh auth login`, "solo GitHub", título de issue con la etapa; `context-intake` menciona `uvx --from 'markitdown[all]'` sin versión fija, la obtención de la versión, fallback, `INTAKE.md` y la plantilla `digest`; `checks.test.ts` rechaza una cabecera con método `markitdown` sin versión | R2, R7, R9, R11, R13, R17, R20, R26–R28, R34, R42, R45 |

## Admisión de las ampliaciones de agentes (spec 0031)

**`architect` ×3 en el flujo y herramientas web.**

- **Garantía:** calidad (tres contextos frescos e independientes, tier `opus`, y cada dato que
  caduca con fuente oficial) y velocidad (fan-out en paralelo sobre trabajo independiente). El
  orden de metas se respeta: el paralelismo no degrada la calidad, porque cada plan es completo.
- **Señal:** en cada `MASTER.md`, la proporción de secciones cuyo `Origen:` es "coinciden" frente
  a las que salieron de un solo plan o de un `D<n>`; y el número de citas con `consultado` en los
  planes y en los `solution_*.md`. También cuántas etapas se convierten a spec en `mapped` (D9):
  si son la mayoría, el despacho triple se está pagando donde no hacía falta.
- **Costo contra lo que produce:** tres arranques en frío (~75k tokens) más tres corridas `opus`
  por etapa, no por tarea. Producen el insumo del `MASTER.md` que el orquestador no podría
  escribir con tres perspectivas en su propio contexto. Las herramientas web solo cuestan cuando
  se usan. Una etapa convertida en `mapped` no paga el despacho.
- **Retiro:** tras 3 etapas o 90 días desde el release, si ≥90% de las secciones coinciden, se
  abre un issue para bajar a un solo `architect`. Si en ese plazo no hay ninguna cita `consultado`
  en planes ni soluciones, se abre otro para quitar `WebFetch`/`WebSearch`.
- **Apagado por default:** el despacho triple solo existe con `harness.masterPlan` (default
  `false`). Las herramientas son incondicionales porque R24 lo pide.

**`scout` con ruta nombrada:** no amplía su trabajo (sigue siendo un Map), solo cambia dónde deja
el reporte. Un arranque en frío por etapa, que saca la exploración del código del contexto
principal (eje tokens).

## NOT in scope

- **Adaptación a Codex y a los demás engines** (fase 2). R41 solo la hace visible.
- **Varias etapas activas a la vez** (fuera de alcance de los requisitos).
- **Reabrir una etapa cerrada.** Es de solo lectura (R50); lo que falte va a la etapa siguiente
  como parte diferida.
- **Soporte de `references/` en el render de skills.** Se abre cuando haya un segundo consumidor
  (D3).
- **La saturación del presupuesto de `SessionStart`** (`orquestacion` sale como puntero en este
  repo). Es previa a esta spec y tiene su propio frente (#919). Aquí solo se evita empeorarla.
- **Un hook que bloquee la edición a mano de `state.json`, `STATUS.md` o de una etapa cerrada.**
  Se detecta con `check` y con los hashes de `CLOSURE.md` (Failure modes).
- **Regenerar `STATUS.md` en `SessionEnd`.** El hook escribiría en el repo sin que nadie lo vea;
  R37 lo deja en manos del agente y la línea de arranque calcula el avance en vivo de todos modos.

## Conocimiento durable (destino propuesto)

- El flujo, las etapas, las fases y el porqué de JSON + Markdown → `docs/architecture.md`
  (sección nueva "Plan maestro"), no `CLAUDE.md`: es lookup, no doctrina always-on.
- "El presupuesto de `SessionStart` está agotado; lo nuevo va por canal propio o antes de
  `orquestacion`" → comentario de `ORCHESTRATOR_CONTEXT_ORDER` y memoria del proyecto.

## Preguntas abiertas

- **[assumed] Umbrales de "cabe en una spec"** (D9: V1 ≤ 8 capacidades, V2 ≤ 3 actores, V3 ≤ 1
  integración, V4 ≤ 5 entidades, V5 una superficie, V7 ≤ 2 decisiones de negocio). Solo
  alimentan una recomendación; el usuario decide (R56). Viven en `fit.ts`.
- **[assumed] Umbrales de la sugerencia de modo:** `template` si hay ≤5 commits y ≤20 archivos
  modificados después del primero; si no, `en-curso`. Solo aplica a la etapa 1 (R16). Viven en
  `signal.ts`.
- **[assumed] El slug va en la misma `AskUserQuestion` de R46.** Así R16 (el modo es la primera
  pregunta después de la confirmación) sigue siendo literal. Si el usuario prefiere un slug por
  defecto (`mvp` para la primera etapa), la segunda pregunta desaparece.
- **[resuelta] Lectura de "recibir" en R52.** R52 se enmendó el 2026-09-24 para decir
  exactamente lo que hace D11.
- **[repo] `markitdown --version`** existe como flag del CLI: se verifica en T1 (Otras
  decisiones). Si no existe, se usa la alternativa ya descrita; el diseño no cambia.

## Cobertura R<n> → componente

| R | Componente |
|---|---|
| R1 | `master-plan.md` (candado, sin `disable-model-invocation`, D3), `roster.ts` / `resolveHarnessPlan`, `evals.md` |
| R2 | `master-plan.md` (precondición: config + `navori doctor`, que sale con 2 si hay errores) |
| R3 | `commands/master.ts` `init <slug>`, `lib/master/init.ts`, `stages.ts` (numeración, slug, `index.json`), `master-plan.md` |
| R4 | `lib/master/init.ts` (`.gitignore` anidado por etapa y recreación, D8), `checks.ts`, `lib/diagnose/master-plan.ts` |
| R5 | `lib/master/init.ts`, `stages.ts` (etapa activa) |
| R6 | `lib/master/schema.ts` (`MasterStateSchema.phase`, con `closed`) |
| R7 | `master-plan.md` (ruteo y reanudación desde `status --json`) |
| R8 | `commands/master.ts` `advance`, `lib/master/checks.ts` |
| R9 | `context-intake.md` |
| R10 | `context-intake.md`, `INTAKE.md`, `checks.ts` |
| R11 | `context-intake.md` (versión de `markitdown`), plantilla `intake`, `checks.ts` |
| R12 | `context-intake.md`, plantilla `digest`, `checks.ts` |
| R13 | `context-intake.md`, `master-plan.md` (encargos) |
| R14 | `master-plan.md` (encargo del `scout`), `scout.md`, `checks.ts` |
| R15 | `lib/master/signal.ts` (vía `detectProject`) |
| R16 | `commands/master.ts` `mode`, `init.ts` (`en-curso` en etapa ≥2), `master-plan.md` (orden de arranque), `schema.ts` |
| R17 | `master-plan.md` |
| R18 | plantilla `plan` (sección 3), `parts.json.state`, `checks.ts` |
| R19 | `signal.ts`, `master-plan.md` (encargo del `scout`), `fit.ts` (V6) |
| R20 | `master-plan.md` (despacho y encargo) |
| R21 | plantilla `plan`, `templates.ts`, `checks.ts` |
| R22 | plantilla `plan`, `checks.ts` |
| R23 | `architect.md` ("Sources"), plantilla `plan`, `checks.ts` (en parte), checklist de rigor |
| R24 | `architect.md` (`tools`, "Sources") |
| R25 | `architect.md` (entrada master-plan), `master-plan.md` (encargo) |
| R26 | `master-plan.md` (consolidación) |
| R27 | `master-plan.md` (`AskUserQuestion`, una a la vez) |
| R28 | `master-plan.md` |
| R29 | plantilla `decisions`, `checks.ts`, `master-plan.md` |
| R30 | plantilla `master`, `checks.ts` (`Origen:`) |
| R31 | `parts.json` / `PartsSchema` (criterios según R59), región de partes en `status.ts`, `checks.ts` |
| R32 | `checks.ts` (fase `mastered`), `master-plan.md` |
| R33 | `master-plan.md`, `part --spec`, `checks.ts` |
| R34 | `master-plan.md` (checklist de rigor) |
| R35 | plantilla `tasks`, `check --part`, `master-plan.md` ("Spec de una parte") |
| R36 | `status.ts`, `commands/master.ts` `status` |
| R37 | `managed/plan-maestro.md`, `CORE_MANAGED_ASSETS`, `schema.ts` |
| R38 | `master-plan-context.sh` (con respaldo desde `INDEX.md`), `build-settings.ts`, `status --line`, candado de `master-plan.md` (acepta el sí a la oferta, D5), `evals.md` |
| R39 | condición del bloque y registro condicional del hook |
| R40 | `status --json` (`allDone`), `master-plan.md` (propone cerrar la etapa) |
| R41 | `engine-capabilities.ts` (`master-plan`), `control-gaps.ts` |
| R42 | `master-plan.md`, `template issue --part` |
| R43 | `comment-draft-confirm.sh` (`gh issue create`, `gh api` REST `…/issues`, GraphQL `createIssue`, `BOUND` con subshells; `ask` en todos los modos, D6) |
| R44 | `part --issue`, `status.ts`, `master-plan.md` (búsqueda previa con la etapa en el título) |
| R45 | `master-plan.md` (`gh auth status`, plugin `gh` en config) |
| R46 | `master-plan.md` (aviso de inicio en tres variantes y `AskUserQuestion`, Contracts), `status --json` (`nextPhase`, `lastClosed`) |
| R47 | `close.ts` (`closable`/`blockers`), `status.ts`, `master-plan.md` (pregunta de entrega) |
| R48 | `part --state descartada\|diferida --reason`, `PartsSchema` (razón obligatoria), `master-plan.md` (pregunta parte por parte) |
| R49 | `close.ts` (secuencia, reconciliación del paso 6 sin etapa activa, `CLOSURE.md` determinista con hashes sobre contenido normalizado a `\n`), `stages.ts` (`index.json`, `INDEX.md`), `lib/diagnose/master-plan.ts` (bandera frente a registro) |
| R50 | `stages.ts` (mutadores solo sobre la activa), `commands/master.ts` (`--stage` cerrada rechazada), `checks.ts` (`check --stage`, hashes de "Integridad"), `lib/diagnose/master-plan.ts` |
| R51 | `master-plan.md` (ruteo y aviso "etapa nueva"), `status --json` (`lastClosed`), `init.ts` |
| R52 | `master-plan.md` (encargo con etapas cerradas y lectura acotada, oferta de diferidas), `stages.ts` (`contextForArchitects`), plantilla `plan` (secciones 1, 4 y 18), `checks.ts` (`questioned`, `mastered`), `PartsSchema.inheritedFrom` |
| R53 | `master-plan.md` (ruteo), `init.ts` (no crea con etapa activa), `status --json` |
| R54 | `MasterIndexSchema`, `stages.ts` (render de `INDEX.md`), `status --line` y `STATUS.md` con la etapa |
| R55 | `fit.ts` (`check --fit`, V1–V7), plantilla `digest`, `master-plan.md` (J1–J3 y regla de recomendación, D9) |
| R56 | `master-plan.md` (`AskUserQuestion` "Cambiar a spec" / "Seguir con el plan maestro", disponible hasta `questioned`), `close.ts` (fases permitidas) |
| R57 | `close --convert` (`close.ts`), `CLOSURE.md` `convertida`, `index.json` `convertida`, `master-plan.md` (entradas de `spec-bootstrap`); `spec-bootstrap.md` sin cambios |
| R58 | `close --abandon --reason` (`close.ts`, excluyente con `--convert`, solo antes de `mastered`), `CLOSURE.md` corto `abandonada`, `index.json` `abandonada`, `master-plan.md` (`AskUserQuestion` de abandono) |
| R59 | `PartsSchema.acceptance` (id `A<m>`, `method`, detalle), plantillas `plan`/`master` (sección 15), `tasks` e `issue` |
| R60 | `check --part` (mapeo `P<n>.A<m>` ↔ `R<n>` en los dos sentidos), guía "Spec de una parte" en `master-plan.md`, `closable` |
| R61 | `part --accept` (D12), estado efectivo de D2 (`hecho` exige evidencia), `blockers`, `STATUS.md` (`commitsBehind`, `orphan`) |
| R62 | `master-plan.md` (`AskUserQuestion` antes de `--approved-by user`), `part` fuera de `allow` (`settings-base.json`), `master-accept-confirm.sh` (`ask` en todos los modos, registro condicional en `build-settings.ts`), `part --accept` rechazado con la bandera apagada (D12) |
| R63 | `CLOSURE.md` (tabla de criterios con método, evidencia y fecha; "no verificado" en `descartada`/`diferida`), hash de `parts.json` en "Integridad" |
