# Entregas funcionales: distribución de specs en PRs — Design

**Fecha:** 2026-10-07 · **Estado:** revisado tras el challenge (`challenge_0044.md`, una ronda) y
el veredicto del orquestador. Pendiente de aprobación.
**Señales:** contrato compartido (formato de `tasks.md`, JSON de `navori spec classify`, receipt,
schema de config), área crítica (permisos de `settings.json`, escrituras de render) y decisión
difícil de revertir (unidad de PR fijada en `docs/DIRECTION.md`).
**Ref verificada:** `origin/main` = `HEAD` = `bcac625f` (tras `git fetch origin main`). Todas las
afirmaciones de "ya existe" se leyeron en esa ref.

## Approach

Una spec deja de producir un PR por lote. La unidad de PR es la **entrega** `E<n>`; la de verificación
y commit es el **milestone** `M<n>`; la de trazabilidad sigue siendo la tarea `T<n>` → `R<n>`. El
cambio tiene cuatro piezas, y cada una se apoya en algo que ya existe:

1. **Un módulo nuevo `packages/cli/src/lib/spec/` y el comando `navori spec`** (`classify` y
   `check`). Leen `tasks.md` y `requirements.md` con un parser de bloques Markdown, sin dependencias
   nuevas. Copian la forma de `navori plan` (`commands/plan.ts`): subcomandos citty, `--json` y
   errores ERROR/WHY/FIX (R4–R14, R22).
2. **Config aditiva.** `SddSchema` gana `deliveries`. Los umbrales no se interpolan en la prosa:
   los publica `navori spec classify --json` (R2, R3, R8).
3. **La decisión del gate vive en el CLI, no en la prosa.**
   - `navori receipt gate --spec <spec> --milestone M<n>` decide `scoped` o `full` a partir de
     `tasks.md`.
   - `navori receipt sign` con los mismos flags recalcula esa decisión, la escribe en el receipt y
     se niega a firmar `full` si el reviewer declaró que corrió el gate acotado.
   - Un receipt `scoped` nunca sale `fresh`, porque la lógica `fresh` de `checkReceipt`
     (`lib/diagnose/receipt.ts`) ya existe. Con un receipt `scoped`, el publisher solo hace commit:
     no publica la rama ni abre PR.
   - Resultado: ningún byte llega al remoto sin gate completo, y eso no depende de que un agente
     elija bien (R15–R17, R25, R26).
4. **Prosa.**
   - Cambian `docs/DIRECTION.md`, `orquestacion` (concentra el texto nuevo de orquestación), `sdd`,
     una línea de `planificacion`, los agentes `reviewer` y `publisher`, la skill `spec-bootstrap`,
     la skill `master-plan` y sus plantillas.
   - Todo se renderiza igual para Claude y Codex. La diferencia de mecanismo va en una fila de la
     matriz de solapamiento (R1, R10, R15–R19, R21, R23, R26).

### Enfoques descartados

- **Solo prosa, sin CLI.** No cumple R4–R14 ni R25. Además, el challenge mostró que, con el gate
  acotado como camino normal, decidirlo por prosa vuelve un descuido en un riesgo de publicación
  (hallazgos 1 y 2).
- **Extender `navori plan classify` con `--spec`.** `lib/plan/classify.ts` (`classify`) puntúa la
  complejidad de un workplan JSON. Las entradas, la salida y el dueño son otros, y R4 nombra
  `navori spec classify`.
- **Reusar el motor de entregas de master-plan.** `lib/master/delivery.ts` trae autoridad, colas,
  digests y aprobación de operador (`authorizeDeliveryQueue`, `publishDelivery`). R22 se cumple
  leyendo `parts.json` en solo lectura (D7).
- **Que el reviewer elija el gate y firme `--scoped` a mano** (primera versión de este design). Se
  descartó por el challenge: un flag olvidado deja `fresh:true` sin gate completo, y eso pasa justo
  en el flujo habitual.

## Components

- `packages/cli/src/lib/spec/tasks.ts` — parser de `tasks.md` por bloques. Toma texto y devuelve
  `ParsedTasks`: entregas, milestones, criterios, tareas con su casilla marcada o no, tareas
  retiradas, formato `deliveries|legacy` y avisos. Es puro — R4, R10, R11, R13, R14.
- `packages/cli/src/lib/spec/requirements.ts` — extrae los ids `R<n>` de `requirements.md` — R11.
- `packages/cli/src/lib/spec/classify.ts`:
  - `classifySpec(parsed, thresholds)` devuelve `SpecClassification` — R4–R8, R14.
  - `decideGate(parsed, classification, milestoneId)` devuelve `{ gateKind, reason }` — R25.
  - Las dos son puras.
- `packages/cli/src/lib/spec/check.ts` — `checkSpec(...)` devuelve hallazgos con `rule` y
  `severity`. En formato legacy todo hallazgo sale como `warning` — R11–R14, R22.
- `packages/cli/src/lib/spec/locate.ts` — resuelve `<specsDir>/<spec>/` con contención, como
  `checkPart` en `lib/master/check-part.ts`. Lo comparten `spec` y `receipt` — R9, R25.
- `packages/cli/src/commands/spec.ts` — `specCommand` con `classify` y `check`, registrado en
  `subCommands` de `packages/cli/src/index.ts` — R4, R7–R9, R11.
- `packages/cli/src/lib/config/schema.ts` — `DeliveriesSchema` en `SddSchema`, más
  `DEFAULT_DELIVERIES` y `resolveDeliveryThresholds(config)` — R2, R3.
- `apps/website/public/schema/navori.config.v1.json` — se regenera con
  `packages/cli/scripts/gen-schemas.mjs` — R2.
- `packages/cli/src/lib/diagnose/receipt.ts` (`signReceipt`, `checkReceipt`, `ReceiptResult`) y
  `packages/cli/src/commands/receipt.ts` (`receiptCommand`) — subcomando `gate`, flags `--spec`,
  `--milestone` y `--gate-ran` en `sign`, y campo `gateKind` en el resultado — R25, R16, R17.
- `packages/cli/src/lib/master/delivery-checks.ts` — `deliveryIdsForSpec(cwd, specPath)`, de solo
  lectura — R22.
- `packages/core/core-assets/settings/settings-base.json` — `Bash(navori spec classify:*)` y
  `Bash(navori spec check:*)` en `allow`. `navori receipt gate` ya queda cubierto por
  `Bash(navori receipt:*)`, que existe. No se agrega ninguna entrada `gh` — R4, R11.
- `packages/cli/src/engines/shared/native-overlap.ts` (`FLOWS`) y `codex-parity.ts`
  (`CODEX_PARITY`) — fila `flow:spec-delivery-publication`; se regenera `docs/native-overlap.md` —
  R23.
- `docs/DIRECTION.md` — sección "Unidad de PR y de verificación de una spec" y un bullet en "Qué
  requiere discusión antes de cambiarse" — R1.
- `core-assets/managed/sdd.md` (bloque `sdd`) — "tasks in batches of 1-3" pasa a E/M/T. No
  menciona umbrales — R10.
- `core-assets/skills/spec-bootstrap.md` — plantilla de `tasks.md` (D2) y regla de orden 3 — R10.
- `core-assets/managed/orquestacion.md` (bloque `orquestacion`, sección "The mechanics") — ciclo por
  milestone, encargo con `spec:`, gate por CLI y orden de entregas — R15.
- `core-assets/managed/planificacion.md` (fila de nivel 3) — una sola línea: un workplan por
  entrega — R15.
- `core-assets/agents/reviewer.md` — usa `receipt gate` y `sign`, la revisión completa en el ciclo
  de cierre y la trazabilidad con el slug de la spec — R16, R17, R25.
- `core-assets/agents/publisher.md` — `mode: commit-only` antes de "PR flow", orden de entregas,
  `Refs`/`Closes`, `Spec-Delivery` y aviso de base distinta de la rama por defecto — R18, R19, R26.
- `core-assets/skills/master-plan.md` y `core-assets/master-plan/{tasks,delivery-master,slice}.md`,
  más sus copias en `en/` — R21, R22.
- `navori.config.json` de este repo — `prTarget: "main"`, y re-render del harness autohospedado —
  R20.
- `docs/research/distribucion-entregas-agentes.md` — línea base de 0039 y 0041 y tabla de
  calibración — R24.

## Decisions

### D1 — LOC estimadas: se declaran por entrega en `tasks.md` (R4, R5)

`tasks.md` declara `Estimated LOC: <n>` bajo cada `## E<n>`, y `classify` suma los valores. Un valor
ausente cuenta 0, emite el aviso `loc-undeclared` y pone `signals.locDeclared:false`, así que decide
solo el umbral de tareas.

- **Por qué no derivarlas de archivos:** antes de codear, los archivos nuevos miden 0 y no hay
  workplan.
- **Por qué no derivarlas del conteo de tareas:** duplicaría `splitMinTasks`.
- **Costo:** la cifra es estimada y se puede jugar con ella. Lo mitiga que el split exige además ≥2
  entregas (R5), y la tabla de R24 compara contra `git diff --shortstat` del PR mergeado.
- **Costo de revertir:** bajo.

### D2 — Gramática de `tasks.md` (R10–R13)

El parser trabaja **por bloque**. Un bloque es una línea inicial más sus líneas de continuación
indentadas, hasta el siguiente ítem de nivel 0 o el siguiente heading. Es el mismo corte que ya hace
`validatePartSpec` en `lib/master/check-part.ts`. Los atributos (`effect:`, `test:`) pueden ir en
cualquier línea del bloque.

Se ignora todo lo que esté dentro de un fence: una apertura `^\s*(```+|~~~+)` se cierra solo con una
línea del mismo carácter y longitud ≥ la de apertura, como en CommonMark. Las palabras clave que lee
la máquina van en inglés.

| Elemento | Forma | Reglas |
|---|---|---|
| Entrega | `## E<n> — <título>`, con ` (foundation)` opcional al final | El separador puede ser `—`, `–`, `-` o `:`. `E<n>` único |
| LOC | `Estimated LOC: <entero>`, entre la entrega y su primer milestone | Opcional (D1) |
| Milestone | `### M<n> — <título>` | `M<n>` único en la spec y dentro de una entrega |
| Criterio | bloque `- **A<n>**`, con `[observable]` opcional, sin casilla | `A<n>` único **en toda la spec** (D6 lo copia tal cual al workplan). El comando es el primer span en backticks que **abre una línea** del bloque (si ninguno abre línea, el primer span del bloque), para que el código citado en la descripción no se confunda con el comando; puede llevar backticks internos si usa un delimitador más largo, como en CommonMark. El esperado es el texto tras el **último** `→` o `->` del bloque, y no puede quedar vacío. Los `·` y `→` dentro de la descripción se toleran |
| Consumidor | línea `- **Consumes:** <consumidor> → <contrato>` dentro de un milestone | Es lo que mira R13 en una entrega `foundation` |
| Tarea | bloque `- [ ] **T<n>** (R<a>, R<b>) — <qué>`; en su bloque, `effect: behavior\|docs\|tests\|schema` y `test: …` | `T<n>` único y dentro de un milestone. `effect` es obligatorio. `- [x]` marca la tarea hecha |
| Tarea retirada | `- [ ] ~~T<n>~~ …` | No cuenta para el tamaño ni para la cobertura, y no es error |

La forma de la tarea es compatible con `TASK_ENTRY` y `TASK_TITLE` de `check-part.ts`.

**R12 (estructural, no prueba).** Una entrega no es vertical si todas sus tareas declaran `effect` ∈
{`docs`, `tests`, `schema`} *y* ningún criterio lleva `[observable]`. Es `error` en `split` y
`warning` en `single`.

- `effect` y `[observable]` son autodeclarados, así que `check` detecta la forma, no la verdad.
- El reviewer los **verifica** en Pass 1 contra el diff: una tarea `behavior` sin comportamiento
  observable es `SPEC_MISS`.
- En este repo la prosa managed que leen los agentes cuenta como `behavior`.

**Detección del formato (R14).**

- Sin ninguna línea de entrega fuera de fences, el formato es `legacy`. Ninguna spec actual tiene
  headings `## E<n>`/`### M<n>`: lo verifiqué con grep sobre `specs/*/tasks.md`.
- En legacy, las tareas se cuentan con el patrón genérico `^- \[[ xX]\] `, el `TASK_ENTRY` de
  `check-part.ts`. Esto incluye los ids `**A<n>**` de `0013` y excluye las `~~T<n>~~` de `0027`.
- Todo hallazgo sale como `warning` y el exit es 0.

Ejemplo (fragmento del propio `tasks.md` de esta spec, en el formato nuevo):

````markdown
## E1 — `navori spec` clasifica y valida specs
Estimated LOC: 1300

### M1 — classify y config
- **A1** [observable] — clasifica la propia 0044 ·
  `bun packages/cli/src/index.ts spec classify 0044-entregas-funcionales --json`
  → JSON con `"shape"` y `"thresholds"`
- [ ] **T1** (R4, R5, R6, R8) — parser por bloques y clasificador puros
  · effect: behavior · test: `lib/spec/__tests__/classify.test.ts`::"split solo con ≥2 entregas y umbral"
````

### D3 — Parser y forma del comando (R4, R7–R9, R11)

El parser va en el módulo nuevo `lib/spec/`. `lib/plan/` es dueño del workplan JSON. El criterio
parseado se valida con `AcceptanceCriterionSchema` (`lib/plan/schema.ts`) en lugar de redefinirse.
`navori spec` no existe hoy.

Subcomandos (`<spec>` es el directorio bajo `sdd.specsDir`):

- `navori spec classify <spec> [--cwd] [--json]`
- `navori spec check <spec> [--cwd] [--json]`

| Caso | `classify` | `check` |
|---|---|---|
| OK, con o sin avisos; o legacy con cualquier hallazgo | 0 | 0 |
| Hallazgos `error` (solo en el formato nuevo) | — | 2 |
| R7 | 1 | 2 (`too-many-deliveries`) |
| R9 o ruta fuera de `specsDir` | 1 | 1 |
| Config inválida (R3) | 1 | 1 |

ERROR/WHY/FIX sigue a `rejectCumplido` de `commands/plan.ts`: tres líneas en stderr y, con
`--json`, `error: { what, why, fix }`. Los avisos van a stderr con el prefijo `WARN:` y a
`warnings[]`.

### D4 — `sdd.deliveries` (R2, R3)

```ts
const DeliveriesSchema = z.object({
  splitMinTasks: z.number().int().positive("sdd.deliveries.splitMinTasks must be a positive integer").optional(),
  splitMinLoc: z.number().int().positive("sdd.deliveries.splitMinLoc must be a positive integer").optional(),
  maxPrsPerSpec: z.number().int().min(2, "sdd.deliveries.maxPrsPerSpec must be an integer >= 2").optional(),
});
export const DEFAULT_DELIVERIES = { splitMinTasks: 12, splitMinLoc: 1500, maxPrsPerSpec: 4 } as const;
export function resolveDeliveryThresholds(config: NavoriConfig): Required<z.infer<typeof DeliveriesSchema>>;
```

- **Campos opcionales sin `.default()`.** `writeConfig` escribe la salida validada; un default se
  materializaría en el archivo y quedaría congelado ahí.
- **Mensajes.** `lib/config/cli-config.ts` ya imprime `issue.path`.
- **"Supera" es estricto (`>`),** como dice la regla 1. El JSON lo declara en
  `thresholds.comparison`.
- **La prosa no lee umbrales.** No hay tokens nuevos ni cambios en `lib/render/interpolate.ts`.
  `sdd` remite a `navori spec classify`, que emite los umbrales efectivos (R8). Así no hay riesgo
  de `<not configured>` ni presión sobre el presupuesto always-on.

### D5 — La decisión del gate vive en el CLI (R15–R17, R25)

**Regla de `decideGate`.** Es decidible a partir de los bytes de `tasks.md` de la rama.

- La **unidad de PR** es la entrega en `split` y la spec entera en `single`.
- `gateKind = "scoped"` solo si se cumplen tres condiciones a la vez:
  - `tasks.md` está en el formato nuevo;
  - existe `M<n>`;
  - queda **≥1 tarea sin marcar en un milestone posterior** de la misma unidad de PR.
- En cualquier otro caso es `full`, con `reason`: `closing-milestone`, `unit-complete`,
  `legacy-format`, `unknown-milestone`, `tasks-unreadable` o `no-spec-flags`.
- Consecuencias:
  - El último milestone siempre es `full`.
  - **Un fix sobre un PR ya abierto siempre es `full`.** Abrir el PR requiere el ciclo de cierre,
    así que todas las tareas de la unidad ya están marcadas (`unit-complete`), sin importar qué
    `M<n>` nombre el encargo.
  - Editar `tasks.md` a mitad de camino solo puede llevar a `full` de más (seguro) o a `scoped` sobre
    bytes que todavía no se publican (R26).

**Superficie.**

- `navori receipt gate --feature <key> --spec <spec> --milestone M<n> --json` devuelve
  `{ gateKind, reason, unit, closingMilestone }`. Es de solo lectura, y el reviewer lo corre
  **antes** del gate.
- `navori receipt sign --feature <key> --spec <spec> --milestone M<n> --gate-ran scoped|full` hace
  esto:
  1. Recalcula `decideGate`.
  2. Si sale `full` y `--gate-ran scoped`, sale con 1 y ERROR/WHY/FIX ("this cycle needs
     `qualityGate.full`; run it and sign again"), y no escribe receipt.
  3. Si sale `scoped` y `--gate-ran scoped`, escribe la cabecera `gate=scoped`.
  4. En cualquier otro caso escribe el hash del gate completo, como hoy.
- El JSON de `sign` y de `check` trae `gateKind`. En `sign` es el valor calculado, no un eco del
  flag; en `check` se lee de la cabecera.
- Sin `--spec`/`--milestone`, `sign` se comporta exactamente como hoy.

**Por qué es seguro.**

- `checkReceipt` compara la cabecera con `sha256(qualityGate.full)`. Con `gate=scoped` responde
  `stale:["gate"]` y `fresh:false`, también con un binario viejo (`HEADER_RE` acepta `gate=(\S+)`).
- Un receipt `scoped` solo permite el commit (R26). Publicar exige `fresh:true` o que el publisher
  corra el gate completo él mismo (la regla actual de `publisher.md`, "Gate").
- Binario viejo:
  - `receipt gate` no existe: citty imprime la ayuda, no hay JSON, y la prosa cae a `full`.
  - Si ignora `--spec`/`--milestone`/`--gate-ran`, firma `full`. Para eso la prosa exige que
    `gateKind` aparezca en la respuesta de `sign` y coincida con el de `receipt gate`; si no, el
    reviewer corre el gate completo y firma sin flags.

**Ciclo acotado concreto (R15).** Son `{{qualityGate.fast}}` más los comandos de los `A<n>` del
milestone. No es el patrón `scoped-gate`, que sigue siendo higiene a mitad de sesión.

**Ciclo de cierre (R17, hallazgo 9).** Pass 1 y Pass 2 leen el **diff completo de la entrega**
(`git diff origin/{{prTarget}}`, de dos puntos). El acotamiento de "Re-review" del paso 3 de Setup
no aplica aquí. Además el reviewer corre `navori spec check <spec> --json`, que debe dar `ok`, y el
gate completo. El receipt que firma es así la lista íntegra revisada que espera `publisher.md`.

**Cambios en `reviewer.md`:**

- Setup, paso 3: el gate lo decide `navori receipt gate`. El acotamiento de lectura de re-review no
  aplica al ciclo de cierre.
- Pass 2, "Quality gate": la tabla `scoped` → fast más `A<n>`, `full` → `{{qualityGate.full}}`.
  Las variantes de ejecución Claude/Codex aplican a ambos.
- "Content receipt" y "Delta re-sign", paso 3: firmar con `--spec/--milestone/--gate-ran` y
  verificar `gateKind`.
- Pass 1, "SDD traceability": lee `{{sdd.specsDir}}/<spec>/tasks.md` con el `<spec>` de la línea
  `spec:` del encargo, porque la clave del handoff ya no es el slug (D6). Comprueba las tareas del
  milestone y verifica `effect`/`[observable]` contra el diff.

**Cambio en `orquestacion.md`** ("The mechanics"). Un bullet de ≤40 palabras:

- en una spec con entregas, un ciclo por milestone;
- encargo `spec: <spec> E<n> M<n>`;
- `navori receipt gate` decide el gate;
- el publisher hace commit-only hasta el cierre;
- `E<n+1>` empieza después del merge de `E<n>`.

La línea "`{{qualityGate.full}}` green is Pass 2 on the shipping diff" agrega "of the PR".

### D6 — Workplan por entrega y contador de rechazos (pregunta 6, hallazgo 6)

**Un workplan por entrega, no por milestone.**

- Clave de feature: `<spec>-e<n>`, en minúsculas porque `FEATURE_SLUG` en
  `lib/primitives/state-root.ts` es `^[a-z0-9][a-z0-9._-]*$`. Ejemplo:
  `0044-entregas-funcionales-e1`.
- `workplan_<spec>-e<n>.json` lleva:
  - `level: 3`;
  - `phases` = los milestones (`PhaseSchema` ya existe desde nivel 2), cada uno con sus `A<n>`;
  - `acceptance` = los `A<n>` de la entrega, copiados con el mismo id (por eso son únicos en la
    spec, D2);
  - `solution.path` = `specs/<spec>/design.md`;
  - `risks` según `checkWorkplan`.
- Se escribe una vez por entrega y avanza con `navori plan update`.
- El plan-gate no cambia: el encargo del implementer abre con `workplan: <spec>-e<n>`.

**Contador.**

- Verificado: `recordAndCountRejections` (`lib/plan/gate.ts`) cuenta hashes distintos de
  `review_<feature>.md` con `CHANGES_REQUESTED` en `workplan_<feature>.gate.jsonl`.
- Con nivel ≥2, `evaluateEscalation` niega el tercer despacho y escala al usuario.
- Con la clave por entrega, el contador es **por entrega**: dos rechazos dentro de `E<n>` escalan, y
  `E<n+1>` empieza en cero. Es la misma granularidad que tenían los lotes, con un costo acotado.
- Consecuencia: `impl_`, `review_` y el receipt usan `<spec>-e<n>` como `--feature`, y `--spec`
  lleva el slug para localizar `tasks.md`.

**Planificación.** `planificacion.md` agrega una sola línea en la fila de nivel 3: "one workplan
per delivery (`<spec>-e<n>`, phases = milestones); see `orquestacion`".

### D7 — Master-plan (R21, R22)

- **`skills/master-plan.md`**:
  - "Spec de una parte": clasificar con `navori spec classify`. En el modo entregas, cada `E<n>` del
    `tasks.md` usa el id de la entrega de `parts.json` que contiene la parte, y `navori spec check`
    lo valida.
  - Fase `executing`: una línea.
  - Se sube `maxWords` (D11).
- **Plantillas**, es y `en/`:
  - `master-plan/tasks.md`: pasa a la gramática de D2, con los campos de parte como sub-viñetas del
    bloque de tarea.
  - `delivery-master.md`: `E<n>` es la unidad de PR, con el mismo id en la spec.
  - `slice.md`: una línea.
- **Mapeo sin el motor.** `deliveryIdsForSpec(cwd, specPath)` en `lib/master/delivery-checks.ts`:
  - usa `readMasterIndex`, `activeStage` y `DeliveryPartsSchema.safeParse`;
  - devuelve los `deliveryId` de las partes cuya `spec` resuelve a esta spec, con su `git.prTarget`
    y `git.integrationTarget`;
  - no llama a `deliveryAuthority` ni a colas.
  - Hallazgos: `master-delivery-unmapped` (error, R22) y `master-target-mismatch` (warning, regla 5).
- **Matiz.** "El mismo id" vale por spec: la spec de una parte de `E2` declara `## E2`.

### D8 — Paridad Codex (R23)

- Toda la prosa se renderiza a los dos engines. No hay unidades nuevas.
- El mecanismo es CLI.
- Fila nueva `flow:spec-delivery-publication` en `FLOWS` y `CODEX_PARITY`, en estado `equivalente`
  y `enforcing: false`. Declara dos diferencias:
  - en Codex, el usuario confirma cada `gh pr create` por entrega (deny-as-confirmation de
    `engines/codex/hook-registrations.ts`);
  - la verificación secundaria con `gh pr list` (D9) la confirma o la corre el usuario.
  - El plan-gate es advisory.
- Se regenera `docs/native-overlap.md`.

### D9 — Publisher: commit-only, orden y cierre del issue (R18, R19, R26)

**`mode: commit-only` (R26).** La regla va **antes** de "PR flow":

- Si el brief dice `mode: commit-only`, o `navori receipt check` devuelve `gateKind:"scoped"`, el
  publisher hace el Commit flow hasta el paso 8 y **se detiene**: no publica la rama ni abre PR, sin
  importar `fresh`.
- La ruta "`fresh:false` → corre el gate completo y abre el PR" queda limitada a receipts `full`.
- El orquestador pone `mode: commit-only` cuando `receipt gate` dio `scoped`. El receipt lo impone
  aunque el brief lo omita.

**Forma.** El publisher la lee de `navori spec classify <spec> --json`.

- `single`: un PR con `Closes #<issue>`.
- `split`: el brief nombra `delivery: E<n>`, y en su PR:
  1. **Orden (primario, determinista).** Tras `git fetch`, corre
     `git merge-base --is-ancestor <sha> origin/{{prTarget}}`, ya preaprobado (`git merge-base*`).
     `<sha>` es el head de `E<n-1>` que reportó el publisher anterior y que el orquestador pasa en
     el brief como `after: <sha>`.
  2. **Orden (secundario).** Si el repo hace squash merge, el sha no es ancestro. Entonces
     `gh pr list --state merged --base {{prTarget}} --search …` sirve solo como señal. No se agrega
     una entrada `allow` para él: si pide permiso y se niega, o no encuentra nada, el publisher
     **pregunta al usuario** en vez de abortar en silencio.
  3. El cuerpo lleva la línea `Spec-Delivery: <spec> E<n>/<total>`, que es la trazabilidad de R18.
     Al terminar, la salida del publisher agrega el head sha (`head: <sha>`) para el siguiente
     paso 1.
  4. `Refs #<issue>`, o `Closes #<issue>` si `E<n>` es la última (R19). Siempre `--base
     {{prTarget}}`.
- **Base distinta de la rama por defecto.** `Closes` solo autocierra al mergear a la rama por
  defecto. El publisher la lee con `git rev-parse --abbrev-ref origin/HEAD` (preaprobado). Si
  difiere de `{{prTarget}}`:
  - el resultado del PR dice que el issue no se cerrará solo;
  - un `closingIssuesReferences` vacío en el paso 8 es lo esperado, no un fallo.

**Serialización (hallazgo 8).** Se mantiene: el usuario eligió no tener rama de integración.

- `E<n+1>` se implementa localmente **solo después** de que `E<n>` se mergee. Su rama parte de
  `origin/{{prTarget}}` actualizado; la regla "behind ≠ 0 → abort" ya lo exige.
- Trade-off: se paga latencia de reloj (la espera del merge de cada entrega) a cambio de no tener
  ramas apiladas ni PRs de reintegración (#1186). Es la columna que mide R24. Si la calibración
  muestra que la espera domina, la palanca es tener menos entregas (subir `splitMin*`), no apilar
  ramas.

### D10 — Compatibilidad con specs anteriores (R14)

- Lo legacy se detecta como en D2. `classify` lo trata como una entrega `single`, con
  `single-over-threshold` si supera un umbral.
- `check` reporta todo como `warning`, con exit 0:
  `WARN:  tasks.md uses the previous format (no E<n> deliveries); treated as one delivery — shape single`.
- `receipt gate` sobre legacy responde `full` (`legacy-format`), así que reviewer y publisher se
  comportan como hoy.

### D11 — Presupuestos de prosa (hallazgo 11)

Cambios always-on:

- `orquestacion`: un bullet de ≤40 palabras más dos palabras en una línea.
- `planificacion`: una línea.
- `sdd`: el reemplazo de "batches of 1-3" (≈+8 palabras, cabe en el margen de 11).

`sdd` no interpola umbrales. Los topes que se pasen se suben al mínimo necesario más ≥5% de margen,
con comentario de porqué en el frontmatter (el patrón de `spec-bootstrap.md` y `master-plan.md`):
`reviewer`, `publisher`, `spec-bootstrap` y `master-plan`. La cifra exacta se fija al medir en la
implementación.

### D12 — Áreas críticas

| Área crítica | ¿La toca? | Qué y riesgo |
|---|---|---|
| Escrituras de render/sync/backup | **Sí, contenido** | Cambia contenido de bloques managed, agentes y skills, sin tokens nuevos de interpolación. Hash y versión suben (flujo normal de `sync`). Este repo se re-renderiza con `navori render --apply`/`sync` para R20 |
| Permisos de `settings.json` y hooks | **Sí, permisos** | Solo dos `allow` de solo lectura con prefijo exacto (`navori spec classify:*`, `navori spec check:*`). Ninguna entrada `gh`. Sin hooks nuevos; el plan-gate no cambia |
| Marcadores managed y guard anti-rollback | No | Solo contenido dentro de los marcadores |
| (Mismo rigor) receipt y publicación | Sí | `receipt gate`/`sign` deciden qué atestigua un receipt. R25 y R26 se revisan como área crítica |

## Contracts

**`navori spec classify --json` (R8).** `formatVersion: 1`, solo cambios aditivos.

```json
{
  "formatVersion": 1,
  "feature": "0044-entregas-funcionales",
  "tasksPath": "specs/0044-entregas-funcionales/tasks.md",
  "format": "deliveries",
  "shape": "split",
  "prCount": 3,
  "signals": { "tasks": 20, "deliveries": 3, "milestones": 7, "estimatedLoc": 2900,
               "locDeclared": true, "exceedsTasks": true, "exceedsLoc": true },
  "thresholds": { "splitMinTasks": 12, "splitMinLoc": 1500, "maxPrsPerSpec": 4, "comparison": "strict-greater" },
  "deliveries": [
    { "id": "E1", "title": "…", "foundation": false, "estimatedLoc": 1300, "last": false,
      "milestones": [ { "id": "M1", "title": "…", "acceptance": ["A1", "A2"],
                        "tasks": [ { "id": "T1", "done": false } ], "closesUnit": false } ] }
  ],
  "warnings": [],
  "error": null
}
```

- `split` si y solo si hay ≥2 entregas y se supera algún umbral. En `single` hay `merged-deliveries`
  (R6).
- R7 llena `error` y sale con 1.
- `closesUnit` marca el último milestone de cada unidad de PR, es decir, la entrada estructural de
  `decideGate` (R25).

**`navori spec check --json`.** `{ formatVersion: 1, feature, format, ok, findings: [{ rule,
severity, where, message }], classification }`. Reglas:

| Grupo | Reglas |
|---|---|
| R11 | `delivery-without-milestone`, `milestone-without-acceptance`, `acceptance-malformed`, `task-outside-milestone`, `task-duplicated`, `requirement-uncovered`, `unknown-requirement` (warning) |
| R12 | `task-without-effect`, `delivery-not-vertical` |
| R13 | `foundation-not-first`, `foundation-without-consumer` |
| R7 | `too-many-deliveries` |
| R22 | `master-delivery-unmapped`, `master-target-mismatch` (warning) |
| R14 | `legacy-format`; en legacy, toda regla sale con `severity: "warning"` |

**Receipt (R25).**

- `navori receipt gate … --json` → `{ gateKind: "scoped"|"full", reason, unit, closingMilestone }`.
- `sign` acepta `--spec`, `--milestone` y `--gate-ran`. La cabecera v2 lleva `gate=scoped` o el hash
  actual.
- `ReceiptResult` gana `gateKind: "full"|"scoped"|null` (`null` en receipts anteriores a v2).
- Los receipts viejos se leen igual que hoy.

**Brief del publisher (R26, R18).** Líneas `mode: commit-only`, `delivery: E<n>` y `after: <sha>`.
Cuerpo del PR: `Spec-Delivery: <spec> E<n>/<total>`.

**Config.** `sdd.deliveries` es opcional; el JSON Schema se regenera.

## Failure modes

- **Binario viejo con prosa nueva (#490).** Sin `receipt gate` o sin `gateKind` en la respuesta de
  `sign`, se cae a `full` y a un solo PR: lado seguro (D5). [UNVERIFIED — que citty ignore flags
  desconocidos. Con la verificación de `gateKind` da igual.]
- **El reviewer corre el gate acotado cuando `receipt gate` dijo `full`.** Si declara la verdad en
  `--gate-ran scoped`, `sign` se niega. Si miente (`--gate-ran full`), se firma `full`: es el mismo
  nivel de confianza que hoy, porque el receipt atestigua el comando, no su ejecución. Pero ese
  escenario solo existe en el ciclo de cierre, donde hoy ya se exige el completo.
- **`tasks.md` editado en la rama.** `decideGate` lee los mismos bytes que se revisan. Una edición
  solo produce `full` de más, o `scoped` sobre bytes que R26 impide publicar.
- **Tareas sin marcar.** El último milestone de la unidad no tiene milestones posteriores, así que
  siempre es `full`: el olvido no afecta al ciclo de cierre. Si después llega un fix que nombra un
  milestone anterior y quedaron tareas posteriores sin marcar, `decideGate` responde `scoped` y R26
  impide publicar ese fix hasta que se corrija la marca o se nombre el milestone de cierre. El fallo
  bloquea de más; nunca publica sin gate completo.
- **Squash merge.** El check de orden primario no ve el ancestro y se usa el secundario o la pregunta
  al usuario (D9).
- **Retraso del índice de búsqueda de GitHub.** Solo afecta a la señal secundaria.
- **Spec partida y abandonada tras mergear `E1`.** El issue queda abierto con `Refs`. Es correcto.
- **Contador de rechazos.** Es por entrega (D6).

## Migration

- **Config.** No requiere migración. Las specs existentes no se migran (legacy, D10).
- **Repos instalados.** Reciben la prosa en el siguiente `sync`. Conviene publicar el CLI antes de
  que los repos rendericen; `check-asset-commands.mjs` solo avisa.
- **Este repo (R20).** `prTarget: main`, re-render del harness autohospedado (`.claude/`, `.codex/`,
  `AGENTS.md`). `ci.yml` corre `quality` hacia `main`.
- **Dogfooding.** Los ciclos de `E1` de esta spec corren con el gate completo, porque
  `receipt gate` llega en `E2`.

## Testing strategy

Cada test responde a un riesgo de arriba, con vitest y `// Covers: R<n>`.

| Riesgo | Test |
|---|---|
| El parser se rompe con tareas en varias líneas, fences de ```` y ~~~, backticks internos o `·`/`→` en la descripción | `lib/spec/__tests__/tasks.test.ts`, con fixtures por caso (`// Covers: R4, R10, R11`) |
| **Specs reales legacy fallan** | `lib/spec/__tests__/real-specs.test.ts`: glob de **todos** los `specs/*/tasks.md` del repo; `check` y `classify` salen con 0, todos los hallazgos son `warning` y el conteo de tareas coincide con `^- \[[ xX]\] ` sin `~~T~~` (`// Covers: R14`) |
| `split` mal decidido; `>` contra `≥` | `classify.test.ts`, bordes 12/13 y 1500/1501, 1 y 2 entregas, LOC sin declarar (`// Covers: R5, R6`) |
| R7 y R9 sin exit ≠0 o sin ERROR/WHY/FIX; path traversal | `commands/__tests__/spec.test.ts` (`// Covers: R7, R9`) |
| El JSON cambia de forma | Snapshot de claves de `classify --json` (`// Covers: R8`) |
| Config inválida aceptada o defaults materializados | `config.test.ts` (`// Covers: R2, R3`) |
| `check` no detecta milestone sin criterio, tarea huérfana o duplicada, `R<n>` sin cubrir, entrega no vertical, foundation mal ubicada o sin `Consumes:` (también dentro de un fence) | `check.test.ts`, un caso por regla (`// Covers: R11, R12, R13`) |
| **`decideGate` responde `scoped` en el cierre o en un fix sobre una unidad completa** | `classify.test.ts`: último milestone → `full`; todas las tareas marcadas → `full`; legacy, milestone desconocido o `tasks.md` ilegible → `full`; trabajo pendiente posterior → `scoped` (`// Covers: R25`) |
| **Un receipt `scoped` deja publicar sin gate completo** | `receipt.test.ts`: `sign --spec --milestone --gate-ran scoped` y luego `check` → `status:"ok"`, `fresh:false`, `gateKind:"scoped"`. `--gate-ran scoped` con decisión `full` → exit 1 sin receipt. Sin flags → igual que hoy, `fresh:true` (`// Covers: R25, R16, R17`) |
| El publisher abre un PR en un milestone intermedio | Test de anclas de render: `publisher` (Claude y Codex) contiene la regla `mode: commit-only` **antes** del heading "PR flow" y la condición `gateKind` (`// Covers: R26`) |
| La prosa nueva no llega a Codex | Render `claude` y `codex`: las anclas `spec: <spec> E<n> M<n>`, `navori receipt gate`, `Spec-Delivery:` y `mode: commit-only` aparecen en ambos (`// Covers: R15, R18, R19, R21, R23`) |
| Falta la fila de la matriz | `native-overlap.test.ts` (`// Covers: R23`) |
| El mapeo E con `parts.json` falla | `delivery-checks.test.ts`, con `deliveryIdsForSpec` sobre una etapa fixture (`// Covers: R22`) |
| Asset que ordena `navori spec` sin permiso | `asset-command-permissions.test.ts`, que ya existe (`// Covers: R4, R11`) |
| **R20 no llega a lo renderizado** | Test que lee `navori.config.json` (`"main"`) y los `reviewer`/`publisher` renderizados de este repo (`.claude/agents/*.md`, `.codex/agents/*.toml`), y espera `origin/main` y `--base main`, sin `origin/dev` (`// Covers: R20`) |
| DIRECTION no fija la unidad | Test de docs: sección y enlace (`// Covers: R1`) |
| Calibración ausente | Test de docs: la tabla de `distribucion-entregas-agentes.md` tiene las filas 0039 y 0041 y las cuatro columnas de R24 (`// Covers: R24`) |
| Topes de palabras y presupuesto always-on | `check:assets`/`check:doc-budgets`, que ya existen |

## Plan de entregas de esta spec (dogfooding)

Propuesta bajo sus propias reglas: 26 `R<n>`, unas 20 tareas (> 12) y tres capacidades demostrables
por separado, así que la forma es `split` con 3 PRs (≤ 4). Ninguna entrega es `foundation`: `E1` se
usa sola sobre specs reales.

| Entrega | Capacidad demostrable | Milestones | `R<n>` | LOC est. |
|---|---|---|---|---|
| **E1** — `navori spec` clasifica y valida specs | `navori spec classify`/`check` sobre cualquier spec del repo | **M1** parser por bloques, `classifySpec` y `sdd.deliveries` (R2–R8). **M2** `checkSpec`, legacy como warnings, test sobre todos los specs reales y permisos `allow` (R9, R11–R14) | R2–R9, R11–R14 | 1300 |
| **E2** — Gates proporcionales y PRs por entrega | Un milestone intermedio sale con commit sin gate completo, y el de cierre abre el PR con el completo | **M3** `receipt gate`, `sign --spec/--milestone/--gate-ran` y `gateKind` (R16, R17, R25). **M4** prosa de reviewer, publisher (commit-only y orden), orquestacion, planificacion, sdd, spec-bootstrap y fila de la matriz (R10, R15, R18, R19, R23, R26). **M5** DIRECTION, `prTarget: main` con re-render y calibración (R1, R20, R24) | R1, R10, R15–R20, R23–R26 | 1200 |
| **E3** — Master-plan reparte con las mismas reglas | `navori spec check` valida los `E<n>` de una parte contra `parts.json` | **M6** `deliveryIdsForSpec` y sus reglas en `check` (R22). **M7** skill y plantillas de master-plan, es y en (R21) | R21, R22 | 450 |

Total estimado: unas 2950 LOC.

- **Orden y dependencias:** `E2` usa `lib/spec` de `E1` (`decideGate`). `E3` usa `checkSpec`.
  `E2`/`M5` va al final porque R20 cambia el destino de los PRs siguientes: `E3` ya sale contra
  `main`.
- **Limitación:** los ciclos de `E1` corren con el gate completo (el mecanismo llega en `E2`).

## NOT in scope

- **Migración automática de specs anteriores.**
- **Cambios en CI.**
- **Hooks o mecanismos del engine que impongan el número de PRs.** Lo fija el invariante 9.
- **Proyección automática de `tasks.md` a workplan.** La copia de `A<n>` es una por entrega (D6); si
  aparece deriva, va en una spec propia.
- **Reviewer de cumplimiento por milestone distinto del actual.**
- **El gate completo de más de 10 min contra el tope de Bash.**
- **Cambiar `DeliveryPartsSchema`.** Solo se avisa la discrepancia de destino (D7).
- **`receipt review begin|seal` con tipo de gate.** El stamp de `review-evidence.ts` sigue
  registrando el gate configurado. Eso es observabilidad (`audit`), no la garantía de publicación,
  que vive en el receipt. Se acepta esa imprecisión en los ciclos acotados.
- **Que el receipt pruebe que el gate corrió.**

## Open questions

- **[assumed]** Sin aprobación humana por workplan de entrega: la cubre la aceptación de la spec.
  Agregarla sería una línea de prosa.
- **[assumed]** El orquestador marca `[x]` las tareas de un milestone al cerrarlo, para que
  `decideGate` vea el avance. Lo exige la tabla de `tasks.md` como tablero (bloque `sdd`), y si falta
  el modo de fallo bloquea de más (ver "Failure modes").

## Durable knowledge

- **Unidad de PR (entrega) y de verificación (milestone).** Destino propuesto: `docs/DIRECTION.md`
  (R1). Los números van en `sdd.deliveries`.
- **"El CLI decide el gate; un receipt `scoped` solo permite el commit".** Destino propuesto: JSDoc de
  `decideGate` y `signReceipt`, y prosa managed de `reviewer`/`publisher`.
- **Gramática de `tasks.md`.** Destino propuesto: la skill `spec-bootstrap` y el JSDoc de
  `lib/spec/tasks.ts`.
