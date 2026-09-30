# Aprendizajes del curso de harness engineering — Design

**Estado:** diseño revisado tras challenge; veredicto del orchestrator aplicado
(`.navori/state/handoffs/challenge_0038.md`). No autoriza implementación.
**Señales:** contrato compartido (schema del workplan, handoff del implementer, formato del
reviewer), área crítica (hooks nuevos en `PostToolUse`/`PostToolUseFailure`, escrituras en
`.navori/state/`), migración de workplans existentes.
**Base inspeccionada:** `cb32c6c5b309d0a9fe71584aa3748fcb5db03843`. `git fetch origin main` el
2026-09-30 dio `origin/main` = `01f3ac97`; el diff `cb32c6c5..01f3ac97` (#1124, #1126) no toca
ninguna ancla citada. Anclas = archivo + símbolo/encabezado. Rutas `commands/`, `lib/` y
`engines/` son relativas a `packages/cli/src/`; `core-assets/` a `packages/core/`.

## Approach

navori no ejecuta ningún comando de criterio (R4, invariante 9 intacto). El host ejecuta el
comando del `A<n>` en su Bash tool, bajo sus propios hooks y permisos. Un hook de navori solo
**registra** que el comando terminó con éxito y en qué estado del árbol. `navori plan update` solo
**compara** esa evidencia con el criterio actual y con el estado actual de ese árbol. El resto se
mantiene de la primera versión: el aviso de atasco comparte el mismo hook, V son campos opcionales
más prosa medida, P es un sidecar más un subcomando, y U es una sección del reporte de rango de
`navori audit`.

### Decision drivers

- `docs/DIRECTION.md` — invariante 9 y `No-metas` ("Que navori ejecute las herramientas del
  agente"): cero ejecución desde la CLI o desde hooks; sin enmienda a DIRECTION.
- `docs/DIRECTION.md` — `Criterio de admisión por superficie`: flags y subcomandos en comandos
  existentes; ningún bloque always-on nuevo.
- `docs/DIRECTION.md` — `Metas` (calidad > tokens > velocidad) y la nota de costo de
  `core-assets/hooks/routing-watch.sh` (un hook `PostToolUse` paga en cada llamada Bash): **un**
  hook por llamada Bash, con presupuesto de procesos explícito.
- `docs/DIRECTION.md` — invariantes 4, 5 y 7, y `Estado del harness`: registros nuevos por el spine
  de render; estado efímero bajo `.navori/state/`.
- `CLAUDE.md` — `Contexto del proyecto` (áreas críticas: hooks, escrituras en el repo del usuario):
  los hooks nuevos son fail-open y no bloquean; el único rechazo nuevo es el de `plan update`.
- `engines/codex/hook-registrations.ts` — `ORDER IS PART OF THE CONTRACT`: ninguna fila nueva
  mueve un `trusted_hash`.

### Qué ya existe (verificado en la base y en `origin/main`)

| Dueño / ancla | Qué resuelve hoy | Brecha |
|---|---|---|
| `lib/plan/schema.ts` — `AcceptanceCriterionSchema`, `WorkplanSchema.progress` | `command` + `expected`; estado sin evidencia | G |
| `commands/plan.ts` — `updateSubCommand`, `writeWorkplanAndRender`; `lib/plan/render.ts` — `applyWorkplanUpdate` | Transición todo-o-nada con escritura atómica | Acepta lo que el agente declara |
| `core-assets/agents/implementer.md` — encargo `workplan:` | El implementer ya corre cada `A<n>` asignado en su worktree | Reporta en prosa: `impl_1114.json.acceptance` trae comandos abreviados ("vitest render-managed-file + …") |
| `lib/plan/gate.ts` — `recordAndCountRejections` | Log de solo-anexar por feature (`workplan_<feature>.gate.jsonl`) con dedupe por hash | Precedente de ubicación y dedupe |
| `core-assets/hooks/routing-watch.sh` | Patrón advisory: `additionalContext`, stamp por sesión, guarda de symlinks, barrido de 7 días, fail-open | Sin evidencia ni memoria de fallos |
| `lib/audit/signals.ts` — `rework` | Repeticiones post-hoc; su docblock mide 3+ repeticiones en 2 de 97 sesiones | Solo post-hoc |
| `lib/handoff/schema.ts` — `ImplHandoffSchema` (`.passthrough()`, `worktree`) | Handoff validado; el implementer declara su worktree | Sin `doubts` |
| `lib/audit/report.ts` — `tallySkills`, `skillRangeSection`, `buildReport` | Uso de skills por sesión en el rango, con ceros | Agentes: `byAgentType` cuenta corridas y omite los declarados sin uso |
| `engines/shared/engine-capabilities.ts` — `CONTROL_DEFINITIONS`; `lib/diagnose/control-gaps.ts` — `scanControlGaps` | Doctor lista todo control no `enforced` por engine | Faltan los dos controles nuevos |
| `engines/shared/gitignore-harness.ts` — `CUBO_A_ENTRIES` | Ignora `.navori/state/` si `gitignoreHarness` ≠ `"off"` | El default del schema es `"off"`; ver Failure modes |

### Escalera de opciones para G

1. **Solo prosa** ("corre el comando y repórtalo"). Es lo que existe y produce la evidencia
   abreviada de `impl_1114`. Descartada.
2. **Hook que registra lo que el host ejecutó + `plan update` que compara — recomendada.** No
   ejecuta nada. El comando pasa por guard, `ask`/`deny` y gates del host de forma nativa. Cuesta
   una llamada de hook por Bash, acotada abajo.
3. **`plan update` ejecuta el comando** (versión anterior). Descartada por el challenge: rompe el
   invariante 9. La política se resolvía bajo un root elegible por el agente (B1). Un tercer
   splitter era más débil que `gate-trigger` (B2). Y el contrato `ask` de los hooks quedaba sin
   modelar (B3).

### Alcance por bloque

| Bloque | Decisión |
|---|---|
| G (R1–R6b) | Implementar; núcleo |
| V (R11–R13) | Implementar |
| S (R7–R10) | Implementar en el mismo hook que G. U1 quedó verificado en la doc oficial (ver § Verificaciones), así que no se activa el diferimiento de requirements.md |
| P | R14 sí; R15 diferido (NOT in scope) |
| U | R16 (agentes) y R17 como extensión del reporte de rango |

## Components

| Componente / ancla | Cambio | Requisitos |
|---|---|---|
| `core-assets/hooks/bash-outcome-watch.sh` (nuevo) + fila en `engines/shared/harness-plan.ts` | Un script, dos carriles: evidencia y reset en `PostToolUse(Bash)`, conteo de atasco en `PostToolUseFailure(Bash)` | R1, R7, R8, R9 |
| `engines/claude/build-settings.ts` | Grupo `PostToolUse` matcher `Bash`, anexado tras los existentes; grupo `PostToolUseFailure` matcher `Bash`. Ambos timeout 10. No se inyectan en coexist, igual que `routing-watch` | R1, R7 |
| `lib/plan/acceptance-index.ts` (nuevo); `commands/plan.ts` — `writeWorkplanAndRender` | Reescribe `acceptance-index` cada vez que la CLI escribe un workplan | R1 |
| `lib/plan/evidence.ts` (nuevo) | Lee `workplan_<feature>.evidence.jsonl`, valida candidatos y recalcula la huella del árbol | R2 |
| `commands/plan.ts` — `updateSubCommand` | Gate de evidencia, regla de engine (R5), ERROR/WHY/FIX; ninguna ejecución de `command` | R2, R3, R4, R5 |
| `lib/plan/schema.ts` — `WorkplanSchema` | `evidence` opcional por `A<n>` | R2, R5, R6 |
| `lib/plan/render.ts` — `renderAcceptance`; `lib/plan/check.ts` — `CheckResult`, `formatCheckResult` | Casos con/sin evidencia; `warnings` aditivos, `ok` intacto | R6 |
| `core-assets/agents/reviewer.md` — `Pass 1` (bullet `navori:if planTiers`) | Correr `navori plan check <feature> --json` y reportar cada `cumplido` sin evidencia | R6b |
| `core-assets/skills/plan-simple.md`, `plan-advanced.md`; `core-assets/agents/implementer.md` — encargo `workplan:` | Correr cada `A<n>` **textual** desde la raíz del árbol; luego `plan update` | R1, R2 |
| `engines/shared/engine-capabilities.ts` — `ControlId`, `CONTROL_DEFINITIONS`, `ENGINE_CAPABILITIES`; `engines/codex/hook-registrations.ts` — fila `unsupported` al final | Controles `acceptance-evidence` y `repeat-failure-advice`; doctor vía `scanControlGaps` | R5, R10 |
| `lib/handoff/schema.ts` — `ImplHandoffSchema`; `implementer.md` — `Closing report` | `doubts` opcional | R11 |
| `reviewer.md` — `Setup`, `Verdict format` | Responder dudas; tabla `Coverage` en `APPROVED`; sidecar + `log-review` | R12, R13, R14 |
| `lib/handoff/review-schema.ts` (nuevo); `commands/handoff.ts` — subcomando `log-review`; `core-assets/settings/settings-base.json` — allow `Bash(navori handoff log-review:*)` | Valida el sidecar y anexa hallazgos ≥ 50 | R14 |
| `lib/audit/report.ts` — `buildReport`, `skillRangeSection`, `agentRangeSection` (nueva); `lib/audit/harness.ts` — `DeclaredAgent` | Agentes por sesión con ceros; `managed`; línea de candidatos con N sesiones | R16, R17 |

## Decisions

### D1 — La evidencia la produce el host; el hook la registra (R1, R4)

**Qué cuenta como éxito.** En Claude Code, `PostToolUse` "fires only on tool success"; con exit
≠ 0 dispara `PostToolUseFailure` en su lugar
([hooks](https://code.claude.com/docs/en/hooks), tabla de eventos y § PostToolUseFailure,
consultado 2026-09-30). El payload de Bash no trae exit code (`tool_response`: `stdout`,
`stderr`, `interrupted`, `isImage`). La señal de éxito es el evento mismo. Con
`tool_response.interrupted: true` no se registra.

**Cómo encuentra el hook los criterios sin parsear workplans en cada Bash.** La CLI mantiene
`acceptance-index` en `<CLAUDE_PROJECT_DIR>/.navori/state/handoffs/`. Se reescribe entero en cada
escritura de workplan (`render`, `update`) a partir de los `workplan_*.json` con algún `A<n>` no
`cumplido`. Cada línea es `<command JSON-escapado>\t<feature>\t<A<n>>\t<dir de estado absoluto>`.
El hook usa `CLAUDE_PROJECT_DIR`, que según la doc "stays put" en la raíz donde empezó la sesión
aunque Claude entre a un worktree. Es el mismo directorio donde el orchestrator corre `plan update`
y resuelve `resolveStateRoot`, así que no hacen falta forks para ubicarlo. Se descartó resolver el
checkout principal con `git rev-parse --git-common-dir`: cuesta un fork por llamada Bash y daría
otra raíz si la sesión empezó dentro de un worktree.

**Carril de evidencia (en `PostToolUse`):**

1. Ruta rápida sin forks adicionales a la lectura de stdin: si `acceptance-index` no existe o está
   vacío, pasa al carril de reset. Si ninguna línea del índice aparece como substring del payload
   crudo (`case` de bash, sobre el comando JSON-escapado), también.
2. Candidato: se extrae `tool_input.command` y se compara **igualdad exacta** con el del índice.
   Sin normalizar espacios: el FIX de R3 da el comando exacto a copiar.
3. Árbol: `tree = git -C <payload.cwd> rev-parse --show-toplevel`. Si `payload.cwd ≠ tree` se
   registra igual (con `cwd`), y `plan update` lo rechaza con un FIX explícito, porque los
   criterios se escriben relativos a la raíz (`cd packages/cli && …`).
4. Huella del árbol (`worktreeTree`): copia del índice de git del árbol a un temporal,
   `GIT_INDEX_FILE=<tmp> git add -A -- . ':(exclude).navori/state' ':(exclude).claude/progress'
   ':(exclude).codex/progress' ':(exclude).claude/worktrees'`, luego `git write-tree`. Resultado:
   el hash del contenido completo del árbol, incluidos cambios sin commit y archivos no ignorados
   nuevos. Las exclusiones evitan que el propio log o los stamps cambien la huella. Efecto lateral
   declarado: escribe objetos sueltos en el object store de ese repo (los recoge `git gc`); no toca
   índice, refs ni working tree.
5. Anexa una línea a `<dir de estado>/workplan_<feature>.evidence.jsonl`, junto al workplan, como
   `workplan_<feature>.gate.jsonl`. Si el mismo comando aparece en varios workplans activos
   (`bun check` está en casi todos), anexa en cada uno: la atadura a la feature la hace
   `plan update` (D2), no el hook.

**R4 como propiedad verificable:** ni `plan update` ni el hook spawnean el `command`. Lo fija un
test con un comando centinela (D-Testing).

### D2 — `plan update` compara, no ejecuta (R2, R3)

Para `--progress A<n>=cumplido`, candidatos = líneas del evidence log con ese `id` y `command`
igual al `command` **actual** del criterio, de la más nueva a la más vieja. La primera que cumpla
todo se acepta:

- `tree` (realpath) es la raíz del checkout del workplan o el `worktree` (realpath) de
  `impl_<feature>.json`. Esto ata la evidencia a la feature: un `bun check` corrido en el worktree
  de otra feature no sirve.
- `tree` existe y `git -C tree rev-parse HEAD` = `head` registrado ("HEAD actual del árbol donde
  corrió", R2).
- La huella recalculada con el mismo procedimiento que D1 paso 4 = `worktreeTree` registrado. Sin
  esto, un cambio sin commit posterior a la corrida pasaría con el mismo HEAD. En el harness el
  diff suele estar sin commit (`reviewer.md` — `Setup`, comentario del diff de dos puntos).
- `cwd` = `tree`.

Aceptada: se copia a `workplan.evidence[A<n>]` y se escribe como hoy (todo-o-nada con varios
`--progress`). Si no hay candidato válido, se rechaza sin escribir (R3):

```
ERROR: A2 not marked cumplido — no valid evidence
WHY:   <no run recorded | recorded for a different command | tree changed since the run (HEAD abc1234 → def5678 | uncommitted changes) | ran in <tree>, not this feature's checkout/worktree | ran from <cwd>, not the tree root | acceptance-index stale>
FIX:   from <tree root>, run exactly:
         cd packages/cli && bun run test -- src/lib/plan/__tests__/check.test.ts
       then: navori plan update <feature> --progress A2=cumplido
       (index stale → run `navori plan render <feature>` first)
```

Con `--json`: `{ updated: false, id, error: { what, why, fix, command } }`.

Consecuencia deseada: un commit posterior (por ejemplo el del scribe) invalida la evidencia. Hay
que volver a correr el criterio sobre el árbol final.

### D3 — Engines sin señal de éxito (R5)

`plan update` exige evidencia solo si `CLAUDE_CODE_CHILD_SESSION=1` y `claude` ∈
`config.engines`. Según la doc, esa variable la pone Claude Code en los subprocesos del Bash tool y
de los hooks, y no la ponen las terminales de IDE
([env-vars](https://code.claude.com/docs/en/env-vars), consultado 2026-09-30). Se prefirió sobre
`CLAUDECODE`, que las extensiones de IDE sí ponen en la terminal de un humano. En cualquier otro
caso (Codex, terminal humana, engines prosa), `cumplido` se acepta y se escribe
`evidence[A<n>] = { kind: "unevidenced", reason: "engine-without-signal" }`, con un `WARNING` en
stderr.

Codex no tiene señal: `PostToolUse` también dispara con exit ≠ 0, y no hay verificación de un exit
code en `tool_response` (U2). Control `acceptance-evidence`: Claude `advisory` (evidencia de hook
`PostToolUse`/`Bash`), Codex y prosa `unsupported` con razón. `scanControlGaps` lo lleva a doctor.
Se declara `advisory` y no `enforced` por honestidad (D5).

### D4 — Distinción en check, render y reviewer (R6, R6b)

| Caso | Render | `plan check` (warning, `ok` intacto) | Reviewer Pass 1 (R6b) |
|---|---|---|---|
| Evidencia registrada con `command` = actual | `(cumplido · <head7> · <ranAt>)` | — | — |
| `kind: unevidenced` (R5) | `(cumplido, sin evidencia: engine sin señal)` | `progress-unevidenced-accepted` | Hallazgo listado, no bloqueante |
| `cumplido` sin entrada (previo a la spec o escrito a mano) | `(cumplido, sin evidencia)` | `progress-unevidenced` | `SPEC_MISS` (bloquea) |
| Evidencia de otro `command` | `(cumplido, evidencia de otro comando)` | `progress-evidence-stale` | `SPEC_MISS` |

El bullet `With a workplan:` de `reviewer.md` (dentro de `navori:if planTiers`) pasa a exigir
`navori plan check <feature> --json`, ya en allow, y aplicar esta tabla. `lib/plan/gate.ts` —
`evaluateWorkplan` sigue dependiendo de `ok`, así que plan-gate no empieza a denegar workplans
viejos.

### D5 — Honestidad del mecanismo

El workplan, el evidence log y el índice están en disco y el agente puede escribirlos con
Write/Edit. Un agente puede fabricar una línea de evidencia o correr
`env -u CLAUDE_CODE_CHILD_SESSION navori plan update …`. D2 hace costosa la fabricación torpe:
la huella del árbol no se inventa sin computarla, y el `WARNING` de R5 queda en el transcript.
Pero no es una frontera de seguridad. Frena al agente sobreconfiado, no al adversario. R6b hace
visible el camino R5 en cada review.

### D6 — Atasco: segundo carril del mismo hook (R7, R8, R9)

U1 está verificado: el ejemplo oficial de `PostToolUseFailure` trae
`"error": "Exit code 1\nError: Cannot find module 'express'"` (salida incluida). La doc advierte
"The format depends on the tool that failed", así que se agrega un fixture de ese ejemplo y una
captura live recomendada antes de fusionar.

- **Clave:** hash de `tool_input.command` (sin espacios de borde, internos colapsados) + hash de
  `payload.cwd` + `agent_id` si está presente. La doc lo define como "Present only when the hook
  fires inside a subagent call", y § subagentes dice que los tool events de subagentes lo traen.
  El encabezado de `routing-watch.sh` ("carries NO agent identifier") contradice la doc vigente y
  queda desactualizado (ver Durable knowledge). Así, dos implementers en worktrees distintos o en
  paralelo no suman fallos entre sí.
- **Firma:** exit code extraído de `error` (`exit code (\d+)`, sin mayúsculas) + hash del cuerpo
  normalizado. El cuerpo sin la línea del exit code y sin ANSI; timestamps ISO-8601 y
  `HH:MM:SS(.fff)` → `<t>`, duraciones → `<d>`, hex de 8 o más → `<h>`, raíz del árbol → `<root>`,
  `$HOME` → `~`, rutas temporales → `<tmp>`; últimas 20 líneas no vacías. Números de línea y
  nombres de test se conservan.
- **No cuenta:** `is_interrupt: true`, ni un cuerpo vacío tras normalizar (firma demasiado gruesa).
- **Consecutivo:** corridas consecutivas de esa clave. Ediciones intermedias no reinician.
  Reinicia un éxito de la misma clave (carril de reset en `PostToolUse`) o una firma distinta.
- **Fase roja de TDD, decidido:** correr el mismo test 3 veces con la *misma* salida normalizada
  significa que los cambios intermedios no movieron el fallo. Escribir tests nuevos o avanzar la
  implementación cambia la lista de fallos, y con ella la firma. El falso positivo que queda es
  "rojo intencional repetido sin cambios", que se acepta. El aviso lo dice: "si el rojo es
  intencional, ignora esta nota". No se sube el umbral para comandos de test.
- **Aviso:** al llegar a 3, un `additionalContext` de hasta 400 caracteres con el comando
  truncado, el exit code, la primera línea normalizada y la sugerencia de cambiar de enfoque
  (`debug-failure`) o escalar al usuario. Una vez por (clave, firma) y sesión.
- **Estado (R8):** `<CLAUDE_PROJECT_DIR>/.navori/state/hooks/bash-outcome-watch/<sid>`, donde `sid`
  es `CLAUDE_CODE_SESSION_ID` saneado. La doc dice que coincide con el `session_id` del payload,
  así que se lee sin fork. Una línea por clave (`<clave> <firma> <cuenta> <avisado> <epoch>`),
  **tope 50 líneas**: al superarlo se descarta la de `epoch` más viejo. Se reescribe con temporal +
  `mv`. Guardas de symlink y barrido de 7 días de `routing-watch.sh`.
- **Fail-open (R9):** todo camino sale 0. Cualquier error omite el aviso y no deja nada en stdout.

### D7 — Presupuesto del hook (M5)

El hook corre en cada llamada Bash (éxito o fallo). Presupuesto:

- **Ruta rápida de éxito** (sin índice activo, o sin substring del índice en el payload, y sin
  archivo de estado de la sesión): arranque de bash + la lectura de stdin del partial
  `extract-cmd`. **Cero procesos externos más.** Reset: `[ -e <estado>/$sid ]` builtin.
- **Fallo:** hasta 3 procesos (extracción de campos y hash). Candidato a evidencia: los de git del
  paso D1.4, aceptados porque solo ocurren con un comando de criterio exacto.
- **Test de presupuesto** (determinista, no por tiempo): el hook corre con `PATH` apuntando a un
  directorio de shims que registran cada invocación. La ruta rápida debe registrar solo la lectura
  de stdin. Además, una medición de mediana en la máquina del implementer (50 corridas, objetivo
  ≤ 15 ms sobre un script vacío) queda en el PR, no se asierta en CI.

### D8 — Codex: filas y goldens (R5, R10)

La entrega aditiva existe en Codex (`additionalContext`; solo `decision:"block"` reemplaza el
resultado — [Codex hooks](https://learn.chatgpt.com/docs/hooks), consultado 2026-09-30). Sin
exit code verificado (U2), el hook no distingue éxito de fallo. Se anexa una fila `unsupported`
para `bash-outcome-watch` al final de `CODEX_HOOK_REGISTRATIONS`. Las filas `unsupported` no se
resuelven y no ocupan índice en `lib/codex/trust.ts`, así que ningún `trusted_hash` existente se
mueve. Controles `acceptance-evidence` y `repeat-failure-advice`: Codex `unsupported`.

Advertencias: `ENGINE_CAPABILITIES.codex.unsupportedSurfaces` se deriva de las filas
`unsupported`, y los controles nuevos entran en el inventario. **Los goldens
`engines/__tests__/__golden__/claude.snap` y `codex.snap` cambian** (hooks nuevos en settings,
superficies y controles); ese diff se revisa, no se regenera a ciegas. Si U2 se confirma y la fila
pasa a `registration`, el nuevo grupo core `PostToolUse` va antes de los hooks de plugin
(`resolveCodexHooks` concatena `resolvePluginCodexHooks` después de los core). Eso renumeraría
cualquier grupo `PostToolUse` de plugin ya aprobado. Esa promoción debe reportar el trust
resultante. "Nunca renumera" vale solo para filas core.

### D9 — Dudas y cobertura del reviewer (R11, R12, R13)

- **R11:** `ImplHandoffSchema.doubts?: { file: string; reason: string }[]`, fuera de
  `REQUIRED_IMPL_KEYS`. `implementer.md` agrega `"doubts": []` a la plantilla y una frase.
- **R12:** `reviewer.md` — `Setup` lee `doubts` de `impl_<feature>.json`. Sección
  `Implementer doubts`: `resolved | issue` + `file:line`. Las dudas se revisan **además** del diff,
  no en su lugar.
- **R13:** con `APPROVED` sin issues ≥ 80, tabla `Coverage` con una fila por sección 1–9 de
  `review-diff`: qué se revisó o `n/a` + motivo.
- **Topes (M8):** se escribe la prosa de D4, D9 y D10, y se fija `maxWords` = conteo medido del
  bloque managed + 10 de margen, en `reviewer.md` e `implementer.md`
  (`agents-assets.test.ts` — "declares maxWords and stays under it"). Sin cifras estimadas por
  adelantado. El PR reporta el antes/después.

### D10 — Captura de hallazgos (R14)

- El reviewer escribe `review_<feature>.json` junto al `.md` y corre
  `navori handoff log-review <feature> --dir .navori/state/handoffs --json` en ambos veredictos y
  en el delta re-sign. Es el patrón de `navori receipt sign`.
- `log-review` valida el sidecar y anexa una línea por hallazgo ≥ 50 a
  `.navori/state/handoffs/findings.jsonl`, con dedupe por hash del sidecar (precedente
  `recordAndCountRejections`). Sin rotación: al volumen observado, 10 000 líneas son ~2 MB.
- `settings-base.json` gana `Bash(navori handoff log-review:*)` en `allow`, junto a
  `Bash(navori handoff check:*)`, para no generar un prompt por review (m7).
- Parsear `review_*.md` está descartado: las 6 líneas con score locales no siguen
  `<file>:<line>` y ninguna trae categoría.
- **Ignorado en git (m8):** en este repo, `.gitignore` ignora `.navori/` (`git check-ignore`
  verificado para `.navori/state/handoffs/x.jsonl` y `.navori/state/hooks/x`). En repos de
  usuario, `CUBO_A_ENTRIES` ignora `.navori/state/` solo si `gitignoreHarness` ≠ `"off"`, y el
  default del schema es `"off"`. Es una condición previa (spec 0036), no introducida aquí. Ver
  Failure modes.

### D11 — Uso agregado (R16, R17)

`navori audit --days N` sigue siendo el comando. `buildReport` agrega `tallyAgents` (sesiones por
agente, fila para cada `HarnessCatalog.agents` aunque tenga cero) y `DeclaredAgent.managed`, por
marcador como `managedSkills`. `skillRangeSection` y la nueva `agentRangeSection` terminan con
"Candidatas a revisión (managed, 0 invocaciones en N sesiones)", donde N es `totals.sessions`, con
la advertencia de piso de `signals.ts`. Límite: solo sesiones Claude Code con audit-mode.

## Contracts

**`acceptance-index`** (`<CLAUDE_PROJECT_DIR>/.navori/state/handoffs/`, texto, lo escribe solo la CLI):
`<command JSON-escapado sin comillas>\t<feature>\t<A<n>>\t<dir de estado absoluto>\n`.

**Línea de `workplan_<feature>.evidence.jsonl`** (la escribe el hook):
`{ ts, feature, id, command, tree, cwd, head, worktreeTree, dirty, sessionId, agentId? }`.

**Workplan:**

```ts
RecordedEvidence = z.object({
  kind: z.literal("recorded"), command: z.string().min(1), ranAt: z.string().datetime(),
  tree: z.string().min(1), head: z.string().regex(/^[0-9a-f]{40}$/),
  worktreeTree: z.string().regex(/^[0-9a-f]{40,64}$/), dirty: z.boolean(),
});
UnevidencedAcceptance = z.object({ kind: z.literal("unevidenced"), reason: z.literal("engine-without-signal") });
WorkplanSchema.evidence = z.record(ACCEPTANCE_ID, z.discriminatedUnion("kind", [RecordedEvidence, UnevidencedAcceptance])).default({});
```

**CLI:** `plan update --progress A<n>=cumplido`: exit 0 escrito; exit 1 rechazado, sin escribir.
Sin flags nuevos. `plan check --json`: `warnings: CheckFinding[]` aditivo. `handoff log-review
<feature> [--dir] [--json]`: exit 0 anexado o ya registrado; exit 1 sidecar ausente o inválido.

**Handoff:** `doubts?: { file: string; reason: string }[]`.

**Sidecar `review_<feature>.json`:** `{ feature, verdict: "APPROVED"|"CHANGES_REQUESTED", findings:
{ category, severity: "CRITICAL"|"HIGH"|"MEDIUM", score: 50..100, file, line?, summary }[] }`.
`category` es un enum cerrado: `spec`, `convention`, `types`, `logic`, `errors`, `security`,
`hardcode`, `naming`, `overengineering`, `dead-code`, `quality-gate`, `commit`. Score ≥ 80 ⇒
`CRITICAL|HIGH`; 50–79 ⇒ `MEDIUM`. La línea de `findings.jsonl` es `{ ts, feature, verdict,
reviewHash, category, severity, score, file }`; `summary` no se copia.

**Controles:** `ControlId` gana `acceptance-evidence` y `repeat-failure-advice`, con declaración
para los cinco engines.

## Failure modes

- **Índice ausente o viejo** (workplan editado a mano sin `render`): la corrida no se registra;
  `plan update` rechaza con WHY `acceptance-index stale` y FIX `navori plan render <feature>`.
- **Worktree reclamado antes de marcar:** `tree` ya no existe → rechazo; se marca antes de
  reclamar o se corre el criterio en el checkout final.
- **Árbol cambió después de la corrida** (commit del scribe, edición): huella distinta → rechazo;
  hay que re-correr. Es intencional.
- **Comando que muta el árbol** (`render --apply`): la huella se toma después de la corrida, así que
  el árbol que se compara es el resultante.
- **`git add -A` lento** en un árbol enorme con no-ignorados: el timeout de 10 s corta el hook; no
  hay evidencia y `plan update` rechaza. Nunca se bloquea la herramienta.
- **`.navori/state/` no ignorado** (`gitignoreHarness: "off"`): las exclusiones del paso D1.4
  mantienen la huella estable; el log aparece como no rastreado en `git status`, igual que los
  handoffs hoy.
- **Hook sin `CLAUDE_PROJECT_DIR`** (otro host): sale 0 sin hacer nada.
- **Bash paralelos en la misma sesión:** pueden perder una actualización del estado de atasco (la
  cuenta queda corta por uno). Las líneas de evidencia usan append atómico de una línea (< 4 KiB).
- **`log-review` omitido:** se pierde un registro advisory; no se agrega un hook para forzarlo.

## Migration

- **Workplans con `cumplido` sin evidencia** (`workplan_1094`, `1095`, `1114`, `1115`,
  `spec0037_t7`, A1 de `1098-1099`): no se tocan. Se renderizan `(cumplido, sin evidencia)` y
  `plan check` da warning sin cambiar `ok`, así que plan-gate sigue permitiendo. En un review
  nuevo, R6b los marca. Se corrigen corriendo el comando y volviendo a hacer `plan update`.
- `acceptance-index` se crea en el primer `render`/`update` tras actualizar navori.
- Handoffs sin `doubts` y reviews sin sidecar siguen válidos; no hay backfill.
- **Render:** asset nuevo, grupo `PostToolUse` anexado tras los existentes, evento
  `PostToolUseFailure` nuevo, fila Codex `unsupported` al final, entrada `allow` nueva. Cambian
  los goldens (D8); el pinned-hash de Codex no cambia.
- **Rollback:** una CLI vieja descarta `evidence` al reescribir (`z.object`), de modo que se
  degrada a "sin evidencia", nunca a evidencia falsa. El hook huérfano se retira por el prune
  existente del render.

## Testing strategy

| Riesgo | Req. | Prueba |
|---|---|---|
| Éxito no registrado / fallo registrado / comando parecido registrado | R1 | `lib/__tests__/bash-outcome-watch.test.ts`: `PostToolUse` con comando exacto → línea; con espacio extra → nada; `interrupted` → nada; `PostToolUseFailure` → nada en evidencia |
| Huella inestable o que ignora cambios | R1, R2 | mismo archivo + `lib/plan/__tests__/evidence.test.ts`: escribir el log no cambia la huella; un edit sin commit la cambia; un archivo nuevo no ignorado la cambia |
| Evidencia de otro árbol, HEAD o comando aceptada | R2 | `commands/__tests__/plan.test.ts`: worktree de otra feature, HEAD movido, `command` editado, `cwd` subdir → rechazo; caso válido → escrito |
| Rechazo inútil o que escribe | R3 | mismo archivo: JSON byte-idéntico tras rechazo; snapshot de ERROR/WHY/FIX con el comando exacto |
| navori ejecuta el criterio | R4 | mismo archivo y test del hook: `command` = `touch <centinela>`; tras `plan update` y tras correr el hook con ese payload, el centinela no existe |
| Codex exige evidencia imposible / Claude acepta sin ella | R5 | `plan.test.ts` con y sin `CLAUDE_CODE_CHILD_SESSION`; `control-inventory.test.ts` + `scanControlGaps` listan `acceptance-evidence` para codex |
| Workplan viejo rompe check o gate | R6 | `lib/plan/__tests__/check.test.ts`, `render.test.ts` (4 casos de D4); `plan-gate.test.ts`: sin evidencia sigue `allow` |
| Reviewer no consume la evidencia | R6b | asserts de presencia en `agents-assets.test.ts` (bullet `plan check` bajo `planTiers`) |
| Falso positivo o negativo del atasco | R7 | `bash-outcome-watch.test.ts`: fixture del ejemplo oficial; 3 fallos misma firma → 1 aviso; timestamps/tmp distintos → misma firma; otro `agent_id` o `cwd` → contador separado; éxito intermedio reinicia; `is_interrupt` no cuenta |
| Estado sin tope o compartido | R8 | mismo archivo: 51 claves → 50 líneas; archivo por sesión; symlink → sin escritura |
| El hook altera o bloquea | R9 | payload corrupto, FS de solo lectura, sin jq/node: exit 0, stdout vacío |
| Costo por llamada Bash | R1, R7 | test de shims de D7: la ruta rápida no invoca procesos más allá de la lectura de stdin |
| Codex declarado como soportado / trust movido | R10 | `control-inventory.test.ts`; pinned-hash de `render-codex.test.ts`; revisión del diff de goldens |
| Handoff viejo inválido | R11 | `lib/handoff/__tests__/check.test.ts` con/sin `doubts` |
| Prosa ausente o tope excedido | R12, R13 | `agents-assets.test.ts` (tope medido) + presencia de `Implementer doubts`/`Coverage` |
| Hallazgos perdidos o duplicados; prompt por review | R14 | `commands/__tests__/handoff.test.ts` (nuevo); la entrada allow aparece en `claude.snap` |
| Agentes sin fila; candidatos mal marcados | R16, R17 | `lib/audit/__tests__/report.test.ts` |

El gate completo (`qualityGate.full`) es obligatorio por lote.

## Verificaciones pendientes

- **U1 — verificado en la documentación, no live.** `code.claude.com/docs/en/hooks.md` (raw,
  consultado 2026-09-30), § "PostToolUseFailure input", trae
  `"error": "Exit code 1\nError: Cannot find module 'express'"`. Coincide con los `tool_result`
  del transcript local (`"Exit code 1\n<salida>"`). Un resumen previo de WebFetch citaba otro
  ejemplo (`"Command failed with exit code 1"`) que no está en el raw. Recomendado antes de
  fusionar: capturar un payload live con un hook de logging en un repo scratch; si difiere, se
  aplica el diferimiento de requirements.md § S.
- **U2 — UNVERIFIED:** exit code en el `tool_response` de Bash en Codex. Mantiene ambos controles
  `unsupported` en Codex. Si se confirma, aplica la advertencia de plugins de D8.
- **Latencia real** de la ruta rápida y del carril de huella en repos grandes: se mide en el PR
  (D7); no cambia el diseño salvo que el paso D1.4 exceda el timeout de forma habitual.

## NOT in scope

- **R15** (resumen de categorías repetidas): diferido a otra spec. Criterio de entrada: ≥ 30
  hallazgos en `findings.jsonl` de ≥ 10 features.
- Ejecutar comandos de criterio desde la CLI o desde hooks, en cualquier forma, incluido un
  `--attest` que marque `cumplido` sin corrida en Claude Code.
- Hacer `expected` verificable mecánicamente: sigue siendo descriptivo y el skill pide que el
  código de salida lo codifique.
- Allow para `navori plan update` (no pedido); bloquear herramientas desde los hooks nuevos;
  Stop hook de gate.
- Evidencia o atasco en Codex mientras U2 siga sin verificar; telemetría Codex en `audit`.
- Backfill de hallazgos desde `review_*.md`; escribir reglas desde hallazgos.
- Cambiar el default de `gitignoreHarness`.
- El resto del curso (evidence.md § "Lo que navori ya cubre" y § Contradicciones).

## Open questions and durable knowledge

Sin preguntas bloqueantes: las cinco de la versión anterior quedaron resueltas por el veredicto
del orchestrator y la reescritura de requirements.md. Supuestos registrados: tope de 50 líneas,
un aviso por (clave, firma) y sesión, umbral 3 sin excepción para tests, log de hallazgos sin
rotación.

Destino durable propuesto (el architect no lo escribe):

- **Skills `plan-simple`/`plan-advanced` (core):** "el `command` de un criterio se corre textual
  desde la raíz del árbol y su código de salida codifica lo esperado".
- **Encabezado de `core-assets/hooks/routing-watch.sh`:** corregir la afirmación de que
  `PostToolUse` no trae identificador de agente. La doc vigente dice que los tool events de
  subagentes traen `agent_id`.
- **evidence.md:** corregir la fila de uso de skills (el agregado por rango ya existe) y la nota
  de U1.
- **DIRECTION:** sin cambios; el invariante 9 queda intacto.
