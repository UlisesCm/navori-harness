# Review adaptativo: verificación proporcional y checks en git hooks nativos — Design

**Fecha:** 2026-10-08 · **Estado:** revisado tras `challenge_0045.md` (una ronda) y las decisiones
finales del usuario del 2026-10-08. Pendiente de aprobación.
**Señales:** contrato compartido (schema de config, `expected` del workplan, línea de evidencia,
JSON de `receipt gate` y de `plan classify --diff`), área crítica (hook `quality-gate-pre-commit`,
registro de hooks de plugin en `settings.json` y `.codex/config.toml`, carril de evidencia de
`routing-watch` y `bash-outcome-watch`, plan-gate, un `allow` nuevo) y decisión difícil de revertir
(qué capa es dueña de los checks mecánicos).
**Ref verificada:** `origin/dev` = `HEAD` = `f8347c87` (tras `git fetch origin dev`). Todas las
afirmaciones de "ya existe" se leyeron en esa ref.

## Approach

El costo del ciclo está en `test:coverage` (398.5 s de ≈408 s; ver Baseline en `requirements.md`).
El diseño reduce primero **cuántas veces corre la suite completa** y después la duplicación de
checks mecánicos. Todo extiende piezas que ya existen; no hay un mecanismo paralelo al de la 0044.

1. **El gate completo corre en la ronda que firma (bloque B).**
   - Un `CHANGES_REQUESTED` se emite con el carril acotado: `qualityGate.scoped` si está declarado,
     si no `qualityGate.fast`, más los `A<n>` asignados.
   - `qualityGate.full` corre solo cuando el reviewer va a firmar `APPROVED` (R8, R9, R25).
   - `navori receipt gate` suma la rama de workplan con fases, con la regla de `decideGate` de la
     0044 y el mismo cierre por fallo hacia `full` (R10, R11).
   - Este repo declara un `scoped` = `check:scoped`: los pasos estáticos de `full`, sin tests
     (R23, R25). Los tests de cada ronda los aportan los `A<n>`.
2. **La duplicación se quita por config versionada, nunca por detección (bloque A).**
   - `qualityGate.nativeHooks: true` saca **solo el paso del gate** del hook `quality-gate-pre-commit`.
     Ese paso queda fuera del script renderizado, y los guards que no son gate siguen corriendo: el
     tope de `progress/current.md` y la user-section (R1–R3).
   - `plugins.<semgrep|jscpd>.nativeHook: true` hace que el render omita el registro del hook de
     ese plugin, y el script se sigue instalando (R1, R4).
   - El render depende solo de `navori.config.json`. `navori doctor` detecta y reporta, y da error
     si lo declarado no está activo con contenido del usuario en el clone o worktree actual (R5–R7).
     navori nunca instala ni escribe hooks nativos.
3. **Aceptación íntegra (bloque D).**
   - `expected` gana una gramática estructurada que parsea solo el CLI.
   - El carril de evidencia compara contra la salida que el host ya entrega en el payload. Guarda
     solo el código de salida y el resultado; nunca la salida ni su hash (R17–R19).
   - El workplan gana `request` (R15, R16).
   - `navori plan check` sube a finding el `cumplido` sin evidencia, sin cambiar qué significa
     `checkWorkplan().ok` para los demás consumidores (R20).
4. **Review y flujo proporcionales al cambio (bloques C y E).**
   - El nivel 0 lleva un criterio `verify:` obligatorio, que el plan-gate valida (R12).
   - `navori plan classify --diff` funciona sin workplan y publica `reviewDepth`. Es `light` solo si
     el repo declara `criticalPaths` y el diff no toca ninguno (R13, R14).
   - `navori handoff render` produce `impl_<f>.md` de forma determinista, y el `scribe` queda solo
     para `markdownRequests` (R21).
   - Un nit posterior a `APPROVED` no reabre el ciclo (R22).

### Enfoques descartados

- **Cesión en tiempo de ejecución según la detección** (primera versión de este design, D1/D2).
  - El challenge mostró cuatro problemas:
    - cedía semgrep/jscpd con una promesa que R1 no hace (C1);
    - su `exit 0` se saltaba el tope de `progress/current.md` y la user-section (C2);
    - leía los stubs de husky como hooks activos (C3);
    - dependía de una lista negra de formas de bypass, incompleta (H1/H2).
  - El usuario decidió quitar la duplicación por config (`requirements.md`, decisiones del
    2026-10-08).
- **Omitir hooks en el render según la detección.** El render dependería del estado git de la
  máquina, y eso rompe el invariante 3 de `docs/DIRECTION.md`. En CI, `bun run check:render`
  (`.github/workflows/ci.yml`, job `quality`) corre sobre un clon sin hooks instalados y vería drift.
- **Partir los guards a un hook nuevo y podar `quality-gate-pre-commit`.** Ver D1.
- **Que navori instale el hook nativo.** Excluido por la decisión del usuario.
- **Memo por fingerprint en semgrep/jscpd (M9 de la auditoría).** Obsoleto con el bloque A.
- **Guardar la cola de la salida o su hash como evidencia.** El hash de una salida de baja entropía
  se recupera por fuerza bruta (D11).
- **Gate y lectura en paralelo (M2 de la auditoría).** Fuera de alcance por `requirements.md`.

## Components

Bloque A — hooks nativos

- `packages/cli/src/lib/config/schema.ts`:
  - `QualityGateSchema` gana `scoped?` y `nativeHooks?`.
  - `PluginEntrySchema` gana `nativeHook?`.
  - Ningún campo lleva `.default()`.
  - Se regenera `apps/website/public/schema/navori.config.v1.json` con
    `packages/cli/scripts/gen-schemas.mjs`.
  - Cubre R1 y R25.
- `packages/cli/src/lib/render/interpolate.ts` (`interpolate`, mapa `extra`): variables derivadas
  `navori.nativeHooks` (`"1"`/`"0"`) y `navori.scopedGate` (`scoped ?? fast`). Usa el mismo patrón
  que `navori.progressSoftCapBytes` (#1263). Cubre R2 y R25.
- `packages/core/core-assets/hooks/quality-gate-pre-commit.sh`: el bloque del gate
  (`gate={{shq:qualityGate.fast}}` … `run_gate`) queda bajo `navori_native_fast`; el tope y la
  user-section no cambian. Cubre R2 y R3.
- `packages/cli/src/lib/config/plugins.ts` (`loadEnabledPlugins`): un plugin con `nativeHook: true`
  se carga con `manifest.hooks` vacío y con `nativeHookOmitted: true`; sus `scripts` quedan igual.
  Es el único punto de omisión, compartido por `buildClaudeSettings`, `resolveCodexHooks`
  (`resolvePluginCodexHooks`) y los checks de `doctor`. Cubre R4.
- `packages/cli/src/lib/diagnose/native-hooks.ts` (nuevo): `detectNativeHooks(cwd)`. Cubre R5 y R6.
- `packages/cli/src/commands/doctor.ts`: `scanNativeHooks(cwd, config)`, junto a
  `scanQualityGateReadiness`. Cubre R5, R6 y R7.
- Auditoría:
  - código de razón `native-hook` en `HOOK_REASON_CODES` (`lib/audit/model.ts`) y en la allowlist
    de jq de `_partials/audit-log.sh`;
  - resultado `deferred` en `correlateGateExecutions`;
  - campo `deferred` en `EpisodeGate` (`outcomes.ts`, `task-metrics.ts`).
- `packages/cli/src/engines/shared/native-overlap.ts` (`FLOWS`): fila `native-git-hooks`. Se
  regenera `docs/native-overlap.md`.
- Skills de plugin (`packages/plugins/{semgrep,jscpd}/skills/*.md`): contrato de invocación desde un
  hook nativo. Cubre R4.

Bloque B — gate por aprobación

- `packages/cli/src/lib/plan/gate-decision.ts` (nuevo, puro): `decideWorkplanGate(plan, phase?)`.
  Devuelve el `GateDecision` de `lib/spec/classify.ts` con `GateReason` extendido. Cubre R10 y R11.
- `packages/cli/src/commands/receipt.ts` (`executeGate`, `signSpecFlags`, `receiptCommand`): rama
  sin `--spec`, `--phase` y `pendingLater`. Cubre R10 y R11.
- `packages/core/core-assets/agents/reviewer.md`: Setup 3, Pass 2 "Quality gate" y "Content
  receipt". Cubre R8, R9 y R25.
- Para este repo: `navori.config.json`, `package.json` (`check`, `check:scoped`, `typecheck`).
  Cubre R23 y R25.

Bloque D — aceptación

- `packages/cli/src/lib/plan/expected.ts` (nuevo, puro): `parseExpected(text)`. Cubre R17.
- `packages/cli/src/lib/plan/schema.ts` (`WorkplanSchema`, `RecordedEvidenceSchema`): `request`,
  `exit` y `outcome`. Cubre R15 y R18.
- `packages/cli/src/lib/plan/acceptance-index.ts`: archivo hermano `acceptance-expected.jsonl`.
  Cubre R18.
- `packages/core/core-assets/hooks/_partials/bash-outcome.sh` (`navori_bash_success_lane`),
  `hooks/routing-watch.sh` y `hooks/bash-outcome-watch.sh`. Cubre R18.
- `packages/cli/src/lib/plan/evidence.ts` (`EvidenceLineSchema`, `validateEvidence`). Cubre R19.
- `packages/cli/src/lib/plan/check.ts` (`checkWorkplan`, `checkEvidence`, `checkStructural`) y
  `commands/plan.ts` (subcomando `check`). Cubre R17 y R20.
- `packages/cli/src/lib/plan/render.ts` (`renderWorkplan`). Cubre R15.

Bloques C y E — nivel y flujo

- `packages/cli/src/lib/plan/gate.ts` (`NIVEL0_LINE`, `evaluateNivel0`). Cubre R12.
- `packages/cli/src/commands/plan.ts` (`classifyDiff`, `diffFiles`). Cubre R13 y R14.
- `navori.config.json` de este repo: `project.criticalPaths`. Cubre R13 y R14.
- `packages/cli/src/lib/handoff/render.ts` (nuevo) y `commands/handoff.ts` (`handoffCommand`).
  Cubre R21.
- `packages/core/core-assets/settings/settings-base.json`: `Bash(navori handoff render:*)`. Cubre
  R21.
- Prosa:
  - `agents/orchestrator.md`: "The `scribe` leg" y "Frugal delegation";
  - `agents/scribe.md`: "Render the handoff";
  - `managed/orquestacion.md`: cláusula del modelo del scribe;
  - `managed/planificacion.md`: fila 0;
  - `agents/reviewer.md`: Pass 1 y Pass 2.
  - Cubre R12–R14, R16, R21 y R22.

## Decisions

### D1 — `nativeHooks` quita el gate del hook, no el hook (R2, R3)

**Forma elegida: el hook sigue registrado y el paso del gate sale del script por config.**

El script renderizado lleva esta constante, resuelta solo desde `navori.config.json`:

```sh
navori_native_fast={{navori.nativeHooks}}
```

Dentro de `if [ "$run_needed" = 1 ]` el orden queda así:

1. `cd` al árbol del commit (`navori_worktree`).
2. `navori_progress_ratchet`. No cambia.
3. `if [ "$navori_native_fast" != 1 ]`: el bloque actual del gate (`gate=…`, `command -v`,
   `run_gate`, detección del package manager, `ask`/`block` sin veredicto).
4. `else`: sin `exit`. Se fija `navori_audit_native=1` y el trap registra `skip` con el código
   `native-hook` (D5).
5. La `navori:user-section` corre después, igual que hoy.

Por qué esta forma y no partir los guards a un hook propio:

- **Contenido del usuario.** La user-section vive dentro de `quality-gate-pre-commit.sh`. Sacar el
  hook del plan haría que el render lo podara (`lib/render/removable.ts`) junto con los checks que
  el usuario escribió ahí. Mover su contenido a otro archivo es una migración de contenido del
  usuario, y eso es área crítica.
- **Codex.** `codexHookCommand` (`engines/codex/hook-registrations.ts`) hashea la cadena de comando.
  Si cambiara el registro, los índices de confianza se moverían y habría que reaprobar en `/hooks`;
  con esta forma la cadena no cambia.
- **Superficie.** Un hook nuevo sumaría filas en `HOOK_IDS` (`native-overlap.ts`), `CODEX_PARITY` y
  `CODEX_HOOK_REGISTRATIONS`, además de otra semántica para `FAST_GATE` en la auditoría. Esta forma
  agrega una constante y un `if`.
- **Determinismo.** El contenido del script depende solo de la config. `check:render` da lo mismo
  en cualquier clon (R2). Una copia cruda sin renderizar deja el placeholder, que no vale `1`, así
  que el gate corre: falla del lado seguro.

**Costo aceptado.** El hook sigue lanzando un proceso por llamada Bash. Sale por el camino rápido
de `gate-trigger` cuando el comando no es `git commit`, como hoy.

**Qué cubre el commit cuando `nativeHooks` es `true`.**

- El hook nativo, si está activo en ese árbol.
- El implementer, que corre `{{qualityGate.fast}}` explícitamente antes de devolver
  (`implementer.md`, Protocol 4).
- Un worktree de agente sin el hook nativo (por ejemplo, husky sin `.husky/_`) pierde solo la
  repetición en el commit, no el check. Lo que no está en `fast` lo cubren el gate completo del
  reviewer y CI.

### D2 — Hooks de plugin: omisión por config en un solo punto (R1, R4)

- `PluginEntrySchema` = `{ enabled: boolean; nativeHook?: boolean }`. Un CLI viejo descarta
  `nativeHook` (`z.object` quita claves desconocidas) y vuelve a registrar el hook: duplica, pero no
  pierde ningún check.
- `loadEnabledPlugins` devuelve el plugin con `manifest.hooks: []` y `nativeHookOmitted: true`.
  Todos los consumidores ven lo mismo:
  - `buildClaudeSettings`, que deja de llamar a `pluginHooksToClaudeShape` para ese plugin;
  - `resolveCodexHooks`;
  - los checks de drift de `doctor` (`commands/doctor.ts`, que también usan `loadEnabledPlugins`).
- El `settingsFragment` (`allow` de `semgrep:*`/`jscpd:*`) y los `scripts` se instalan igual (R4).
- El hook de semgrep cubría `git commit`, `git push` y `gh pr create` (`TRIGGER_RE` en
  `check-semgrep.sh`). Con `nativeHook: true` se pierden los tres disparos, porque es un solo
  registro. Es lo que declara el usuario: el hook nativo corre el chequeo. Donde semgrep no esté en
  `qualityGate.full` ni en CI, esa declaración es la única garantía, y `doctor` lo dice (D3).
- Codex: `resolveCodexHooks` pone los hooks de plugin después de las filas core. Omitir uno corre el
  índice de las filas `late` y pide **una** reaprobación en `/hooks` tras el render. Ese costo queda
  en la fila `native-git-hooks` de `FLOWS`.
- Contrato de invocación (R4), que ya existe y está en uso:
  - Ejemplo de un repo consumidor: su `package.json` define
    `"semgrep:check": "bash .claude/scripts/check-semgrep.sh </dev/null"` (y su par de jscpd), y el
    pre-commit versionado lo llama vía `check:fast`.
  - Con stdin vacío el script escanea sin condición (rama "No command extracted").
  - Desde git, exit 0 es verde o un skip explicado; 2 son findings; 1 es un fallo del escáner. Todo
    lo distinto de 0 aborta el commit.
  - Las skills de plugin lo documentan, y avisan que en repos con `.claude/` en gitignore un
    worktree nuevo no tiene `.claude/scripts/`.

### D3 — `navori doctor`: detecta, reporta y da error (R5, R6, R7)

`detectNativeHooks(cwd)` evalúa `pre-commit` y `pre-push` en el clone o worktree actual. Solo lee;
nunca ejecuta un hook.

1. `top = git rev-parse --show-toplevel` y `rel = git -C top rev-parse --git-path hooks`. El
   directorio de hooks es `resolve(top, rel)`.
   - Se evita `--path-format=absolute`, que exige git ≥2.31.
   - `core.hooksPath` existe desde git 2.9.
   - Si git falla o su versión es menor a 2.9, el estado es `unknown` (cuenta como ausente) y el
     mensaje incluye `git --version` (M6).
   - Verificado con git 2.54.0: un `core.hooksPath` relativo se resuelve contra el toplevel de cada
     worktree.
2. `f = dir/<event>` tiene que ser un archivo regular, ejecutable y no vacío. Si no, está ausente.
3. Según quién lo generó:

| Gestor (cómo se reconoce) | Activo con contenido del usuario si… |
|---|---|
| husky v9: `dir` termina en `/_` y existe `dir/h`, o `f` es el stub `. "$(dirname "$0")/h"` | existe `dirname(dir)/<event>`, regular y no vacío. El `h` de husky sale 0 cuando `.husky/<hook>` no existe (fuente de husky, consultada el 2026-10-08), así que el stub solo no cuenta |
| lefthook: `f` menciona `lefthook` | un `lefthook.yml`/`.yaml` (o `.lefthook.*`, `lefthook-local.*`) en `top` declara la clave de nivel superior `<event>:` |
| pre-commit framework: `f` lleva la cabecera generada por pre-commit | existe `.pre-commit-config.yaml`; para `pre-push`, además, el archivo menciona `pre-push` (`stages`, `default_stages` o `default_install_hook_types`) |
| cualquier otro | `f` tiene al menos una línea que no es shebang, comentario ni vacía |

Cualquier caso que no encaje cuenta como ausente (R6).

Reporte:

| Estado | Config | Nivel |
|---|---|---|
| `pre-commit` activo | `qualityGate.nativeHooks` ausente | warning: el gate rápido corre duplicado; sugiere declararlo (R7) |
| `pre-commit` ausente | `qualityGate.nativeHooks: true` | **error** que nombra `pre-commit`, el gestor reconocido y por qué cuenta como ausente (stub, sin config, versión de git) (R6) |
| `pre-commit` y `pre-push` ausentes | `plugins.<p>.nativeHook: true` | **error** que nombra el plugin y los dos eventos (R6) |
| cualquiera | `plugins.<p>.nativeHook: true` | info: el hook nativo es la única garantía de ese chequeo si no está en `qualityGate.full` (aviso de C1) |
| siempre | — | info con lo encontrado por evento: gestor, ruta y archivo del usuario (R5) |

- **Worktrees.** Con alguna declaración nativa, `doctor` recorre además `git worktree list
  --porcelain` y emite un warning por worktree bajo `.claude/worktrees/` donde el `pre-commit` dé
  ausente. Es un warning, no un error: el error de R6 es por el clone o worktree actual, y el
  implementer ya corre `fast` (D1).
- **Lo que `doctor` no prueba:** que el hook nativo corra `qualityGate.fast` o el chequeo del plugin.
  Eso es la declaración del usuario (R1).

### D4 — Este repo declara los hooks nativos (dogfooding)

- Solo `qualityGate.nativeHooks: true`. `plugins.<p>.nativeHook` sigue siendo una función para repos
  consumidores (T10), pero este repo ya no lo declara.
- Por qué: `scripts/git-hooks/pre-commit` corre `bun run check:fast`, que equivale a
  `qualityGate.fast` (D15).
- Enmienda 2026-10-09: #1282 retiró los plugins jscpd/semgrep de este repo (ahora scripts
  `check:dup`/`check:ast` como devDependency; semgrep corre solo en CI sobre `main`).
- **`hooks:install` corre desde `prepare`** (decisión del usuario, 2026-10-08): `bun install` deja
  instalado `.git/hooks/pre-commit`, que comparten todos los worktrees. Si
  `scripts/js/install-git-hooks.mjs` encuentra un hook ajeno, avisa y sale 0 en vez de lanzar, para
  no romper `bun install`; en ese caso `doctor` sigue dando el error de R6, que es la señal buscada.

### D5 — Auditoría: `skip` con código de razón (restricción 1 del encargo; challenge H3)

Hoy el trap de `quality-gate-pre-commit.sh` (`navori_audit_on_exit`) ya registra `skip` cuando no
corrió gate. `correlateGateExecutions` (`lib/audit/model.ts`) solo cuenta `gate-started` y los
terminales `allow`/`block`, así que un `skip` no produce ejecución. Por eso, sin cambios, un commit
con `nativeHooks` se vería igual que una llamada Bash cualquiera.

Cambios:

- **No hay veredicto nuevo.** Se suma el código `native-hook` a `HOOK_REASON_CODES`
  (`lib/audit/model.ts`) y a la allowlist de jq de `_partials/audit-log.sh`. El test
  `hook-audit-instrumentation.test.ts` ya falla si esos dos difieren.
- `correlateGateExecutions`: un handle de `quality-gate-pre-commit` cuyo único evento es `skip` con
  `reason: "native-hook"` da `outcome: "deferred"`, `ran: false`.
- `EpisodeGate.deferred: number`. `gateOf` (`lib/audit/outcomes.ts`) lo cuenta. En `efficiencyOf`
  (`task-metrics.ts`), un run con `executions === 0 && deferred > 0` aporta `gate: null` y
  `gateReason: "native-hook"`. La métrica R17 sale `partial` o `unavailable` con esa razón, en vez
  de un cero falso.
- La suma `unattributed.gateExecutions` de `outcomes.ts`: sigue contando solo `completed`.
- **Desfase de versiones.** Un CLI viejo que lee un registro con `reason: "native-hook"` lo descarta
  en el validador de registros (`model.ts`, comprobación `isHookReason`). Para él se pierde un `skip`
  que de todos modos ignoraba; el resultado no cambia.
- Los hooks de plugin omitidos (D2) no emiten nada. No forman parte de `FAST_GATE`, así que la
  métrica no depende de ellos.

### D6 — El gate sigue al veredicto; un solo carril acotado (R8, R9, R25)

Tabla de Pass 2 en `reviewer.md` ("Quality gate"):

| Situación | Gate que corre el reviewer |
|---|---|
| Pass 1 → `SPEC_MISS` | ninguno (como hoy) |
| Lectura de Pass 2 con algún issue ≥80 | carril acotado → `CHANGES_REQUESTED` (R8) |
| Sin issues ≥80 y `receipt gate` → `scoped` | carril acotado → `APPROVED`, firma `--gate-ran scoped` (commit-only) |
| Sin issues ≥80, cualquier otro caso | `{{qualityGate.full}}`; rojo → `CHANGES_REQUESTED`, verde → `APPROVED` (R9) |
| Delta re-sign | `{{qualityGate.full}}` (como hoy) |

- **Carril acotado:** `{{navori.scopedGate}}` más los comandos `A<n>` asignados. La fila `scoped` de
  la 0044 ("fast + `A<n>` del milestone") pasa a usar `{{navori.scopedGate}}`. La línea `verify:` de
  nivel 0 la suma E4 (D8); esta tabla no depende de ella.
- La lectura de Pass 2 va antes del gate. Setup 3 pierde "the full quality gate is still run
  anyway".
- El implementer sigue con `{{qualityGate.fast}}`.
- **Riesgo de la auditoría (M1): fallos que se ven una ronda tarde.** En este repo `scoped` incluye
  todos los checks baratos de `full` (D15). Lo único que queda fuera de una ronda intermedia son
  los tests que no estén en sus `A<n>`.

**Ahorro esperado, dicho con honestidad (challenge M2).**

- Ahorra una corrida de `full` (≈400 s) por cada ronda `CHANGES_REQUESTED` extra.
- Ahorra otra por cada fase no final de un workplan de nivel 2 (D7).
- Un ciclo aprobado a la primera paga lo mismo que hoy. El reordenamiento de D15 solo acorta las
  corridas rojas.
- [UNVERIFIED: rondas por ciclo en este repo.] La métrica existe en la auditoría de la 0042
  (`r17.reviewRoundsToAcceptance` en `lib/audit/report.ts`) y no la corrí. Si sale ≈1, E1 sigue
  siendo la entrega de mayor ahorro de las cuatro, pero el ahorro absoluto es chico. La tarea de
  calibración de E1 la mide antes y después.

### D7 — `receipt gate` para workplans con fases (R10, R11)

`decideWorkplanGate(plan, phase?)`, pura:

- **Fase de referencia:** la de `--phase <nombre|n>` (nombre exacto o índice base 1). Sin
  `--phase`, la última fase cuyos `A<n>` están todos en `cumplido`.
- **`scoped`** solo si existen `phases`, la referencia existe y alguna fase posterior tiene un
  `A<n>` sin `cumplido`.
- **`full`** en cualquier otro caso, con `reason`:
  - `no-phases`
  - `unknown-phase`
  - `no-completed-phase`
  - `closing-phase`
  - `unit-complete`
  - `workplan-unreadable` (no existe, no parsea o no pasa `WorkplanSchema`; cubre R11)
- **`receipt gate`:** `navori receipt gate --feature <f> [--phase <p>] --json`, sin `--spec`. Con
  `--spec` funciona exactamente como en la 0044. El JSON conserva la forma
  `{ gateKind, reason, unit, closingMilestone }`, con `unit = <f>` y `closingMilestone: null`, y
  suma `closingPhase` y `pendingLater: ["A<n>", …]`, que son los `A<n>` posteriores sin `cumplido`
  (M4).
- **Prosa del reviewer:** con `scoped`, el reviewer copia `pendingLater` al veredicto. Así el
  orquestador ve por qué la publicación es commit-only, y un `A<n>` olvidado o una fase abandonada
  no deja el workplan en `scoped` para siempre sin aviso.
- **`receipt sign`:** `--feature <f> --gate-ran scoped|full [--phase <p>]`, sin `--spec`. Recalcula
  la decisión y se niega a firmar `scoped` si sale `full` (el mismo ERROR/WHY/FIX de `signReceipt`).
  `signSpecFlags` acepta dos formas: `--spec --milestone --gate-ran`, o `--gate-ran [--phase]`.
- **Seguridad, confirmada en el challenge:** un `scoped` mal decidido solo fuerza commit-only
  (`publisher.md`, regla `mode: commit-only`). Nunca publica sin `full`.
- **Alcance:**
  - Solo los workplans de nivel 2 tienen `phases` (`PhaseSchema`, "Level 2 only").
  - Un workplan de nivel 1 da siempre `full`.
  - Los workplans de entrega de una spec siguen usando `--spec`.
  - El encargo puede nombrar la fase en una segunda línea, `phase: <nombre>`. `WORKPLAN_LINE` solo
    lee la primera.

### D8 — Nivel 0: línea `verify:` (R12)

```
nivel-0: <paths> | verify: `<command>` → <expected>
```

- **`<paths>`:** como hoy.
- **`<command>`:**
  - es un span de código de N backticks, que cierra con N backticks;
  - un `|` o un `→` adentro no rompe el parseo;
  - no puede estar vacío.
- **Separador:** `→` o `->`, entre espacios.
- **`<expected>`:**
  - no puede estar vacío;
  - si E3 ya está mergeada y cumple la gramática de D11, se valida, y un `matches:` inválido se
    niega;
  - si no, es texto libre.
- **Regex:** `^nivel-0:\s*(\S+)\s+\|\s+verify:\s+(`+)(.+?)\2\s+(?:→|->)\s+(\S.*)$`.
- **Sin `verify:`:** se niega con un `reason` que muestra la gramática completa.
- **Alcance de R12 (challenge M1):** exige que el criterio exista, no que sea bueno.
  `` `true` → exit 0 `` pasa. La sustancia la juzga el reviewer cuando lo vuelve a correr.
- **Quién lo corre:** el implementer lo corre y lo reporta en `impl_<f>.json` (`verification`); el
  reviewer lo vuelve a correr dentro de su gate. No hay workplan, así que no hay carril de evidencia.
- **Codex:**
  - La primera línea llega por el mensaje en v1 o por el archivo de despacho en v2 (`readDispatch`).
  - `CODEX_PARITY["hook:plan-gate"]` está `verified`, `equivalente` y enforcing (smoke S4).
  - Es advisory solo sin aprobación en `/hooks` o con un `navori` global anterior a esta spec.
- **Binarios mezclados:**
  - CLI viejo con prosa nueva: deja pasar sin exigir `verify` (`NIVEL0_LINE` captura `\S+`).
  - CLI nuevo con prosa vieja: niega y muestra la gramática.

### D9 — Profundidad del review decidida por el CLI (R13, R14)

`navori plan classify <feature> --diff [<base>]`:

- **Sin workplan:** deja de fallar. Clasifica con `declaredLevel: 0`, sin señales declaradas.
- **Archivos, solo en ese modo:** la unión de `git diff --name-only <base>...HEAD`,
  `git diff --name-only <base>` y `git ls-files --others --exclude-standard`. Sin la unión, un cambio
  sin commitear clasifica cero archivos.
- **Con workplan, sin cambios:** se queda en `...HEAD`. Extender la unión haría que
  `exceedsDeclared` empezara a dispararse por archivos sin rastrear en el Pass 1 de todo workplan
  (challenge M1). Eso queda fuera de alcance.
- **JSON nuevo, aditivo:** `workplan: boolean`, `reviewDepth: "light"|"full"` y `depthReason`.
- **`light`** solo si se cumplen las cinco condiciones:
  - no hay workplan;
  - `level === 0`;
  - no hay ninguna señal `floor:*`;
  - `project.criticalPaths` no está vacío;
  - ninguna señal `critical-area:*` coincide.
- **`depthReason`** cuando sale `full`:
  - `workplan`
  - `level`
  - `criticalPaths-undeclared`
  - `critical-path-matched`
  - `floor`

Por qué R13 exige `criticalPaths` (challenge C4): `CRITICAL_AREA_WEIGHT` = 3 =
`LEVEL_ZERO_MAX_SCORE` (`lib/plan/signals.ts`), así que tocar un archivo crítico puede seguir
dando nivel 0. Y sin `criticalPaths` declarados, `matchesCriticalPaths` devuelve `false` siempre.

Reviewer (Pass 2):

- con `reviewDepth: "light"`, solo el checklist de `review-diff` (R13);
- con `full`, o cuando a su juicio el diff toca un área de `{{project.criticalAreas}}`, el review
  completo con `security-invariants` (R14).

**Este repo declara `project.criticalPaths`** (lista aprobada por el usuario el 2026-10-08):

- `packages/core/core-assets/hooks/**`
- `packages/core/core-assets/settings/**`
- `packages/plugins/*/scripts/**`
- `packages/cli/src/lib/render/**`
- `packages/cli/src/engines/**/build-settings.ts`
- `packages/cli/src/engines/codex/hook-registrations.ts`
- `packages/cli/src/lib/diagnose/receipt.ts`
- `packages/cli/src/lib/plan/{gate,evidence}.ts`
- `packages/cli/src/commands/{render,sync,backup,update}.ts` (escriben en el repo del usuario)

Hay un test que corre `classify --diff` con el `navori.config.json` real.

### D10 — `request` en el workplan (R15, R16)

- `WorkplanSchema.request: z.string().min(1).max(20000).optional()`, con el texto literal de la
  petición o `<ID> — <cuerpo>`.
- `renderWorkplan` lo muestra citado (`> `) después de `objective`. R15 dice `goal`, pero el campo
  real es `objective`.
- Reviewer, Pass 1: compara el diff también contra `request`; una divergencia es `SPEC_MISS`. El
  texto es dato, no instrucciones.
- `plan-simple` y `plan-advanced` piden llenarlo cuando hay petición o ticket.

### D11 — `expected` estructurado y carril de evidencia (R17–R19)

**Gramática (R17).** `parseExpected(text)` es la única fuente y evalúa el string completo.

| Forma | Regex | Semántica |
|---|---|---|
| `exit <n>` | `^exit (0\|[1-9]\d{0,2})$`, n ≤ 255 | código de salida n |
| `contains: <texto>` | `^contains: (.+)$` | exit 0 y `stdout + "\n" + stderr` contiene el texto literal |
| `matches: /<re>/<flags>` | `^matches: /(.+)/([imsu]*)$` | exit 0 y `RegExp(re, flags)` coincide en la misma cadena |
| otro | — | texto libre: comportamiento de hoy |

- `expected` sigue siendo `z.string()` para que un CLI viejo pueda leer el workplan.
- `checkStructural` agrega `acceptance-expected-invalid` si un `matches:` no compila.

**Registro (R18).**

- **Entrada.** El CLI escribe `acceptance-expected.jsonl` junto a `acceptance-index`. Lleva una
  línea por criterio pendiente con `expected` estructurado, con la **misma clave que la línea del
  índice**: `{ feature, id, binding, stage, expected, spec }`. `binding` y `stage` son los campos de
  0044/master-plan que `linesForDir` ya escribe; quedan vacíos fuera de una entrega. Así un criterio
  `P1.A2` de `<spec>-e<n>` encuentra su `expected` y dos stages de una misma feature no chocan
  (H5).
- **Carril de éxito** (PostToolUse, solo Claude):
  - Si hay un acierto con `spec`, el camino lento lanza `node -e` con el payload.
  - Lee `tool_response.stdout` y `.stderr`. La doc oficial dice que Bash devuelve `stdout`, `stderr`,
    `interrupted` e `isImage`.
  - Devuelve `outcome`, que puede ser `pass`, `fail` o `unevaluated`. Es `unevaluated` si:
    - la salida pasa de 4 MiB;
    - aparece el marcador de truncado de Claude Code (`/\[\d+ characters truncated\]/`). No pude
      confirmar si el host trunca el `stdout` de éxito; por eso el marcador se trata como señal y no
      como garantía (H5);
    - `interrupted` es `true`.
  - La línea sigue escribiéndose con un solo `printf >>` al final ("fail-open, sin línea parcial").
  - Sin node, o si falla el snippet, la línea sale sin `outcome`.
- **Carril de fallo** (`bash-outcome-watch.sh`, PostToolUseFailure, solo Claude):
  - Escribe línea **solo** para criterios cuyo `spec.kind` es `exit`.
  - El código sale de `^Exit code (\d+)(\n|$)` anclado al inicio de `error`. No reutiliza el
    `/exit code\s+(\d+)/i` sin anclar de `bash-outcome.sh`.
  - No escribe nada si `is_interrupt` es `true` o si `error` trae la línea de timeout del host
    (`Command timed out`).
  - Texto libre, `contains` y `matches` siguen sin dejar línea al fallar.

**Validación (R19).** `validateEvidence` recibe `expected`:

- **Decide la línea más nueva** que pasa las comprobaciones de comando, árbol, HEAD y binding. Una
  línea `pass` más vieja nunca anula una `fail` o `unevaluated` más nueva (H5).
- **Texto libre:** solo valen líneas sin `exit` (todas las de hoy) o con `exit: 0`.
- **Estructurado:** exige `line.expected === expected` y `outcome === "pass"`. Los motivos de
  rechazo son:
  - `expected not met: <forma>`;
  - `output not comparable (too large, truncated or interrupted)`;
  - `comparison not recorded (hooks older than the CLI, or node unavailable)`, con FIX
    `navori render --apply` y volver a correr.
- `rejectCumplido` da el ERROR/WHY/FIX. `RecordedEvidenceSchema` copia `exit` y `outcome`, ambos
  opcionales.

**Secretos y modelo de confianza.**

- No se guarda la salida, ni su cola, ni su hash.
- **El modelo de confianza no cambia.** Cualquier proceso que pueda escribir en
  `workplan_<f>.evidence.jsonl` puede escribir `outcome:"pass"`, porque el fingerprint excluye
  `.navori/state`. Falsificar una comparación cuesta lo mismo que falsificar una línea hoy. Un
  `deny` de escritura sobre esa ruta queda fuera de alcance.
- **Residual:** los resultados de `contains:` y `matches:` funcionan como oráculo sobre la salida.
  Un criterio inyectado podría sondearla bit a bit con `plan update` repetidos. El riesgo es bajo y
  queda anotado.

**Codex.** `evidenceRequired` es falso fuera de una sesión hija de Claude, y ahí `cumplido` se acepta
como `unevidenced` (spec 0039 R10). Con `expected` estructurado, la comparación la hace el reviewer.

### D12 — `cumplido` sin evidencia es finding en `plan check`, sin cambiar `ok` (R20)

`checkWorkplan(raw, cwd, options?: { evidence?: "warning" | "finding" })`. Por defecto es
`"warning"`: el `ok` de hoy queda intacto (challenge H4). Cada llamador:

| Llamador | Modo | Por qué |
|---|---|---|
| `commands/plan.ts` (subcomando `check`) | `finding` | R20: `progress-unevidenced` y `progress-evidence-stale` van a `findings`, y el exit es ≠0 |
| `lib/plan/gate.ts` (`evaluateWorkplan`) | `warning` | el arreglo es volver a correr el comando, y eso lo hace el implementer que se va a despachar |
| `lib/master/slice.ts` (dos llamadas) | `warning` | validan metadatos de planeación para proyectar una entrega |
| `lib/master/part.ts` (dos llamadas) | `warning` | ídem, para la prueba de la parte |

- `progress-unevidenced-accepted` (engine sin señal, Codex) sigue como warning en los dos modos.
- El reviewer ya corre `navori plan check --json` (Pass 1), así que ahora el CLI y él dicen lo mismo.

### D13 — `navori handoff render` y la contradicción F5 (R21)

- `renderImplHandoff(impl)` es una plantilla pura sobre `ImplHandoffSchema`: estado, archivos,
  verificación, `acceptance`, `doubts` y decisiones. No agrega afirmaciones.
- `navori handoff render <feature> [--dir] [--cwd] [--json]` refuse sin escribir (exit 1) si:
  - `impl_<f>.json` falta, no parsea o es de otra feature (la semántica de 0030 R6);
  - `harness.scribeOwnsMarkdown` no es `true` (el default es `false`, `lib/config/schema.ts`). En ese
    modo el implementer escribe `impl_<f>.md` y el comando no puede pisarlo; el FIX lo explica
    (H6).
- Si nada de eso aplica, escribe con `writeStateFileAtomic`.
- Permiso: `Bash(navori handoff render:*)` en `allow`. Solo escribe en el directorio de estado.
- **Resolución de F5.** Toda la prosa nueva va dentro de `<!-- navori:if scribeOwnsMarkdown -->`.
  - El orquestador corre `navori handoff render` después de `handoff check` y antes del reviewer.
  - El `scribe` se despacha solo si `markdownRequests` no está vacío.
  - En `scribe.md` desaparece la sección "Render the handoff".
  - En `orchestrator.md` y `orquestacion.md` se borra la cláusula de modelo
    "`{{models.scribe}}` when the scribe is only rendering the handoff".
  - Esto **enmienda 0030 R5 y R8**, no la 0033: el R5 de la 0033 trata de la vigencia del gate. Se
    agrega una nota al final de `specs/0030-scribe-owns-markdown/requirements.md`.
- El Setup 1 del reviewer sigue leyendo `impl_<f>.md`.

### D14 — Un nit posterior a `APPROVED` no reabre el ciclo (R22)

`orchestrator.md`, "Frugal delegation", último bullet:

> An informational observation (score < 80) after `APPROVED` goes into the PR body (or
> `follow-up-prs`); it never reopens the cycle. Only an issue ≥80 or an edit the user asks for
> triggers `implementer` → delta re-sign.

Va en el agente porque el bloque always-on `10-orquestacion.md` ya se entrega como puntero (aviso
actual de `check:doc-budgets`, presupuesto de 8000 caracteres).

### D15 — Config de este repo (R23, R25)

**Nuevo script raíz** `"typecheck": "bun run --filter navori typecheck"`. Sirve para no encadenar
`cd`.

**`qualityGate.fast`:** `bun run lint && bun run typecheck` (R23).

**`qualityGate.full`**, de barato a caro, con el mismo conjunto de checks que hoy:

1. `format:check`
2. `lint`
3. `typecheck`
4. `check:links`
5. `check:render`
6. `check:assets`
7. `check:doc-budgets`
8. `check:blame-ignore`
9. `jscpd:check`
10. `semgrep:check`
11. `cd packages/cli && bun run check:size`
12. `bun run test:coverage`

El script `check` de `package.json` se reordena igual.

**`qualityGate.scoped`** = `bun run check:scoped`: los pasos 1–11 de `full`, sin `test:coverage` y
sin tests (R25). Una ronda intermedia ya ve goldens, `check:render`, `check:assets` y la deriva de
`core-assets` sin correr vitest; los tests de la ronda son sus `A<n>`.

**Decisión: sin selector de tests (`test:related`).** Se probó `vitest related` sobre el diff de M3
y se descartó: los módulos hub (`config.ts`, `permission-rules.ts`) seleccionaron 241 archivos y
tardó 518 s, contra ~408 s del `full` completo. El selector costaba más que el gate que reemplazaba.
El `scoped` queda en checks estáticos (8 s medidos, `check:scoped`), y lo que cada ronda necesita
se declara en sus `A<n>`.

Lo que se le escape a esta aproximación lo atrapa `full` en `APPROVED`.

### D16 — Prosa, paridad y presupuestos (R24)

- **Engines.** Toda la prosa nueva vive en assets que renderizan Claude y Codex. Solo se usa
  `navori:if scribeOwnsMarkdown`, que ya existe.
- **Variables derivadas.** `navori.scopedGate` y `navori.nativeHooks` siempre resuelven, así que
  ningún engine ve `<not configured>`.
- **Fila `native-git-hooks` en `FLOWS`**, con `codex: "emit"`. Dice que la omisión es por config y
  que omitir un hook de plugin pide una reaprobación en `/hooks` de Codex.
- **Presupuestos, por entrega.** Cada PR pasa `check:doc-budgets` solo (challenge M3). Medido con
  `wc -w`:
  - `reviewer.md` mide 3066 y su tope es 2966. Crece ≈+70 palabras en E1 (D6, D7), ≈+20 en E3 (D10)
    y ≈+30 en E4 (D9). Cada entrega sube el tope al conteo medido más 10 palabras, con el porqué en el
    frontmatter, como en la 0044 (D11).
  - `orchestrator.md` mide 3151 y su tope es 3050. Crece ≈+40 palabras en E4 (D13, D14).
  - `planificacion`: solo cambia la celda de la fila 0, ≈+8 palabras, en E4.
  - `orquestacion` y `scribe` bajan.

### D17 — Áreas críticas

| Área crítica | ¿La toca? | Qué y riesgo |
|---|---|---|
| Escrituras de render/sync/backup | Sí | El contenido de `quality-gate-pre-commit.sh` depende de la config. `settings.json` y `.codex/config.toml` pierden el registro de un plugin con `nativeHook`. No se poda ningún archivo con contenido del usuario (D1). Se aplica con el flujo normal de `render --apply` y backup |
| Permisos de `settings.json`, deny/ask y hooks | **Sí** | Un `allow` de prefijo exacto. El gate sale del hook core por config. Hay omisión de hooks de plugin. Se agrega lógica a los carriles de evidencia y a la gramática del plan-gate. Cada pieza falla del lado seguro: un placeholder crudo corre el gate; un CLI viejo vuelve a registrar el hook; una evidencia sin comparación se rechaza; un nivel 0 sin `verify:` se niega |
| Marcadores managed y guard anti-rollback | No | — |
| (Mismo rigor) receipt y publicación | Sí | `receipt gate`/`sign` para workplans (D7). La regla del publisher no cambia |

### Cobertura de requisitos

| R | Decisión |
|---|---|
| R1 | D1, D2 (schema) |
| R2 | D1 |
| R3 | D1 |
| R4 | D2 |
| R5 | D3 |
| R6 | D3 |
| R7 | D3 |
| R8, R9 | D6 |
| R10, R11 | D7 |
| R12 | D8 |
| R13, R14 | D9 |
| R15, R16 | D10 |
| R17, R18, R19 | D11 |
| R20 | D12 |
| R21 | D13 |
| R22 | D14 |
| R23 | D15 |
| R24 | D16 |
| R25 | D6 (`navori.scopedGate`), D15 (valor de este repo) |

## Contracts

**Config.**

```ts
const QualityGateSchema = z.object({
  fast: z.string().min(1),
  full: z.string().min(1),
  scoped: z.string().min(1).optional(),
  nativeHooks: z.boolean().optional(),
});
const PluginEntrySchema = z.object({
  enabled: z.boolean(),
  nativeHook: z.boolean().optional(),
});
```

- `nativeHook` solo tiene efecto en plugins cuyo manifiesto trae `hooks` (`semgrep`, `jscpd`). En
  cualquier otro plugin, `doctor` avisa.
- En un workspace de `MonorepoWorkspaceSchema`, `nativeHooks` se ignora y `doctor` avisa.

**Variables derivadas.**

- `{{navori.scopedGate}}` = `qualityGate.scoped ?? qualityGate.fast`.
- `{{navori.nativeHooks}}` = `"1"` si y solo si `qualityGate.nativeHooks === true`.

**`LoadedPlugin`.** Gana `nativeHookOmitted?: true`.

**Auditoría.**

- Código de razón `native-hook`.
- `GateExecution.outcome` suma `"deferred"`.
- `EpisodeGate.deferred: number`.
- `gateReason` acepta `"native-hook"`.

**`detectNativeHooks`.**

```ts
{
  git: { ok: boolean; version: string | null },
  events: Record<"pre-commit" | "pre-push", {
    state: "active" | "absent" | "unknown";
    manager: "husky" | "lefthook" | "pre-commit" | "plain" | null;
    path: string | null; userFile: string | null; why: string | null;
  }>
}
```

**`receipt gate` sin `--spec`.**

```json
{ "gateKind": "scoped", "reason": "pending-later-work", "unit": "mi-feature",
  "closingMilestone": null, "closingPhase": "Integración", "pendingLater": ["A4"] }
```

**Línea de nivel 0.**

```
nivel-0: src/a.ts | verify: `bun test src/a.test.ts` → exit 0
```

**`plan classify --diff --json`.** Gana `workplan`, `reviewDepth` y `depthReason`.

**Workplan.**

- `request?` (≤20000).
- La evidencia `recorded` gana `exit?` y `outcome?: "pass"|"fail"|"unevaluated"`.

**Línea de evidencia.** Gana los campos opcionales `exit`, `expected` y `outcome`.
`EvidenceLineSchema` es `z.object`, así que un CLI viejo los descarta.

**`acceptance-expected.jsonl`.**

```json
{"feature":"f","id":"A2","binding":"","stage":"","expected":"contains: 3 passed","spec":{"kind":"contains","text":"3 passed"}}
```

**`checkWorkplan`.** Tercer parámetro opcional: `{ evidence?: "warning" | "finding" }`.

**`navori handoff render <feature>`.**

- Exit 0 y escribe.
- Exit 1 sin escribir si el handoff falta, no es válido, es de otra feature o
  `scribeOwnsMarkdown` no es `true`.
- Con `--json`: `{ status, path, error? }`.

## Failure modes

- **Declaración sin hook nativo activo en un clone.**
  - `doctor` da error.
  - Mientras tanto el commit no corre `fast` desde el harness, pero el implementer ya lo corrió y el
    reviewer corre `full`.
  - Para un plugin con `nativeHook` que no está en `full` ni en CI, el chequeo queda sin respaldo.
    `doctor` lo dice en la fila info (D3). Es la responsabilidad que asume quien declara.
- **Worktree de agente sin hook nativo** (husky sin `.husky/_`). Igual que el caso anterior; `doctor`
  avisa por worktree.
- **Bypass del hook nativo** (`--no-verify`, `HUSKY=0`, variables de config de git). Ya no hay
  cesión que dependa de detectarlo. `guard-destructive.sh` sigue bloqueando `--no-verify`, y el gate
  completo y CI no se pueden saltar.
- **Variables `GIT_*` heredadas dentro del hook nativo.** Es responsabilidad del hook del proyecto;
  el de este repo ya las limpia.
- **Timeout.** El hook nativo corre bajo el timeout de Bash del `git commit`, no bajo los 600 s del
  hook.
- **Fallos que se ven una ronda tarde (D6).** Cuentan para el tope de 2 de
  `recordAndCountRejections`. Lo acota el `scoped` de este repo.
- **`receipt gate` con progreso mal marcado.** Bloquea de más (commit-only, con `pendingLater`
  visible) y nunca publica sin `full`.
- **Desfase entre CLI, hooks y prosa.**
  - Hooks viejos: la evidencia sale sin `outcome` y se rechaza con FIX.
  - CLI viejo: ignora `nativeHook` y `nativeHooks` y vuelve a registrar o correr el gate (duplica,
    no pierde).
  - Un CLI viejo con un registro de auditoría `native-hook` lo descarta.
- **Regex costosa en `matches:`.** Corre en la máquina del mismo usuario, sobre ≤4 MiB, dentro del
  carril fail-open.
- **Test fuera de los `A<n>`.** Lo atrapa `full` en `APPROVED`, una ronda más tarde.

## Migration

- **Config.** Los campos son opcionales; un repo sin ellos se comporta como hoy. Se regenera el
  JSON Schema.
- **Hooks ya renderizados.**
  - `quality-gate-pre-commit.sh` cambia de contenido al siguiente `render --apply`, con backup. Su
    user-section se conserva.
  - Con `plugins.<p>.nativeHook`, desaparece el registro del hook de plugin en `settings.json` y en
    `.codex/config.toml`. El script se queda.
  - En Codex hay una reaprobación en `/hooks` (D2).
- **Receipts en curso (challenge M3).**
  - D15 cambia el texto de `qualityGate.full`, así que cada `receipt.txt` vigente queda `stale` por
    `gate=<identity>` (`evidenceIdentity`, `lib/diagnose/receipt.ts`). Hay que volver a firmar.
  - Un receipt `scoped` lleva la constante `SCOPED_GATE`, no la identidad de `qualityGate.scoped` ni
    de los `A<n>`. Si cambia `scoped`, no se detecta. Se acepta porque un receipt `scoped` nunca
    publica.
- **Workplans en curso.** Un `expected` que valía exactamente `exit 0` pasa a estructurado. Un
  `cumplido` antiguo sin evidencia hace fallar `plan check`, pero no el plan-gate ni master-plan
  (D12).
- **Encargos de nivel 0 en curso.** Se niegan, con la gramática en el mensaje.
- **Spec 0030.** Nota de enmienda de R5 y R8.
- **Este repo.**
  - Se actualizan `navori.config.json` (D4, D9, D15) y `package.json` (`check`, `typecheck`).
  - Se agrega `check:scoped` (script raíz; sin tests).
  - Se re-renderiza el harness autohospedado (`.claude/`, `.codex/`, `AGENTS.md`).
- **Orden de publicación.** Conviene publicar el CLI antes de que los repos rendericen la prosa
  nueva.

## Testing strategy

Cada test responde a un riesgo de arriba, con vitest y `// Covers: R<n>`.

| Riesgo | Test |
|---|---|
| Con `nativeHooks` el hook pierde el tope o la user-section | `quality-gate-native.test.ts` sobre el script renderizado con `nativeHooks:true`. Payload de Claude y payload de Codex (`nv_engine=codex`). Casos: `progress/current.md` sobre el techo → exit 2; user-section con `exit 2` → exit 2; commit normal → exit 0 sin `gate-started` y con `skip`/`native-hook`. Con `nativeHooks` ausente, el gate corre como hoy. Una copia cruda sin renderizar corre el gate (`// Covers: R2, R3`) |
| El render depende del estado git o diverge entre engines | Goldens de render **con y sin** `qualityGate.nativeHooks` y `plugins.semgrep.nativeHook`: `settings.json`, `.codex/config.toml` y `quality-gate-pre-commit.sh`. El mismo golden en un repo con y sin hooks instalados (`// Covers: R2, R4`) |
| La omisión de un plugin pierde el script o difiere entre consumidores | `plugins.test.ts`: `loadEnabledPlugins` con `nativeHook`, que da `hooks: []` y los `scripts` intactos; `build-settings` y `resolveCodexHooks` sin el registro (`// Covers: R4`) |
| Se acepta como activo un stub de husky, un lefthook sin jobs o un pre-commit sin etapa | `native-hooks.test.ts`, con fixtures en repo y worktree temporales: husky solo con `pre-push` (pre-commit ausente); husky con los dos; `.husky/_` ausente en un worktree; lefthook sin `pre-commit:`; pre-commit framework sin `pre-push`; hook plano de solo comentarios; `core.hooksPath` relativo; git simulado < 2.9 (`// Covers: R5, R6`) |
| `doctor` no nombra el hook ni avisa del duplicado | `doctor-native-hooks.test.ts`: las filas de D3 y el warning por worktree (`// Covers: R5, R6, R7`) |
| La auditoría cuenta cero en vez de "no observado" | `outcomes.test.ts`: solo `skip`/`native-hook` da `gate:null` y `gateReason:"native-hook"`; mixto da contadores separados. Golden de la salida de `audit-log.sh` renderizado con `native-hook`. `hook-audit-instrumentation.test.ts` comprueba la paridad de la allowlist (`// Covers: R2`) |
| Un `receipt gate` de workplan publica sin `full` | `gate-decision.test.ts` (todas las razones, `pendingLater`) y `receipt.test.ts` (`sign --gate-ran scoped` con decisión `full` da exit 1 sin receipt) (`// Covers: R10, R11`) |
| El carril acotado no usa `scoped` | `interpolate.test.ts` y render de `reviewer` con la tabla de D6, en Claude y Codex (`// Covers: R8, R9, R25, R24`) |
| Config de este repo | Test que lee `navori.config.json`: `typecheck` en `fast`; `test:coverage` último en `full`; mismo conjunto de checks; `scoped` = `check:scoped` (pasos estáticos de `full`, sin tests); las tres declaraciones nativas (`// Covers: R23, R25, R1`) |
| `scoped` sin tests | `repo-gate-config.test.ts`::"orden y conjunto": `qualityGate.scoped` = `check:scoped` y su cadena no contiene `vitest`; `bun run check:scoped` → exit 0 sin correr vitest (`// Covers: R25`) |
| Nivel 0 sin `verify:` pasa | `plan-gate.test.ts`: gramática, v2 de Codex por archivo de despacho (`// Covers: R12`) |
| Review ligero sobre algo crítico | `plan.test.ts`: sin workplan, sin `criticalPaths` da `full`/`criticalPaths-undeclared`; con el config real de este repo y un hook cambiado da `full`; un archivo trivial da `light`. Con workplan, archivos sin rastrear no cambian `exceedsDeclared` (`// Covers: R13, R14`) |
| `request` | `render.test.ts` y anclas del reviewer en los dos engines (`// Covers: R15, R16`) |
| `expected` mal parseado | `expected.test.ts` (`// Covers: R17`) |
| El carril guarda salida, escribe línea parcial o confunde exits | `bash-outcome.test.ts`: un secreto en stdout no aparece en la línea; un kill antes del `printf` no deja línea; sin node no hay `outcome`; el marcador de truncado da `unevaluated`; `error` con "exit code 7" fuera de la primera línea no cuenta; un timeout o `is_interrupt` no deja línea; un criterio con `binding` encuentra su `expected` (`// Covers: R18`) |
| Una `pass` vieja anula una `fail` nueva; `expected` editado | `plan.test.ts` (`// Covers: R19`) |
| `plan check` rompe a master-plan o al plan-gate | `check.test.ts` en los dos modos; `slice.test.ts`/`part.test.ts` con un `cumplido` heredado siguen `ok`; el plan-gate permite el despacho (`// Covers: R20`) |
| `handoff render` en modo legacy o con JSON inválido | `handoff-render.test.ts`: snapshot; faltante, inválido u otra feature dan exit 1; `scribeOwnsMarkdown:false` da exit 1 sin tocar el `.md` del implementer (`// Covers: R21`) |
| Prosa ausente en un engine | Anclas `claude` y `codex` de `orchestrator`, `scribe`, `reviewer` y `planificacion`, con y sin `scribeOwnsMarkdown` (`// Covers: R21, R22, R24`) |
| Permiso faltante | `asset-command-permissions.test.ts` (`// Covers: R21`) |
| Presupuestos | `check:doc-budgets`, `check:assets` |

## NOT in scope

- Instalar, escribir o validar el contenido de git hooks nativos.
- Detectar en tiempo de ejecución si el hook nativo corrió (decisión del usuario).
- Gate y lectura en paralelo (M2 de la auditoría).
- Usar el resultado del `git commit` como veredicto del hook nativo en la auditoría.
- Extender la unión de archivos de `classify --diff` a workplans (D9).
- `nativeHooks` por workspace de monorepo.
- El engine `pi`: no verifiqué si registra estos hooks. Hereda el contenido del script si lo
  registra.
- Evidencia con comparación en Codex (sigue en `unevidenced`).
- Un `deny` de escritura sobre `*.evidence.jsonl` (D11).
- `master-plan` (`parts.json` tiene su propio `AcceptanceCriterionSchema`).

## Open questions

- **[resuelto 2026-10-08]** `hooks:install` desde `prepare` (D4) y la lista de `criticalPaths` (D9).
- **[assumed]** `contains`/`matches` implican exit 0.
- **[assumed]** Tope de 20000 caracteres para `request`.

## Durable knowledge

- **"La duplicación con el hook nativo se quita por config versionada; navori detecta en `doctor`,
  nunca decide en tiempo de ejecución ni instala hooks".** Destino propuesto: `docs/DIRECTION.md`,
  un bullet en "Unidad de PR y de verificación". Detalle en el JSDoc de `detectNativeHooks`.
- **"El gate completo corre en la ronda que firma; el carril acotado es `navori.scopedGate` + `A<n>`".**
  Destino propuesto: prosa de `reviewer` y JSDoc de `decideWorkplanGate`.
- **"La evidencia guarda el resultado de la comparación, nunca la salida ni su hash; decide la
  línea más nueva".** Destino propuesto: header de `bash-outcome.sh` y JSDoc de `validateEvidence`.
- **Enmienda de 0030 R5/R8.** Destino propuesto: nota en
  `specs/0030-scribe-owns-markdown/requirements.md`.

## Entregas propuestas

Hay 25 `R<n>`, unas 20 tareas y ≈3600 LOC (> 1500), con cuatro capacidades. Por las reglas de la
0044 la forma es `split` en 4 PRs (≤ `maxPrsPerSpec`). Cada entrega se puede publicar sola cuando
las anteriores están mergeadas, pasa `check:doc-budgets` por su cuenta y trae sus propias anclas de
prosa para los dos engines (su parte de R24). Ninguna es `foundation`.

| Entrega | Capacidad demostrable | `R<n>` | LOC est. |
|---|---|---|---|
| **E1** — El gate completo corre una vez por aprobación | Una ronda `CHANGES_REQUESTED` corre el `scoped` de este repo (`check:scoped`, 8 s medidos, sin tests) y no `full`. Un workplan de nivel 2 con fases pendientes da `scoped` con `pendingLater` y commit-only. `full` está ordenado y `typecheck` entra en `fast`. Incluye la calibración de rondas por ciclo antes y después (D6) | R8–R11, R23, R25, R24 (su prosa) | 1000 |
| **E2** — Los checks mecánicos viven en el hook nativo | Con la declaración `nativeHooks` de este repo, un `git commit` del agente corre `check:fast` una sola vez (el nativo) y conserva el tope de `progress/current.md`. `settings.json` no registra hooks de calidad duplicados. `doctor` reconoce el hook de `.git/hooks` y da error en un clon sin `hooks:install`. La auditoría muestra `native-hook` | R1–R7, R24 (fila de matriz) | 1150 |
| **E3** — La aceptación compara contra lo esperado | Un `A<n>` con `contains:` cuyo comando no imprime el texto no se puede marcar `cumplido`. La línea de evidencia no lleva la salida. `navori plan check` lo reporta como finding sin romper master-plan. `request` aparece en el plan renderizado | R15–R20, R24 (su prosa) | 1000 |
| **E4** — El ciclo de un cambio chico es proporcional | Un `nivel-0:` sin `verify:` se niega. Con `verify:`, un archivo trivial recibe el review ligero y un `criticalPath` el completo. `impl_<f>.md` sale de `navori handoff render` sin despachar al scribe. Un nit tras `APPROVED` va al PR | R12–R14, R21, R22, R24 (su prosa) | 450 |

Total estimado: unas 3600 LOC.

- **Orden por dependencia y valor.**
  - E1 primero: no depende de nada y es la mayor ganancia medida, porque cada corrida de `full`
    evitada son ≈400 s.
  - E2 no depende de E1. Va segunda porque D4 usa el `fast` nuevo de E1 para que el `check:fast` del
    hook nativo cubra lo declarado.
  - E3 es independiente.
  - E4 va al final: usa `parseExpected` de E3 para validar `verify:`. Sin E3 aceptaría texto libre,
    así que también se puede publicar sola.
- **Prosa compartida.** La tabla de D6 (E1) no menciona `verify:`; E4 agrega esa línea. La prosa de
  `scribe` y el nit (R21, R22) va con E4 porque los dos acortan el ciclo de un cambio chico.
- **Tensión con la memoria del usuario** ("PRs close whole issues"). La 0044 manda partir en
  entregas una spec que supera los umbrales. Si el usuario prefiere un solo PR, la forma es `single`
  con `merged-deliveries`.

## Fuentes

- Claude Code hooks reference: https://code.claude.com/docs/en/hooks. Forma de `PostToolUse` y
  `PostToolUseFailure`; `error` abre con `Exit code N`. Consultada el 2026-10-08.
- Vitest CLI: https://vitest.dev/guide/cli. Consultada el 2026-10-08.
- husky v9: https://raw.githubusercontent.com/typicode/husky/main/index.js (stubs de `.husky/_`,
  `core.hooksPath`) y https://raw.githubusercontent.com/typicode/husky/main/husky (el script `h` sale
  0 si `.husky/<hook>` no existe o si `HUSKY=0`). Consultadas el 2026-10-08.
- `git rev-parse --git-path hooks` con `core.hooksPath` relativo en worktrees: probado localmente
  con git 2.54.0 (Apple Git-157) el 2026-10-08.
