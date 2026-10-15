# Correcciones del mecanismo de planes tras la segunda auditoría — Design

**Estado:** borrador, revisado tras el challenge
(`.navori/state/handoffs/solution_review_0052-correcciones-mecanismo-planes.md`) y las decisiones del
usuario y del orquestador · **Fecha:** 2026-10-14 · **Base revisada:** `HEAD` de
`docs/0052-correcciones-mecanismo-planes` = `c7062433` (`dev` con `main` integrado: 0049, 0050,
0051). `origin/dev` tras `git fetch origin dev` está en `3d985f71`, un commit atrás: `c7062433` es el
merge de sincronización que viaja en su propio PR. Toda afirmación "ya existe" de abajo se verificó
contra `c7062433`. El PR de esta spec apunta a `dev`.

**Señal arquitectónica:** áreas críticas (settings/permisos, reglas ask/deny, hooks, escrituras
derivadas en el repo del usuario), concurrencia (claim del despacho, `plan update` en paralelo),
contrato compartido (gramática de la apertura `nivel-0:`, subcomando nuevo, reglas nuevas de
`plan check`) y una migración de comportamiento (workplans y `STATUS.md` existentes).

**Área crítica.** Se tocan `settings-base.json` (allow y ask), los hooks `master-accept-confirm` y
`plan-gate`, y la escritura de `STATUS.md`/`MASTER.md`/`CLOSURE.md`. No se tocan marcadores managed
ni el guard anti-rollback, y no se agrega ninguna regla a `guard-destructive`.

## Decision drivers

Tomados de `docs/DIRECTION.md`, `CLAUDE.md` y las decisiones del usuario en `requirements.md`:

1. **Fail-closed donde el gate promete enforcement.** Con `harness.planTiers` activo, una duda del
   gate (config ilegible, payload roto, rol desconocido en Codex) deniega; solo la ausencia de
   configuración o un rol que no escribe deja pasar.
2. **Una sola fuente por regla.** El nivel lo calcula solo `classify`; la validez de un workplan la
   decide solo `checkWorkplan`; la lista de roles vive en el roster; el lock y el claim reusan
   primitivas existentes.
3. **Cero dependencias y cero esquemas persistidos nuevos**, salvo una línea `reset` en el log del
   gate y la refinación de `parts.json` legacy.
4. **Simple > clever:** nada de parsers de shell nuevos ni de autenticación criptográfica. Los
   controles locales se declaran como seatbelt, nunca como frontera de seguridad.
5. **Presupuestos de doctrina** (`check:doc-budgets`, `skill-caps.test.ts`, entrega de contexto de
   8,000 caracteres) se respetan o se suben con la regla de 5% documentada.

## Approach

Cada defecto se corrige en la pieza dueña. Hay tres piezas nuevas, todas mínimas:

- **`navori plan escalation-reset`** (R9), que escribe una línea `reset` en el log del gate.
- **`NON_IMPLEMENTER_ROLES`** en `engines/shared/roster.ts` (R3), la lista explícita de roles que no
  escriben código: los seis de R3 más `explorer`, el rol de solo lectura que Codex trae integrado.
- **Un claim por `rename`** del archivo de despacho (R7), dentro de `gate.ts`.

Lo demás **reusa** lo que ya existe:

- El lock de `plan update` (R11) es `withFileLock` de `lib/primitives/lockfile.ts`, el mismo de
  `lib/workspace/registry.ts`.
- La huella de árbol sin escrituras en `.git` (R30) es el modo `readOnly` de `fingerprintTree`
  (`lib/plan/evidence.ts`), que `lib/plan/resume.ts` ya usa.
- La confirmación del reinicio (R9) y de las variantes envueltas (R36) reusa
  `master-accept-confirm.sh` y su `TRIGGER_RE` no anclado; la copia Codex de ese hook ya deniega
  como confirmación.
- Las etiquetas por idioma (R31) se agregan a `MasterMarkers` (`lib/master/markers.ts`).
- El aviso de hooks y doctrina desactualizados frente al binario reusa `computeRenderPending`
  (`commands/status.ts`, un render en seco), que hoy solo usa `navori status`.

### Gate (R1–R7)

`evaluatePlanGate` cambia de orden: primero clasifica el payload, después resuelve la raíz y la
configuración, y solo entonces lee el encargo.

1. **Payload (R4).** `parsePayload` devuelve una unión: `{ ok: true, payload }` o
   `{ ok: false, problem }`.
   - Es `problem` solo cuando la raíz no es objeto o cuando `tool_input` falta o no es objeto.
     `navori plan gate` ya no traga un JSON ilegible en `gateSubCommand`: lo pasa como
     `{ ok: false, problem: "payload is not valid JSON" }`.
   - Un campo `subagent_type`, `agent_type`, `prompt` o `message` con tipo distinto de `string` se
     trata como **ausente**, igual que hoy. En Codex eso lleva al despacho y en Claude a
     `NO_OPENING_LINE_REASON`. La forma V2 de `message` sigue sin verificar (0041 F20), y un
     `message` nulo o un payload solo con `items` no debe denegar todo spawn por "forma inesperada".
2. **¿Es un implementer? (R3).** Antes de leer nada:
   - Claude: `normalizeRole(subagent_type) === "implementer"`, con
     `normalizeRole = s => s.replace(/\s+/g, "").toLowerCase().replace(/^[^:]*:/, "")`. Sin
     `subagent_type` es `general-purpose`: deja pasar.
   - Codex: es implementer todo spawn cuyo rol normalizado falte o no esté en
     `NON_IMPLEMENTER_ROLES` (`scout`, `architect`, `auditor`, `reviewer`, `scribe`, `publisher`,
     `explorer`). `default`, `worker`, `orchestrator` y cualquier rol desconocido quedan gateados
     (decisión del usuario: fail-closed).
   - **Consecuencia aceptada.** Un spawn `default` sin rol que llegue mientras hay un despacho
     vigente lo consume (es un implementer para el gate), y el implementer real recibe
     `already claimed`. Es fail-closed: nada pasa sin plan. La doctrina Codex manda nombrar un rol
     de la lista en todo spawn de análisis.
   - **Cómo sabe el gate que es Codex.** El hook ya distingue su copia de Codex por `$0`
     (`plan_gate_no_verdict` en `plan-gate.sh`). La copia Codex invoca
     `NAVORI_HOOK_ENGINE=codex navori plan gate`. El binario usa esa variable y, si falta (copias
     viejas del hook), conserva la heurística actual: `agent_type` presente. Una variable de entorno
     no rompe un binario viejo; un flag desconocido podría.
   - Un payload `problem` no se clasifica: sigue al paso 3 y se deniega si el gate está activo.
3. **Raíz y configuración (R2, R1).** `configRoot(cwd)` = `git rev-parse --show-toplevel` desde el
   `cwd` del payload (o `process.cwd()`), sin lanzar; si no es un checkout, el mismo `cwd`.
   - `navori.config.json` ausente en esa raíz ⇒ allow.
   - Presente pero `readConfig` lanza ⇒ deny con el mensaje de `ConfigError` y la salida:
     "corrija `navori.config.json` o actualice navori si la configuración es más nueva que el
     binario". Como no se puede leer, deniega aunque `planTiers` estuviera apagado.
   - `planTiers !== true` ⇒ allow.
   - Activo: `checkoutRoot` sigue siendo el control duro (symlinks, no-Git), como hoy.
   - Un payload `problem` con el gate activo ⇒ deny nombrando el problema.
   - **Repos anidados y worktrees (aceptado así).** Un `cwd` dentro de un submódulo o de un repo
     anidado resuelve el toplevel interior. Si allí no hay `navori.config.json`, ese checkout no
     usa navori y el gate deja pasar. Un worktree enlazado sin la config (repos donde va
     gitignored) se trata igual. Se documenta en la doctrina del gate; no se sube al
     `--git-common-dir`.
4. **Apertura `workplan:`/`spec:` (R5).** `evaluateWorkplan` llama a
   `checkWorkplan(raw, { cwd: root.cwd, feature })`. Las reglas nuevas de R15 (feature, nivel
   recalculado, `BLOCKED`) viven en `checkWorkplan`, así que gate y `plan check` no pueden
   discrepar. La verificación `spec` conserva solo `level !== 3`.
5. **Apertura `nivel-0:` (R6, R8).** La gramática pasa a `nivel-0: <path>[,<path>…] <feature>`
   (aceptada por el usuario). El `<feature>` es obligatorio porque la cuenta de rechazos se indexa
   por `review_<feature>.md`. En Codex V2 el feature sale del despacho y debe coincidir. Orden de
   decisión:
   - falta `<feature>` ⇒ deny con la forma nueva. Si la doctrina renderizada todavía muestra la
     forma vieja, el mensaje pide `navori render --apply`;
   - existe `workplan_<feature>.json` ⇒ deny `la feature ya tiene workplan; abra con
     workplan: <feature>`. Así una feature con plan (y quizá nivel ≥2 con rechazos) no puede
     esquivarlo bajando a nivel 0;
   - normalización de rutas, la misma de R19 más dos reglas: una ruta absoluta o con un segmento
     `..` ⇒ deny; `//` se colapsa; sin plegado de mayúsculas;
   - alguna ruta normalizada casa con `criticalPaths` (`matchesCriticalPaths`, ahora exportado) ⇒
     deny;
   - `classify` ≠ 0 ⇒ deny, como hoy;
   - `evaluateEscalation(root, feature, 0)`.

   **Residuo declarado.** La ruta y el slug los declara el orquestador. Un slug nuevo para el mismo
   trabajo empieza la cuenta en 0, y el gate no ve el diff real. La doctrina lo dice (R6).
6. **Despacho Codex (R7).** `readDispatch` trata como vencido un `createdAt` posterior a `now` en
   más de 60 s (`DISPATCH_FUTURE_SKEW_MS`), además del TTL de 10 min. Es un control contra relojes
   torcidos, no contra un agente hostil: el despacho lo escribe el propio orquestador. Tras una
   decisión `allow`, el gate **reclama** el archivo con
   `renameSync(file, ".dispatch_<f>.json.claim-<pid>-<now>")` y compara los bytes reclamados con
   los evaluados:
   - `ENOENT` en el rename ⇒ deny `dispatch already claimed by a concurrent spawn`;
   - bytes distintos ⇒ deny `dispatch changed during evaluation; rewrite it and retry`;
   - después, `rmSync` del archivo reclamado.

   El nombre empieza con `.` a propósito: `dispatch_<f>.claim-….json` sí casaría con
   `DISPATCH_FILE` y se leería como un despacho con feature equivocado, lo que bloquearía todo
   despacho posterior. Mismo precedente que `writeStateFileAtomic` (`.${name}.tmp-pid`).

### Escalación (R8, R9)

- `recordAndCountRejections` cuenta los `reviewHash` **posteriores a la última línea `reset`** y
  devuelve también su `ts`. La deduplicación sigue siendo contra todo el historial, así que el
  `CHANGES_REQUESTED` que motivó el reinicio no se vuelve a contar aunque `review_<f>.md` no cambie.
- **Nivel 0 o 1 (R8): el tope se renueva por pares.** Con `n` ≥ 2 rechazos vigentes, el rechazo
  que cerró el par más reciente es el número `2·⌊n/2⌋`. `solution_<f>.md` y
  `solution_review_<f>.md` deben existir **y** tener `mtime` posterior al `ts` de ese rechazo. Así
  los rechazos 4, 6… exigen rehacer el diseño y su challenge. Hoy basta con que los archivos
  existan, aunque sean viejos o vacíos, y desde la primera escalación el tope se pierde.
- **Nivel ≥2 (R9).** Se deniega con la instrucción de escalar, y el mensaje nombra
  `navori plan escalation-reset <f> --approved-by user --reason "<…>"`, que corre el usuario.
- **`navori plan escalation-reset <feature> --approved-by user --reason <texto>`**:
  - exige `--approved-by user` literal (como `approveDeliveryBaseline`) y `--reason` no vacío;
  - rechaza si `workplan_<f>.json` falta o su `level` es < 2. En 0/1 la salida es el diseño (R8), no
    el reinicio (decisión del orquestador);
  - rechaza si no hay ≥2 rechazos vigentes;
  - agrega `{"ts","kind":"reset","approvedBy":"user","reason","rejectionsBefore"}` a
    `workplan_<f>.gate.jsonl` con `appendFileSync`, tras `ensureStateDirectory`;
  - emite `appendCliEvent(cwd, { name: "plan-escalation-reset", verdict: "allow" })`, nombre que se
    agrega a `METADATA_NAMES` (`lib/audit/cli-event.ts`). El evento no lleva la razón; la razón
    queda solo en el log local.
- **Confirmación del host:**
  - una regla `ask` `Bash(navori plan escalation-reset:*)` en `settings-base.json`: prompt en Claude
    y `prefix_rule` `prompt` en Codex vía `buildCodexRules`;
  - en `master-accept-confirm.sh`, `RESET_RE` en el `TRIGGER_RE`, `escalation-reset` en
    `TRIGGER_TOKENS` y una rama `*escalation-reset*` en `approval_description` ("another review
    round after two rejections at level 2 or higher"). En Claude es `ask`; en Codex es
    deny-as-confirmation, que cubre subagentes, donde `prefix_rule` no pregunta.

  Es el mismo par que ya protege `navori master close`. En Claude, regla e hook pueden mostrar dos
  prompts; se acepta.
- **Seatbelt, no frontera de seguridad.** `workplan_<f>.gate.jsonl` es un archivo local sin
  protección. Un agente puede anexarle una línea `reset` con `echo >>` (pre-aprobado) o borrarlo, y
  hoy borrarlo ya reinicia la cuenta. `approvedBy: "user"` registra lo que el comando exigió, no una
  identidad verificada. La doctrina lo declara junto al recibo (R47), y no se agrega una regla de
  `guard-destructive`.

### CLI del workplan (R10–R19)

- **`plan update` (R10, R11, R16).** Se parte en dos fases.
  - **Fase 1, sin lock:**
    - parseo estricto: `^(A\d+)=(pendiente|cumplido|bloqueado)$`, `--date` con `z.iso.date()`;
    - `--progress` junto con `--decision` ⇒ error de uso, exit 1;
    - `applyWorkplanUpdate` sobre el `Workplan` tipado (valida ids existentes) y validación de
      evidencia (`validateEvidence`, que puede tardar por la huella). El resultado es una lista de
      **mutaciones**: `progress[id] = status`, `evidence[id] = valor | borrar` y
      `decisions += {text, date}`.
  - **Fase 2, dentro de `withFileLock(<stateRoot>/.plan-update.lock)`** (timeout 5 s, stale 30 s,
    los valores por defecto), con `ensureStateDirectory` antes de tomar el lock (sin el directorio,
    `openSync(…, "wx")` fallaría con `ENOENT`):
    - se relee el JSON **crudo** como objeto;
    - por cada `cumplido`, se verifica que el `command` del criterion en el crudo siga siendo el
      validado. Si no, exit 1 `criterion changed concurrently; rerun`;
    - un helper nuevo `applyMutationsToRaw(raw, mutations)` (`lib/plan/render.ts`, junto a
      `applyWorkplanUpdate`) aplica las mutaciones **sobre el objeto crudo**. Crea `progress`,
      `decisions` o `evidence` cuando faltan, porque el esquema los rellena por defecto y el crudo
      puede no traerlos. Los campos no declarados sobreviven a cualquier profundidad (R16);
    - se valida con `WorkplanSchema.safeParse` y solo entonces se escriben JSON, `.md` e índice de
      aceptación (R10).

  El lock es por raíz de estado, no por feature, porque `writeAcceptanceIndex` reescribe un índice
  compartido. Lo toman `plan render` y `prepareDeliverySlice` (`lib/master/slice.ts`, que escribe
  un workplan y el índice). Medido en el challenge: reconstruir el índice con 108 workplans toma
  unos 28 ms, así que la sección crítica es corta. `delivery-criterion` (`part.ts`) solo lee el
  workplan y no lo toma.
- **`evidenceRequired` (R12, R13).** El `catch` hoy devuelve `codexSession`, así que Claude y Pi
  con configuración **ilegible** aceptan `cumplido` sin evidencia (nota de R12 ya corregida).
  - Configuración presente e ilegible dentro de una sesión identificada ⇒ `true` para los tres
    motores; ausente ⇒ `false`, igual que R1.
  - **El hilo principal de Claude ya exige evidencia.** Claude Code pone
    `CLAUDE_CODE_CHILD_SESSION=1` en todo subproceso que lanza por Bash, PowerShell o Monitor,
    hooks y status line. Es decir, en cualquier hilo, no solo en subagentes
    (https://code.claude.com/docs/en/env-vars, consultado 2026-10-14; en esta sesión el Bash de un
    subagente lo muestra). El carril de éxito (`navori_bash_success_lane` en
    `_partials/bash-outcome.sh`, invocado desde `routing-watch.sh` con `claude-post-tool-use`) no
    filtra por `agent_id`: registra evidencia del hilo principal también.
  - Por eso `plan update` desde el orquestador exige evidencia sin `CLAUDECODE`, y R48 pre-aprueba
    `plan render` y `plan update`. `cumplido` sin evidencia solo queda para quien corre el CLI fuera
    de un host (una terminal humana) o para un motor sin señal, y aparece como advertencia (R13).
    La razón de `ENGINE_CAPABILITIES.claude.controls["acceptance-evidence"]` deja de decir "child
    session".
- **`cd` encadenado (R14).** `leadingCdDir` pasa a `cdChainDir(command)`:
  - si el comando contiene `;`, `||`, salto de línea, `(`, `` ` `` o `$(`, se rechaza todo el modelo
    y solo vale la raíz;
  - si no, se parte por `&&` y se componen, en orden, todos los segmentos que sean exactamente
    `cd <dir>`, con `<dir>` relativo y de segmentos simples (las mismas reglas de hoy: sin `..`,
    `~`, comillas, variables ni globs);
  - un segmento que no es `cd` pero menciona `cd`, `pushd` o `popd` también rechaza el modelo;
  - `cd a && x && cd b` ⇒ `<tree>/a/b`. El destino debe seguir dentro del árbol.
  - Si la evidencia se rechaza por `cwd`, el `fix` deja de ser el comando repetido. Dice desde qué
    directorio corrió, desde cuál debe correr (`cd <tree>` primero) y la alternativa: cambiar el
    `command` del criterion a `cd <rel> && …`, re-renderizar y correrlo.
- **`plan check` (R15).** Reglas nuevas en `checkWorkplan`, con firma
  `checkWorkplan(raw, { cwd?, feature? })`:
  - `acceptance-duplicate-id`;
  - `feature-mismatch` (cuando se pasa `feature`);
  - `solution-blocked` (`solution.verdict === "BLOCKED"`);
  - `level-below-classification` extendido: compara `level` con el máximo entre
    `classification.level` y el **recálculo** `classify({ files: plan.files.map(f => f.path),
    ...declaredFlagsFromSignals(plan.classification.signals), ...projectClassifyContext(cwd) })`.
    `classify` es puro y lineal en archivos × globs; el costo es despreciable. Se conserva el id de
    regla para no romper a quien filtra por él; el mensaje dice cuál de los dos niveles ganó.

  El subcomando `check` envuelve `JSON.parse`: un JSON ilegible es un hallazgo `schema` con el
  mensaje del parser, sin traza, y exit 2.
- **`classify` (R17, R18, R19):**
  - `readProjectClassifyContext` sale de `commands/plan.ts` a `lib/plan/classify.ts` como
    `projectClassifyContext(cwd)`, para que lo compartan `check`, gate y CLI;
  - **R19:** un helper `normalizeRepoPath(p)` en `classify.ts` aplica `path.posix.normalize` tras
    cambiar `\` por `/`, quita `./`, colapsa `//` y descarta vacíos, sin plegar mayúsculas.
    Devuelve además si la ruta es absoluta o escapa con `..`. `classify()` normaliza sus `files`
    al entrar, así que vale para todo llamador; las rutas absolutas o con `..` se clasifican tal
    cual (no casan con globs relativos). La apertura `nivel-0:` las deniega (gate, paso 5);
  - **R17:** sin `--files`, sin `--diff` y sin borrador con `files` no vacío ⇒ error de uso, exit 1;
  - **R18:** `--diff` toma la unión de
    `git -c core.fsmonitor=false --no-optional-locks diff --name-only -z <merge-base>` (commiteado
    y sin commitear, contra el árbol de trabajo) y `git ls-files -z --others --exclude-standard`.
    La base por defecto es `origin/<prTarget>` de `effectiveConfig`; sin configuración, `origin/main`
    como hoy. `--no-optional-locks` evita reescribir `.git/index` al refrescar stat.

### Plan maestro (R20–R35)

- **R20 (solo legacy, decisión del orquestador).** `PartSchema.superRefine` rechaza `\n`, `\r` o
  `<!--` en todo texto que `renderMasterParts` lleva a la región: `title`, `objective`, `scope[]`,
  `outOfScope[]`, `seedRequirements[]`, `acceptance[].description` y los campos de método
  (`test.file`, `test.case`, `command.run`, `manual.check`). El mensaje nombra parte, campo y
  arreglo: `P<n>.<campo>[<i>]: no puede contener salto de línea ni '<!--'; edite parts.json y
  sepárelo en elementos de lista o en una sola línea`. Las partes de `deliveries` no se tocan.
- **R21.** Un helper `assertNoCloseInProgress(state, stageDir)` en `lib/master/stages.ts`, junto a
  `assertLegacyStage`, lanza `cierre iniciado (<outcome>); reanude con 'navori master close'`.
  Lo llaman `changeMasterPart`, `runMasterAdvance` (vía `buildCheckContext`) y `setMasterUx`.
- **R22.** `openNewStage` falla con `slug "<s>" ya lo usó la etapa <dir>; elija otro` si algún
  `index.stages[].slug` coincide, sin importar su estado.
- **R23.** `checkClosedStage` ramifica por `entry.workflow === "deliveries"`:
  - valida `state.json` con `DeliveryStateSchema`, `phase === "closed"` y `closure` presente;
  - no exige `CLOSURE.md`;
  - no compara `STATUS.md` con un render, porque una etapa cerrada ya no se regenera.
- **R24, R32.** El `renderStatusMd` de deliveries:
  - deja la línea `<E>: <decision>; publication=<…>` sin `presented=` ni `scope=`. Esos campos
    siguen en `deliveryLifecycle.deliveries[]` de `--json`;
  - elimina la línea `Preparación:`; `Fase:` y "## Bloqueos" ya dicen lo mismo.

  `runMasterInit` deja de imprimir "ejecución, aceptación y publicación aún no disponibles" e
  imprime la secuencia real de subcomandos. El diagnóstico `deliveries-pending` de
  `lib/diagnose/master-plan.ts` deja de decir "execution not ready for delivery" y nombra el
  siguiente subcomando según los bloqueos.
- **R25.** En `deliveryLifecycle` deja de haber un `catch` mudo. Si existe una presentación y la
  identidad revisada no la iguala, el bloqueo es
  `<E>: la prueba técnica quedó obsoleta: <causa>`, con `causa` = el mensaje lanzado, o
  `el árbol cambió desde la presentación` si solo difiere la identidad.
- **R26.** `readMasterStatus` (deliveries) ya no lanza ante `parts.json` inválido: devuelve
  `workflow: "deliveries"` y el bloqueo `parts.json inválido: …`. `runMasterInit`, que pasa por
  `writeMasterStatus`, deja de mostrar traza.
- **R27.** `baseline is missing or stale` con `authorization` presente pasa a
  `baseline obsoleta con cola autorizada; revóquela con 'navori master delivery-revoke' y apruebe
  baseline y cola de nuevo`. `approveDeliveryBaseline` nombra el mismo comando en su
  `changed baseline requires explicit queue revision`.
- **R28.** `checkDeliveryPreparation` agrega un bloqueo si `parts.json.spec` no existe o sale de
  `specsDir` (contención física, el mismo patrón de `safeSpec`).
- **R29.** `runMasterCheck`: si `masterPartsRegion` devuelve `null` y el contenido trae
  `<!-- navori:master-parts`, el hallazgo es
  `marcador '<!-- navori:master-parts' sin cierre; corríjalo a mano`, no "repare con status", que
  fallaría (0051 R11).
- **R30.** `deliveryProofTree(cwd, stagePath, { readOnly })` pasa `readOnly` a `fingerprintTree`;
  `reviewedDeliveryIdentity` y `effectiveDeliveryPart` lo propagan, y `deliveryLifecycle` (camino
  de `status`) lo activa. Las escrituras de entregas (`part.ts`, `presentDelivery`, …) siguen sin
  `readOnly`. `memoryTree` produce el mismo id de árbol sin objetos ni índice temporal, y
  `codex-resume.test.ts` ya fija la igualdad entre ambos modos. En modo `readOnly`,
  `fingerprintTree` todavía corre `rev-parse --git-path` y revisa el `.lock`, pero no escribe.
- **R31.** `MasterMarkers` gana:
  - `codebaseHeaders` (`es`: Stack, Estructura, Convenciones, Specs; `en`: Stack, Structure,
    Conventions, Specs), que reemplaza `CODEBASE_HEADERS` y su `TODO(i18n)`;
  - las etiquetas de `STATUS.md`, de la región y de `CLOSURE.md`.

  `renderStatusMd(status, language)` y `renderMasterParts(parts, mode, language)` reciben el idioma
  como parámetro **obligatorio**: el compilador encuentra los 9 llamadores de `renderStatusMd`, y un
  llamador olvidado no puede escribir en un idioma y comparar en otro. `renderClosure` ya ramifica
  algunas etiquetas por `language`; se completan.
- **R33.** `runMasterClose` rechaza al inicio, antes de ramificar por workflow:
  `options.reason !== undefined && options.reason.trim() === ""` ⇒ `--reason no puede estar vacío`.
  Hoy `""` es falsy y en `deliveries` pasa como ausente.
- **R34.** `contextForArchitects(index, masterDir)` filtra con `existsSync`.
- **R35.** Un helper `readDeliveryWorkplan(cwd, feature)` en `part.ts` reemplaza las dos lecturas
  crudas. Si falta, lanza
  `falta el workplan .navori/state/handoffs/workplan_<f>.json; créelo con 'navori master delivery-slice <P>'`,
  con ruta relativa al checkout.

### Confirmación (R36)

`guard-destructive.sh` **no** desenvuelve `sh -c` ni `eval`: su cabecera lo declara como límite
("Still unhandled: `sh -c`, `eval`, …"), y `gate-trigger.sh` dice lo mismo de
`navori_count_triggers`. No hay parser que reusar, y crear uno contradice el driver 4. Lo que sí se
reusa es que `TRIGGER_RE` de `master-accept-confirm.sh` **no está anclado** (`.*${BOUND}(…)`):
`eval navori master close` ya se detecta. Lo que lo rompe son las comillas, porque `BOUND` no
incluye `"` ni `'`. La corrección:

- antes de `is_scan_trigger`, borrar **solo** `"` y `'` de `cmd`: `cmd="${cmd//[\"\']/}"`.
  - **Nunca `\`.** `navori_count_triggers` une `\<salto>` con un espacio antes de segmentar
    (FIX B de `gate-trigger.sh`). Si el hook borrara la `\` antes, la continuación partiría el
    segmento y `navori master part P1 \⏎ --accept A1 --approved-by user` dejaría de preguntar
    (challenge B1, medido en bash y zsh).
  - Con esto, `sh -c 'navori master close'`,
    `bash -lc "cd x && navori master part P1 --accept A1 --approved-by user"`,
    `eval "navori master close"` y `navori master "close"` caen en el mismo segmento que ya casa.
  - El error posible es preguntar de más (`echo "navori master close"`), la dirección segura, y ya
    pasa hoy con `echo navori master close`.
- el atajo `has_trigger_token` sigue sobre el payload crudo. El residuo es una palabra partida por
  comillas (`navo"ri`), que es ofuscación deliberada; la cabecera del hook lo declara.
- **Codex `delivery-*`.** Reglas `ask` en `settings-base.json` para `delivery-baseline`,
  `delivery-queue`, `delivery-criterion`, `delivery-review`, `delivery-decision`,
  `delivery-publication` y `delivery-revoke`. `buildCodexRules` las traduce a `prefix_rule`
  `prompt`. Sus entradas en `EXPECTED_PROMPTS` (`asset-command-permissions.test.ts`) quedan
  redundantes y se borran. `delivery-check`, `delivery-slice` y `delivery-present` no aprueban ni
  revocan y no reciben regla.

### Doctrina, settings y aviso de render (R13, R37–R48)

- **R40.** Se agregan a `managed/planificacion.md`, que se renderiza solo con `planTiers` y entra
  primero (`05-`), tres líneas:
  - la precondición de plan;
  - "toda escritura de código pasa por `implementer` → `reviewer`, sin ruta inline";
  - la apertura `spec: <spec> E<n> M<n>`.

  Se borra el "see `orquestacion`" de la fila 3. Medido en este repo: `10-orquestacion.md`
  (6,833 caracteres) ya llega como puntero detrás de los 1,860 de `05-`. Sin `planTiers` no existe
  `05-` y `10-` cabe (6,833 < 8,000), así que no hace falta mover nada fuera de `orquestacion`.
- **R38.** Una sola redacción, en `planificacion`, `agents/orchestrator.md` ("Caps") y
  `skills/plan-advanced.md`: "Dos `CHANGES_REQUESTED`: en nivel 0/1, un `solution_<f>.md` y su
  challenge nuevos antes del siguiente despacho (cada par de rechazos pide los suyos); en nivel ≥2,
  escala al usuario; solo él autoriza otra ronda con `navori plan escalation-reset`".
- **R41.** Cambia el texto en estos lugares:
  - `planificacion`: "Codex plan-gate is advisory…" pasa a "Codex: the plan-gate denies; one
    implementer at a time (two or more fresh `dispatch_<f>.json` deny); name a listed role on every
    analysis spawn";
  - la nota Codex de `orquestacion`;
  - la `reason` de `ENGINE_CAPABILITIES.codex.controls["plan-gate"]`
    (`engine-capabilities.ts`);
  - la fila `spec-delivery-publication` de `docs/native-overlap.md`.

  Y cambia un `state`: `ENGINE_CAPABILITIES.codex.controls["acceptance-evidence"]` pasa de
  `unsupported` a `advisory`, con el carril de evidencia por rollout de 0050. No es solo texto:
  - `codexControlCapability` y `codexCapabilityFor` (`codex-parity.ts`) resuelven
    `control:acceptance-evidence` por la fila de `CODEX_PARITY` y su verificación por versión. Una
    declaración `advisory` exige una `CodexVerification`;
  - el hito busca la verificación que 0050 registró para el carril de rollout. Si existe, la fila
    apunta a ella. Si no, la capacidad versionada queda `unknown` (la política vigente), solo cambia
    la declaración de render, y la doctrina no promete más;
  - `control-inventory.test.ts` ("acceptance-evidence control") se ajusta: Claude y Codex
    `advisory`, los motores de prosa `unsupported`.

  El `state` de `plan-gate` sigue gobernado por la verificación por versión (S4); allí solo cambia
  el texto.
- **R47 y C1.** La doctrina del reviewer y `plan-advanced` declaran juntos que el recibo, el log del
  gate y su `reset` son atestaciones locales sin autenticación: seatbelts contra la inercia, no
  fronteras contra un agente deliberado. La independencia del review en Codex depende de
  `CODEX_THREAD_ID`.
- **R6, R13, R37, R39, R42–R46.** Ediciones de texto:
  - `plan-simple`: R13 (con la aclaración del hilo principal), R43 (un solo responsable de
    `plan update`, marcar justo tras correr sobre el mismo árbol, borrador mínimo con
    `classification` y las señales), R44;
  - `plan-advanced`: R37, R38, R44;
  - `agents/reviewer.md`: R42, R45 (`navori receipt gate --phase`);
  - `skills/master-plan.md`: R46;
  - `spec-bootstrap` u `orquestacion`: R39, apertura sin entregas y workplan de entrega de nivel 3;
  - `planificacion`: R6 (el gate verifica solo la ruta declarada, autodeclarada igual que el slug;
    deniega rutas absolutas y `..`; una feature con workplan abre con `workplan:`) y la gramática
    nueva de `nivel-0:`.

  Los espejos se regeneran con `navori render --apply` y los Markdown los escribe `scribe`.
- **R48.** Se agregan `Bash(navori plan render:*)` y `Bash(navori plan update:*)` al `allow` de
  `settings-base.json`, y se borran sus dos entradas de `EXPECTED_PROMPTS`. `plan update` entra
  también: con el hilo principal ya bajo evidencia (arriba), quitar el prompt no abre un `cumplido`
  silencioso. En Codex `allow` nunca se traduce (`build-rules.ts`).
- **Aviso de render pendiente en `doctor` (C4/C9 del challenge).** `doctor` no detecta hoy hooks ni
  doctrina renderizados más viejos que el binario. `navori status` sí, con `computeRenderPending`.
  - La función sale de `commands/status.ts` a `lib/render/render-pending.ts`.
  - `doctor` agrega una advertencia `render-pending` con el conteo y la orden
    `navori render --apply`.
  - Así se ven las copias de `plan-gate.sh` sin `NAVORI_HOOK_ENGINE` y la doctrina con la apertura
    `nivel-0:` vieja.

### Markdown de doctrina para el implementer (R49)

Decisión de Ulises (2026-10-14), tomada en M15: la doctrina de IA es parte del código que el
implementer cambia. Mandarla al scribe obliga a una ronda implementer → scribe → implementer en cada
hito de doctrina (M15 la tuvo) sin ganar nada: el scribe escribe la misma prosa con menos contexto.
Revierte en parte la decisión de 0030 ("ningún `.md`"): el scribe sigue dueño del Markdown de
estado y de entregables para humanos.

- **Lista cerrada de prefijos, relativa a la raíz del repo**, en el hook (no en la configuración):
  - fuente: `packages/core/core-assets/{agents,skills,managed,hooks}/`;
  - Claude: `.claude/{agents,skills,context,hooks}/`;
  - Codex: `.codex/agents/`, `.codex/hooks/`, `.agents/skills/` y `.codex/orchestrator.md`;
  - Pi: `.pi/navori/` (hooks y doctrina que renderiza su motor).
- **Solo herramientas de edición.** `Write`, `Edit`, `NotebookEdit` y cada ruta de `apply_patch`
  pasan si la ruta está en la lista. Las formas de Bash (redirección, `tee`, `sed -i`, `perl -i`,
  `cp`/`mv`, intérpretes) siguen bloqueando todo `.md`: el texto de un comando no da una ruta
  confiable, y la herramienta de edición basta.
- **Normalización.** Una ruta absoluta se recorta contra la raíz del repo (`git rev-parse
  --show-toplevel` desde el `cwd` del payload, o `CLAUDE_PROJECT_DIR`). Una ruta fuera de la raíz o
  con un segmento `..` se bloquea. Symlinks: misma limitación aceptada del encabezado del hook.
- **Espejos.** Editar un espejo generado (`.claude/agents/…`) lo pisa el siguiente render; la
  doctrina del implementer dice que edite la fuente y corra `navori render --apply`. El hook no lo
  distingue: es contrato, no barrera.
- **Mensaje.** El bloqueo nombra los prefijos permitidos y la ruta `markdownRequests` para el resto.
- **Pi.** `role-tools.ts` aplica la misma lista para el implementer. La vía gestionada de Pi (D4)
  rechaza `.pi/navori/` antes de esta lista, así que ahí la escritura sigue bloqueada en Pi.
- **Doctrina.** `agents/implementer.md`, `agents/scribe.md` y la regla de ejecución de `tasks.md`
  dicen qué Markdown escribe cada rol.

### Opciones descartadas

- **R11: compare-and-swap sin lock** (releer el hash y reintentar). Con evidencia lenta, dos
  procesos pueden reintentar en bucle, y además falta un lock para el índice compartido. Un lock
  corto alrededor de lectura, aplicación y escritura es más simple y ya existe.
- **R11: el lock alrededor de todo, incluida la evidencia.** La huella de un repo grande puede pasar
  el timeout de 5 s y bloquear a los demás. Se descarta por la duración, no por la corrección.
- **R7: un lockfile `O_EXCL` por despacho.** Deja un `.lock` huérfano si el hook muere y necesita
  política de stale. `rename` es atómico, no deja nada que caducar y consume el archivo en el mismo
  paso.
- **R3: derivar los roles que no escriben de `ROSTER_AGENTS` por exclusión.** Un rol nuevo que
  escriba quedaría exento sin que nadie lo decida. La lista explícita más la prueba de paridad
  obliga a decidirlo.
- **R3: no consumir el despacho si el rol es `default`.** Abriría un camino sin plan para un spawn
  que el gate considera implementer. El usuario eligió fail-closed.
- **R3: detectar Codex por `tool_name`.** No está en las fixtures ni verificado en el payload
  `[SIN VERIFICAR]`; `$0` ya es el discriminador del hook.
- **R4: denegar campos con tipo inesperado.** La forma V2 de `message` no está verificada; un host
  que mande `null` dejaría sin despacho todo implementer.
- **R8: indexar el nivel 0 por la ruta.** `review_<f>.md` va por feature; la cuenta sería siempre 0.
- **R8: pasar a la escalación de nivel 0 el nivel del workplan existente.** Denegar `nivel-0:`
  cuando existe workplan es más simple y empuja a la apertura correcta.
- **R9: reinicio sin confirmación o solo por regla `ask`.** En subagentes Codex `prefix_rule` no
  pregunta (sonda V1, `codex-parity.ts`). Hace falta el hook.
- **R9: proteger `*.gate.jsonl` con una regla de `guard-destructive` o `role-guard`.** Sería una
  regla por patrón de texto, fácil de rodear (`tee`, `cp`, Write); prometería una frontera que no
  hay. Se declara seatbelt.
- **R36: un parser de `sh -c`/`eval`.** Contradice el driver 4 y el encuadre de seatbelt.
- **R36: borrar también `\`.** Rompe la unión de `\<salto>` (challenge B1).
- **R40: encoger `orquestacion` hasta que quepa.** Le faltan unos 700 caracteres, y el bloque crece
  con cada spec; mover tres líneas a `05-` garantiza la entrega.
- **R16: `WorkplanSchema.loose()`.** Solo preserva el nivel raíz; los objetos anidados se seguirían
  podando. Parchar el JSON crudo preserva todo.
- **R31: `language` dentro de `MasterStatus`.** Ensucia `--json` con un dato de render.
- **R48: dejar `plan update` como `ask`.** Se descartó con la evidencia del hilo principal; el
  prompt no agrega garantía sobre la que ya da la evidencia.
- **R2: subir al checkout principal con `--git-common-dir`.** Cambia qué repo "usa navori" en
  worktrees y submódulos; el caso se acepta y se documenta.

## Components

- `packages/cli/src/lib/plan/gate.ts`:
  - `parsePayload` (unión `ok`/`problem`, campos no string como ausentes), `normalizeRole`,
    `isImplementerSpawn`. Covers R3, R4.
  - `configRoot` y el orden nuevo en `evaluatePlanGate`. Covers R1, R2.
  - `evaluateWorkplan` usa `checkWorkplan(raw, { cwd, feature })`. Covers R5.
  - `evaluateNivel0` con la gramática nueva, la negativa ante workplan existente, las rutas
    normalizadas, `criticalPaths` y la escalación. Covers R6, R8.
  - `readDispatch` con el desfase futuro; claim por `rename` en `evaluatePlanGate`. Covers R7.
  - `recordAndCountRejections` cuenta después del último `reset` y devuelve los `ts`;
    `evaluateEscalation` exige `solution_*` posteriores al último par; mensaje de nivel ≥2.
    Covers R8, R9.
- `packages/cli/src/engines/shared/roster.ts`: `NON_IMPLEMENTER_ROLES` y
  `CODEX_BUILTIN_READ_ONLY_ROLES = ["explorer"]`. Covers R3.
- `packages/core/core-assets/hooks/plan-gate.sh`: `NAVORI_HOOK_ENGINE=codex` en la copia Codex.
  Covers R3.
- `packages/cli/src/lib/render/render-pending.ts` (sale de `commands/status.ts`) y la advertencia
  `render-pending` de `commands/doctor.ts`. Covers R3 (migración de hooks viejos) y R6 (doctrina
  vieja).
- `packages/cli/src/commands/plan.ts`:
  - `gateSubCommand` (JSON ilegible). Covers R4.
  - `updateSubCommand` (parseo, dos fases, lock, parche crudo). Covers R10, R11, R16.
  - `renderSubCommand` bajo el mismo lock. Covers R11.
  - `evidenceRequired`. Covers R12.
  - `checkSubCommand`. Covers R15.
  - `classifySubCommand` y `classifyDiff`. Covers R17, R18.
  - Subcomando nuevo `escalation-reset`. Covers R9.
- `packages/cli/src/lib/plan/render.ts`: `applyMutationsToRaw`. Covers R11, R16.
- `packages/cli/src/lib/plan/check.ts`: `checkWorkplan(raw, { cwd?, feature? })`, `checkLevel`
  con recálculo, `checkStructural` con ids duplicados, `BLOCKED` y feature. Covers R5, R15.
- `packages/cli/src/lib/plan/classify.ts`: `normalizeRepoPath`, normalización de entrada,
  `matchesCriticalPaths` exportado, `projectClassifyContext`. Covers R6, R19 y lo que comparten R5
  y R15.
- `packages/cli/src/lib/plan/evidence.ts`: `cdChainDir` (reemplaza `leadingCdDir`), `cdTargetCwd`,
  `fix` de `validateEvidence` en el caso `cwd`. Covers R14.
- `packages/cli/src/lib/audit/cli-event.ts`: `plan-escalation-reset` en `METADATA_NAMES`.
  Covers R9.
- `packages/cli/src/lib/master/schema.ts`: refinación de una línea en `PartSchema`. Covers R20.
- `packages/cli/src/lib/master/stages.ts`:
  - `assertNoCloseInProgress`. Covers R21.
  - `contextForArchitects(index, masterDir)`. Covers R34.
- `packages/cli/src/lib/master/part.ts`:
  - `changeMasterPart` llama a `assertNoCloseInProgress`. Covers R21.
  - `readDeliveryWorkplan`; los dos llamadores de `checkWorkplan` pasan `{ cwd, feature }`.
    Covers R35, R5.
- `packages/cli/src/lib/master/slice.ts`:
  - los dos llamadores de `checkWorkplan` pasan `{ cwd, feature }`. Covers R5.
  - `prepareDeliverySlice` escribe bajo `.plan-update.lock`. Covers R11.
- `packages/cli/src/lib/master/checks.ts`:
  - `runMasterAdvance` y `buildCheckContext`. Covers R21.
  - `checkClosedStage` con la rama de deliveries. Covers R23.
  - El hallazgo del marcador huérfano en `runMasterCheck`. Covers R29.
  - `CODEBASE_HEADERS` sale a `markers.ts`. Covers R31.
- `packages/cli/src/commands/master.ts`:
  - `setMasterUx`. Covers R21.
  - El texto de `init`. Covers R32.
- `packages/cli/src/lib/master/init.ts`: `openNewStage`. Covers R22.
- `packages/cli/src/lib/master/status.ts`:
  - `readMasterStatus` (deliveries). Covers R26, R27.
  - `renderStatusMd(status, language)`. Covers R24, R31, R32.
  - `renderMasterParts(…, language)`. Covers R31.
- `packages/cli/src/lib/master/delivery.ts`:
  - `deliveryLifecycle`. Covers R25, R30.
  - `deliveryProofTree`, `reviewedDeliveryIdentity` y `effectiveDeliveryPart` con `readOnly`.
    Covers R30.
  - El mensaje de `approveDeliveryBaseline`. Covers R27.
- `packages/cli/src/lib/master/delivery-checks.ts`: `checkDeliveryPreparation` con la
  contención de `spec`. Covers R28.
- `packages/cli/src/lib/master/close.ts`:
  - el rechazo de `--reason` en blanco. Covers R33.
  - las etiquetas de `renderClosure`. Covers R31.
- `packages/cli/src/lib/master/markers.ts`: `codebaseHeaders` y las etiquetas de estado, región
  y cierre. Covers R31.
- `packages/cli/src/lib/diagnose/master-plan.ts`: texto de `deliveries-pending`. Covers R32.
- `packages/core/core-assets/hooks/master-accept-confirm.sh`: borrado de comillas, `RESET_RE`,
  `TRIGGER_TOKENS` y `approval_description`. Covers R9, R36.
- `packages/core/core-assets/settings/settings-base.json`:
  - `ask` de `escalation-reset`. Covers R9.
  - `ask` de los siete `delivery-*`. Covers R36.
  - `allow` de `plan render` y `plan update`. Covers R48.
- `packages/cli/src/engines/shared/engine-capabilities.ts`, `codex-parity.ts`
  (`CODEX_PARITY`/`codexControlCapability`) y `docs/native-overlap.md`. Covers R41.
- Doctrina:
  - `managed/planificacion.md`. Covers R6, R38, R40, R41.
  - `managed/orquestacion.md` (nota Codex). Covers R41.
  - `agents/orchestrator.md`. Covers R38.
  - `agents/reviewer.md`. Covers R42, R45, R47.
  - `skills/plan-simple.md`. Covers R13, R43, R44.
  - `skills/plan-advanced.md`. Covers R37, R38, R44, R47.
  - `skills/master-plan.md`. Covers R46.
  - `skills/spec-bootstrap.md`. Covers R39.
  - Los presupuestos en `lib/assets/doc-budgets.ts` y `metadata.maxWords`. Covers R37–R47.

## Decisions

- **El nivel recalculado vive en `checkWorkplan`, no en el gate.** R5 y R15 piden la misma regla.
  Ponerla en el validador compartido hace imposible que `plan check` diga verde y el gate deniegue.
  Las entradas son `plan.files[].path`, `declaredFlagsFromSignals(classification.signals)` y
  `criticalPaths`/`localSkills` de la configuración. `classify` no lee disco. Medido en el
  challenge sobre los 108 workplans de este repo: 0 en rojo.
- **`nivel-0: <path> <feature>` (aceptado por el usuario).** Una apertura de un solo token se
  deniega con la forma nueva en el mensaje. Una feature con workplan no puede abrir en nivel 0.
- **Codex fail-closed (aceptado por el usuario).** `default`, `worker`, sin rol y desconocidos son
  implementers. `explorer` se agrega a la lista porque es el rol de solo lectura integrado de Codex
  (https://learn.chatgpt.com/docs/agent-configuration/subagents, citado por el challenge;
  `[SIN VERIFICAR]` en esta sesión). Un spawn `default` puede consumir un despacho vigente: se
  acepta como comportamiento fail-closed.
- **El reinicio solo existe para nivel ≥2 (decisión del orquestador).**
- **El tope de nivel 0/1 se renueva por pares** con `mtime` de los artefactos de diseño.
- **R20 solo legacy (decisión del orquestador, `requirements.md` ya actualizado).**
- **R12 requiere código (nota ya corregida en `requirements.md`).**
- **R48 incluye `plan update`.** La evidencia del hilo principal de Claude ya es obligatoria
  (`CLAUDE_CODE_CHILD_SESSION`, documentado por Anthropic) y el carril de éxito no filtra por hilo.
- **El lock es por raíz de estado.** El índice de aceptación es compartido. La contención real es
  de milisegundos: lectura, render y tres escrituras.
- **Claim después de decidir `allow`.** Un deny no consume el despacho (0041 lo prueba con "V2: a
  dispatch for a feature without a valid workplan is denied and kept").
- **Configuración ausente frente a ilegible:** la misma regla en el gate (R1) y en
  `evidenceRequired` (R12).
- **Reset y log del gate como seatbelt.** Sin regla nueva en `guard-destructive`; la doctrina lo
  declara con R47.
- **R31 con `language` obligatorio.** Lo evita el compilador, no una prueba.
- **R41: texto en `plan-gate`, `state` en `acceptance-evidence`.** El primero no tiene verificación
  nueva; el segundo sí refleja un carril que existe, sujeto a la verificación por versión.
- **Presupuestos.** `planificacion` está en 269/284 palabras. R6, R38, R40, R41 y la gramática
  nueva agregan unas 110. En el hito de doctrina se mide con `check:doc-budgets --list`, se sube el
  techo a la medida × 1.05 (redondeo hacia arriba) y se agrega un comentario que nombre `0052` y la
  medida, como el precedente de 0044. Igual con `metadata.maxWords` de `plan-simple`,
  `plan-advanced`, `master-plan` y `reviewer`, medidos con `countWords(parseAsset(raw).managedBody)`.
  La entrega de contexto se verifica con la advertencia de `check:doc-budgets`: `05-` crece unos
  600 caracteres y `20-`/`30-` siguen cabiendo (1,860 + 600 + 1,644 + 1,331 < 8,000).

## Contracts

- **`navori plan gate`:** exit 0 allow, exit 2 deny con `[navori] BLOCKED by plan-gate: <reason>`
  en stderr. Cambian:
  - JSON ilegible, raíz no objeto o `tool_input` ausente/no objeto con `planTiers` activo ⇒ 2
    (antes 0). Campos con tipo inesperado: ausentes, como hoy;
  - configuración presente e ilegible ⇒ 2 (antes 0), con la salida en el mensaje;
  - `cwd` en subdirectorio ⇒ la misma decisión que la raíz;
  - Codex con rol ausente o fuera de `NON_IMPLEMENTER_ROLES` ⇒ gateado;
  - un segundo spawn sobre el mismo despacho ⇒ 2 `dispatch already claimed…`;
  - `createdAt` > `now` + 60 s ⇒ vencido.

  Entrada nueva: la variable `NAVORI_HOOK_ENGINE=codex`.
- **Apertura `nivel-0:`:** `nivel-0: <path>[,<path>…] <feature>`, con `<feature>` igual a
  `FEATURE_SLUG`. Deniega si falta la feature, si existe `workplan_<feature>.json`, si una ruta es
  absoluta o lleva `..`, si alguna ruta casa con `criticalPaths` o si hay escalación pendiente.
- **`navori plan check`:** exit 0 ok, exit 2 con hallazgos, exit 1 si el workplan no existe.
  Reglas nuevas: `acceptance-duplicate-id`, `feature-mismatch`, `solution-blocked`; JSON ilegible
  ⇒ `schema`. `level-below-classification` incluye el recálculo. `--json` conserva
  `{ ok, findings, warnings }`.
- **`navori plan update`:** exit 0 y escribe; exit 1 y no escribe por uso inválido, evidencia
  rechazada, timeout de lock (`another plan update holds .plan-update.lock; retry`) o criterion
  cambiado. El JSON escrito valida con `WorkplanSchema` y conserva campos no declarados.
- **`navori plan classify`:** exit 1 sin entradas (R17). `--diff` incluye cambios sin commitear y
  sin seguimiento; la base por defecto es `origin/<prTarget>`. `--json` conserva sus campos.
- **`navori plan escalation-reset <feature> --approved-by user --reason <texto>`:** exit 0 y una
  línea `reset`; exit 1 sin escribir si falta o difiere `--approved-by user`, si la razón está en
  blanco, si no hay workplan, si el nivel es < 2 o si hay menos de dos rechazos vigentes. El host
  pide confirmación (regla `ask` y hook); es un seatbelt, no una atestación autenticada.
- **`workplan_<f>.gate.jsonl`:** las líneas existentes `{ts, reviewHash, verdict}` no cambian; se
  agrega `{ts, kind: "reset", approvedBy: "user", reason, rejectionsBefore}`. Un binario viejo
  ignora la línea `reset` (no tiene `reviewHash`) y cuenta de más: dirección estricta.
- **Escalación 0/1:** con `n` ≥ 2 rechazos vigentes, `solution_<f>.md` y `solution_review_<f>.md`
  con `mtime` posterior al rechazo número `2·⌊n/2⌋`.
- **`WorkplanSchema`:** sin cambios de forma.
- **`parts.json` legacy (`PartSchema`):** los textos renderizados no admiten `\n`, `\r` ni `<!--`.
  No hay campo nuevo.
- **`navori master status --json` (deliveries):** con `parts.json` inválido devuelve `workflow` y
  `blockers` en vez de fallar. `deliveryLifecycle.deliveries[]` conserva `scopeIdentity` y
  `presentedIdentity`.
- **`STATUS.md` deliveries:** sin `presented=`, `scope=` ni `Preparación:`, con etiquetas en el
  idioma declarado.
- **`navori doctor`:** advertencia nueva `render-pending` con el conteo de archivos que
  `navori render --apply` cambiaría.
- **Settings renderizados:**
  - `allow` + `navori plan render:*` y `navori plan update:*`;
  - `ask` + `navori plan escalation-reset:*` y los siete `delivery-*`. La prueba "recognizes only
    the intended `:*` ask entries" (`build-settings.test.ts`) pasa de 7 a 15 entradas;
  - `.codex/rules/navori.rules` gana 8 `prefix_rule` `prompt`.

## Failure modes

- **Dos `plan update` en paralelo.** El segundo espera el lock hasta 5 s.
  - Si lo obtiene, relee el crudo y aplica encima: nada se pierde.
  - Si no, sale con 1 nombrando el lock y no escribe: R11 permite rechazar, no perder.
- **Lock huérfano** (proceso muerto dentro de la sección crítica). `withFileLock` lo roba tras 30 s
  por `mtime`, con `rename` atómico. Mientras tanto, los demás fallan visiblemente a los 5 s. Un
  titular pausado más de 30 s borra en su `finally` un lock que otro robó; con una sección crítica
  de milisegundos se acepta.
- **Criterion editado a mano entre las dos fases.** La fase 2 lo detecta y rechaza todo; no se
  escribe evidencia de un comando viejo.
- **Workplan crudo sin `progress` o `decisions`.** `applyMutationsToRaw` los crea; la validación
  posterior lo confirma.
- **`delivery-slice` y `plan update` sobre la misma raíz.** Comparten el lock; el índice no pierde
  líneas.
- **Dos hooks sobre el mismo despacho.** Solo uno gana el `rename`; el otro deniega.
  - Si el hook muere entre el `rename` y el `rm`, queda un `.dispatch_….claim-…` que no casa con
    `DISPATCH_FILE` y no bloquea nada; basura acotada.
  - Si el orquestador reescribe el despacho durante la evaluación, la comparación de bytes deniega.
  - Si el `rename` falla por otro error, deniega (fail-closed).
  - Un spawn `default` puede gastar el despacho del implementer; el implementer recibe
    `already claimed` y el orquestador reescribe el despacho. Fail-closed, aceptado.
- **Cierre interrumpido.** Con `state.outcome` definido, `part`, `advance` y `ux` se rechazan con
  la instrucción de reanudar. `status` y `check` siguen funcionando, y `close` reanuda como hoy.
- **Payload del gate ilegible.** Con el gate activo deniega. Si el host deja de mandar
  `tool_input`, todo implementer se bloquea hasta corregirlo: es lo que pide R4, y el mensaje lo
  nombra. Un `message` con tipo raro no bloquea: cae al despacho o a "sin apertura".
- **Configuración ilegible.** El gate deniega aunque `planTiers` estuviera apagado, nombrando cómo
  salir. `plan update` exige evidencia. `plan check` recalcula sin `criticalPaths`, que es más
  laxo, pero el gate ya deniega antes.
- **Línea torcida en `gate.jsonl`.** Se ignora, como hoy. Si es una línea `reset`, cuentan los
  rechazos previos: más estricto, nunca más laxo.
- **`reset` escrito a mano por un agente o log borrado.** No se detecta. Es el seatbelt declarado;
  borrar el log ya reiniciaba la cuenta antes de esta spec.
- **`solution_*` tocados con `touch`.** Satisfacen el `mtime`. Es el mismo encuadre de seatbelt: el
  gate exige el paso y el reviewer lee su contenido.
- **`master-accept-confirm` con payload ilegible.** Sigue en fail-open (`[ -n "$cmd" ] || exit 0`),
  como hoy. El CLI exige `--approved-by user` en lo que registra aprobación. Riesgo aceptado y
  heredado: el hook es un seatbelt.
- **Comillas que parten una palabra** (`navo"ri master close`). El atajo de tokens no las ve.
  Residuo declarado.
- **`deliveryLifecycle` en modo `readOnly` sobre un repo enorme.** `memoryTree` respeta el mismo
  `deadline`; un timeout se reporta como bloqueo con causa (R25), no como identidad falsa.
- **Repo anidado o worktree sin configuración.** El gate deja pasar (aceptado, documentado).

## Migration

- **Workplans que ahora fallan `plan check` o el gate:**
  - `level` menor que el recálculo: archivos agregados tras `classify`, `criticalPaths` nuevos o
    señales guardadas que no cuadran con el nivel;
  - `feature` distinto del nombre del archivo, típico de un workplan copiado;
  - ids duplicados;
  - `solution.verdict: BLOCKED`.

  No hay migración automática: el mensaje es la migración. Para el nivel dice "corre
  `navori plan classify <f>`, sube `level` y `classification`, re-renderiza y vuelve a pedir
  aprobación". Un workplan de una feature terminada no se vuelve a evaluar mientras nadie lo
  despache.
- **Workplans de entrega** (`delivery-<slug>-p<n>`): `checkDeliveryPlanSource` ya exige
  `plan.level ≥ expected.level`. El recálculo nuevo usa las mismas entradas (`files` = `scope`),
  así que una proyección vigente no cambia de veredicto.
- **`parts.json` legacy con saltos de línea o `<!--` en una etapa abierta.** Desde esta versión
  todo `navori master …` de esa etapa falla hasta editarlo. El mensaje nombra parte, campo, índice
  y el arreglo (un elemento por línea). No se reescribe solo, porque cambiaría texto del usuario.
- **Aperturas `nivel-0:` de un token.** Se deniegan. El mensaje trae la forma nueva y pide
  `navori render --apply` si la doctrina renderizada sigue mostrando la vieja; `doctor` avisa
  `render-pending`. La doctrina se actualiza en el mismo PR.
- **Copias viejas de `plan-gate.sh`** sin `NAVORI_HOOK_ENGINE` conservan la heurística actual de
  Codex: un spawn sin `agent_type` pasa como `general-purpose`, justo el caso que R3 cierra. El
  aviso `render-pending` de `doctor` lo hace visible.
- **Etapas con slug repetido.** R22 solo impide abrir una nueva. Las que ya existen siguen legibles,
  y sus workplans de entrega colisionan por nombre. `checkDeliveryPlanSource` compara
  `source.stageSlug` y los digests, así que un workplan de la etapa vieja se reporta como
  `diverged` y no se acepta en silencio. Queda como limitación documentada, sin reparación
  automática.
- **`STATUS.md` de deliveries activos y regiones `en`.** Difieren una vez del render nuevo. El
  primer `navori master check` lo reporta con "repare con 'navori master status'" (0051 R9). Las
  etapas cerradas no se regeneran y R23 deja de compararlas. En repos `es`, la región y `STATUS.md`
  legacy no cambian de bytes.
- **Features en nivel 0/1 que ya pasaron una escalación.** Su `solution_*` es anterior al par de
  rechazos vigente si acumulan más de dos: el siguiente despacho pide rehacer el diseño. Es el
  objetivo del cambio.
- **Settings.** `navori render --apply` agrega las reglas. Un repo sin re-render sigue preguntando
  por `plan render`/`update`; `escalation-reset` lo confirma el hook aunque falte la regla.

## Testing strategy

Cada prueba responde a un riesgo de arriba y lleva `// Covers: R<n>`.

- **`lib/plan/__tests__/plan-gate.test.ts`:**
  - R1: configuración con JSON roto ⇒ deny con el error y la salida; sin archivo ⇒ allow (se
    conserva "allows when there is no navori.config.json…").
  - R2: `cwd` = subdirectorio con workplan inválido ⇒ deny, igual que la raíz.
  - R3: `"Implementer"`, `"navori:implementer"` y `" implementer "` en Claude ⇒ gateados. En Codex
    (`NAVORI_HOOK_ENGINE=codex`), sin `agent_type`, con `default`, `worker` u `orchestrator` ⇒
    gateados; los siete roles de la lista ⇒ allow. Se conserva "allows a non-implementer role
    without reading anything".
  - R4: "an unknown payload shape is allowed, not a crash" se reescribe: `tool_input` ausente con
    `planTiers` ⇒ deny nombrando el problema; sin configuración ⇒ allow; `message: null` en Codex
    ⇒ se trata como cifrado/ausente y va al despacho.
  - R5: workplan con `feature` ajeno, `level` 1 con `files` que recalculan 2, y `BLOCKED` ⇒ deny.
    `VALID_LEVEL1` (`files: []`) sigue en allow.
  - R6: `nivel-0: src/payments/x.ts demo` con `criticalPaths: ["src/payments/**"]` ⇒ deny;
    `./src//payments/x.ts`, `/abs/x.ts` y `a/../x.ts` ⇒ deny; apertura sin feature ⇒ deny con la
    forma nueva; feature con workplan ⇒ deny que pide `workplan:`.
  - R7: dos evaluaciones sobre un despacho (la segunda tras un `rename` simulado) ⇒ allow y luego
    deny `already claimed`; `createdAt` = `now` + 61 s ⇒ vencido, + 59 s ⇒ válido; no queda archivo
    que case con `DISPATCH_FILE`.
  - R8: `nivel-0:` con dos `CHANGES_REQUESTED` ⇒ exige `solution_*`; con `solution_*` más viejos
    que el cuarto rechazo ⇒ deny; tocados después ⇒ allow.
  - R9: nivel 2 con dos rechazos, línea `reset` y luego el mismo `review_<f>.md` ⇒ allow; con un
    rechazo nuevo después ⇒ cuenta 1.
- **`lib/plan/__tests__/check.test.ts`:** R15, cada regla nueva por id, más el recálculo con y sin
  `cwd`.
- **`lib/plan/__tests__/classify.test.ts`:** R19, `./src/a.ts`, `src\\a.ts` y `src//a.ts` casan
  con `src/**` y cuentan un solo directorio raíz; `Src/a.ts` no se pliega. Las 14 fixtures
  calibradas no cambian de nivel.
- **`lib/plan/__tests__/render.test.ts`:** R16, `applyMutationsToRaw` crea `progress` ausente y
  conserva claves desconocidas anidadas.
- **`commands/__tests__/plan.test.ts`:**
  - R10: `A1=hecho`, `A9=cumplido`, `--date ayer` y `--progress` con `--decision` ⇒ exit 1 y el
    archivo byte-idéntico.
  - R11: con el lock tomado (archivo `.plan-update.lock` fresco) ⇒ exit 1 sin escribir; dos updates
    secuenciales a ids distintos ⇒ ambos presentes; criterion editado entre fases (stub) ⇒ exit 1.
  - R12: los tres motores con configuración ilegible ⇒ `cumplido` rechazado; con configuración
    ausente ⇒ advertencia.
  - R15: JSON ilegible ⇒ exit 2, hallazgo `schema`, sin traza en stderr.
  - R16: un campo `x-note` en la raíz y otro dentro de un criterion sobreviven a `update`.
  - R17: `classify demo` sin borrador ⇒ exit 1.
  - R18: un archivo sin commitear y otro sin seguimiento aparecen en `--diff --json`; la base por
    defecto sale de `prTarget`.
  - R9: `escalation-reset` sin `--approved-by user`, con razón en blanco, en nivel 1 o con un solo
    rechazo ⇒ exit 1 sin línea nueva; el caso válido escribe exactamente una línea `reset`.
- **`lib/plan/__tests__/evidence.test.ts`:** R14, `bun i && cd packages/cli && bun test` con `cwd`
  = `<tree>/packages/cli` ⇒ ok; con `;`, `$(`, `..` o `pushd` ⇒ solo vale la raíz; el `fix` del
  rechazo por `cwd` no es el comando repetido.
- **`lib/master/__tests__/slice.test.ts`:** R11, `prepareDeliverySlice` con el lock tomado falla
  sin escribir.
- **`engines/shared/__tests__/roster-parity.test.ts`:** R3, `NON_IMPLEMENTER_ROLES` ⊂ ids del
  roster ∪ `CODEX_BUILTIN_READ_ONLY_ROLES`, y roster − lista = `{orchestrator, implementer}`.
- **`commands/__tests__/status-render-pending.test.ts` y `commands/__tests__/claude-doctor.test.ts`:**
  R3, `doctor` advierte `render-pending` con un `plan-gate.sh` viejo y `status` no cambia.
- **`lib/master/__tests__/schema.test.ts`:** R20, salto de línea en `scope[1]` y `<!--` en
  `title` ⇒ el mensaje nombra `P<n>`, el campo y el arreglo; una parte `deliveries` con salto de
  línea sigue válida.
- **`lib/master/__tests__/part.test.ts`, `checks.test.ts`, `commands/__tests__/master-first-use.test.ts`:**
  R21, con `outcome` fijado: `part`, `advance` y `ux` ⇒ mensaje de reanudar, y `parts.json` y
  `state.json` intactos.
- **`lib/master/__tests__/init.test.ts`:** R22, slug de una etapa abandonada ⇒ falla nombrándola.
- **`lib/master/__tests__/checks.test.ts`:** R23, etapa deliveries cerrada sin `CLOSURE.md` ⇒
  sin fallas; R29, apertura sin cierre ⇒ "corríjalo a mano"; R31, `CODEBASE.md` con Structure y
  Conventions en repo `en` ⇒ verde.
- **`lib/master/__tests__/status.test.ts`:** R24, el render no contiene `presented=`, `scope=` ni
  `Preparación` y `--json` sí trae las identidades; R26, `parts.json` inválido ⇒ `workflow` más
  bloqueo, sin excepción; R27, baseline obsoleta con cola ⇒ nombra `delivery-revoke`; R31,
  etiquetas `en` en `STATUS.md` y en la región.
- **`lib/master/__tests__/delivery.test.ts`:** R25, edición tras presentar ⇒ bloqueo con causa;
  R30, conteo de `.git/objects` y `mtime`/bytes de `.git/index` iguales antes y después de
  `deliveryLifecycle`, y la misma identidad que en modo escritura.
- **`lib/master/__tests__/delivery-checks.test.ts`:** R28, `spec` inexistente y `spec` fuera de
  `specsDir` ⇒ bloqueo.
- **`lib/master/__tests__/close.test.ts`:** R33, `--reason "  "` en legacy y en deliveries ⇒
  rechazo sin escribir; R31, `CLOSURE.md` `en`.
- **`lib/master/__tests__/stages.test.ts`:** R34, una etapa abandonada sin `DECISIONS.md` no aparece.
- **`commands/__tests__/master-delivery.test.ts`:** R35, `delivery-criterion` sin workplan ⇒ ruta
  relativa, sin `ENOENT` ni ruta absoluta; R32, el texto de `init`.
- **`lib/diagnose/__tests__/master-plan.test.ts`:** R32, el texto de `deliveries-pending`.
- **`engines/claude/__tests__/master-accept-confirm.test.ts`** (corre bash y zsh con
  `acrossShells`):
  - R36: `sh -c '…close'`, `bash -lc "cd x && …part … --approved-by user"`, `eval "…close"` y
    `navori master "close"` ⇒ ask (Claude) y deny (copia Codex); `navori master status` envuelto ⇒
    skip; `navori master part P1 \⏎ --accept A1 --approved-by user` sigue preguntando en ambos
    shells.
  - R9: `escalation-reset … --approved-by user` ⇒ ask con su `approval_description`.
- **`engines/claude/__tests__/build-settings.test.ts` y `engines/__tests__/codex-rules.test.ts`:**
  R9, R36 y R48, la lista exacta de `:*` en `ask`, los `prefix_rule` de Codex, y
  `navori plan render`/`update` en `allow` sin `allow` en Codex.
- **`__tests__/asset-command-permissions.test.ts`:** R48 y R36, sin entradas obsoletas; el tope
  `< 30` se conserva.
- **`__tests__/plan-tiers-contracts.test.ts`:** R40, con `planTiers` y un `progress/current.md` de
  campo, el contexto inline contiene la precondición, la regla sin ruta inline y `spec:`, aunque
  `10-orquestacion.md` salga como puntero, y no contiene "see `orquestacion`".
- **`engines/shared/__tests__/engine-capabilities.test.ts`, `engines/__tests__/control-inventory.test.ts`,
  `engines/shared/__tests__/codex-parity.test.ts`, `engines/shared/__tests__/native-overlap.test.ts`:**
  R41, la razón de `plan-gate` y el `state` de `acceptance-evidence`, con su resolución versionada.
- **`lib/assets/__tests__/skill-caps.test.ts`, `__tests__/doc-budgets-check.test.ts`:** R37–R47 con
  los topes nuevos.
- Doctrina (R13, R37–R39, R42–R47): aserciones de texto en `__tests__/orquestacion-doctrina.test.ts`,
  `__tests__/plan-tiers-contracts.test.ts` y `lib/__tests__/skills-assets.test.ts`, con una frase
  ancla por requisito.

Los hitos que tocan hooks, settings o Markdown corren además `bun run test:golden`,
`bun run check:assets`, `bun run check:render` y `bun run check:doc-budgets`. El PR cierra con
`bun check`.

## Hitos propuestos (una entrega, un commit por hito)

| Hito | R | Archivos | Pruebas existentes | Commit |
|---|---|---|---|---|
| M1 | R1, R2, R4 | `lib/plan/gate.ts`, `commands/plan.ts` (`gate`) | `plan-gate.test.ts` | `fix(plan): el gate deniega con config ilegible, payload roto o cwd en subdirectorio` |
| M2 | R3 | `engines/shared/roster.ts`, `lib/plan/gate.ts`, `hooks/plan-gate.sh`, `lib/render/render-pending.ts`, `commands/status.ts`, `commands/doctor.ts` | `plan-gate.test.ts`, `roster-parity.test.ts`, `status-render-pending.test.ts`, `claude-doctor.test.ts`, goldens | `fix(plan): normaliza el rol del implementer, gatea spawns Codex sin rol conocido y avisa render pendiente` |
| M3 | R17, R18, R19 | `lib/plan/classify.ts`, `commands/plan.ts` (`classify`) | `classify.test.ts`, `plan.test.ts` | `fix(plan): classify normaliza rutas, incluye cambios sin commitear y exige entradas` |
| M4 | R5, R15 | `lib/plan/check.ts`, `lib/plan/gate.ts`, `commands/plan.ts` (`check`), llamadores en `lib/master/part.ts` y `lib/master/slice.ts` | `check.test.ts`, `plan-gate.test.ts`, `plan.test.ts`, `part.test.ts`, `slice.test.ts` | `fix(plan): check y gate recalculan el nivel y rechazan feature ajeno o BLOCKED` |
| M5 | R6, R8, R9 | `lib/plan/gate.ts`, `commands/plan.ts` (`escalation-reset`), `lib/audit/cli-event.ts`, `settings-base.json` (ask), `hooks/master-accept-confirm.sh` (`RESET_RE`, tokens, descripción) | `plan-gate.test.ts`, `plan.test.ts`, `master-accept-confirm.test.ts`, `build-settings.test.ts`, `codex-rules.test.ts`, `cli-event.test.ts`, goldens | `feat(plan): nivel-0 con feature, tope por pares y reinicio de escalación confirmado` |
| M6 | R7 | `lib/plan/gate.ts` | `plan-gate.test.ts` | `fix(plan): un despacho Codex autoriza un solo spawn y rechaza fechas futuras` |
| M7 | R10, R11, R12, R16 | `commands/plan.ts` (`update`, `render`, `evidenceRequired`), `lib/plan/render.ts`, `lib/master/slice.ts` | `plan.test.ts`, `render.test.ts`, `slice.test.ts` | `fix(plan): update valida la entrada, serializa escrituras y conserva campos` |
| M8 | R14 | `lib/plan/evidence.ts` | `evidence.test.ts` | `fix(plan): acepta el cwd de una cadena de cd y propone otra corrección` |
| M9 | R20, R21, R22, R33 | `lib/master/schema.ts`, `stages.ts`, `part.ts`, `checks.ts`, `commands/master.ts` (`ux`), `init.ts`, `close.ts` | `schema.test.ts`, `part.test.ts`, `checks.test.ts`, `init.test.ts`, `close.test.ts`, `master-first-use.test.ts` | `fix(master): bloquea mutaciones durante el cierre, slugs repetidos y textos multilínea` |
| M10 | R24, R25, R26, R27, R30, R32 | `lib/master/status.ts`, `delivery.ts`, `commands/master.ts` (`init`), `lib/diagnose/master-plan.ts` | `status.test.ts`, `delivery.test.ts`, `master-delivery.test.ts`, `diagnose/master-plan.test.ts`, `workflow-compatibility.test.ts` | `fix(master): STATUS.md de entregas estable, causas nombradas y status sin escribir en .git` |
| M11 | R23, R28, R35 | `lib/master/checks.ts` (`checkClosedStage`), `delivery-checks.ts`, `part.ts` | `checks.test.ts`, `delivery-checks.test.ts`, `master-delivery.test.ts` | `fix(master): valida etapas de entrega cerradas, la spec de parts.json y el workplan faltante` |
| M12 | R29, R31, R34 | `lib/master/markers.ts`, `checks.ts`, `status.ts`, `close.ts`, `stages.ts` | `checks.test.ts`, `status.test.ts`, `close.test.ts`, `stages.test.ts`, `markers.test.ts` | `fix(master): etiquetas en inglés, marcador huérfano y contexto de arquitectos existente` |
| M13 | R36 | `hooks/master-accept-confirm.sh`, `settings-base.json` (ask `delivery-*`) | `master-accept-confirm.test.ts`, `build-settings.test.ts`, `codex-rules.test.ts`, `asset-command-permissions.test.ts`, goldens | `fix(hooks): confirma comandos de master envueltos o entrecomillados y delivery-* en Codex` |
| M14 | R48 | `settings-base.json` (allow) | `asset-command-permissions.test.ts`, `build-settings.test.ts`, goldens | `fix(settings): pre-aprueba navori plan render y plan update` |
| M15 | R13, R37–R47 | `managed/planificacion.md`, `managed/orquestacion.md`, `agents/orchestrator.md`, `agents/reviewer.md`, skills `plan-simple`, `plan-advanced`, `master-plan`, `spec-bootstrap`, `engine-capabilities.ts`, `codex-parity.ts`, `docs/native-overlap.md`, `lib/assets/doc-budgets.ts`, espejos | `plan-tiers-contracts.test.ts`, `orquestacion-doctrina.test.ts`, `skills-assets.test.ts`, `skill-caps.test.ts`, `doc-budgets-check.test.ts`, `engine-capabilities.test.ts`, `control-inventory.test.ts`, `codex-parity.test.ts`, `native-overlap.test.ts`, goldens | `docs(planes): alinea la doctrina con el gate, la escalación y el CLI` |
| M16 | R49 | `hooks/implementer-no-markdown.sh`, `engines/pi/role-tools.ts`, `agents/implementer.md`, `agents/scribe.md`, espejos | `implementer-no-markdown.test.ts`, `codex-hook-payloads.test.ts`, `pi/__tests__/controls.test.ts`, `scribe-owns-markdown-contracts.test.ts`, goldens | `feat(hooks): el implementer escribe Markdown de doctrina de IA` |

Dependencias:

- M4 usa `projectClassifyContext` y la normalización de M3.
- M5 usa `normalizeRepoPath` y `matchesCriticalPaths` (M3) y el `checkWorkplan` de M4.
- M6 va después de M2, porque la clasificación Codex decide si se lee el despacho.
- M7 cambia `slice.ts` después de M4, que ya tocó sus llamadores.
- M12 cambia la firma de `renderStatusMd`, que M10 ya tocó: M10 primero.
- M15 al final, porque documenta la gramática y los comandos de M5, M13 y M14.
- M16 después de M15 (decisión tomada durante M15); no depende de otros hitos.

## NOT in scope

- **Autenticación criptográfica del recibo, del log del gate o del `reset`.** El agente que firma
  o escribe tiene los mismos permisos de disco que quien verificaría; una firma local no agrega
  garantía sin una identidad fuera del checkout. R47 y la doctrina del reset declaran el límite.
- **Proteger `*.gate.jsonl` con reglas de `guard-destructive` o `role-guard`.** Sería una barrera de
  texto fácil de rodear; se declara seatbelt.
- **Atar un despacho Codex a un spawn concreto.** Codex V2 cifra el `message` y el payload no trae,
  antes del spawn, un id que el orquestador pueda escribir en el despacho. R7 garantiza "a lo más un
  spawn por archivo", no "este spawn".
- **Atar el slug de `nivel-0:` al trabajo real.** El slug y la ruta son autodeclarados; el gate no
  ve el diff.
- **Un campo `closeReady`.** 0051 decidió `closable` más `evidenceBlockers`; otro booleano
  reabre esa decisión sin un defecto nuevo.
- **Invalidar evidencia cuando se mueve `HEAD`.** La evidencia se ata a la huella del contenido
  (0039/0050). Atarla a `HEAD` rompe el squash-merge y los commits de contenido idéntico, el caso
  que `effectiveDeliveryPart` excluye a propósito.
- **Un parser de shell** para `sh -c`, `eval`, `$'…'` o palabras partidas por comillas (R36).
- **Refinar las partes de `deliveries`** contra saltos de línea (R20, decisión del orquestador).
- **Reparar etapas existentes con slug repetido** o migrar workplans en lote.
- **Resolver la configuración desde el checkout principal** en worktrees o submódulos.
- **Gate de planes en Pi** y en motores de prosa (siguen `unsupported`).
- **Cambiar el `state` de capacidad de Codex `plan-gate`.**

## Cobertura R<n> → hito

R1, R2, R4 → M1 · R3 → M2 · R17, R18, R19 → M3 · R5, R15 → M4 · R6, R8, R9 → M5 · R7 → M6 · R10,
R11, R12, R16 → M7 · R14 → M8 · R20, R21, R22, R33 → M9 · R24, R25, R26, R27, R30, R32 → M10 · R23,
R28, R35 → M11 · R29, R31, R34 → M12 · R36 → M13 · R48 → M14 · R13, R37–R47 → M15 · R49 → M16.

## Preguntas abiertas

Ninguna. Las cinco del borrador quedaron resueltas: el usuario aceptó la gramática de `nivel-0:` y
los roles Codex fail-closed; el orquestador decidió R20 solo legacy, el reinicio solo en nivel ≥2
y la corrección de la nota de R12.

## Conocimiento durable (destino propuesto)

- **Dominio** (`DOMINIO.md` o equivalente): "Un despacho Codex se consume por `rename` atómico;
  todo artefacto reclamado empieza con `.` para no casar con `DISPATCH_FILE`."
- **`CLAUDE.md` del repo, área crítica:** "Las validaciones de workplan viven solo en
  `checkWorkplan`; el gate no reimplementa reglas."
- **Skill `plan-simple`/`plan-advanced`:** la gramática de `nivel-0:`, el tope por pares y el
  reinicio de escalación como seatbelt (M15 ya lo lleva).
