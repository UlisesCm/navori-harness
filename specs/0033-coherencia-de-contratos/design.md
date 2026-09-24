# Coherencia de contratos del harness — Design

**Señal:** contrato compartido (receipt, handoff del implementer, registro de capacidades),
área crítica (writes y deletes del render en `.agents/skills/`, permisos de `settings-base.json`),
cambio de ownership (quién valida un handoff). **Base revisada:** `origin/main` = `6edc58b4`.

## Approach

Cinco frentes, un mismo principio: **cada contrato se define una vez, en código cuando es
verificable, y la prosa de los assets lo cita en vez de reformularlo.** Donde la regla se puede
comprobar, la comprueba un subcomando del CLI que corre igual en todos los engines (el precedente
es `navori receipt` y `navori plan check`). Donde no se puede, el registro de controles lo declara
`advisory` y `doctor` lo dice.

| Frente | Qué cambia | Pieza que define la regla |
|---|---|---|
| F01 (R1–R4) | Tres estados de atribución y un solo método para demostrarlos | sección "Failure attribution" de `verify-before-done` |
| F02 (R5–R8) | La vigencia de la evidencia se define por identidad (árbol + comando + inputs), no por turno | receipt v2 en `lib/diagnose/receipt.ts` |
| F03 (R9–R12) | Codex descubre las skills locales mediante un puntero generado con marcador | `engines/codex/local-skill-pointer.ts` + `orphanScans` |
| F04/F05 (R13–R17) | El consumidor valida el handoff con un comando | `navori handoff check` (`lib/handoff/`) |
| F06 (R18–R19) | Base declarada y fallback explícito | placeholder `{{branchBase}}` / `{{shq:branchBase}}` |
| Inventario (R20–R23) | Estado por control y por engine, probado contra el render | `HARNESS_CONTROLS` en `engines/shared/engine-capabilities.ts` |

### Criterios de decisión (derivados de las reglas del proyecto, antes de las opciones)

1. **Un solo pipeline de render** (`docs/DIRECTION.md`, invariante 7): todo lo que escribe o poda
   en el repo del usuario pasa por `PlacementRequest` → `collectPlan` → `commitWrites`
   (`engines/shared/execute-plan.ts`). Se descarta cualquier ruta de escritura paralela.
2. **Modelo híbrido no destructivo** (invariante 4): la fuente `.claude/skills/<id>/` es del
   usuario. Un destino que navori no escribió no se toca.
3. **navori genera, no ejecuta** (invariante 9): los validadores son comandos que el agente invoca,
   igual que `navori receipt` y `navori plan check`. navori no corre el gate del usuario.
4. **Un solo dueño por regla** (DIRECTION, "Convención: regla autosuficiente"): los umbrales y las
   definiciones viven en un módulo. La spec 0032 documenta el costo de no hacerlo: siete lugares
   con umbrales que no coincidían.
5. **Honestidad por control, no por host** (auditoría, sección 7.3): lo que no se puede garantizar
   se declara `advisory`/`unsupported`. No se inventan hooks nuevos para convertirlo en garantía.
6. **Presupuesto de palabras** (`check:doc-budgets`): `verify-before-done`, `solution-design`,
   `reviewer`, `publisher` y `orquestacion` están en su techo o muy cerca de él. La prosa nueva
   reemplaza prosa vieja.
7. **Sin dependencias nuevas.** zod ya está en el CLI (`lib/plan/schema.ts`).

## Components

**F01 — atribución de fallas**

- `packages/core/core-assets/skills/verify-before-done.md` — reemplaza la fila "Zero new errors vs
  baseline" y la sección "Baseline attribution" por una sola sección "Failure attribution". Tiene
  los tres estados literales (*introduced (demonstrated)*, *pre-existing (demonstrated)*, *origin
  not determined*), la regla de que la ubicación respecto de `git diff --name-only` solo sirve para
  orientar, y el método de R3. La fila de la tabla queda como puntero a esa sección — cubre R1, R2,
  R3, R4.
- `packages/core/core-assets/agents/implementer.md` — la fila "Zero new errors in typecheck/lint"
  de "Evidence-based completion" y la viñeta "Zero new errors" pierden el "predates you" y citan
  la sección de `verify-before-done` — cubre R4.
- `packages/core/core-assets/agents/reviewer.md` — la fila "Zero new errors vs baseline" de la
  plantilla del Pass 2 pasa a "Failure attribution: estado por falla + la corrida sobre la base
  que lo demuestra". Las líneas de "Hard rules" sobre errores nuevos citan los estados — cubre R4.
- `packages/core/core-assets/skills/review-diff.md` — la viñeta "Zero new errors/warnings vs
  baseline" cita los tres estados — cubre R4.

**F02 — vigencia de la evidencia**

- `packages/cli/src/lib/diagnose/receipt.ts` — receipt v2. `signReceipt` escribe en la cabecera
  `base=`, `gate=` e `inputs=` (ver Contracts). `checkReceipt` los recalcula y devuelve `fresh` y
  `stale[]` además de `status`. Una función exportada, `evidenceIdentity()`, es la **única
  definición** de "evidencia vigente" — cubre R5, R7.
- `packages/cli/src/commands/receipt.ts` — `resolveReceiptOptions` resuelve también
  `qualityGate.full` desde la config. Nuevo flag `--include-consumed`, solo para `check` — cubre
  R5, R6.
- `packages/cli/src/lib/diagnose/detect.ts` — la lista de lockfiles que hoy está repetida en
  `detectPackageManager` y `detectPackageManagerSource` pasa a una constante exportada `LOCKFILES`.
  La reusan esas dos funciones y `evidenceIdentity()` — cubre R5.
- `packages/core/core-assets/skills/verify-before-done.md` — la Iron Law y "Gate function" pasan a
  hablar de evidencia *vigente*. Quien produce evidencia la produce corriendo el comando. Quien la
  consume la verifica con `navori receipt check`, que corre en ese turno y exige `"fresh":true`. La
  fila "PR creatable" no cambia de sentido — cubre R5, R8.
- `packages/core/core-assets/agents/publisher.md` — sección Gate, camino "Reviewed". Con
  `"status":"ok"` y `"fresh":true` no se vuelve a correr el gate. Con `"fresh":false` el publisher
  corre `{{qualityGate.full}}` él mismo antes de seguir. La viñeta "Re-run by hand whenever the diff
  changed…" desaparece porque `stale` la hace mecánica. El paso "Consume the receipt" cambia
  `rm -f receipt.txt` por un renombre a `receipt.consumed.txt` — cubre R6, R7, R8.
- `packages/core/core-assets/managed/cierre-sesion.md` — el paso 1 reemplaza "cite this cycle's
  green run" por `navori receipt check … --include-consumed --json`. Con `"status":"ok"` y
  `"fresh":true` se cita el receipt; en cualquier otro caso se vuelve a correr el gate — cubre R6,
  R7, R8.
- `packages/core/core-assets/agents/reviewer.md` — el párrafo del Quality gate del Pass 2 deja de
  decir "fresh … this cycle" y dice "evidencia ligada al receipt (identidad de R5)". El reviewer
  sigue corriendo el gate: es quien produce la evidencia — cubre R8.
- `packages/core/core-assets/agents/implementer.md` — "Evidence-based completion" cita la regla de
  vigencia de `verify-before-done`. El implementer también produce evidencia, así que corre su
  `{{qualityGate.fast}}` — cubre R8.

**F03 — skills locales en Codex**

- `packages/cli/src/engines/codex/local-skill-pointer.ts` (nuevo) — dos piezas:
  - `classifyLocalSkills(cwd, ids, planSkillIds)`, **función pura** (solo lee disco) y **única
    fuente** de la clasificación de los ids declarados en tres conjuntos disjuntos:
    - `emit`: la fuente existe en `.claude/skills/<id>/` y el destino no existe o lleva el marcador
      `<id>-local-pointer`.
    - `missing`: la fuente no existe (R11).
    - `foreign`: la fuente existe, pero el destino `.agents/skills/<id>/SKILL.md` existe y
      `navoriAuthorship` no lo da por `ours` (R12).

    Los ids que ya están en `plan.skills` no entran en ningún conjunto: gana la skill del plan.
  - `buildLocalSkillPointer(source)`, que arma el cuerpo del puntero: `name` y `description` salen
    del frontmatter de la fuente, sanitizados, y el cuerpo remite a `.claude/skills/<id>/SKILL.md`.
    **No** pasa por `adaptHarnessTextForCodex`.

  Cubre R9, R10, R11, R12.
- `packages/cli/src/engines/codex/index.ts` — en `createCodexAdapter`, `extraFiles` llama a
  `classifyLocalSkills` y emite **solo `emit`**: un `PlacementRequest` (`body`, `managedId:
  "<id>-local-pointer"`, `commentStyle: "html"`) por id, más el sidecar `agents/openai.yaml` si la
  fuente declara `disable-model-invocation`. `orphanScans` agrega `emit ∪ foreign` a los `desired`
  de los dos escaneos de `.agents/skills` (`skill-dir` y `skill-nested-file`). Así, un destino
  foráneo no se poda ni se reporta como huérfano, y un id `missing` sale de `desired` y su puntero
  previo se poda. **`AdapterCtx` y `EngineAdapter` no cambian**: el adapter no tiene canal de avisos
  y no lo necesita — cubre R9, R10, R12.
- `packages/cli/src/commands/render.ts` — llama una vez por render a `classifyLocalSkills` y empuja
  a su `warnings: string[]` existente un aviso por cada id de `missing` ("declarado en
  `project.localSkills` pero ausente de `.claude/skills/<id>/`") y por cada id de `foreign`
  ("`.agents/skills/<id>/SKILL.md` no lo escribió navori; se conserva intacto; bórralo para recibir
  el puntero"). Los avisos de `missing` salen con cualquier engine configurado; los de `foreign`,
  solo si `codex` está configurado — cubre R11, R12.
- `packages/cli/src/commands/doctor.ts` — reemplaza el filtro en línea de `missingLocalSkills` por
  la misma `classifyLocalSkills`. Reporta `missing` con la sugerencia de mover la skill a
  `.claude/skills/<id>/` (fuente única, también en repos solo-Codex) y `foreign` con el mismo texto
  que `render` — cubre R11, R12.
- `packages/cli/src/engines/shared/skills-index.ts` — `buildSkillRows` no cambia de conducta: sigue
  resolviendo con `resolveLocalSkillPath`, que es la misma primitiva sobre la que se construye
  `classifyLocalSkills` — cubre R11.
- `packages/cli/src/lib/diagnose/host-contracts.ts` — nuevo contrato
  `codex-skill-body-redirect`, con el patrón de `skills-load-shape`: "Codex, al activar una skill
  cuyo `SKILL.md` remite en su cuerpo a `.claude/skills/<id>/SKILL.md`, abre ese archivo y sigue
  sus enlaces relativos". El `source` lo declara **unverified** hasta la sonda del lote C, y
  `enforcedBy` admite que nada lo vigila en CI (la sonda es manual). La interfaz `HostContract` no
  cambia: su test ya acepta un `enforcedBy` que admite la brecha — cubre R9.

**F04/F05 — consumo del handoff**

- `packages/cli/src/lib/handoff/schema.ts` (nuevo, zod) — `ImplHandoffSchema` es la única definición
  del esquema de `impl_<feature>.json`. Exporta `REQUIRED_IMPL_KEYS` y suma el campo `head` —
  cubre R13.
- `packages/cli/src/lib/handoff/check.ts` (nuevo) — `checkHandoff({cwd, dir, feature, consumer})`.
  Con `consumer: "orchestrator"` verifica exists, parse y feature (R14, R15). Con `consumer:
  "scribe"` verifica además el checkout, la rama y cada `markdownRequests[].path` (R16). La lista
  de directorios de progreso la comparte con `receipt.ts`: `PROGRESS_DIRS` pasa a un módulo común,
  `lib/primitives/progress-dirs.ts` — cubre R14, R15, R16.
- `packages/cli/src/commands/handoff.ts` (nuevo) — `navori handoff check <feature> [--for
  scribe] [--dir] [--cwd] [--json]`, registrado en `subCommands` de `packages/cli/src/index.ts` —
  cubre R14, R16, R17.
- `packages/core/core-assets/settings/settings-base.json` — `Bash(navori handoff check:*)` en
  `permissions.allow`, junto a `Bash(navori receipt:*)` — cubre R17.
- `packages/core/core-assets/managed/orquestacion.md` — antes de despachar al `scribe` o al
  `reviewer` sobre un feature, el orquestador corre `navori handoff check <feature> --json`, y solo
  despacha con `"status":"ok"`. Va en este bloque porque es el que llega a Codex (`AGENTS.md`,
  `includeOrchestration: true`); Codex no renderiza `orchestrator.md` (`ENGINE_CAPABILITIES.codex`,
  `orchestrator-agent`) — cubre R14, R15, R17.
- `packages/core/core-assets/agents/orchestrator.md` — el párrafo "The `scribe` leg" remite a la
  regla del bloque, sin repetirla — cubre R14.
- `packages/core/core-assets/agents/implementer.md` — "Closing report" agrega
  `"head": "<git rev-parse HEAD at the end>"` — cubre R13.
- `packages/core/core-assets/agents/scribe.md` — antes de "Render the handoff", un preflight:
  `navori handoff check <feature> --for scribe --cwd <checkout you will edit> --json`. Cualquier
  resultado que no sea `"status":"ok"` es `BLOCKED` y no se escribe nada. Después edita y commitea
  solo dentro del `worktree` que devuelve el comando — cubre R16, R17.
- `packages/core/core-assets/hooks/subagent-stop-handoff.sh` — **no cambia de conducta**: sigue
  advisory (restricción heredada). Solo lo toca un test de paridad: su lista `required` debe ser
  igual a `REQUIRED_IMPL_KEYS`.

**F06 — base declarada**

- `packages/core/core-assets/agents/architect.md` — la viñeta de "Method" pasa a
  `origin/{{branchBase}}` e incluye el fallback de R19: nombrar la ref usada, o marcar la
  afirmación como *unverified* con su causa — cubre R18, R19.
- `packages/core/core-assets/skills/solution-design.md` — el paso 1 de "Process" hace lo mismo —
  cubre R18, R19.
- `packages/core/core-assets/skills/scoped-gate.md` — el snippet de "The pattern" y el caso
  "Baseline freshness" usan `base={{shq:branchBase}}` y `origin/$base`. El fallback a la ref local
  imprime en stderr qué ref se usó, y la falta de ambas refs sale con error — cubre R18, R19.

**Inventario de controles**

- `packages/cli/src/engines/shared/engine-capabilities.ts` — se extiende con `ControlId` (unión
  cerrada), `CONTROL_DEFINITIONS` (descripción y condición por flag), `controls` y
  `analyticWriteTools` dentro de cada `EngineCapabilities`. `validateEngineCapabilities` también
  valida los controles — cubre R20, R23.
- `packages/cli/src/lib/diagnose/control-gaps.ts` (nuevo) — `scanControlGaps(config)`: para cada
  engine configurado, los controles aplicables que no están `enforced` — cubre R21.
- `packages/cli/src/lib/plan/gate-support.ts` — **se elimina**. `scanPlanTiersGateSupport` pasa a
  ser una fila de `scanControlGaps` (control `plan-gate`). Su test migra a `control-gaps.test.ts` y
  conserva la cita a la spec 0032 R17 — cubre R21.
- `packages/cli/src/commands/doctor.ts` y `packages/cli/src/lib/i18n.ts` — una sección agrupada
  reemplaza `planTiersGateDegraded` (ver Decisions, severidad) — cubre R21.
- `packages/cli/src/engines/__tests__/control-inventory.test.ts` (nuevo) — renderiza los cinco
  engines en un directorio temporal y compara el registro con el render efectivo — cubre R22, R23.

## Decisions

### D1 — Vigencia de la evidencia: extender el receipt (R5–R8)

**Qué existe.** `lib/diagnose/receipt.ts`: `signReceipt` escribe `# navori-receipt v1
feature=<f>` más una línea `<blob>  <path>` (o `deleted  <path>`) por cada archivo del diff
contra `origin/<target>`, incluidos los no rastreados y excluido `progress/`. `checkReceipt`
detecta `uncovered` y `drift`. Eso ya identifica **el contenido cambiado**. No registra la
**base** (`targetSha` sale en el JSON pero no en el archivo), ni el **comando** del gate, ni los
**inputs**. Tampoco dice nada sobre la vigencia del gate: hoy esa vigencia es la prosa de
`publisher.md` ("Re-run … whenever the diff changed since the review (rebase/merge…)").

| Peldaño | Opción | Veredicto |
|---|---|---|
| Patrón existente | Solo prosa: `verify-before-done` define la vigencia y el publisher la juzga leyendo `review_<feature>.md` | Descartada: sin comprobación del comando ni de la base es el mismo "juicio del agente" que produjo F02. R5 pide un único lugar verificable. |
| **Extensión** | **Receipt v2**: la cabecera gana `base`, `gate` e `inputs`; `check` devuelve `fresh` y `stale` | **Recomendada** |
| Abstracción nueva | Artefacto aparte `gate-evidence.json` + `navori evidence check`, escrito por quien corra el full gate (reviewer o publisher inline) | Descartada: duplicaría la identidad de árbol que `inspect()` ya calcula y dejaría dos artefactos sobre los mismos bytes. Su única ventaja, cubrir el camino inline, se resuelve más barato volviendo a correr el gate (ver abajo). |

**Por qué la extensión.** La identidad (base + blobs del diff) ya determina el árbol completo que
se verificó. Sumarle el hash del comando y de los inputs completa R5 sin un artefacto nuevo. El
publisher ya consume el receipt y el reviewer ya lo firma solo en APPROVED, que exige el gate
verde del Pass 2. Separar `status` (cobertura de la aprobación) de `fresh` (vigencia del gate) deja
intacto el contrato actual (`"status":"ok"`, exit 0) y agrega una sola decisión.

**Consecuencias aceptadas.**
- **Rebase sin cambios propios ⇒ sigue vigente** (decisión del usuario, 2026-09-24). Si
  `origin/<target>` avanzó y la rama se rebasó, pero los blobs del diff son idénticos a los
  aprobados, `fresh` sigue en `true`. `base` se registra en la cabecera solo como información y
  no vence la evidencia. Una rotura que aparezca al combinar el cambio con el `main` nuevo la
  detecta el CI del PR, no el publisher. Si el rebase resolvió conflictos, los blobs cambian y
  eso ya es `drift`. La frase "(rebase/merge…)" sale de `publisher.md`.
- **Camino inline (sin reviewer).** No hay receipt, así que el publisher corre el full gate, como
  hoy. El cierre de sesión en ese camino también lo vuelve a correr (R7 por omisión). Es un costo
  real pero acotado: los cambios inline son los pequeños.
- **Cierre después del publisher.** El publisher consumía el receipt con `rm -f`, lo que obligaba
  al cierre a correr el gate otra vez. Renombrarlo a `receipt.consumed.txt` conserva la evidencia
  sin rearmarla. Solo `check --include-consumed` lo lee (y solo si no hay `receipt.txt`), y los
  assets solo pasan ese flag en `cierre-sesion`. Así, un receipt consumido nunca autoriza otro
  commit: el problema que motivó el `rm -f` sigue cerrado.
- **La Iron Law no se contradice (R8).** La regla pasa a ser "la afirmación se respalda con el
  comando que la prueba, corrido en este turno". Para quien produce, ese comando es el gate. Para
  quien consume, es `navori receipt check`, que corre en este turno y verifica identidad. "Este
  turno" deja de ser el criterio de vigencia del gate.

### D2 — Skills locales en Codex: puntero generado con marcador (R9–R12)

**Qué existe.** `placeSkill` en `engines/codex/index.ts` solo coloca `plan.skills`.
`orphanScans` recorre `.agents/skills` con `match: () => true` y `desired` = `plan.skills`, así
que una copia manual se reporta como huérfana (`pushKept`, razón `foreign`); una copia con marcador
navori ajeno al plan se podaría. `resolveLocalSkillPath` (`lib/assets/skill-meta.ts`) solo acepta
la forma `.claude/skills/<id>/SKILL.md`. `doctor` ya nombra los ids faltantes (`missingLocalSkills`
en `commands/doctor.ts`); `render` no. La fuente real tiene archivos de soporte:
`.claude/skills/playwright-cli/references/` contiene nueve `.md` enlazados de forma relativa desde
su `SKILL.md`.

| Peldaño | Opción | Veredicto |
|---|---|---|
| Patrón existente | Copia generada de `SKILL.md` con marcador, vía `placeSkill` + `transform` | Descartada: rompe los enlaces relativos a `references/` (playwright-cli). Copiar el directorio entero exige un shape de huérfano nuevo para archivos arbitrarios del usuario y duplica bytes. `adaptHarnessTextForCodex` reescribiría la prosa del usuario. Además, un cambio en el cuerpo de la fuente dejaría la copia vencida en cada edición. |
| Variante | Symlink `.agents/skills/<id>` → `.claude/skills/<id>` | Descartada con evidencia de código: `navoriAuthorship` (`lib/render/removable.ts`) nunca borra un symlink (razón `symlink`), así que R12 no se cumpliría; `createBackup` (`lib/render/backup.ts`) salta todo lo que no es archivo regular, así que no habría backup; y `inspect`/`liveBlob` de `receipt.ts` abortan ante entradas no regulares, así que cualquier PR que agregue el link bloquearía el ciclo de publicación. Además, Windows. |
| Variante | Config de Codex que agregue `.claude/skills` como raíz de skills | Descartada: no hay contrato registrado en `lib/diagnose/host-contracts.ts` ni documentación de que Codex lo soporte, **y a diferencia del puntero no tiene una sonda barata**: habría que probar una clave de config que quizá no existe. |
| **Extensión** | **Puntero generado**: `.agents/skills/<id>/SKILL.md` con `name`/`description` de la fuente y un cuerpo que remite a la fuente, escrito por el spine con marcador managed | **Recomendada, condicionada a la sonda del lote C** |
| Fallback declarado | **Copia generada con enlaces reescritos**: `SKILL.md` de la fuente con marcador, donde los enlaces relativos se reescriben a rutas repo-relativas hacia `.claude/skills/<id>/` | Se usa solo si la sonda del puntero falla (ver abajo) |

**Criterio #3 aplicado por igual.** El puntero depende de una conducta del host que nadie ha
medido: que Codex siga una redirección escrita en el cuerpo de un `SKILL.md` hacia otra raíz. La
documentación pública de Codex (progressive disclosure) solo muestra skills autocontenidas. Es la
misma clase de dependencia que descarta la fila de config. Lo que las distingue:

- El puntero queda registrado como contrato `unverified` (`codex-skill-body-redirect` en
  `host-contracts.ts`).
- El lote C **arranca** con una sonda manual contra Codex real, antes de escribir el adapter.
- Tiene un fallback declarado que no depende de esa conducta.

La copia del fallback también depende del host, pero solo en lo ya contratado: que Codex descubra
y cargue `.agents/skills/<id>/SKILL.md`, que es el camino actual de toda skill del plan
(`placeSkill`).

**Sonda (inicio del lote C).**
1. En un repo temporal, un puntero escrito a mano en `.agents/skills/probe/SKILL.md` remite a
   `.claude/skills/probe/SKILL.md`, y esa fuente enlaza `references/token.md`, que contiene un
   token único.
2. Se le pide a Codex una tarea que active la skill.
3. **Pasa** si la respuesta contiene el token. El resultado (versión de Codex, fecha, pasa/falla)
   se registra en el `source` del contrato. Si pasa, el contrato deja de ser `unverified`.

**Si la sonda falla → fallback.** Se genera una copia de `SKILL.md` con el mismo `managedId`, el
mismo guard `foreign` y la misma poda. Los enlaces relativos de Markdown (con destino `references/y.md`) y
las rutas relativas entre backticks que resuelven a un archivo existente bajo la fuente se
reescriben a `.claude/skills/<id>/references/y.md`. Evaluación de lo que rompe o cambia:

- **R10 se vuelve más estricto:** cualquier edición del cuerpo de la fuente deja la copia vencida.
  El preview de `render` lo detecta, pero en este repo `bun check:render` falla en cada edición de
  una skill local hasta que se corra `render --apply`. Es fricción, no una rotura.
- **La reescritura es parcial:** una mención en prosa suelta ("ver references/y.md") no se
  reescribe. Se acepta y se documenta en el propio bloque de la copia.
- **Duplica bytes** en el repo: `playwright-cli` tiene 420 líneas.
- **La copia no puede pasar por `adaptHarnessTextForCodex`,** por la misma razón que el puntero:
  sería reescribir la prosa del usuario y arriesgar la autorreferencia.
- **El frontmatter solo copia `name` y `description`.** `allowed-tools` es de Claude.
- **Nada más cambia:** backup, anti-rollback, `user-modified-skipped`, poda y los tres conjuntos de
  `classifyLocalSkills` se aplican igual. La interfaz del adapter tampoco cambia.

No se implementa como default: su costo en R10 solo se justifica si el puntero no funciona.

**Por qué el puntero, si la sonda pasa.** Codex lo descubre de forma nativa, porque lista la
`description` real. El
contenido se lee de la única fuente, así que los enlaces relativos resuelven y navori no toca ni
adapta la prosa del usuario (R10). Todo pasa por `PlacementRequest`/`commitWrites`, con backup,
escritura atómica, anti-rollback y detección de edición manual incluidos (criterio 1). El
destino solo depende del frontmatter de la fuente, así que solo "se vence" cuando cambian `name` o
`description`, y ese caso lo detecta el preview de `render` (ver Observaciones, R10). El puntero
dice en su cuerpo que es un puntero; no aparenta ser una instalación nativa, como pide la
auditoría (F03, "Mejora").

**Reglas del puntero.**
- Se emite solo si la fuente existe (R11). Un id declarado sin fuente no genera destino: su puntero
  previo, si lo hay, sale de `desired` y se poda con backup. Un puntero hacia la nada sería
  contenido inventado.
- Si el id ya está en `plan.skills` (una skill de biblioteca reclamada), gana la del plan, como en
  `buildSkillRows`.
- Si el destino existe sin el marcador `<id>-local-pointer`, cae en `foreign`: no se escribe, no se
  poda y el aviso lo emite `render` (ver Failure modes).

### D3 — Validación del consumidor: subcomando del CLI (R13–R17)

**Qué existe.** El esquema de `impl_<feature>.json` vive en prosa (`implementer.md`, "Closing
report") y ya incluye `worktree`, `branch` y `commits`. `subagent-stop-handoff.sh`
(`navori_check_impl_json`) lo repite como lista de claves requeridas, en modo advisory y sin ver
handoffs ausentes. `scribe.md` ("Render the handoff") valida en prosa la existencia, el parseo y el
feature, y aplica `markdownRequests` "in the producer's own worktree" sin comprobar nada.
Precedentes de validador portable: `navori plan check` y `navori receipt`.

| Peldaño | Opción | Veredicto |
|---|---|---|
| Patrón existente | Solo prosa en `orquestacion.md` y `scribe.md` | Descartada: R16 pide un comando ejecutable, y la prosa es justo lo que F04/F05 señalan como insuficiente. |
| Extensión de un hook | Endurecer `subagent-stop-handoff.sh` o sumar al `plan-gate` un chequeo en el despacho del scribe/reviewer | Descartada para esta spec: el primero está prohibido por la restricción heredada. El segundo solo existiría en Claude, así que no sirve para R17 por sí solo. Queda como mejora posterior (NOT in scope). |
| **Extensión del CLI** | **`navori handoff check`** + esquema zod único | **Recomendada** |
| Abstracción nueva | Framework de handoffs tipados para todos los artefactos (`review_*`, `solution_*`) | Descartada: la auditoría (F05) advierte en contra de "un refactor de schemas sólo porque parezca elegante"; R13–R16 solo piden el handoff del implementer. |

**Límite explícito de R17.** La paridad que se prueba es **textual**: el mismo comando, con
`--json` y la condición `"status":"ok"`, aparece en el render de ambos engines. Que el agente de
verdad lo invoque sigue siendo `advisory` en los dos (D5, `handoff-consumer`). Si el modelo omite la
instrucción, nada lo detecta en ningún engine, igual que hoy. R17 se cumple porque ningún engine
depende de un hook exclusivo de Claude, no porque exista una garantía de invocación.

**Por qué el subcomando.** Corre igual en Claude y en Codex. Codex reescribe `.claude/progress/`
→ `.codex/progress/` en la prosa (`compat.ts`), así que `--dir .claude/progress` llega bien, como
ya pasa con `receipt`. La regla vive en código y tiene tests. El orquestador lo invoca desde el
bloque `orquestacion`, que es el único que llega a ambos hosts.

**Detalles.**
- **R15 por construcción:** el comando lee exactamente `impl_<feature>.json` y exige
  `data.feature === <feature>`. El handoff de otro feature nunca se abre. El slug se valida
  (`^[a-z0-9][a-z0-9._-]*$`) antes de formar la ruta.
- **R16, identidad del checkout:** `--cwd <checkout>` debe tener `git rev-parse --show-toplevel`
  igual, tras `realpath`, al `worktree` registrado, y `git branch --show-current` igual a `branch`.
  El comando devuelve el `worktree` resuelto para que el scribe edite y commitee con rutas
  absolutas bajo él (en Claude, el cwd de Bash se reinicia entre llamadas de un subagente).
- **R16, paths:** cada `markdownRequests[].path` debe ser relativo (sin `/` inicial, sin letra de
  unidad, sin `\`); su forma normalizada no puede tener segmentos `..`; el `realpath` de su
  directorio padre, si existe, debe quedar dentro del worktree (cubre la fuga por symlink); no
  puede estar bajo `PROGRESS_DIRS` (sesión y handoffs); y su extensión debe ser `.md` o `.mdx`,
  que es el contrato de `markdownRequests` en `implementer.md`.
- **`head` (R13)** es obligatorio en el contrato del productor. El checker lo reporta como
  *warning* cuando falta, nunca como falla: ninguna comprobación bloqueante de R14–R16 lo necesita,
  y así un handoff en vuelo no rompe la cadena cuando se actualiza navori (ver Migration). Si
  existe y difiere del `HEAD` del checkout, también es un warning ("el checkout se movió desde el
  handoff").
- **Modo `scribeOwnsMarkdown: false`** (no hay JSON): el comando verifica que
  `impl_<feature>.md` exista, no esté vacío y tenga la línea `Status:`. El feature queda ligado
  solo por el nombre del archivo, y `--for scribe` no aplica. Ver Observaciones.

### D4 — `branchBase` en los assets (R18–R19)

`{{branchBase}}` ya se interpola en assets de prosa (`verify-before-done`, `cierre-sesion`) y
`{{shq:branchBase}}` en código shell (`lib/render/interpolate.ts`, marcador `shq:`). No hace falta
mecanismo nuevo: es el patrón existente, sin alternativas genuinas.

- **Prosa** (`architect`, `solution-design`): "against `origin/{{branchBase}}` after `git fetch
  origin {{branchBase}}`; if the fetch fails or the ref doesn't exist, name the ref you actually
  used — or mark the claim *unverified* with the cause".
- **Shell** (`scoped-gate`): `base={{shq:branchBase}}`, primero `origin/$base`, después `$base`
  con un aviso en stderr que nombra la ref local y advierte que puede estar desactualizada. Si
  ninguna existe, sale distinto de cero con la causa. No hace `fetch`: el patrón corre en un hook
  de pre-commit, y agregar red en cada commit es un costo que la skill no debe imponer. R19 queda
  cubierto porque se declara la ref usada.
- **`branchBase` y no `prTarget`**: R18 fija `branchBase`. Es la base desde la que se corta el
  trabajo, y contra ella tiene sentido decir que algo "ya existe". El receipt y el reviewer siguen
  usando `prTarget`, que es otra pregunta: el diff que se va a publicar.

### D5 — Registro de controles: extender `ENGINE_CAPABILITIES` (R20–R23)

**Qué existe.** `ENGINE_CAPABILITIES` (`engines/shared/engine-capabilities.ts`, #821) declara por
engine las superficies que **no** renderiza (`unsupportedSurfaces`), con una razón que el tipo
exige, y se valida al cargar el módulo contra `ENGINES`. `lib/plan/gate-support.ts` fija en código
`GATE_CAPABLE_ENGINE = "claude"`: es una segunda fuente para la misma verdad. `host-contracts.ts`
registra conductas del *host*, no garantías de navori, así que es otro eje.

| Peldaño | Opción | Veredicto |
|---|---|---|
| Patrón existente | Sumar controles como entradas de `unsupportedSurfaces` | Descartada: no puede expresar `enforced` frente a `advisory`, ni condiciones por flag, ni la evidencia que el test necesita. |
| **Extensión** | **`controls` + `analyticWriteTools` dentro de cada `EngineCapabilities`; `ControlId` como unión cerrada; `CONTROL_DEFINITIONS` con condición** | **Recomendada** |
| Abstracción nueva | Módulo propio `harness-controls.ts`, organizado por control → engine | Descartada: partiría en dos archivos el conocimiento "qué no garantiza este engine y por qué", justo lo que #821 unificó. R20 pide un único registro. |

**Por qué la extensión.** `Record<ControlId, ControlDeclaration>` hace que olvidar un control en
un engine sea un error de compilación, el mismo mecanismo que ya obliga a escribir `reason`. La
unión discriminada exige `evidence` cuando el estado es `enforced`. `validateEngineCapabilities`
ya corre al importar el módulo. `unsupportedSurfaces` se queda: describe archivos que no se
renderizan, mientras que `controls` describe garantías. Donde coinciden, la razón del control cita
la superficie.

**Estados iniciales** (el test de R22 los confirma contra el render; cualquier discrepancia se
corrige en el registro, nunca en el test):

| Control (`ControlId`) | Condición | claude | codex | agents-md / cursor / copilot |
|---|---|---|---|---|
| `plan-gate` | `harness.planTiers` | enforced (hook `plan-gate`, `PreToolUse` `Agent`) | advisory (asset copiado sin registrar en `config.toml`; el reviewer usa `classify`) | unsupported (`subagent-orchestration`) |
| `markdown-ownership` | `harness.scribeOwnsMarkdown` | enforced (hook `implementer-no-markdown`) | advisory (contrato en prosa) | unsupported |
| `handoff-shape` | — | advisory (hook `subagent-stop-handoff`, `PostToolUse`, advisory por diseño) | advisory (contrato en prosa; hook no registrado) | unsupported |
| `handoff-consumer` | — | advisory (`navori handoff check` invocado por prosa) | advisory (ídem) | unsupported |
| `analytic-write-tools` | — | advisory (tools del frontmatter + instrucciones) | advisory (`sandbox_mode` `workspace-write` + instrucciones) | unsupported (no se renderizan agentes) |
| `local-skill-discovery` | `project.localSkills` no vacío | enforced (raíz nativa `.claude/skills`) | enforced (evidencia: puntero en `.agents/skills`) | advisory (fila en el índice de skills del archivo de prosa) |

**Severidad en `doctor` (R21).** Si listara cada fila no `enforced` como warning, un repo
solo-Claude vería tres warnings permanentes, y la regla de `skill-triggers.ts` advierte que
reportar de más "trains people to skim". Por eso: una sola sección agrupada, `p.log.info`, con
una fila por engine × control (estado + razón). Solo sube a `warn` un control con condición de flag
que el usuario **activó** (`planTiers`, `scribeOwnsMarkdown`) y que no está `enforced` en un engine
configurado. Así se conserva la severidad del aviso actual de la spec 0032 R17. Nunca cambia el
`ok` de doctor.

**R23 — tools efectivas.** `analyticWriteTools: Record<"auditor" | "scout" | "reviewer" |
"architect", readonly string[]>` por engine. En claude es la intersección del `tools:` renderizado
con `WRITE_CAPABLE_TOOLS = {Write, Edit, MultiEdit, NotebookEdit, Bash}`; hoy da `["Bash",
"Write"]` para los cuatro. En codex es `["sandbox:<sandbox_mode efectivo>"]`: el del `.toml` del
agente o, si no lo tiene, el de `.codex/config.toml`; hoy da `workspace-write`. En los engines de
prosa es `[]`. Solo se declara; ningún privilegio cambia.

### D6 — Orden de lotes sugerido

El orquestador escribe `tasks.md`; esto solo propone el orden y el porqué.

1. **Lote A — F01 + F02 (R1–R8).** Base de todo lo demás: fija qué es evidencia vigente. Toca
   `receipt.ts` y la prosa de `verify-before-done`, `implementer`, `reviewer`, `publisher`,
   `review-diff` y `cierre-sesion`.
2. **Lote B — F06 (R18–R19).** Chico, solo assets (`architect`, `solution-design`,
   `scoped-gate`), sin archivos en común con A: puede correr en paralelo con A, dentro del tope de
   dos implementers.
3. **Lote C — F03 (R9–R12).** Área crítica (writes y deletes en `.agents/skills`). Va solo para
   que el challenge y el review se concentren en él. Arranca con la sonda manual de D2, y su
   resultado decide entre el puntero y el fallback antes de escribir el adapter.
4. **Lote D — F04/F05 (R13–R17).** Depende de A solo en la prosa de `implementer.md`: conviene
   aplicarlo después para no chocar en el mismo archivo.
5. **Lote E — Inventario (R20–R23).** Va al final porque dos de sus controles
   (`local-skill-discovery`, `handoff-consumer`) solo tienen su estado real después de C y D. Borra
   `gate-support.ts`.

Después de cada lote que toque assets: `navori render --apply` en este repo (auto-hospedaje) y
`bun check:render`.

## Contracts

**Receipt v2 — cabecera del archivo** (`.claude/progress/receipt.txt`):

```
# navori-receipt v2 feature=<f> base=<sha de origin/<target> al firmar> gate=<sha256 del comando> inputs=<sha256>
```

- `gate` = sha256 de la cadena `qualityGate.full` resuelta desde `navori.config.json`.
- `inputs` = sha256 de la concatenación ordenada `"<nombre>\0<sha256 del contenido>\n"` de cada
  lockfile de `LOCKFILES` presente en la raíz del repo. Si no hay ninguno, es el hash de la cadena
  vacía.
- Las líneas de cuerpo no cambian (`<blob>  <path>` / `deleted  <path>`). `readReceipt` sigue
  ignorando las líneas que empiezan con `#`, y la cabecera se lee aparte.

**`ReceiptResult` (JSON de `receipt check`)** — campos nuevos, aditivos; `formatVersion` sigue en
`1` porque ningún consumidor existente se rompe:

```json
{ "status": "ok | findings | error", "fresh": true, "stale": ["gate" | "inputs" | "format"], "consumed": false }
```

`status` y el exit code (0/2/1) conservan su significado: cobertura y drift de la aprobación.
`fresh` es `stale.length === 0`. Un receipt v1 da `stale: ["format"]`. `consumed: true` solo
aparece cuando `--include-consumed` leyó `receipt.consumed.txt`.

**`impl_<feature>.json`** — `ImplHandoffSchema` (`lib/handoff/schema.ts`). Cambia un solo campo:

```json
{ "head": "<40-hex sha: git rev-parse HEAD at the end>" }
```

`REQUIRED_IMPL_KEYS` = el conjunto que ya exige `subagent-stop-handoff.sh` (`feature`, `status`,
`worktree`, `branch`, `commits`, `filesTouched`, `verification`, `markdownRequests`). `head` es
esperado (se reporta como warning si falta), no requerido. `acceptance` (spec 0032) sigue siendo
opcional.

**`navori handoff check <feature> [--for scribe] [--dir <progress dir>] [--cwd <checkout>] [--json]`**

```json
{
  "formatVersion": 1,
  "feature": "<f>",
  "consumer": "orchestrator | scribe",
  "status": "ok | findings | error",
  "failures": [{ "check": "exists | parse | feature | worktree | branch | path", "detail": "string" }],
  "warnings": [{ "check": "head | legacy-md", "detail": "string" }],
  "worktree": "<realpath registrado, o null>",
  "branch": "<rama registrada, o null>"
}
```

Exit 0 = `ok`; 2 = `findings`; 1 = `error` (un fallo de git o de I/O, nunca de validación).
Los assets solo avanzan con `"status":"ok"`, igual que con el receipt.

**Registro de controles** (`engine-capabilities.ts`):

```ts
type ControlId = "plan-gate" | "markdown-ownership" | "handoff-shape" | "handoff-consumer"
  | "analytic-write-tools" | "local-skill-discovery";
type RenderEvidence =
  | { kind: "hook"; script: string; event: "PreToolUse" | "PostToolUse" | "SessionStart"; matcher: string }
  | { kind: "native-skill-root" }
  | { kind: "local-skill-pointer" };
type ControlDeclaration =
  | { state: "enforced"; reason: string; evidence: RenderEvidence }
  | { state: "advisory"; reason: string; evidence?: RenderEvidence }  // p. ej. un hook advisory registrado
  | { state: "unsupported"; reason: string };
interface ControlDefinition { description: string; condition?: "planTiers" | "scribeOwnsMarkdown" | "localSkills"; hookScripts: readonly string[] }
```

**Puntero de skill local** (`.agents/skills/<id>/SKILL.md`):

```markdown
---
name: <id>
description: "<description de la fuente, sanitizada, entre comillas JSON>"
---
<!-- navori:managed id="<id>-local-pointer" … -->
Project-local skill, maintained in `.claude/skills/<id>/SKILL.md` (relative to the directory that
holds `.agents/`). Read that file before acting; its supporting files resolve relative to its
directory. This entry only makes it discoverable here.
<!-- /navori:managed id="<id>-local-pointer" -->
```

## Failure modes

**F03 — área crítica: writes y deletes en `.agents/skills/`.**

- **Destino escrito a mano** (el usuario copió la skill a `.agents/skills/<id>/`). Si se emitiera
  el request, `renderManagedFile` (camino 4b, rama "no match" de `injectManagedSection`) mezclaría
  el frontmatter y agregaría el bloque al final de un archivo del usuario. Mitigación:
  - `classifyLocalSkills` lo clasifica `foreign` con `navoriAuthorship`, y el adapter no emite el
    request.
  - El id entra en `desired` (`emit ∪ foreign`), así que `collectOrphans` no lo poda ni lo reporta
    como huérfano (R12).
  - El aviso **no** puede salir del pipeline: sin request no hay `skipped`, y con el id en
    `desired` no hay `kept`. Por eso lo emite `commands/render.ts` desde el mismo conjunto
    `foreign`, en su `warnings: string[]`, y `doctor` repite el diagnóstico.
  - Una sola función clasifica; tres consumidores (adapter, render, doctor) leen su resultado. No
    hay dos criterios de "foráneo" que puedan divergir.
- **Puntero editado a mano dentro del bloque.** Lo cubre `user-modified-skipped`, sin cambios.
- **Puntero escrito por un navori más nuevo.** Lo cubre el anti-rollback (`newer`, `KeepReason`),
  sin cambios.
- **Id que deja de declararse** (R12). Sale de `desired`; `collectOrphans` lo encuentra como
  `skill-dir` con marcador propio y lo poda. `commitWrites` lo respalda antes (backup proporcional,
  #405). Si el directorio tiene otros archivos aparte de `SKILL.md` (por ejemplo, el sidecar
  `openai.yaml`), rige la regla existente: se borra solo `SKILL.md`, y el sidecar lo poda su propio
  escaneo `skill-nested-file`.
- **Fuente borrada con el id todavía declarado.** El id queda en `missing`: `render` y `doctor` lo
  nombran (doctor sugiere mover la skill a `.claude/skills/<id>/`), el puntero no se genera y el
  previo se poda con backup, porque `missing` no entra en `desired`. Nunca queda un puntero a la
  nada (R11).
- **Codex no sigue la redirección** (contrato `codex-skill-body-redirect` sin verificar). Lo detecta
  la sonda manual al inicio del lote C, antes de escribir el adapter. Si falla, se usa el fallback
  de D2. Después del lote C, una regresión del host no la ve CI; el contrato lo admite en
  `enforcedBy`.
- **Autorreferencia.** Si el cuerpo del puntero pasara por `adaptHarnessTextForCodex`, la regex de
  `.claude/skills/<id>/SKILL.md` lo reescribiría a `.agents/skills/<id>/SKILL.md`, es decir, a sí
  mismo. Por eso el puntero se emite como `body` ya serializado, sin `transform`. Un test lo fija.
- **Description hostil o que rompe el YAML.** Se aplica `sanitizeProjectValue` (sin `<!--`/`-->`
  ni saltos de línea) y se escribe como string JSON, que es YAML válido. Sin `description`, el
  puntero usa un texto fijo que nombra la ruta. `doctor` ya avisa de la falta de trigger
  (`scanTriggerlessLocalSkills`).
- **Render de workspace (monorepo).** El puntero se resuelve contra `ctx.cwd`, el mismo directorio
  que contiene `.agents/` y `.claude/` del workspace. El cuerpo dice que la ruta es relativa a ese
  directorio.
- **Falla de escritura a medio render.** Ya la cubren `commitWrites` (escritura atómica, un solo
  try) y `RenderWriteError` con la ruta del backup.

**Receipt.**

- **`git fetch` falla.** `inspect` ya devuelve `error` (exit 1) y el publisher se detiene. El
  cierre, en ese caso, corre el gate.
- **Receipt v1 en vuelo al actualizar navori.** Da `stale:["format"]`: el publisher corre el full
  gate, pero no pide re-review, porque el drift sigue verificándose con las líneas v1.
- **Un receipt consumido autoriza un commit nuevo.** Imposible por construcción: el flag solo
  aparece en `cierre-sesion`, y `receipt-wiring.test.ts` verifica que `publisher.md` y `reviewer.md`
  no lo contengan.
- **Gate no determinista** (flaky). No lo detecta la identidad. Queda fuera: la identidad prueba
  que es "el mismo gate sobre los mismos bytes", no que el gate sea confiable.

**Handoff.**

- **Worktree reclamado** (`worktree-reclaim.sh`) o movido. `failures[worktree]` con el detalle;
  el scribe reporta `BLOCKED` sin escribir nada.
- **Trabajo en paralelo.** El nombre del archivo y el campo `feature` ligan cada consulta a un solo
  feature. Un reporte en vuelo de otro feature no se lee (R15). El hook advisory mantiene su
  falso positivo conocido, que ya está documentado.
- **`navori` ausente o sin el subcomando** (build viejo). El comando no existe, la salida no es
  `"status":"ok"` y el asset no avanza. Falla cerrado, igual que con `receipt`.

**Inventario.**

- **El registro se desincroniza del render.** Lo atrapa `control-inventory.test.ts` (R22) en el
  gate.
- **Ruido en doctor.** Lo mitiga la severidad agrupada de D5.

**Presupuestos de palabras.** `verify-before-done`, `solution-design`, `reviewer`, `publisher` y
`orquestacion` ya están en su techo o cerca de él (se mide con `check:doc-budgets` antes de cada
lote). Regla: la sección "Failure attribution" reemplaza a "Baseline attribution" y a la fila de la
tabla; la vigencia reemplaza la prosa de "this turn" y de "Re-run by hand". Subir `maxWords` solo
se autoriza en `solution-design`, en la cantidad exacta que agregue el fallback de R19 y con la
razón comentada en su frontmatter, como ya lo hace ese archivo.

## Migration

- **Receipts v1.** No se migran: son artefactos de un solo ciclo. `check` los trata como vencidos
  (`format`), y eso cuesta una corrida del gate en el ciclo que cruza la actualización.
- **`receipt.txt` → `receipt.consumed.txt`.** Es aditivo. Un `receipt.consumed.txt` que quede de
  un ciclo anterior se sobrescribe en el siguiente consumo. `progress/` ya está fuera del backup
  (`EPHEMERAL_HARNESS_PATHS`) y del receipt (`PROGRESS_DIRS`).
- **`impl_<feature>.json` sin `head`.** Es válido con warning, así que ningún handoff en vuelo
  rompe la cadena. El hook advisory no cambia su lista.
- **`scanPlanTiersGateSupport` y `planTiersGateDegraded`.** Se eliminan junto con sus strings de
  i18n (es y en). La salida de doctor cambia de forma, no de contenido: la fila `codex · plan-gate
  · advisory` sustituye el aviso anterior.
- **Repos ya renderizados con copias manuales en `.agents/skills/`.** Se conservan (`foreign`) con
  un aviso. El usuario decide cuándo borrarlas para recibir el puntero.
- **Este repo.** Hoy `.agents/skills/` no tiene ninguna de las cuatro skills locales, así que no
  hay conflicto. El primer `render --apply` después del lote C crea los cuatro punteros.

## Testing strategy

Cada test responde a un riesgo nombrado arriba y cita los `R<n>` que cubre.

| Riesgo | Test | Cubre |
|---|---|---|
| Una falla se etiqueta por su ubicación en el diff | `lib/__tests__/failure-attribution.test.ts`: `verify-before-done` contiene los tres estados literales y el método (misma ejecución sobre base y cambio, sin `git stash`); **ningún** asset renderizable (`agents`, `skills`, `managed`, `lib-skills`, `presets`, skills de plugins) coincide con los patrones prohibidos (`predates you`, "outside … list/diff … pre-existing", "Diff file → introduced"). Fixtures de texto: regresión en un consumidor no editado, falla preexistente en un archivo editado y ausencia de baseline; ninguno puede quedar clasificado como "demostrado" con evidencia de ubicación sola | R1, R2, R3, R4 |
| La vigencia no detecta un cambio de árbol, comando o input | `lib/diagnose/__tests__/receipt.test.ts` (repo git temporal, como hoy): firmar y verificar sin cambios da `fresh:true`; cambiar un archivo da drift; rebasar sobre una base nueva sin cambiar los archivos del diff sigue dando `fresh:true`, con la base nueva visible en la cabecera; cambiar `qualityGate.full` da `["gate"]`; cambiar el lockfile da `["inputs"]`; una cabecera v1 da `["format"]`; `status` y el exit code quedan iguales en los casos stale | R5, R7 |
| Un receipt consumido autoriza un commit, o el cierre no lo encuentra | mismo archivo: `--include-consumed` lee `receipt.consumed.txt` solo si no hay `receipt.txt` y marca `consumed:true`; sin el flag, un consumido cuenta como ausente | R6 |
| La prosa de los consumidores se contradice | `lib/__tests__/receipt-wiring.test.ts` (extendido): `publisher.md` exige `"fresh":true` o corre el gate y no contiene `--include-consumed`; `cierre-sesion.md` usa `--include-consumed` y ya no dice "cite this cycle's green run"; `verify-before-done.md` define la vigencia y los demás la citan sin redefinirla; `reviewer.md` y `implementer.md` no usan "this turn" como criterio de vigencia del gate | R6, R8 |
| La skill local no es descubrible en Codex | Sonda manual del lote C (resultado en `host-contracts.ts`, contrato `codex-skill-body-redirect`) + `engines/codex/__tests__/local-skills.test.ts`: con `localSkills` y la fuente en disco, el render crea `.agents/skills/<id>/SKILL.md` con el `name` y la `description` de la fuente y un cuerpo que remite a `.claude/skills/<id>/SKILL.md` (no a sí mismo); `disable-model-invocation` produce el sidecar | R9 |
| navori modifica la fuente, o el cambio en la fuente no se detecta | mismo archivo: los bytes de `.claude/skills/<id>/` quedan idénticos después de `--apply`; cambiar la `description` de la fuente hace que el preview reporte `updated` en el puntero; cambiar solo el cuerpo no | R10 |
| Se inventa un destino para un id faltante | mismo archivo + tests de `doctor`: un id declarado sin fuente no genera puntero, poda el previo y aparece en el aviso de `render` y en `doctor` (con la sugerencia de moverla a `.claude/skills/<id>/`) | R11 |
| La poda borra o reporta el destino de una skill declarada, o no poda uno retirado | mismo archivo: el puntero de un id declarado no aparece en `kept` ni en `removals`; al quitar el id se poda con backup (`backupPath` no nulo, el archivo está en el snapshot) | R12 |
| Un destino foráneo se modifica, se poda o no se avisa | `engines/codex/__tests__/local-skill-pointer.test.ts` (unidad de `classifyLocalSkills`: los tres conjuntos son disjuntos, un id del plan no cae en ninguno) + `commands/__tests__/render-local-skills.test.ts`: con un `.agents/skills/<id>/SKILL.md` escrito a mano, después de `render --apply` el archivo queda **byte-idéntico**, no aparece en `kept` ni en `removals`, y los `warnings` del render contienen exactamente el aviso de `foreign` con esa ruta; `doctor` reporta la misma ruta | R12 |
| Un handoff sin identidad, o de otro feature, pasa | `lib/handoff/__tests__/check.test.ts`: casos de ausente, JSON inválido y `feature` distinto (los tres fallan y nombran la comprobación); un `impl_<otro>.json` válido no satisface `check <feature>`; falta de `head` da warning y `ok` | R13, R14, R15 |
| El scribe escribe en el checkout, la rama o el path equivocados | mismo archivo, con repo y worktree temporales: `--cwd` en otro checkout falla `worktree`; otra rama falla `branch`; paths absolutos, con `..`, con symlink que escapa, bajo `progress/` o con otra extensión fallan `path`; todo correcto da `ok` | R16 |
| La validación depende de un hook de Claude | `lib/__tests__/handoff-wiring.test.ts`: `orquestacion.md` (que se renderiza en `AGENTS.md` para Codex) y `scribe.md` invocan `navori handoff check` con `--json` y avanzan solo con `"status":"ok"`; el render de Codex del bloque conserva el comando con `--dir .codex/progress`; `settings-base.json` permite `Bash(navori handoff check:*)`; paridad entre la lista `required` de `subagent-stop-handoff.sh` y `REQUIRED_IMPL_KEYS`; el hook sigue sin `decision: block` | R17 |
| Un asset afirma contra `origin/main` fijo o sin fallback | `lib/__tests__/branch-base-assets.test.ts`: `architect`, `solution-design` y `scoped-gate` no contienen `origin/main` literal; renderizados con `branchBase: "develop"` contienen `origin/develop`; el snippet de `scoped-gate` ejecutado en un repo temporal sin remoto usa la ref local y lo dice en stderr, y sin ninguna ref sale distinto de cero | R18, R19 |
| El registro está incompleto o con razones vacías | `engines/shared/__tests__/engine-capabilities.test.ts` (extendido): cada engine declara cada `ControlId` con una razón no vacía, y `enforced` sin `evidence` no compila (`@ts-expect-error`) | R20 |
| Doctor no lista los controles o duplica el aviso de `planTiers` | `lib/diagnose/__tests__/control-gaps.test.ts` (migra `gate-support.test.ts`, conserva la cita a la spec 0032 R17): con `planTiers` en `true` y codex configurado, `plan-gate` sale como `advisory` y como `warn`; con el flag apagado, no sale; en un repo solo-Claude salen las filas `advisory` como `info`; no queda otra ruta que emita `planTiersGateDegraded` | R21 |
| El estado declarado no coincide con el render | `engines/__tests__/control-inventory.test.ts`: renderiza los cinco engines en un directorio temporal con todos los flags encendidos y una skill local. Para cada engine × control: `enforced` ⇒ la evidencia existe (hook registrado en `.claude/settings.json` o en `.codex/config.toml` con el evento y el matcher; puntero presente); `unsupported` ⇒ ningún `hookScripts` del control está registrado; `advisory` con evidencia de hook ⇒ el hook está registrado. Con los flags apagados, los hooks condicionados no se registran | R22 |
| Las tools de escritura declaradas no son las efectivas | mismo archivo: para `auditor`, `scout`, `reviewer` y `architect`, la intersección del `tools:` de `.claude/agents/<id>.md` con `WRITE_CAPABLE_TOOLS`, y el `sandbox_mode` efectivo de `.codex/agents/<id>.toml`, son iguales a `analyticWriteTools`; en los engines de prosa, `[]` | R23 |

Además: golden snapshots de Codex (`engines/__tests__/__golden__/codex.snap`) si su config de
fixture declara skills locales, y `bun check:render` en este repo después de cada lote.

## NOT in scope

- **Endurecer `subagent-stop-handoff.sh`.** Es una restricción heredada: su matching sigue siendo
  heurístico.
- **Lograr `enforced` para `handoff-consumer` en Claude** con un chequeo en el despacho del
  `scribe`/`reviewer` dentro de `plan-gate`. Es una extensión barata: el hook ya intercepta `Agent`
  y la spec 0032 fija el precedente de `workplan: <feature>` en la primera línea. Pero toca hooks
  (área crítica) y rompería la simetría que pide R17. Queda para un issue posterior, cuando haya
  datos de uso del comando.
- **Entorno como input de la evidencia** (versión del runtime, variables de entorno). R5 limita
  los inputs al lockfile y la configuración del gate. La auditoría menciona el entorno, pero
  registrarlo exige decidir qué entra, y eso abre más discusión que valor.
- **Validar `--feature` en `navori receipt check`.** Hoy `readReceipt` ignora la cabecera, así que
  `feature=` es cosmético. R5 define la vigencia como árbol + comando + inputs, y con esa identidad
  la garantía ya está completa: un feature mal escrito no hace pasar bytes que no se revisaron.
  Ligar el receipt a un feature (por ejemplo, un receipt por feature) cambia el contrato de
  publicación y merece su propia spec.
- **Cambiar privilegios de los roles analíticos** (F08). R23 solo los declara.
- **`origin/main` en `presets/monorepo-turbopnpm/skills/turbo-workspaces.md`** (filtro de turbo).
  No está en la lista de R18. Ver Observaciones.
- **Adaptar al vocabulario de Codex el contenido de las skills locales** (rutas `.claude/…` dentro
  de su prosa). Es contenido del usuario, y navori no lo reescribe.
- **F07 y las oportunidades condicionadas de la auditoría**, por decisión del usuario en
  requirements.

## Decisiones del usuario (2026-09-24)

- **`harness.scribeOwnsMarkdown: false`:** R14 valida `impl_<feature>.md` (existe, no está vacío,
  tiene `Status:`), ligado al feature solo por el nombre del archivo. R16 no aplica: no hay
  `markdownRequests`. Es lo que implementa D3 y lo que fija R24.
- **Fuente única de skills locales:** `.claude/skills/<id>/` lo es también en repos solo-Codex.
  Una skill escrita directamente en `.agents/skills/<id>/` se nombra como faltante (`missing`, R11)
  y además como destino foráneo (`foreign`, R12). `doctor` sugiere moverla a `.claude/skills/<id>/`.
- **Rebase sin cambios propios ⇒ evidencia vigente:** el publisher confía en el gate del
  reviewer mientras los archivos del diff sean idénticos a los aprobados. Las roturas por
  combinación con el `main` nuevo quedan para el CI del PR. Ver D1.

## Observaciones a los requisitos

Aplicadas por el orquestador en `requirements.md` (R4, R10, R13, R18).
