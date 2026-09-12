# Lecciones de claude-code-harness (CCH) para navori

> Auditoría del repo [Chachamaru127/claude-code-harness](https://github.com/Chachamaru127/claude-code-harness)
> — v5.15.0, snapshot 2026-09-10, MIT — desde la perspectiva de navori.
>
> El objetivo no es copiar CCH: es destilar las decisiones de cableado y las
> tácticas de guardrail que ya pagaron su costo de iteración allá, y usarlas
> como sanity check de lo que navori ya definió (managed blocks, engine
> adapters, `guard-destructive`, agentes leader/implementer/reviewer).
>
> Las citas de rutas, comandos, IDs de regla y nombres de campo son literales
> del repo en ese snapshot. Lo que es lectura nuestra va marcado como tal.

---

## TL;DR

CCH es el proyecto más cercano a navori que hemos auditado: mismo problema
(un harness multi-agente que debe correr igual en Claude Code, Codex, Cursor y
Grok), resuelto con **arquitectura opuesta en la capa de render** y
**bastante más profunda en la capa de seguridad**.

Las cinco cosas que más nos importan, en una línea cada una:

1. **Un binario Go es el dispatcher único de hooks** — el JSON de hooks no tiene
   lógica, sólo 43 grupos de eventos que llaman `bin/harness hook <name>`.
2. **`hosts.toml` es un descriptor declarativo de capacidades por host**, y
   `harness gen` materializa el hook nativo de cada uno apuntando al *mismo*
   motor de políticas. Un motor, N adaptadores.
3. **El guard de comandos tiene un tercer veredicto: "indeterminado"** — si no
   puede probar estáticamente el blanco de un `rm -rf`, no adivina. Eso es
   exactamente el fix del issue #655.
4. **Los agentes se hablan con contratos JSON versionados** (`worker-report.v1`,
   `advisor-response.v1`, `test-wiring-audit.v1`), no con prosa.
5. **El set de `deny` tiene un ratchet criptográfico**: si encoge respecto al
   baseline, el harness no arranca.

Lo que **no** debemos copiar: 355 MB de repo con cuatro binarios de 13 MB
commiteados, un CHANGELOG de 545 KB, un `Plans.md` de 88 KB, y documentación
core bilingüe sin contrato de idioma.

---

## 1. Qué es CCH (contexto)

Plugin de desarrollo para delegar planificación, implementación, validación y
review a Claude Code o Codex. El bucle de producto son **5 verbos**:
`/harness-plan` → `/harness-work` → `/harness-review` → `/harness-sync` →
`/harness-release`, cada uno con su gate. El humano aprueba el contrato
(`spec.md` + `Plans.md`), no lo escribe.

Se instala como plugin de marketplace de Claude Code, y tiene rutas de setup
para Codex CLI, Cursor y Grok. Declara tiers de soporte explícitos
(`supported` / `internal-compatible` / `candidate` / `future/unsupported`) y
una regla que vale la pena robar tal cual:

> `not_observed != absent` — la falta de prueba local significa "no probado
> aquí". No significa imposible, y no significa soportado.

**Diferencia de posicionamiento con navori**: CCH es *el harness*; navori es
*el generador de harnesses*. CCH se instala y te da su bucle; navori renderiza
un harness dentro de tu repo desde `navori.config.json`. Comparten el problema
multi-engine y el problema de guardrails; no compiten en la capa de
distribución.

---

## 2. Mapa rápido del repo

| Superficie | Tamaño | Qué contiene |
|---|---|---|
| `go/` | 403 archivos `.go`, ~55 paquetes internos | El motor: policy engine, runtime floor, hook handlers, hostgen, ledgers |
| `bin/` | 4 binarios × ~13 MB | `harness-{darwin-amd64,darwin-arm64,linux-amd64,windows-amd64.exe}` **commiteados** |
| `skills/` | 23 skills | 5 verbos core + browser, cursor-*, ci, memory, failure-codifier… |
| `agents/` | **5** agentes | `worker`, `reviewer`, `advisor`, `livemsg-gate`, `test-wiring-auditor` |
| `hooks/hooks.json` | 67 KB | 43 grupos de eventos; copia idéntica en `.claude-plugin/hooks.json` |
| `scripts/` | 225 archivos `.sh` | Companions (codex/cursor), resolvers, generadores, validadores |
| `tests/` | 282 archivos | Suite shell que fija el cableado, no sólo la lógica |
| `docs/` | 178 archivos | Contratos, políticas, snapshots fechados de investigación |
| `.claude/rules/` | 22 archivos | Doctrina cargada bajo demanda desde `CLAUDE.md` y prompts de agente |
| `harness.toml` / `hosts.toml` | 7 KB / 10 KB | SSOT de proyecto y descriptor de hosts |

Composición total: 511 `.md`, 430 `.sh`, 403 `.go`, 92 `.ts`. 355 MB en disco.

---

## 3. Cómo resuelven el cableado

### 3.1 — Un dispatcher único, JSON sin lógica

`.claude-plugin/hooks.json` declara ~43 grupos de eventos (`PreToolUse`,
`PostToolUse`, `PermissionRequest`, `SubagentStart`/`SubagentStop`,
`PreCompact`/`PostCompact`, `SessionStart`/`SessionEnd`, `TeammateIdle`,
`TaskCreated`/`TaskCompleted`, `WorktreeCreate`/`WorktreeRemove`,
`Elicitation`/`ElicitationResult`, `InstructionsLoaded`, `PostToolUseFailure`,
`PermissionDenied`, `StopFailure`, `ConfigChange`, `CwdChanged`,
`FileChanged`, `Notification`, `Stop`, `UserPromptSubmit`) y **todos** invocan
la misma forma:

```
bin/harness hook <name>
```

Hay 58 handlers en `go/internal/hookhandler/`: `pre-tool`, `post-tool`,
`memory-bridge`, `tdd-check`, `todo-sync`, `session-register`, `inbox-check`,
`plans-watcher`, `quality-pack`, `runtime-reactive`, `stop-evaluator`,
`writing-lint`, `worktree-create`… El JSON no tiene ni un `if`.

Cada comando trae inline un bootstrap que resuelve el plugin root:

```bash
valid_root(){ [ -x "$1/bin/harness" ] && [ -f "$1/.claude-plugin/plugin.json" ] && grep -q '"name"..."claude-code-harness"' "$1/.claude-plugin/plugin.json"; }
# prueba CLAUDE_PLUGIN_ROOT, CLAUDE_PROJECT_DIR, $PWD, ~/.claude/plugins/marketplaces/..., cache/...
# si ninguno valida: echo "[claude-code-harness] plugin root not found; hook skipped" >&2; exit 0
```

**Fail-open explícito y verificación de identidad del root** (no basta con que
exista el binario: el `plugin.json` tiene que declarar el nombre correcto).

> **Comparación**: navori tiene 10 hooks shell independientes, cada uno con su
> propio parseo de payload resuelto por `navori:include extract-cmd`. El modelo
> de includes evita la duplicación, pero cada hook sigue siendo un proceso
> shell con su propia lógica. El costo del modelo CCH es un binario por
> plataforma; el beneficio es que toda la lógica es Go testeable y el JSON es
> inerte.

### 3.2 — `hosts.toml`: capacidades por host como dato

```toml
[claude]
hook_event = "PreToolUse"
hook_path  = ".claude-plugin/hooks.json"
matcher    = "Write|Edit|MultiEdit|Bash|Read"
deny       = "exit2"
transport  = "stdin-json"
delivery_strategy = "monitor"

[codex]
hook_event = "PreToolUse"
hook_path  = ".codex/hooks.json"
matcher    = "*"
deny       = "permissionDecision"
delivery_strategy = "turn"

[cursor]
hook_event = "preToolUse"
hook_path  = ".cursor/hooks.json"
deny       = "permission"
```

`harness gen` lee ese descriptor y materializa el hook nativo de cada host,
todos apuntando a `bin/harness hook pre-tool --host <h>`. El resultado es lo
que ellos llaman *3cli hook floor*:

```
host native hook → bin/harness hook pre-tool --host <claude|codex|cursor>
                → runtimefloor + R01–R16 policy
                → exit 2 + envelope de deny propio del host
```

Detalles que valen:

- **El mecanismo de deny es un campo, no una rama de código**: `exit2` para
  Claude, `permissionDecision` para Codex, `permission` para Cursor. El codec
  (`go/internal/hookcodec`) traduce un veredicto único al envelope de cada host.
- **`harness gen --check` es el drift gate**: compara lo generado contra lo
  commiteado y sale 1 si difieren. Equivalente a nuestro `check:render`.
- **El `hooks.json` de Claude NO se genera**: se mantiene a mano porque el
  marketplace lo lee directo, pero `--check` verifica que su grupo de guardrail
  siga coincidiendo con `hosts.toml`. Es una excepción declarada, no un olvido.
- Los comentarios del TOML llevan **el registro de medición**: qué versión del
  CLI se midió, qué se observó, qué se refutó de una conclusión anterior y qué
  sigue sin observarse. Ejemplo literal: *"UNTESTED LINK (discovery != firing)"*.

Además hay un segundo SSOT, `hosts/registry.json`, con la metadata de producto
por host: `tier`, `setup_script`, `safety_model`
(`pre_use` / `pre_use_bash_plus_post_gate` / `pre_use_partial_no_fs_jail`),
`floor_member`, `manifest_source`, `bootstrap_route`, `blocked_public_phrases`
y los `smoke` tests que sostienen el tier. Las tablas del README se derivan de
ahí en build time y **los manifests no pueden sobreescribirlas**.

### 3.3 — `harness.toml` + `harness sync`: generación de archivo completo

Un solo TOML con `[project]`, `[env]`, `[livemsg]`, `[safety.permissions]`,
`[safety.sandbox]`, `[tdd]`, `[worker.self_review]`. `harness sync` genera
**archivos completos**: `.claude-plugin/plugin.json`, `hooks/hooks.json`,
`.claude-plugin/settings.json`. Y `permissions.deny` prohíbe editarlos a mano:

```
"Edit(.claude/settings*)", "Write(.claude/settings*)",
"Edit(.claude-plugin/settings*)", "Write(.claude-plugin/settings*)"
```

> **Aquí navori está mejor y conviene decirlo**: el modelo de archivo completo
> sólo funciona si el repo es del harness. navori renderiza **bloques managed
> con hash dentro de archivos que ya son del usuario**, que es lo que permite
> adoptar en un repo con `.claude/` preexistente. Su modelo es más simple; el
> nuestro es el que hace posible el producto.

### 3.4 — Skills: metadata de diseño + gate de CI sobre el grafo

Cada skill lleva el frontmatter oficial (`name`, `description`,
`allowed-tools`, `argument-hint`, `user-invocable`, `disable-model-invocation`,
`context`, `effort`) **más** metadata de diseño propia:

| Campo | Significado | Valores |
|---|---|---|
| `kind` | Tipo | `workflow`, `reference` |
| `purpose` | Qué problema resuelve | texto corto |
| `trigger` | Qué palabras/eventos la cargan | lista |
| `shape` | Cómo se comporta estructuralmente | `dict`, `workflow`, `wrap`, `delegate`, `evaluate` |
| `role` | Responsabilidad en el equipo | `generator`, `executor`, `evaluator`, `orchestrator`, `synchronizer` |
| `base` | A qué skill envuelve/delega | nombre |
| `pair` | Su contraparte natural | nombre |
| `owner`, `since`, `deprecated_in`, `replaces` | Inventario | — |

Ejemplo real (`skills/breezing/SKILL.md`): `shape: wrap`, `base: harness-work`,
`pair: harness-review`, `role: orchestrator`.

**El gate de CI verifica el grafo** (`docs/skill-orchestration-design-contract.md`,
`tests/test-skill-design-contract.sh`):

- las skills core tienen la metadata completa;
- `base` y `pair` resuelven a nombres de skill existentes;
- `shape: wrap` **obliga** a declarar `base`;
- **`role: evaluator` no puede tener tools mutantes** salvo excepción documentada.

Ese último punto es la traducción a máquina de una regla de diseño:
*generador y evaluador se mantienen separados; ninguna skill escribe código y
aprueba su propio trabajo*.

Tres tácticas más del mismo archivo:

1. **Anti-triggers dentro del `description`.** Literal:
   `"...Use when user mentions CI failures... Do NOT load for: local builds,
   standard implementation work, reviews, or setup."`
   El `description` es el SSOT de ruteo (`skills/routing-rules.md`) y la tabla
   "Do NOT Load For" del cuerpo debe coincidir **exacto**. La regla de
   prioridad es: *la exclusión gana siempre*, y *no se usa "juicio de
   contexto" porque genera ambigüedad*.
2. **i18n en el frontmatter**: `description-ja` y `description-en` conviven con
   `description`, con contrato en `docs/i18n-language-contract.md`.
3. **Progressive disclosure por skill.** `SKILL.md` sólo trae entrada,
   auto-selección y condiciones de paro; una tabla rutea al detalle:

   ```
   | Solo / Breezing, 1–17 pasos          | references/execution-modes.md   |
   | Backend role-scoped, topologías      | references/backend-selection.md |
   | Codex review, verdict mapping        | references/review-loop.md       |
   | Sprint Contract, PR closeout         | references/sprint-contract.md   |
   ```

   `harness-review` tiene 12 archivos de referencia, `harness-work` 8,
   `harness-setup` 8. El cuerpo de la skill se mantiene corto a propósito.

### 3.5 — Agentes: pocos, con contrato y con `disallowedTools`

Sólo 5 agentes. Frontmatter mucho más rico que el nuestro:

```yaml
name: worker
tools: [Read, Write, Edit, Bash, Grep, Glob]
disallowedTools: [Agent]          # ← lista negativa además de la positiva
model: claude-sonnet-5
effort: medium
maxTurns: 100
memory: project
isolation: worktree               # ← aislamiento declarado en el agente
skills: [harness-work]            # ← skill precargada
initialPrompt: |
  ...
```

El `reviewer` y el `advisor` llevan `disallowedTools: [Write, Edit, Bash, Agent]`
— read-only reforzado por lista negativa, no sólo por omisión.

**Se hablan con contratos JSON versionados**, no con prosa:

| Contrato | Emisor → receptor | Contenido |
|---|---|---|
| `sprint-contract.json` | Lead → worker | task_id, `files[]` permitidos, DoD, `spec_path`, `validation_commands[]`, `lane`, `stage` |
| `worker-report.v1` | worker → Lead | diff real, evidencia por regla de self-review, `effort_applied`, `turns_used`, pendientes |
| `advisor-request.v1` / `advisor-response.v1` | worker ↔ advisor | `decision: PLAN \| CORRECTION \| STOP` |
| `test-wiring-audit.v1` | auditor → Lead | `verdict: PASS \| ADD_REQUIRED \| APPEAL_REJECTED`, `required_tests[]`, `evidence[]` |
| `livemsg-gate.v1` | gate → transporte | `SEND \| HOLD` |
| `failure-rule.v1` | codifier → humano | patrón + `confidence` + `proposed_ssot_target` |

> **Comparación**: nuestros agentes cierran con `done -> <file>` y el
> orquestador lee el archivo. Funciona, pero el formato del archivo es
> convención, no contrato: nada falla si el implementer omite la evidencia.

### 3.6 — Ruteo de ejecución y de backend

**Modo** (topología) por conteo de tareas, con flags que siempre ganan:

| Tareas | Modo | Razón declarada |
|---|---|---|
| 1 | Solo | overhead mínimo |
| 2–3 | Parallel (Task tool) | umbral donde separar workers empieza a rendir |
| 4+ | Breezing | Lead + workers paralelos + reviewer independiente |

**Backend** (quién implementa) es *ortogonal* al modo: `claude` (subagente
nativo), `codex` (`scripts/codex-companion.sh`) o `cursor`
(`scripts/cursor-companion.sh`). Tres reglas que copiaría:

1. **Se resuelve una sola vez por run**, por un script dedicado
   (`scripts/resolve-impl-backend.sh`), con precedencia explícita:
   flag > env > project file > user file > default `claude`.
   *"No leas `HARNESS_IMPL_BACKEND` directamente para decidir el backend."*
2. **Es role-scoped**: sólo el worker sigue el backend resuelto. Reviewer y
   advisor quedan fijos en Claude. La única excepción permitida es un
   *fresh-context advisory pre-review* de Cursor que puede aportar findings,
   pero **el verdict primario (`APPROVE` / `REQUEST_CHANGES`) sólo lo emite el
   brain**.
3. **Si el backend no es `claude`, no se spawnea worker**: el Lead llama al
   companion directo, el gate de self-review pasa a N/A y el diff review del
   Lead se vuelve el único gate — **y eso está escrito**, no implícito.

Y una tabla de `effort` por complejidad, con el candado correcto:

| Score | Riesgo de código | Effort |
|---|---|---|
| 0–2 | — | `medium` (default del frontmatter) |
| ≥ 3 | no | `high` |
| ≥ 3 | sí (core/guardrails/security/architecture/migration) | `xhigh` |

> *"El score de complejidad es material para revisar la decisión, no permiso
> para cambiar automáticamente un effort explícito."* Y: **no inyectar
> marcadores free-text tipo `ultrathink` en el prompt de spawn.**

### 3.7 — Estado: ledgers append-only

Todo el estado vive en `.claude/state/*.jsonl`, append-only y **fail-open**
(un fallo de escritura nunca bloquea el flujo; `AppendFailOpen` se traga el
error, la versión shell sale 0 con un warning a stderr):

`judgment-ledger.jsonl` · `orchestration-ledger` · `destructive-delete.jsonl` ·
`deferred-ops.jsonl` · `tdd-red-log/<task-id>.jsonl` ·
`skill-trigger-stats.jsonl`

El judgment ledger además tiene **recall**: al armar una decision card, busca
hasta 3 decisiones pasadas similares del **mismo proyecto** (el filtro por
proyecto es estructural, no hay modo cross-project en v1) y las inyecta como
`similar_past_decisions`.

### 3.8 — `.claude/rules/`: doctrina bajo demanda

22 archivos referenciados desde `CLAUDE.md` y desde los prompts de agente. El
`worker`, antes de tocar código, tiene instrucción literal de leer
`.claude/rules/test-quality.md` y `.claude/rules/implementation-quality.md`.

Es el mismo patrón que nuestro `.claude/context/*.md` + "dónde vive la
profundidad", pero con dos diferencias: (a) los rules están escritos como
**post-mortems codificados** (cada uno abre con "por qué existe esta regla" y
el incidente que la originó), y (b) el agente los carga por instrucción
explícita en su `initialPrompt`, no por criterio.

---

## 4. La capa de seguridad (donde están más adelante)

Dos capas deliberadamente asimétricas:

| Capa | Decide | Configurable |
|---|---|---|
| **Runtime floor** — 5 categorías | permite/deniega con reglas por categoría | Sin switch global de apagado; sólo allowlists acotadas |
| **Guardrails** — R01–R16 | `deny` / `confirm` / `warn` | Parcialmente, por config de proyecto |

El floor cubre: **billing, egress de red, lectura de secretos, deploys a
producción, y destrucción fuera del worktree de la tarea**. Sus allowlists son
configuración *protegida del operador*: **el agente no puede reescribirlas para
que su propio trabajo pase**.

### 4.1 — El motor de reglas: declarativo, puro, con ID

`go/internal/policy` es un paquete **puro** (sólo stdlib + `hookproto` +
`shellscan`), sin dependencias de config ni de estado. Cada regla es un par
`(toolPattern, evaluate)`, se evalúan en orden y **gana la primera que
matchea**.

| ID | Regla | ID | Regla |
|---|---|---|---|
| R01 | `no-sudo` | R09 | `warn-secret-file-read` |
| R02 | `no-write-protected-paths` | R10 | `no-git-bypass-flags` (`--no-verify`, `--no-gpg-sign`) |
| R03 | `no-bash-write-protected-paths` | R11 | `no-reset-hard-protected-branch` |
| R04 | `confirm-write-outside-project` | R12 | `confirm-direct-push-protected-branch` |
| R05 | `confirm-rm-rf` | R13 | `warn-protected-review-paths` |
| R06 | `no-force-push` | R14 | `test-required-for-src-write` (TDD) |
| R07 | `codex-mode-no-write` | R15 | `no-stage-secret-file` |
| R08 | `breezing-reviewer-no-write` | R16 | `no-self-approve-deferred` |

El ID viaja en el mensaje de deny y en el decision log, así que el operador
puede inspeccionar exactamente qué regla, categoría y verdict frenó una
operación.

**Detalle de defensa en profundidad ganado por re-verificación adversarial**:
R08 bloquea `ln` además de `rm`/`mv`/`cp -r`/`tee`, porque en 2026-08-11
demostraron que un `ln -s` dentro de la excepción de `.claude/state` permitía
escribir a cualquier archivo del repo a través del symlink. El lado de
escritura se tapó con `EvalSymlinks` **y** el lado de creación aquí.

### 4.2 — `shellscan`: el tercer veredicto ⭐

`go/pkg/shellscan` (~900 líneas + corpus de tests) separa dos preguntas que
navori hoy resuelve como una sola:

```go
DangerousRemoval(command)                    -> (bool, targets []string)
RemovalContextIndeterminate(command, targets) -> bool
```

La segunda responde: *¿puede la ejecución del shell agregar blancos, mover la
base de un blanco relativo, o seguir symlinks más allá de lo que devolvió la
primera?* Devuelve `true` si hay backticks, `<(...)`, `xargs`, o un pipe
**cuando algún blanco es relativo** (con todos los blancos absolutos, la base no
se puede mover y cada segmento se extrae independiente — está razonado y
verificado en el comentario del código).

Y dos funciones que resuelven clases enteras de falso positivo/negativo:

- **`StripNonExecutableText`**: quita comentarios y cuerpos de heredoc —
  **pero conserva el cuerpo si el opener tiene un intérprete**, incluyendo el
  caso `cat <<EOF | bash`. Un marcador de heredoc entrecomillado no puede
  usarse para esconder comandos (hay test dedicado).
- **`ExpandLiteralAssignments`**: resuelve `VAR=/tmp/x; rm -rf "$VAR"` a su
  blanco literal antes de decidir.

Complementos: `IsWithinSessionScratch(path, sessionID)`,
`IsAllowlistedTempPath(path)` (ambos con tests de colisión de prefijo y de
symlink en `$TMPDIR`/`$HOME`), `ResolveCommandForAnalysis`,
`InspectVerbInvocations` (para distinguir `cat` de lectura de `cat` con
redirect de escritura).

> **Aplicación directa a navori (#655)**: nuestro `guard-destructive.sh` (839
> líneas) ya hace segmentación por línea, normalización de wrappers y
> contenido inerte, y documenta honestamente sus límites (`sh -c`, `eval`,
> ofuscación base64). Lo que le falta es **no forzar veredicto binario**: hoy
> bloquea o pasa. El modelo de CCH es bloquear sólo lo que puede *probar*, y
> mandar lo indeterminado a la política (`warn` / `ask` / `defer`).

### 4.3 — Deferred-ops: un deny que no mata el run ⭐

`destructiveDelete = "warn" | "ask" | "defer"` en `harness.toml`. Los tres
modos, con el razonamiento tal como está escrito en el TOML:

- **`warn`** (default desde v5.11.0, HOTL): deja pasar, avisa y registra en
  `.claude/state/destructive-delete.jsonl`. **Pero sigue en `ask`** si el
  blanco está fuera del root, tiene `..`, tiene `$VAR` sin resolver, tiene glob,
  o es un `.` / `/` pelado.
- **`ask`**: confirmación previa. Es el opt-out recomendado para repos con
  datos no versionados bajo el root, o cuando estás desarrollando el guardrail
  mismo.
- **`defer`** (para runs desatendidos): lo que sería `ask` se convierte en
  `deny` + encolado en `.claude/state/deferred-ops.jsonl`. **El deny no
  detiene el run.** Al agente se le devuelve un contrato de conducta explícito:

  > no reintentar · continuar con otras tareas · reportar la lista de
  > pendientes al terminar

  El operador aprueba fuera de banda: `bin/harness deferred list` y
  `bin/harness deferred approve <id>`, y la aprobación **vale para un solo
  uso**. Reintentos del mismo comando no duplican la cola.

Y el candado: **R16 `no-self-approve-deferred`** impide que el agente ejecute
el comando de aprobación. El mensaje de deny es instructivo, no sólo
prohibitivo:

> *"R16: approving a deferred op is operator-only. Report the pending queue
> (`bin/harness deferred list`) and ask the operator to run the approve command
> themselves."*

### 4.4 — Ratchet del set de `deny` ⭐

`go/internal/selfaudit` normaliza `permissions.deny` (sorted + unique + JSON
canónico), le saca SHA-256 y lo compara contra un baseline versionado en el
repo (`templates/security/deny-baseline.json`):

> **igual o mayor pasa; menor rechaza el arranque.** El baseline sólo lo
> actualiza un humano.

```
bin/harness self-audit baseline --settings .claude-plugin/settings.json \
                                --baseline templates/security/deny-baseline.json
```

Complemento en la misma familia — y este es el vector que más me gustó:

```
bin/harness self-audit hooks --file .claude/settings.local.json
```

`settings.local.json` está gitignored, **nunca pasa por code review**, y admite
hooks tipo `command`. Es el lugar perfecto para inyectar ejecución persistente.
El self-audit lo lee y detecta hooks no reconocidos contra un allowlist de
fingerprints conocidos (`CCHKnownHooks`).

La integridad se ancla con un marcador al final del `CLAUDE.md`:
`<!-- harness-integrity: last-audit=2026-05-18 -->`, que **sólo el humano
actualiza; el agente lee y detecta, nunca escribe**.

### 4.5 — Blast radius de las capas de defensa ⭐

`.claude/rules/defense-layer-blast-radius.md` — escrito después de romper
sesiones ajenas **dos veces el mismo día** (2026-08-10):

| Incidente | Qué metieron | Qué rompió |
|---|---|---|
| 1º | `sandbox.filesystem.denyRead` sobre el directorio de config de `gh` | `gh` no pudo leer su config → murió el credential helper de git → `git push` caído ~30 min en otra sesión |
| 2º | `sandbox.enabled: true` | El bloqueo de DNS por default y el deny de lectura de config SSH dejaron sin resolver los alias de `ssh_config` → otra sesión sin acceso a producción |

El 2º fue *hard fail* porque en el mismo cambio movieron
`Bash(dangerouslyDisableSandbox:true)` de `ask` a `deny` — **taparon la salida
de emergencia junto con el agujero**.

La tabla de alcance:

| Capa | Qué fuerza | A quién alcanza | Daño si se equivoca |
|---|---|---|---|
| `permissions.deny/ask/allow` | llamadas a tools | **sólo al agente**; sus subprocesos no | el agente pierde una operación; las herramientas externas intactas |
| guardrail hook (R01–R16 + floor) | `PreToolUse` sobre llamadas del agente | **sólo al agente** | se frena el trabajo; matchea strings, así que es propenso a falso positivo |
| `sandbox` (Seatbelt / aislamiento OS) | acceso a FS y red del proceso | **el OS lo impone a todo el árbol de procesos** | CLIs, daemons y subprocesos ajenos dejan de funcionar |

**El principio**: *a mayor fuerza de la capa, más angosto su alcance.* La
misma prohibición de lectura duele en órdenes de magnitud distintos según
dónde la pongas. Orden recomendado: `permissions.deny Read(...)` primero →
runtime floor si hay que tapar la vía Bash → `sandbox.filesystem` sólo cuando
se demostró que las dos anteriores no alcanzan.

Checklist de 5 puntos antes de agregar una defensa:

1. **¿Qué proceso legítimo lee hoy esa config?** Bloquear un directorio
   completo se lleva por delante al dueño de la herramienta. La misma trampa
   está en `~/.config/gh`, `~/.npmrc`, `~/.ssh`, `~/.docker/config.json`,
   `~/.aws`, `~/.fly`, `~/.vercel`, `~/.wrangler`, `~/.kube`.
2. **¿Es el secreto, o una config que contiene el secreto?** Lo primero se
   bloquea por archivo; lo segundo, si lo bloqueas por directorio, apaga la
   herramienta.
3. **En capas default-deny, lo que rompe es lo que no escribiste.** La red del
   sandbox deniega todo por default, DNS incluido.
4. **¿Estás tapando la salida de emergencia en el mismo cambio?** Una cosa a
   la vez.
5. **¿Qué dice la doc que ya tienes?** Buscar en el repo antes de investigar
   afuera suele ser más rápido.

Y el asimétrico que cuesta caro descubrir solo:

> **Las restricciones se heredan; las exenciones no.**
> `git push` → lanza `gh` como credential helper → `gh` hereda el sandbox del
> padre **aunque `gh` esté en `excludedCommands`**, porque `excludedCommands`
> matchea el nombre del comando invocado, no de sus hijos.

Cierra con una regla de despliegue escalonado: todo lo que pueda afectar
procesos externos entra primero al `.claude/settings.json` de **un** proyecto,
se prueba el camino real (`git push`, `npm install`, `ssh`) y sólo después se
promueve a user scope.

### 4.6 — Paridad medida, no asumida

En su `CLAUDE.md` documentan, **con fecha de medición (2026-08-11)**, qué hace
realmente cada capa por regla — y admiten dónde la "doble defensa" es mito:

| Regla | Capa `permissions` | Guardrail (medido) |
|---|---|---|
| `.claude/settings*`, `.claude-plugin/settings*` | `deny` | R02/R03: **permite con warning** |
| `.github/workflows/*` | `deny` | R13: **permite con warning** |
| `git push --force` | `deny` | R06: `deny` (**doble defensa real**) |
| `git reset --hard` | `deny` | R11: `deny` **sólo si referencia rama protegida**; `HEAD~1` pasa |
| `git add <secret>` | — | R15: `deny` |

> *"El rol de las capas es asimétrico. Muchas filas NO son doble defensa."*

Lo mismo por host en `docs/hardening-parity.md`, con la regla explícita de
**prohibido declarar false parity**, y una nota que vale como modelo:
*"Grok hoy está fuera del floor. No se debe afirmar deny de nivel PreToolUse
para Grok."*

---

## 5. Calidad de la implementación (los gates)

### 5.1 — `self_review` con evidencia y rebote automático ⭐

En `harness.toml`:

```toml
[worker.self_review]
default_rules = [
  "dry-violation-none",
  "plans-cc-markers-untouched",
  "all-declared-symbols-called",
  "dod-items-verified-with-evidence",
  "no-existing-test-regression",
  "tdd-red-evidence-attached",     # activa sólo si [tdd.enforce].enabled = true
]
extra_rules = []
max_retries_before_escalate = 2
```

El worker devuelve en `worker-report.v1` un
`self_review[] = {rule, verified: true, evidence: "<salida real del comando>"}`.
**El Lead rebota automáticamente al worker, sin spawnear reviewer, si alguna
regla viene con `verified: false` o `evidence: ""`.** Máximo 2 rebotes en la
misma sesión; al tercero escala.

Es barato (no gasta un reviewer en trabajo obviamente incompleto) y convierte
"revisé mi trabajo" de declaración a artefacto.

Su `preflight` del worker es la versión en prosa del mismo control — 7 puntos
antes de correr los comandos de validación, incluyendo *"no metiste refactors
ajenos a la tarea"* y *"puedes explicar cada cambio desde el diff"*.

### 5.2 — TDD con evidencia máquina-verificable ⭐

`[tdd.enforce]` con `level = "off" | "central" | "max"`,
`default_max_red_log_age_minutes = 60` y `bypass_audit_required = true`.

Lo importante: **qué cuenta como prueba de la fase Red**. Sólo dos cosas:

1. un registro `FAIL` en `.claude/state/tdd-red-log/<task-id>.jsonl`, o
2. la salida **literal** del test fallando, pegada en el briefing o el reporte.

Y el skip está tipado, no es un boolean: `[tdd:skip:<reason>]` o
`skip_tdd_reason`; sin razón no hay skip. Si no hay framework de tests,
`skip_tdd_reason: "no-test-framework-detected"`.

### 5.3 — `test-wiring-auditor`: el auditor de la red de tests ⭐

Agente **fresh-context** (no hereda ni conversación ni memoria de la sesión de
implementación) que responde una sola pregunta: *¿la red de tests siguió al
diff?* Sus tres primeros pasos son fijos: correr el pase mecánico
(`scripts/test-wiring-audit-core.sh --base --head`), leer la regla
(`.claude/rules/workflow-test-wiring.md`) y leer cada archivo de superficie de
producto que cambió.

Dos mecanismos que copiaría tal cual:

- **Apelación acotada a 1.** `appeal_round >= 2` → `verdict:
  APPEAL_REJECTED`, sin re-analizar. Cada cadena de invocación tiene techo:
  1 pase de auditoría + 1 arbitraje de apelación.
- **Lista literal de propuestas prohibidas.** El auditor **no puede** proponer:
  quitar la invocación de un test, agregar `|| true`, convertir a `set +e`, o
  reducir la cantidad de asserts. Está enumerado como `forbidden`, no dejado al
  criterio.

El gate de PR es binario: si el veredicto es `ADD_REQUIRED`, el PR no mergea
hasta que los `required_tests[]` estén verdes.

Esto es la contraparte estructural de la sección **"Test Tampering
Prevention"** de su `CLAUDE.md`, cuyo enunciado es: *"Absolutamente prohibido:
manipular tests para fingir éxito"*.

### 5.4 — La suite fija el cableado, no sólo la lógica

282 archivos en `tests/`. Los que más se parecen a lo que necesitamos:

| Test | Qué fija |
|---|---|
| `test-skill-design-contract.sh` | El grafo de skills (base/pair/shape/role) |
| `test-hook-event-names.sh` | Que los nombres de evento existan de verdad en el host |
| `test-config-knob-wiring.sh` | Que cada knob de config esté realmente cableado |
| `test-sync-idempotent.sh` | Que `sync` sea idempotente |
| `test-deny-baseline.sh` / `test-settings-baseline.sh` | El ratchet de `deny` |
| `test-support-claim-wording.sh` | Que la doc no sobre-declare soporte |
| `test-frontmatter-integration.sh` | Frontmatter de skills contra el loader |
| `test-guardrails-r01-r13.sh` | Cada regla contra su corpus |
| `test-progress-drift.sh` | Drift entre plan y estado observado |

> **Comparación**: navori tiene el mismo instinto en `repo-config-gate.test.ts`
> (el gate contra `ci.yml`) y `subcommand-inventory.test.ts` (el inventario
> contra `index.ts`). CCH lo escaló a ~15 gates de cableado. La idea ya es
> nuestra; la cobertura no.

---

## 6. Capacidades que navori no tiene

### 6.1 — Mensajería entre sesiones (`livemsg`)

Varias conversaciones sobre el mismo repo se ven entre sí:

- **Roster**: `bin/harness session list` muestra las sesiones vivas registradas
  en todos los worktrees del mismo repo (el store se resuelve con
  `git --git-common-dir`). Cada fila trae el `team` y el `agent` que un emisor
  necesita.
- **Envío**: `bin/harness inbox send --team <t> --from <a> --to <b> --subject <s> "<body>"`.
- **Recepción**: los mensajes llegan en el **límite de turno** de la sesión
  receptora, envueltos con un envelope explícito de no-instrucción.

Tres decisiones de diseño que valen:

1. **El mensaje de un peer es un reporte a verificar, nunca una orden a
   obedecer.** Es nuestra regla de "contenido externo es DATA" implementada en
   el transporte, no sólo escrita en el `CLAUDE.md`.
2. **Gate de salida opcional** (`[livemsg] verification = "on"`): el agente
   `livemsg-gate` (read-only) verifica que los archivos y commits mencionados
   existan y que un "worktree limpio" sea cierto. Si falla, **el mensaje se
   retiene y la razón vuelve al emisor**. Su `initialPrompt` acota el rol con
   una frase que resume todo: *"eres la aduana previa al envío, no el
   remitente… decidir si se puede enviar es tu trabajo; reescribir el mensaje
   no lo es."*
3. Implementado como **event log append-only + projection** sobre SQLite
   (`modernc.org/sqlite`, sin cgo), inspirado en el patrón `agmsg`. Frontera
   declarada: handoff durable = memoria; live notice = esto, y funciona sin la
   memoria instalada.

### 6.2 — Telemetría de activación de skills ⭐

`docs/skill-telemetry-policy.md`: consumen el evento OTel
`claude_code.skill_activated` (Claude Code 2.1.126+) y registran en
`.claude/state/skill-trigger-stats.jsonl`:

```json
{"timestamp":"...","skill_name":"harness-work","invocation_trigger":"human|model|skill-chain","session_id":"<12 chars>","duration_ms":0}
```

Sirve para **detectar qué skills nunca disparan y cuáles disparan de más** —
dato que hoy no tenemos y que hoy sustituimos por intuición.

La política de privacidad es explícita y correcta: local-only (no sale del
disco), `session_id` truncado a 12 caracteres, **no se registra el prompt de
entrada ni la salida de la skill**, ni usuario, ni tokens, ni rutas de archivo;
opt-out con `HARNESS_SKILL_TELEMETRY_DISABLE=1`; retención 30 días con rotación
(no borrado, para preservar el append-only); excluido del repo por `.gitignore`.

### 6.3 — `failure-codifier`: bucle de auto-aprendizaje

Mina el orchestration ledger y el judgment ledger buscando fallas recurrentes,
y emite propuestas `failure-rule.v1` con confidence:

- `count >= 3` → `medium`; `count >= 5` → `high`
- Sugiere destino (`proposed_ssot_target`: `patterns.md` o `decisions.md`)
- **La promoción al SSOT es proposal-only: prohibida estructuralmente la
  auto-promoción.** El codifier no tiene `Write` sobre esos archivos ni
  siquiera después de aprobación humana — la escritura la hace otro flujo.

### 6.4 — Superficies de decisión para no-técnicos

Tres vistas HTML de una sola pantalla, generadas desde schemas versionados
(`plan-brief-context.v1`, `progress-snapshot.v1`, `acceptance-context.v1`):
**Plan Brief** (al cerrar el plan: entendimiento, opciones, riesgos, criterios
de aceptación), **Progress** (durante el trabajo) y **Acceptance** (antes del
release: pass/fail por criterio con ship / wait / reject).

Con una honestidad que conviene imitar: *"el porcentaje de completitud es una
razón de conteo de tareas, no una tasa de aceptación ni un estado de
implementación detectado automáticamente"*.

### 6.5 — Disciplina de claims públicos

`docs/public-claims-contract.md` + `scripts/validate-publication-records.py`:
el README, la landing y el copy de release sólo pueden describir comportamiento
verificado contra la implementación actual. Los tiers por host se derivan de
`hosts/registry.json` en build time y **los manifests no pueden
sobreescribirlos**. Evidencia faltante o vieja es `unavailable`, **no** prueba
de que el claim sea cierto: *fail closed*.

---

## 7. Anti-patrones de CCH (qué NO copiar)

### 7.1 — Binarios commiteados

`bin/` tiene 4 binarios de ~13 MB (53 MB) versionados. De ahí salen commits
como *"chore: rebuild binaries after comment-only source change (drift gate)"*
y *"chore: rebuild 4 platform binaries"*. El repo pesa 355 MB. Es el precio de
"no requiere Node.js": distribuyes el binario o pides toolchain.

### 7.2 — Documentación que se desincroniza

`docs/ARCHITECTURE.md` describe una capa `profiles/` y "30+ skills" que ya no
existen (hay 23 y no hay `profiles/`). El `CHANGELOG.md` pesa 545 KB y
`Plans.md` 88 KB. `docs/` tiene 178 archivos, muchos snapshots fechados de
investigación (`upstream-update-snapshot-2026-05-*.md`) que nadie va a releer.

**Lectura nuestra**: el mismo instinto que produce sus mejores documentos
(escribir la medición, no la conclusión) produce este pantano cuando no hay
política de archivado. Ellos la tienen para `Plans.md`
(`.claude/memory/archive/Plans-*.md`, 30 archivos) pero no para `docs/`.

### 7.3 — Bilingüe sin contrato de idioma en el core

El `CLAUDE.md`, los `initialPrompt` de los agentes y buena parte de
`.claude/rules/` están en japonés; el README, los contratos de skills y los
prompts de Codex en inglés. Tienen `docs/i18n-language-contract.md` para la
salida de usuario, pero el **contenido interno** quedó mezclado. Para un
proyecto que se lee en seis meses, eso es deuda.

### 7.4 — Superficie de comandos amplia

23 skills, de las cuales 5 son el producto (`plan`/`work`/`review`/`sync`/
`release`) y el resto son adaptadores (`cursor-ask`, `cursor-do`,
`cursor-review`, `cursor-setup`), utilidades (`ci`, `maintenance`, `memory`,
`agent-browser`) y una skill de redacción en japonés
(`japanese-writing-drafter`) que claramente es de su autor, no del producto.
El README pelea contra eso vendiendo "5 verbos"; el repo dice otra cosa.

---

## 8. Comparación navori ↔ CCH

| Eje | navori | CCH | Quién va mejor |
|---|---|---|---|
| Render en repo ajeno | bloques managed + hash + anti-rollback | archivo completo generado + `deny` sobre editar | **navori** (es lo que hace posible adoptar) |
| Motor de hooks | 10 hooks shell + includes | 1 binario Go, 58 handlers | **CCH** (testeable, JSON inerte) |
| Adaptadores multi-engine | engine adapters en código | `hosts.toml` declarativo + `gen --check` | **CCH** (capacidad como dato) |
| Ruteo de tarea | por señal (R1/R2/R2-fan/R3, áreas críticas, regla de 4 archivos) | por conteo de tareas | **navori** (contar tareas no sabe si tocas el render) |
| Contrato entre agentes | `done -> <file>` (convención) | JSON versionado (`*.v1`) | **CCH** |
| Guard de comandos | `guard-destructive.sh`, veredicto binario | `shellscan` + veredicto indeterminado + cola diferida | **CCH** |
| Presets / plugins detectados | 12 presets + 7 plugins + registry | no existe esa capa | **navori** |
| Doctrina de capas de defensa | implícita | `defense-layer-blast-radius.md` | **CCH** |
| Memoria | Engram (MCP, cross-repo) | harness-mem opcional + ledgers locales | empate (modelos distintos) |
| Telemetría de skills | no hay | ledger OTel local | **CCH** |
| Higiene del repo | monorepo pnpm limpio | 355 MB, docs desincronizada | **navori** |

---

## 9. Roadmap propuesto: qué incorporar y en qué orden

### P0 — cae en trabajo ya abierto

1. **Tercer veredicto en `guard-destructive` (issue #655).**
   Separar "¿es forma destructiva?" de "¿puedo probar el blanco?". Cuando el
   contexto sea indeterminado (blanco relativo + pipe/subshell/backtick/`xargs`),
   no bloquear ni pasar: rutear a `ask`. Sumar expansión de asignaciones
   literales (`VAR=…; rm -rf "$VAR"`) y conservar cuerpos de heredoc que van a
   un intérprete.
   *Referencia*: `go/pkg/shellscan/shellscan.go` — `DangerousRemoval`,
   `RemovalContextIndeterminate`, `StripNonExecutableText`,
   `ExpandLiteralAssignments`.

2. **Modo `defer` + cola de pendientes.**
   Config `destructive.mode = warn | ask | defer`. En `defer`: deny + encolar +
   devolver al agente el contrato de conducta (no reintentar, seguir, reportar
   al cerrar). Aprobación fuera de banda, de un solo uso, y una regla que
   impida al agente auto-aprobarse. Resuelve el patrón "el guard dudó y la
   sesión se murió".

### P1 — barato y de alto valor

3. **Ratchet del set de `deny` + detección de hooks en `settings.local.json`.**
   Hash canónico contra baseline versionado; menor → falla. Y leer
   `settings.local.json` buscando hooks `command` no reconocidos, que es el
   archivo que nunca pasa por review. Encaja con el anti-rollback de bloques
   managed que ya tenemos.

4. **`blast-radius` como bloque managed de doctrina.**
   La tabla de alcance por capa, el principio "a mayor fuerza, menor alcance",
   el checklist de 5 puntos y el asimétrico de herencia. navori **escribe
   permissions y hooks en repos ajenos**: es la doctrina que más nos falta por
   escrito.

5. **Tabla de paridad medida.**
   Documentar, con fecha de medición, qué hace realmente cada capa por regla en
   nuestro harness — y dónde la "doble defensa" que sugiere el `CLAUDE.md` no
   existe.

### P2 — cambios de contrato

6. **Metadata de diseño en skills + gate en la suite.**
   Agregar `shape` / `role` / `base` / `pair` al frontmatter de las skills core
   y un test que verifique el grafo: referencias que resuelven, `wrap` con
   `base`, y **`role: evaluator` sin tools de escritura**. Convierte el
   catálogo en grafo verificable y hace imposible que un evaluador escriba.

7. **Anti-triggers en las descripciones de skill.**
   Sumar un `Do NOT use for:` explícito a las skills que se pisan entre sí
   (`review-diff` vs `security-guidance`, `structural-search` vs `debug-error`).
   Barato, y la regla "la exclusión gana" elimina ambigüedad de ruteo.

8. **Contratos de salida versionados para agentes.**
   Reemplazar la convención `done -> <file>` por un envelope mínimo con
   `schema_version`, `verdict` y `evidence[]`, al menos para `reviewer` y
   `ticket-audit`. Hoy nada falla si el agente omite la evidencia.

9. **`self_review` con evidencia + rebote sin reviewer.**
   Lista de reglas en config, el implementer devuelve `{rule, verified,
   evidence}`, y el orquestador rebota si falta evidencia — máximo 2 veces.

### P3 — capacidades nuevas

10. **Telemetría de activación de skills.** Ledger local desde el evento OTel,
    con la política de privacidad de CCH copiada tal cual (local-only, sin
    contenido, opt-out, retención). Alimentaría a `navori audit` para detectar
    skills muertas.
11. **Red-log de TDD** como evidencia máquina-verificable para el gate.
12. **Auditor de red de tests** fresh-context, con apelación acotada a 1 y
    lista literal de propuestas prohibidas.
13. **Codificador de fallas**: minar `progress/` + engram buscando patrones
    recurrentes, proponer reglas con confidence, promoción sólo con aprobación
    humana.

---

## 10. Cierre

CCH no es nuestro competidor: es el **otro extremo del mismo problema**. Ellos
construyeron *un* harness excelente y luego tuvieron que hacerlo portable;
nosotros construimos el **generador** de harnesses y tenemos que llenarlo de
contenido igual de bueno.

Lo que más deberíamos internalizar no es una feature suelta, sino **su
disciplina de evidencia**: `not_observed != absent`, medir la paridad en vez de
asumirla, escribir en el comentario del código qué se observó y qué se refutó,
y codificar cada incidente como regla con su post-mortem al principio. Esa
disciplina es la que produce cosas como el tercer veredicto de `shellscan` o el
ratchet del `deny` — no al revés.

Y lo que **no** debemos copiar es su relación con el peso: 355 MB, binarios
versionados, un CHANGELOG de medio mega y una `ARCHITECTURE.md` que describe
una arquitectura que ya no existe. navori vende reproducibilidad; un repo que
no se puede leer en seis meses la contradice.

---

## Apéndice — rutas de referencia rápida

| Tema | Archivo en CCH |
|---|---|
| Descriptor de hosts | `hosts.toml`, `hosts/registry.json` |
| Config de proyecto | `harness.toml`, `claude-code-harness.config.schema.json` |
| Motor de reglas | `go/internal/policy/rules.go` |
| Análisis de shell | `go/pkg/shellscan/{shellscan,removalvars,temproots,agentstate}.go` |
| Runtime floor | `go/internal/runtimefloor/`, `go/internal/floor/` |
| Ratchet de `deny` | `go/internal/selfaudit/selfaudit.go`, `templates/security/deny-baseline.json` |
| Generación por host | `go/cmd/harness/gen.go`, `go/internal/hostgen/`, `go/internal/hookcodec/` |
| Contrato de skills | `docs/skill-orchestration-design-contract.md`, `skills/routing-rules.md` |
| Doctrina de defensas | `.claude/rules/defense-layer-blast-radius.md`, `.claude/rules/self-audit.md` |
| Paridad por host | `docs/hardening-parity.md` |
| Telemetría de skills | `docs/skill-telemetry-policy.md` |
| Mensajería entre sesiones | `go/internal/livemsg/`, `agents/livemsg-gate.md` |
| Auditor de tests | `agents/test-wiring-auditor.md`, `.claude/rules/workflow-test-wiring.md` |
| Claims públicos | `docs/public-claims-contract.md` |
