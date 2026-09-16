# Roster de agentes y skills — Referencias

**Status:** proposed · [`requirements.md`](./requirements.md) · [`design.md`](./design.md) ·
[`tasks.md`](./tasks.md)

Todo lo que la spec afirma sobre herramientas externas, el código o el uso real sale de una de
las fuentes de este archivo. Cada entrada dice dónde está y cómo volver a encontrarla o medirla.
Consultas y mediciones hechas el **2026-09-16**. Las anclas de código se re-verificaron sobre `origin/main` en `5a0bbc34` (la primera versión citaba `3f0fceb0`).

**Cómo buscar una cita.** Las páginas de documentación cambian y los números de línea se
mueven, así que cada cita trae su texto literal y su sección. Para encontrarla, descarga la
versión Markdown (`.md`) y busca la frase:

```bash
curl -sL <url>.md | grep -n "<frase literal>"
```

## 1. Documentación oficial

### Claude Code

Índice completo: <https://code.claude.com/docs/llms.txt>.

| Página | Sección | Cita literal | Sostiene |
|---|---|---|---|
| <https://code.claude.com/docs/en/hooks> | PreToolUse decision control | *"For `"allow"` and `"ask"`, shown to the user but not Claude. For `"deny"`, shown to Claude."* | R10, R11 |
| <https://code.claude.com/docs/en/hooks> | PreToolUse decision control | *"A hook's `"ask"` also forces a permission prompt in auto mode: the classifier can still deny the tool call, but it can't approve the call silently."* | R10 |
| <https://code.claude.com/docs/en/hooks> | PreToolUse decision control | *"Deny and ask rules are still evaluated regardless of what the hook returns"* | R10 |
| <https://code.claude.com/docs/en/hooks> | Hook locations | *"When a subagent calls a tool, tool events such as `PreToolUse` and `PostToolUse` fire the same configured hooks as in the main conversation, and the input carries the `agent_id` and `agent_type`"* | R10, NOT in scope (0023) |
| <https://code.claude.com/docs/en/sub-agents> | Available tools | *"The first filter removes these tools, even when listed in the `tools` field"* (la lista incluye `AskUserQuestion`) | R30, `design.md` (handoff de dos pasos descartado) |
| <https://code.claude.com/docs/en/sub-agents> | Choose a model | *"Claude Code resolves the subagent's model in this order: 1. The per-invocation `model` parameter 2. The subagent definition's `model` frontmatter…"* | `design.md` (tier de `architect`) |
| <https://code.claude.com/docs/en/sub-agents> | Supported frontmatter fields | Fila `effort`: *"Effort level when this subagent is active. Overrides the session effort level."* (no hay parámetro por invocación) | `design.md` (por qué conservar un agente barato) |
| <https://code.claude.com/docs/en/sub-agents> | Built-in subagents | *"A user or project subagent named `Explore` overrides the built-in"* y *"it delegates research to the Plan subagent"* | §1 de requirements (colisiones) |
| <https://code.claude.com/docs/en/skills> | Bundled skills | *"Claude Code includes a set of bundled skills, such as `/doctor`, `/code-review`, `/batch`, `/debug`, `/loop`, and `/claude-api`"*, más la tabla con `/run`, `/verify` y `/run-skill-generator` | R29 (nombres descartados) |
| <https://code.claude.com/docs/en/skills> | Tabla de precedencia | *"Your skill replaces the bundled command, but not its aliases. A project `code-review` skill replaces `/code-review`, and the bundled alias `/review` never runs your skill"* | R29 |
| <https://code.claude.com/docs/en/permissions> | Manage permissions | *"Rules are evaluated in order: deny, then ask, then allow."* | `design.md` (borrador por hook) |
| <https://code.claude.com/docs/en/permissions> | Compound commands | *"An ask rule like `Bash(git clean *)` still prompts you for `cd /tmp && git clean -f` … even in auto mode."* | `design.md` |

### Codex

Las URLs de `developers.openai.com/codex/*` redirigen a `learn.chatgpt.com/docs/*`. Índice
completo: <https://learn.chatgpt.com/llms.txt>.

| Página | Sección | Cita literal | Sostiene |
|---|---|---|---|
| <https://learn.chatgpt.com/docs/agent-configuration/subagents> | Custom agents | *"Codex ships with built-in agents: `default`… `worker`… `explorer`: read-heavy codebase exploration agent."* | §1 (`explorer` descartado) |
| <https://learn.chatgpt.com/docs/agent-configuration/subagents> | Global settings | *"If a custom agent name matches a built-in agent such as `explorer`, your custom agent takes precedence."* | §1 |
| <https://learn.chatgpt.com/docs/agent-configuration/subagents> | Custom agents | *"If a custom agent file sets `model` or `model_reasoning_effort`, the value in the file takes precedence. Before applying the file, Codex resolves each setting from an explicit spawn value, then the corresponding `[agents]` default, then the parent's value."* | `design.md` (tier de `architect`) |
| <https://learn.chatgpt.com/docs/hooks> | PreToolUse | *"`permissionDecision: "ask"`, legacy `decision: "approve"`, `continue: false`, `stopReason`, and `suppressOutput` are parsed but not supported yet. Codex marks the hook run as failed, reports the error, and continues the tool call."* | R13 |
| <https://learn.chatgpt.com/docs/hooks> | Review and trust hooks | *"Codex records trust against the hook's current hash, so new or changed hooks are marked for review and skipped until trusted."* y *"Use `/hooks` in the CLI to inspect hook sources, review new or changed hooks, trust hooks"* | Reset del parque, criterio 3 |
| <https://learn.chatgpt.com/docs/build-skills> | Where Codex loads local skills | *"If two skills share the same `name`, Codex doesn't merge them; both can appear in skill selectors."* y *"such as the skill-creator and plan skills"* | R29 |

### tgrep

- **Repositorio:** <https://github.com/microsoft/tgrep>. Lo confirma `brew info tgrep`.
- **README en crudo:** <https://raw.githubusercontent.com/microsoft/tgrep/main/README.md>.
- **Versión instalada:** 1.0.8.

| Fuente | Cita literal o salida | Sostiene |
|---|---|---|
| README, tabla de flags | *"`-n, --line-number` \| Show line numbers (default: on when stdout is a terminal)"* | Siguiente paso si D19 falla (mensaje con `-n`) |
| README, tabla de flags | *"`--no-index` \| Skip index, grep all files"* | `design.md` |
| README, arquitectura | *"falling back to filesystem scans until the index is ready"* | `design.md` |
| README | *"exits with code `2`"* (solo documentado para `-z`, flag no soportado; no es un contrato general) | Contexto |
| `tgrep search --help` | *"Usage: tgrep search [OPTIONS] <PATTERN> [PATH]..."* y *"exit code only (0 = match found, 1 = no match)"* | Siguiente paso si D19 falla |
| Prueba local | `tgrep search -n -F --no-index -- needle-x <dir>` sale con 0 con coincidencia y con 1 sin ella | Siguiente paso si D19 falla |

### codegraph

- **Repositorio:** <https://github.com/colbymchenry/codegraph>.
- **README en crudo:** <https://raw.githubusercontent.com/colbymchenry/codegraph/main/README.md>.
- **npm:** `@colbymchenry/codegraph` 1.6.0. `npm view @colbymchenry/codegraph repository.url`
  apunta al repositorio.

| Fuente | Cita literal o salida | Sostiene |
|---|---|---|
| README, quick start | *"`codegraph init` creates the local `.codegraph/` directory and builds the full graph in the same step"* y *"you run `codegraph init` once per project"* | `design.md` (Reset del parque) |
| README, benchmark ("Why CodeGraph wins") | *"CodeGraph only helps when queried *directly*, so its instructions steer agents to answer directly rather than delegate exploration to file-reading sub-agents — otherwise a sub-agent reads files regardless and CodeGraph becomes overhead."* | `design.md` (frontera de `scout`), R22 |
| README, installer | *"the MCP server's own guidance only reaches the main agent"* | `design.md` |
| `codegraph --help` | *"explore [options] <query...> Explore an area: relevant symbols' source + call paths in one shot (same output as the codegraph_explore MCP tool)"* | `design.md` |
| `codegraph serve --help` | *"--mcp Run as MCP server (stdio transport)"* | Contexto |

### git

| Fuente | Cita literal | Sostiene |
|---|---|---|
| <https://git-scm.com/docs/git-worktree>, sección REFS (también `git help worktree`) | *"In general, all pseudo refs are per-worktree and all refs starting with refs/ are shared. … refs inside refs/bisect, refs/worktree and refs/rewritten are not shared."* | R31 |

### gh y acli (ayuda local)

| Comando | Qué documenta | Sostiene |
|---|---|---|
| `gh pr comment --help`, `gh issue comment --help` | `-b, --body`, `-F, --body-file`, `-e, --editor`, `-w, --web` | R10, R11 |
| `gh pr review --help` | `-a, --approve`, `-c, --comment`, `-r, --request-changes`, `-b`, `-F` | R10 |
| `gh api --help` | *"The default HTTP request method is `GET` normally and `POST` if any parameters were added"*; `-X, --method`, `-f`, `-F` (*"use \"@<path>\" or \"@-\" to read value from file or stdin"*), `--input` | R10, R11 |
| `gh api graphql -f query='{__schema{mutationType{fields{name}}}}' --jq '.data.__schema.mutationType.fields[].name'` (introspección de solo lectura) | Mutaciones `addComment`, `addDiscussionComment`, `addPullRequestReview`, `addPullRequestReviewComment`, `addPullRequestReviewThread`, `addPullRequestReviewThreadReply` | R10 |
| `acli jira workitem comment --help` | Subcomandos `create`, `update`, `delete`, `list` | R10 |
| `acli jira workitem comment create --help` | `-b, --body` *"plain text or Atlassian Document Format (ADF)"*; `-F, --body-file` *"Plain text file with text or Atlassian Document Format (ADF)"*; `--editor` | R10, R11 |
| `acli jira workitem comment update --help` | `--body-adf` *"Body in Atlassian Document Format (JSON file)"*; `-F, --body-file` *"Plain text file containing comment body"* | R10, R11, R45 |

## 2. Código del repo

Base: `5a0bbc34`. Para ver una línea citada tal como estaba:

```bash
git show 5a0bbc34:<ruta> | sed -n '<desde>,<hasta>p'
```

| Tema | Ubicación |
|---|---|
| Claude no poda agentes | `packages/cli/src/engines/claude/adapter.ts:70-72`, `engines/claude/index.ts:848` |
| Codex poda huérfanos | `packages/cli/src/engines/codex/index.ts:277-294` |
| Reconciliación de retirados | `engines/shared/harness-assets.ts` (`RETIRED_SKILLS`, `RETIRED_HOOKS`), `engines/claude/index.ts:1104-1143` |
| Catálogos de ids | `harness-assets.ts:20` (`CORE_AGENTS`), `:35-49` (`CORE_SKILLS`); `lib/config.ts:24`; `lib/plugins.ts:12`; `lib/legacy-agents.ts:13-34`; `lib/recommended.ts:83`, `:103`; `lib/i18n.ts:2224`, `:3355`; `lib/audit/signals.ts:18` |
| Schema descarta claves | `lib/schema.ts:158-167`; `writeConfig` en `lib/config.ts:254-258` |
| Error de config legible | `lib/cli-config.ts:13` (`readConfigOrExit`, `ConfigError`) |
| Hook de PR actual | `core-assets/hooks/pr-pilot-confirm.sh:4`, `:107`, `:117` (sale sin `jq`), `:126`, `:131`; `engines/claude/build-settings.ts:73`, `:126`; `engines/shared/harness-plan.ts:194` |
| Parser de comandos de hooks | `core-assets/hooks/_partials/gate-trigger.sh:14-16`, `:83-88`; `_partials/extract-cmd.sh:22-28` |
| Codex sin transformar hooks | `engines/codex/index.ts:254-261`; `engines/codex/build-config-toml.ts` (solo `mcp_servers` de plugins) |
| Plugins con `scripts` y `hooks` | `lib/plugins.ts:93-155`; `engines/claude/build-settings.ts:454` |
| Schema de plugin codegraph y tgrep | `packages/plugins/codegraph/plugin.json`, `packages/plugins/tgrep/plugin.json` |
| Receipt en prosa | `core-assets/agents/reviewer.md:75` (gate full), `:87-126` (receipt y delta re-sign), `:99` (`git diff --name-only`); `commit-pr-pilot.md:50-132` |
| Contradicciones del playbook | `core-assets/agents/leader.md:26-31`, `:73`, `:77`, `:169-170`; "operator" como el humano en `core-assets/managed/orquestacion.md:64` |
| Skills citadas | `skills/ticket-intake.md:24`, `:37`; `verify-before-done.md:52`, `:57`; `review-diff.md:36`, `:66`, `:106`; `security-guidance.md:21`; `loop-back-debug.md:60`; `spec-bootstrap.md:15`; `babysit-prs.md:47-49` |
| Auditor, ticket-audit y researcher | `core-assets/agents/auditor.md:56-62`, `:57`; `ticket-audit.md:51-52`; `researcher.md:42` (`git grep`); `implementer.md:47`, `:81` (`git stash`) |
| Minero de búsqueda | `scripts/mine-search-routing.py:113` |
| Precedente de `navori` invocado por un hook | `core-assets/hooks/audit-mode-trigger.sh:103`; `settings/settings-base.json:74-79` |
| Aviso de citty con código 0 | `scripts/check-asset-commands.mjs:15-17` |
| Presupuesto del bloque de orquestación | `engines/claude/__tests__/session-start-budget.test.ts:159` (`CEILING = 6500`); `.claude/context/10-orquestacion.md` mide 6,324 caracteres (6,400 bytes) |
| Marcadores de retirados (hallazgo B1 del challenge v2) | `engines/claude/index.ts:1120` (`planFlatSkillRemoval(cwd, id, id)`), `:1200` (comentario: `<id>-base` en core); `lib/removable.ts:141` (`openingTagFor` exacto); `.claude/skills/debug-error/SKILL.md` (`id="debug-error-base"`) |
| Reporte de lo conservado | `lib/removable.ts:157-166` (`KeepReason`); `engines/codex/index.ts:124-126` (`prune: presetLoadedSafely`) |
| Hooks core sin condición y plugin global | `engines/shared/harness-plan.ts:117-185`; `engines/claude/global-plugin.ts:151` (`includeLeader: true`) |
| Referencias a skills retiradas fuera de assets | `commands/doctor.ts:1421`; `core-assets/presets/express-mongoose.json:44`; `packages/plugins/semgrep/plugin.json:46` |

## 3. Historia de git

| Commit | Qué hizo | Cómo verlo |
|---|---|---|
| `7c6930dc` (#803) | Retira tgrep y codegraph, incluido `guard-search-routing.sh` | `git show 7c6930dc --stat` |
| `7c6930dc^` | Último árbol con el guard v1 y sus 16 pruebas; es la referencia del siguiente paso si D19 falla | `git show 7c6930dc^:packages/plugins/tgrep/scripts/guard-search-routing.sh`, `git show 7c6930dc^:packages/cli/src/lib/__tests__/guard-search-routing.test.ts`, `git show 7c6930dc^:packages/plugins/tgrep/plugin.json` |
| `91e5fa52` (#838) | Reintroduce codegraph y tgrep v2 con routing, sin guard; mergeado el 2026-09-16 10:22 | `git log -1 --format='%h %ad' --date=iso 91e5fa52` |
| `faff0324` (#841), `5cc080cb` (#842), `c328bc9d` (#843), `205aa949` (#844), `5a0bbc34` (#845) | Avance de `main` durante la spec: engram a skill, fuente única de subcomandos, CLAUDE.md a 199 líneas, recorte de docs de agentes, cierre de sesión que reescribió `progress/current.md` | `git log --oneline 3f0fceb0..5a0bbc34` |
| `fe36b072` (#801) | Plan de search v2 | `git show fe36b072 --stat` |
| `b7f45ad2` (#793) | Pilot exige base actualizada (#771) | `git show b7f45ad2` |
| `218bfac3` (#365) | Saca el backstop del receipt del pre-commit | `git show 218bfac3` |
| `67627ce8` (#344, #348) | Drift falso bajo zsh | `git show 67627ce8` |
| `73714d4c` (#341, #342, #354) | Blob inspeccionable, unión de receipts, delta re-sign | `git show 73714d4c` |
| `8b3ba7d8` (#202) | Cobertura del pilot alineada al receipt | `git show 8b3ba7d8` |
| `e54ae48e` (#148) | Cobertura del review sobre el diff | `git show e54ae48e` |
| `2ac67db7` (#352) | Backstop ciego bajo Codex | `git show 2ac67db7` |
| `2f302a7a` (#785) | Gate de seguridad contra el remoto | `git show 2f302a7a` |
| `37b9b29a` (#839), `3f0fceb0` (#840) | Codex habilitado y perfiles de modelo del repo | `git show 3f0fceb0 -- navori.config.json` |
| `26f05dcd` | Commit huérfano previo al rebase de `07f62181`; no es un estado más reciente de `main` | `git show 26f05dcd:navori.config.json` |

Para contar los commits del receipt: `git log --oneline | grep -ciE "receipt|drift|pilot|pre-flight|preflight"` (26).

## 4. Documentos internos

| Documento | Sección | Qué aporta |
|---|---|---|
| `docs/research/tgrep-como-funcionaba.md` | §4 "El guard", §5 "Los números", §6 "Lo que NO funcionó", §7 decisiones | 7.4% con doctrina contra 40.7% con guard; qué bloquea, qué deja pasar y por qué |
| `docs/research/search-v2-results.md` | §4.4, §6.3, §6.7 | Estado de search v2, decisión #761 (tools MCP por nombre exacto), benchmark §9 sin correr, rollback |
| `docs/research/activacion-subagentes-y-skills.md` | "La remedición (2026-09-11, n=16)" | Evidencia detrás de la moratoria |
| `progress/history.md`, `specs/0023-guard-gh-pr-create/design.md:39`, `specs/0024-nudge-espejo-busqueda/requirements.md:35` | Moratoria de doctrina | Estaba en `progress/current.md` hasta `3f0fceb0`; #845 reescribió ese archivo |
| `search-v2.md` (raíz) | D02 (`:14`), manifest de tgrep (`:106`), M03 (`:374`), §9.5 D19, `:653` | Sin hooks ni scripts en tgrep; métrica de campo pre-registrada (≥ 25% en dos semanas); no expandir con hooks antes de medir |
| `docs/DIRECTION.md` | Invariantes (9: "navori genera, no ejecuta"), `:76-81`, `:152-153` | Invariante y la mención desactualizada de tgrep y codegraph |
| `specs/0012-solutioning/design.md` | `:14-17`, `:176` | Rechazo de `solution-architect` que F enmienda |
| `specs/0017-tgrep-search-layer/design.md` | `:237-238` | *"re-evaluar solo si el audit post-rollout muestra que el wrapper no se usa"* |
| `specs/0019-orquestacion-cabe-en-el-arranque/` | R3, R4 | Techo de 6,500 caracteres |
| `specs/0020-delegacion-por-mecanismo-nativo/requirements.md` | R1 | `description` + `when` por agente |
| `specs/0023-guard-gh-pr-create/` | R3 | Texto que nombra `commit-pr-pilot.md` |
| `docs/research/propuesta-simplificacion-agentes.md` (sin versionar, en el checkout principal) | Todo | Propuesta original que dio pie a la spec |

## 5. Mediciones locales y cómo reproducirlas

Las ventanas por `mtime` se mueven con el tiempo: re-ejecutar hoy no da el mismo número exacto,
pero sí la misma forma.

**Uso de agentes, 90 días** (tabla de requirements §2):

```bash
find ~/.claude/projects -name '*.jsonl' -mtime -90 -print0 \
  | xargs -0 grep -hoE '"subagent_type":"[a-zA-Z-]+"' | sort | uniq -c | sort -rn
```

**Invocaciones de la tool `Skill` y lecturas de `SKILL.md`, 90 días** (requirements §2):

```bash
find ~/.claude/projects -name '*.jsonl' -mtime -90 -print0 \
  | xargs -0 grep -hoE '"name":"Skill","input":\{"skill":"[^"]+"' \
  | sed -E 's/.*"skill":"([^"]+)"/\1/' | sort | uniq -c | sort -rn
find ~/.claude/projects -name '*.jsonl' -mtime -90 -print0 \
  | xargs -0 grep -hoE '"file_path":"[^"]*/skills/[^"/]+/SKILL\.md"' \
  | sed -E 's#.*/skills/([^/]+)/SKILL\.md"#\1#' | sort | uniq -c | sort -rn
```

**Búsqueda** (requirements §5). Ojo: `tgrep search` existe desde #838 (2026-09-16), así que antes de esa fecha el conteo es 0 por construcción. Para contar desde el merge, usa `-newermt '2026-09-16 10:22'`:

```bash
P=~/.claude/projects
find $P -name '*.jsonl' -mtime -30 -print0 | xargs -0 grep -ho '"name":"mcp__codegraph__codegraph_explore"' | wc -l
find $P -name '*.jsonl' -mtime -30 -print0 | xargs -0 grep -hoE '"command":"tgrep search' | wc -l
find $P -name '*.jsonl' -mtime -30 -print0 | xargs -0 grep -hoE '"command":"(grep|rg) ' | wc -l
```

**Plugins habilitados e índices por repo** (requirements §5), desde `~/Documents/Dev - Docs`:

```bash
for c in $(find . -maxdepth 3 -name navori.config.json -not -path '*/node_modules/*' -not -path '*/worktrees/*'); do
  python3 -c "import json;j=json.load(open('$c'));print('$c', [k for k,v in j.get('plugins',{}).items() if isinstance(v,dict) and v.get('enabled',True)])"
done
```

**Contenido de usuario en skills y agentes renderizados** (`design.md`, "Por qué reset"). El script
toma lo que queda después del último bloque managed, sin comentarios ni encabezados, e imprime
los archivos con texto:

```bash
find . -path '*/.claude/skills/*/SKILL.md' -not -path '*/node_modules/*' -not -path '*/worktrees/*' \
  -exec python3 -c '
import sys,re
for p in sys.argv[1:]:
    s=open(p,encoding="utf-8").read()
    e=[m.end() for m in re.finditer(r"<!-- /navori:managed[^>]*-->", s)]
    if not e: continue
    t=re.sub(r"^#+ .*$","",re.sub(r"<!--.*?-->","",s[e[-1]:],flags=re.S),flags=re.M).strip()
    if t: print(len(t.split()),"words:",p)
' {} +
```

Para agentes, el mismo script con `-path '*/.claude/agents/*.md'`.

**Skills versionadas en git** (recuperables tras el reset):

```bash
git -C navori/alertaciudadana_app ls-files .claude/skills | grep -c SKILL.md
```

**Artefactos de diseño:**

```bash
find . -path '*/.claude/progress/*' -name 'solution_*.md' -not -path '*/worktrees/*' | wc -l
```

**Tamaños y conteos:**

```bash
wc -w packages/core/core-assets/agents/*.md packages/core/core-assets/skills/*.md
grep -rhoE "\b(leader|orchestrator)\b" packages/core/core-assets | sort | uniq -c
wc -c .claude/context/10-orquestacion.md
```

## 6. Artefactos de esta sesión

**Reportes efímeros** en `.claude/progress/` del checkout principal (gitignored; lo esencial ya
está en la spec):
- `research_0026_inventory.md`: alcance del renombre.
- `research_0026_migration.md`: render, poda, config y harness global.
- `research_0026_receipt.md`: viabilidad de `navori receipt`.
- `research_0026_publisher.md`: permisos y hooks de canales.
- `research_0026_prior_decisions.md`: specs previas y moratoria.
- `solution_review_0026.md`: challenge en contexto fresco de la versión con migración.
- `solution_review_0026_v2.md`: challenge en contexto fresco de la versión con reset (2 BLOCKER: marcador `-base` de retirados y guard contra `search-v2.md`).

**Memorias de engram** del proyecto `navori-harness`. Se recuperan con `mem_search` o con
`engram search "<consulta>"`:

| Id | Topic key | Contenido |
|---|---|---|
| #3143 | `harness/agent-roster-simplification` | Decisión de nombres del roster |
| #3144 | `harness/agent-usage-and-routing-contradictions` | Uso real de agentes y contradicciones |
| #3146 | `harness/agent-rename-migration-mechanics` | Por qué renombrar sin migración rompe cosas |
| #3150 | `harness/spec-0026-roster` | Estado de la spec |
| #3155 | `harness/spec-0026-skills` | Evaluación de skills core |
| #3156 | `harness/skill-name-collisions` | Skills integradas de Claude y Codex |

**Worktree y rama de la spec:** `.claude/worktrees/spec-0026-roster`, rama
`docs/spec-0026-roster-agentes`, creada desde `origin/main` (`3f0fceb0`).

## 7. Inspiración externa: ECC y deepseek-harness

Revisión del 2026-09-16, solo lectura (`gh api` y `raw.githubusercontent.com`), con los commits
fijados para que las citas no se muevan.

### ECC (everything-claude-code)

- **Repositorio:** <https://github.com/affaan-m/ECC>, rama `main` en `8321021`.
- **Base de las citas:** `https://github.com/affaan-m/ECC/blob/8321021/<path>`.
- **Crudo:** `https://raw.githubusercontent.com/affaan-m/ECC/8321021/<path>`.
- **Research previo del repo:** `docs/research/ecc-lessons.md`. El código de ECC no cambió desde
  ese análisis; lo que envejeció es lo que dice de navori.

| Path | Cita literal | Sostiene |
|---|---|---|
| `agents/code-reviewer.md` (≈ línea 57) | *"For any finding tagged HIGH or CRITICAL, include: The exact snippet and line number · The specific failure scenario: input, state, and outcome · Why existing guards, such as types, validation, or framework defaults, do not catch it… If you cannot produce all three, demote to MEDIUM or drop."* | R32 |
| `agents/code-reviewer.md` | *"It Is Acceptable And Expected To Return Zero Findings"* y *"Do not withhold approval to appear rigorous. If the diff is clean, approve it."* | R32 |
| `tests/ci/code-reviewer-false-positive-guard.test.js` | Prueba que fija esos encabezados | R32 (patrón: prosa crítica fijada por test) |
| `agents/code-reviewer.md`, "Security (CRITICAL)" | Ocho patrones: *"Hardcoded credentials · SQL injection · XSS vulnerabilities · Path traversal · CSRF vulnerabilities · Authentication bypasses · Insecure dependencies · Exposed secrets in logs"* | R33 |
| `agents/code-architect.md` (366 palabras) | *"choose the simplest architecture that meets the requirement · avoid speculative abstractions unless the repo already uses them"*; su sección "Build Sequence" se rechaza | R51, R48 |
| `docs/legacy-artifact-inventory.md` | Tabla `Shim \| Preferred current direction` por id retirado | R38, R41 |
| Issue #2463 | *"skill-health dashboard always shows 0 runs — recordSkillExecution() is never called outside tests"* | R52 |
| `scripts/hooks/run-with-flags.js` | *"This eliminates one Node.js process spawn (~50-100ms savings per hook)."* (declarado en un comentario, no medido) | E1 (ruta rápida sin forks) |
| `skills/jira-integration/SKILL.md` | `jira_curl -X POST … "$JIRA_URL/rest/api/3/issue/PROJ-1234/comment"` y la tabla *"Tests written → Comment with test coverage summary…"* | NOT in scope (`curl` directo); R34 |
| `README.md` (≈ línea 464) | `cp agents/*.md ~/.claude/agents/` | Colisión externa de `architect` |
| `rules/common/agents.md` (#2471) | *"Your final message IS the deliverable. Never end your turn with 'waiting for background agents'"* | Contra la activación por prosa |

**Verificación relacionada en la documentación oficial de Claude Code**
(<https://code.claude.com/docs/en/sub-agents>):
- **Scopes:** *"Plugin's `agents/` directory … 5 (lowest)"*.
- **Anidamiento:** *"If you omit `Agent` from the `tools` list entirely, the agent can't spawn any
  subagents with the Agent tool."* Sostiene la prueba de T12.

### deepseek-harness (dsh)

- **Repositorio:** <https://github.com/deepseek-ai/deepseek-harness>, rama `master` en `0d1f500`.
- **Base de las citas:** `https://github.com/deepseek-ai/deepseek-harness/blob/0d1f500/<path>`.
- **Crudo:** `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/0d1f500/<path>`.
- **Research previo del repo:** `docs/research/deepseek-harness-lessons.md`. Upstream no avanzó
  desde ese análisis; sus cifras sobre `CLAUDE.md` de navori están desactualizadas (2,797
  palabras hoy, no 3,355).
- **Sin roster de desarrollo:** dsh no tiene agentes de ese tipo; lo adoptable son scripts
  `verify-*` y skills.

| Path | Cita literal o fragmento | Sostiene |
|---|---|---|
| `scripts/change-scope.ts` | `'--no-ext-diff'`, `'--no-textconv'`, `'--no-renames'`, `'-z'`; `env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C' }`; `'-c', 'core.fsmonitor=false'`; campos `formatVersion`, `baseSha`, `mergeBaseSha` | R1, R2, R3 |
| `.agents/notes/archived/process/2026-07-27-explicit-change-scope-report.md` | *"rename detection is disabled so both sides of a rename remain visible"*; *"The command never guesses or fetches a base"* | R1 y la tensión del target por default |
| `scripts/verify-doc-budgets.ts:36` | *"budgeted file does not exist (renamed or deleted? update scripts/doc-budgets.manifest.json in the same change)"* | R51 |
| `docs/AGENTS.md` | *"1. **Relocate**… 2. **Condense**… 3. **Raise** the ceiling only when the words need the space"* | T15 (condensar y luego bajar `maxWords`) |
| `scripts/verify-concrete-terms.ts` | `const blockedTerm = 'prove' + 'nance'` (`:9`), `.normalize('NFKC')` (`:28`), `if (containsBlockedTerm(file))` (`:49`), *"tracked-file discovery omitted a required repository area"* (`:68`) | R44, T17 |
| `AGENTS.md` | *"prove each changed acceptance path rejects an invalid case"* | T8, T17 |
| `.agents/notes/archived/architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md` | *"No alias, compatibility package, duplicate service key, dual event name, or fallback parser remains. The repository rejects the old name."* | R39, R40 |
| `.agents/notes/implemented/process/2026-07-04-doc-tiers-and-budgets.md` | *"a prose rule with no mechanical backstop demonstrably does not hold here"* | B, E1, G |
| `AGENTS.md` | *"Never default to the full suite or repeat a passing check for commit or push. CI owns exhaustive coverage"* | Tesis opuesta a R32, registrada |

**Documentación oficial de git para las flags de R1** (`git help git`, `git help diff`;
<https://git-scm.com/docs/git>, <https://git-scm.com/docs/git-diff>):
- `GIT_OPTIONAL_LOCKS`: con 0, git no toma locks opcionales.
- `-z`, `--no-ext-diff` y `--no-textconv`.

### Reportes de la sesión

Efímeros, en `.claude/progress/` del checkout principal:
- `research_0026_ecc.md`
- `research_0026_deepseek.md`
