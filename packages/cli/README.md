> [English](https://github.com/UlisesCm/navori-harness/blob/main/packages/cli/README.md) | [Español](https://github.com/UlisesCm/navori-harness/blob/main/packages/cli/README.es.md) | [简体中文](https://github.com/UlisesCm/navori-harness/blob/main/packages/cli/README.zh-CN.md)

# navori

Multi-agent harness and SDD scaffolder for Claude Code and other AI engines.

`navori` brings your Claude Code setup (agents, skills, hooks, `CLAUDE.md`, and `AGENTS.md`) to multiple repositories with one command, preserving local customizations and existing work.

It also renders a complete Codex harness: `AGENTS.md`, skills in
`.agents/skills/`, agents and hooks in `.codex/`, and project-local MCP configuration.

## Engine profiles

```jsonc
// Paridad completa para ambos proveedores
{ "engines": ["claude", "codex"] }

// Claude completo + guía AGENTS.md ligera para Codex y otras herramientas
{ "engines": ["claude", "agents-md"] }

// Solo guía universal, con el menor número de archivos
{ "engines": ["agents-md"] }

// Solo Pi (opt-in; ver docs/pi.md)
{ "engines": ["pi"] }
```
`codex` already includes and manages `AGENTS.md`; you do not need to combine it with
`agents-md`. If both appear in a config, the Codex adapter takes precedence
to avoid duplicate blocks.

## Installation

```bash
npm i -g navori
# o sin instalar
npx navori init
```
## Quick start

```bash
# Modo opinado: cero preguntas, harness completo sin instalar software externo
# (engram siempre activo, +gh si el repo tiene remote de GitHub).
# Avisa si falta el binario de algún plugin habilitado y cómo instalarlo.
cd ~/tu-repo
navori init --recommended

# + proveedores externos (tgrep, acli) + pre-commit hook +
# scan-monorepo + project block estricto — requiere instalar los binarios de esos proveedores.
# También avisa si falta algún binario y cómo instalarlo, sin instalarlo nunca.
navori init --full

# O wizard interactivo con detección de stack
navori init
```
`init` automatically detects the following from the repository:
- **Project name** (from `package.json`, `pyproject.toml`, `Cargo.toml`, the git remote, or the directory name)
- **Stack**: framework (Next.js, Vite, NestJS, Express, Astro, etc.), UI, forms, state, test
- **Suggested preset** depending on stack (e.g. `vite-react-ts-mantine`, `nextjs`, `express-mongoose`)
- **Quality gate** assembled from the `package.json` scripts
- **Git base branch** (`origin/HEAD`, falling back to main/master/develop)
- **Existing Claude infrastructure** (`.claude/`, `CLAUDE.md`, `AGENTS.md`, agents, skills) — offers to coexist or replace with backup

It generates:
- `navori.config.json` — repo source of truth
- `CLAUDE.md` with managed blocks that the CLI keeps synchronized
- `.claude/` with agents, skills, hooks and settings

## Optional update notice

In interactive commands, Navori can warn you if it detects a newer version. The
npm registry query runs in the background and does not block the command. The first run only starts populating the cache, so the notice may appear on a later run. The check and notice are limited to once every 24 hours. It is not displayed in CI, JSON mode, or help and version commands.

To disable it, set `NAVORI_NO_UPDATE_NOTIFIER=1`. The notice recommends the
update command based on the detected installer, with `npx` as a fallback.
It does not install or update anything automatically, and it does not run `render`. After
updating Navori, run `navori render --apply` to apply the changes to your
harness.

### Plugin tool update notices

Plugins like `engram` can declare `latestRelease` in their manifest to receive
notices when a newer version is available. The notice appears at the end of the
startup context, in a reserved space of 300 characters, at most once every 24 hours per version.

The query is executed:
- **Source**: `api.github.com/repos/<owner>/<repo>/releases/latest` or
  `registry.npmjs.org/<package>/latest` (no token, just a `navori/<version>` User-Agent)
- **Frequency**: at most one request per tool per day, reserved under a lock
- **Network**: network requests run in a detached background worker; the session
  never waits
- **Cache**: `~/.navori/tool-versions/` (similar to `~/.navori/update-notice/`)
- **CI**: no network requests, cache refreshes, or notices

Disable it along with the Navori update notice: `NAVORI_NO_UPDATE_NOTIFIER=1`.

**Limitations:**
- Codex in non-networked sandboxes does not get refreshes or prompts.
- Pi does not have session hooks, so warnings appear only in `navori doctor`.
- If the notice does not fit in its reserved space, a pointer to `navori doctor` is shown and the notice
  is retried in the next session (it is not marked as delivered).
- `doctor` displays all messages as informational rows, without applying `--strict`.

If an abrupt closure leaves the warning blocked, you will only intervene if the lock persists
more than a minute. In that case, stop all `navori` processes and delete
`~/.navori/tool-versions/lock` or `~/.navori/update-notice/lock`; keep the files
cache files in both directories.

## Commands

| Command | What it does |
|---|---|
| `init` | Bootstraps a repository with automatic detection and a wizard (or `--recommended` with no questions or external installs, or `--full` to add external providers and a strict policy). |
| `add <plugin>` | Enables a plugin and optionally installs its external tool. |
| `remove <plugin>` | Disables a plugin and cleans up its managed blocks, sub-blocks, and scripts. |
| `configure <section>` | Adjusts a config section without rerunning the wizard. |
| `adopt <path>` | Brings a hand-written `.claude/` file under Navori management by wrapping it in a managed block without rewriting its content (preview by default). |
| `refresh` | Redetects the repository, refreshes the config, and runs sync in one step. |
| `update` | Updates Navori from npm, then runs `refresh` with the new binary (see [Update Navori](#update-navori)). |
| `render` | Generates native files for each configured engine (preview by default; `--apply` writes them). `--all` renders all repositories in the global registry; `--prune` removes entries for repositories that no longer exist. |
| `registry <sub>` | Manages the global registry of Navori repositories for `render --all` (`ls`, `scan <dir>`, `add`, `remove`, `prune`). |
| `sync` | Refreshes all configured engines with conflict resolution and backups. Resolve block conflicts interactively (`--interactive`, with diff and keep-mine/accept-new choices) or in bulk (`--accept-new` / `--keep-mine`). In interactive mode, unmarked whole files are resolved one at a time (diff, keep/accept); `--accept-new-files` accepts all resolvable files at once. |
| `preset init <id>` | Scaffolds a local preset in `.navori/presets/<id>/`. |
| `scan` | Detects new workspaces in monorepos (`pnpm-workspace.yaml` / `package.json#workspaces`). |
| `doctor` | Audits config and drift for each managed block (`CLAUDE.md` **and `AGENTS.md`**), canonical ordering, malformed markers, monorepo desynchronization, and missing external tools (`--strict` for CI). Informational findings do not affect `--strict`: installed versions with known issues (`externalTool.versionAdvisory`) and new tool version notices (`navori tools notice`). |
| `status` | Shows a quick snapshot: config, active plugins, drift count, and next steps. |
| `audit` | Reports how the harness actually ran: token attribution, adherence gaps, review and receipt outcomes, tool availability over time, and efficiency and lifecycle for each accepted task. `--snapshot` saves a named snapshot of a range; `--compare` compares it with another by cohort, with causes and evidence. |
| `gate <fast\|full>` | Runs `qualityGate.fast` or `qualityGate.full`, writing full output to a log (`.navori/state/gate/`) and only a compact verdict to stdout. Flag: `--cwd <path>`. |
| `receipt <sub>` | Records the reviewed bytes before publishing: `sign` (`--feature <id>`, `--gate-ran scoped\|full`, `--spec <dir> --milestone <Mn>` or `--phase <name\|index>`), `check`, `gate --spec <dir> --milestone <Mn>` or `--phase <name\|index>` (decides whether a milestone needs the scoped or full gate), and `review begin` / `review seal --nonce <n>` (review sidecar with content identity). Common flags: `--target <ref>`, `--dir <path>`, `--json`. |
| `spec <classify\|check> <feature>` | `classify` decides whether a spec ships in one PR or one PR per delivery (based on `sdd.deliveries` thresholds); `check` validates its `tasks.md`: milestones, criteria, coverage, and vertical deliveries. Flags: `--cwd`, `--json`. |
| `tools notice [--ack <pluginId@x.y.z,…>]` | Emits pending external tool version notices for the startup hook; `--ack` marks them as delivered. |
| `handoff <check\|log-review>` | `check` validates the implementer's handoff (`impl_<feature>.json`) before the next agent is dispatched. `log-review <feature>` validates `review_<feature>.json` and adds findings with score >= 50 to `findings.jsonl` (`navori handoff check <feature> [--for scribe] [--produced-by reviewer [--since <iso>]] [--dir <path>] [--cwd <checkout>] [--json]`). |
| `plan <sub>` | Tiered planning (`harness.planTiers`): `classify [--files\|--diff]` measures task complexity and level; `render`/`update` keep the Markdown workplan in sync with its JSON; `check` validates its schema and rules; `gate` is the `PreToolUse(Agent)` hook that denies dispatch without a valid workplan. |
| `master <sub>` | Guided, staged master-plan flow (`init`, `ux`, `mode`, `template`, `check`, `advance`, `status`, `part`, `close`) and deliveries for its parts: `delivery-slice`, `delivery-check`, `delivery-baseline`, `delivery-queue`, `delivery-criterion`, `delivery-review`, `delivery-present`, `delivery-decision`, `delivery-publication`, `delivery-revoke`. Commands that authorize or approve require `--approved-by`. |
| `bench` | Runs `render` in dry-run mode N times and reports latency to detect local regressions. |
| `workspace <sub>` | Manages cross-repository workspaces (`init`, `ls`, `show`, `link`, `add-repo`, `set-default`, `render`, `rename`, `delete`). |
| `ticket <sub>` | Manages tickets as files in a workspace (`new`, `list`, `show`, `archive`, `delete`). |
| `dominio <sub>` | Manages the durable workspace knowledge base (`init`, `list`, `show`, `reindex`, `doctor`, `inject`). |
| `codex <sub>` | Codex-specific commands; currently, `trust` approves project hooks in `~/.codex/config.toml`. |
| `backup <sub>` | Lists and restores backups from `~/.navori/backups/`. |
| `migrations <sub>` | Lists and restores migrations from `~/.navori/migrations/`. |

## Presets

A preset provides stack-specific skills and rules in addition to the core. The `init` suggests one based on what it detects.

**Official presets (included):**

| Preset | Stack |
|---|---|
| `vite-react-ts` | Vite + React + TS (SPA, UI-lib agnostic) |
| `vite-react-ts-mantine` | Vite + React + TS + Mantine (SPA) |
| `nextjs` | Next.js (App Router) |
| `react-native-expo` | React Native + Expo (mobile app) |
| `astro` | Astro (static / SSR) |
| `nestjs` | NestJS (backend) |
| `express` | Express (backend, DB agnostic) |
| `express-mongoose` | Express + Mongoose (backend) |
| `fastapi-python` | FastAPI (backend, Python) |
| `bun-keystone` | Keystone 6 + Prisma (backend, Bun) |
| `background-worker` | Background worker (jobs + queues: agenda / bullmq / amqplib) |
| `medusa` | Medusa.js v2 (backend) |
| `monorepo-turbopnpm` | Monorepo with Turborepo + pnpm workspaces |

The **neutral** presets (`vite-react-ts`, `express`) provide generic stack skills without tying you to a specific library; specialized presets (`…-mantine`, `…-mongoose`) add skills for that layer. **Does your stack lack an official preset?** No problem. `init` still installs the complete harness (agents, gates, protocol, SDD), so you can use it right away; you simply will not get stack-specific skills. `init` warns you, keeps the baseline (`preset: custom`), and suggests filling the gap with a local preset.

**Local presets** — create one checked-in to the repo under `.navori/presets/<id>/`:

```bash
navori preset init sveltekit
# ✓ .navori/presets/sveltekit/  (manifest + managed/stack.md + skills/)
# ✓ navori.config.json → preset: sveltekit
# → edita las plantillas y corre 'navori render --apply'
```
The resolution is **local → bundled**: if you have a local preset with the same id as an official one, the local one wins. So you can override an included preset without touching the package.

## Available plugins

| Plugins | For what | External tool |
|---|---|---|
| `engram` | Persistent memory between sessions | `engram` binary |
| `codegraph` | Structural code discovery via MCP; explicit opt-in (not included in `--full`) | `codegraph` binary |
| `tgrep` | Textual code discovery via indexed CLI | `tgrep` binary |
| `acli` | Read Jira tickets from the terminal | `acli` |
| `gh` | GitHub Issues, PRs and workflow runs | `gh` |

> `codegraph` and `tgrep` were briefly retired on 2026-09-15 and reintroduced on
> 2026-09-16 (#838) with an integration that lets them work together — see the record in
> [`docs/research/tgrep-como-funcionaba.md`](https://github.com/UlisesCm/navori-harness/blob/main/docs/research/tgrep-como-funcionaba.md).

Activate one:

```bash
navori add engram          # te ofrece instalar la tool externa si falta
navori add engram --skip-install   # solo registra el plugin
```
## Planning by levels (`harness.planTiers`)

With `harness.planTiers: true` in `navori.config.json`, `navori plan classify` measures
task complexity from signals such as money/credentials/PII, a new dependency, a schema
migration, or a change to a `project.criticalPaths` path, then assigns a level from 0 to 3.
The `PreToolUse(Agent)` hook (`navori plan gate`) denies dispatching a subagent without the
workplan required for its level and raises the requirement after two consecutive rejections.
If `navori` is missing or its build lacks the `plan` subcommand, the hook has no verdict. In
modes that show a prompt, it asks for confirmation instead of leaving the user without a path
forward (`bypassPermissions`, `dontAsk`, and `plan` modes continue to block). `navori plan
classify --diff` runs the same classifier against `git diff --name-only <base>...HEAD` and
warns when the work exceeds the level declared in the workplan.

`project.criticalPaths` (an array of globs) is optional. Without it, `classify` detects the
"touches a critical area" criterion only when it is explicitly declared with `--criticalArea`,
instead of inferring it from the files changed.

The `architect` agent no longer has a `harness.architect` flag; it is always rendered. Set its
tier with `models.architect`/`effort.architect` (`opus`/`xhigh` by default). A config that still
contains `harness.architect` fails with a retired-key warning instead of silently ignoring it;
`navori configure migrate` removes the key.

## Spec deliveries (`sdd.deliveries`)

A large spec does not have to ship in one PR. `navori spec classify <feature>` compares it
with the `sdd.deliveries` thresholds in `navori.config.json` (`splitMinTasks`, `splitMinLoc`,
`maxPrsPerSpec`; defaults: 12 tasks, 1,500 estimated LOC, and 4 PRs) and determines whether it
should ship in one PR or one PR per delivery. `navori spec check` validates `tasks.md` against
its grammar:

- **`E<n>`**: delivery; one PR each.
- **`M<n>`**: milestone; each is checked and committed separately.
- **`T<n>`**: task; declares the `R<n>` it covers.

The full quality gate runs once per PR, not once per milestone. `navori receipt gate` decides
which gate to run for each milestone.

## Workspace Harness (`monorepo.workspaceHarness`)

`monorepo.workspaceHarness` determines how much harness each workspace in a monorepo receives.
It is one value for the entire repository:

- `minimal` (default): your context file plus skills that root doesn't already have. A skill
  identical to that of the root is not duplicated.
- `full`: everything, as before the harness was trimmed.
- `root`: only its context file (`CLAUDE.md`, and `AGENTS.md` under Codex). The root writes the
  library and preset skills that declare the workspaces.

`navori doctor` treats `minimal` and `root` as trimmed harnesses and reports when the value is `full`.

## Defensive harness (read-only by default)

The harness generated by `navori` starts with safe permissions. This reduces routine prompts
without lowering protections for dangerous operations:

- **Reads do not require confirmation**: `git status/diff/log/show`, `ls`, `cat`, `grep`, `Read`/`Glob`/`Grep`, and similar commands run without interrupting you.
- **Destructive operations require confirmation** (`ask`): `rm -rf`, `git push --force`, `git reset --hard`, `git clean -f`, `chmod -R`, and others.
- **Discarding uncommitted work is blocked** (`guard-destructive`, exit 2, no approval possible): `git reset --hard`, `git checkout -f`, `git checkout -- .` (or `git checkout .`), `git restore <paths>` without `--staged`, and `git clean -f` (without `-n`). The block depends on repository state: if the tree is clean, there is nothing to lose and the command passes. If the target directory cannot be inspected (for example, because it uses a variable, substitution, or nonexistent path), the command is also blocked. The message explains how to proceed safely.
- **`publisher` does not rewrite history**: after a failed commit, it does not run `git reset` or rewrite commits. It reports the state with `git status` and `git log -1 --stat`; recovery is left to the orchestrator or user.
- **Catastrophic operations are denied** (`deny`): `rm -rf /`, `sudo rm`, `mkfs`, and others.
- A `guard-destructive` hook acts as an additional backstop.

**Ephemeral state outside the tree**: The two harness hooks (`managed-drift-watch.sh` and `routing-watch.sh`) write their state to `<git-common-dir>/navori/` — outside the working tree, invisible to `git status`. Additionally, `render` and `sync` write a versioned `.claude/.gitignore` that ignores `progress/`, `worktrees/`, and `settings.local.json`, preventing those paths from appearing as untracked in `git status`. If `codex` is enabled, it also outputs `.codex/.gitignore` with only ephemeral entries from that directory. For updated repos, also ignore legacy files `.claude/.managed-drift-stamp` and `.claude/.routing-watch/`. Nothing the engines need is ignored.

## Workspaces and cross-repository tickets

If a ticket touches multiple repos (frontend + backend + microservice), the workspace gives you a single point:

```bash
# Crear workspace
navori workspace init bonum --description "Bonum platform"

# Registrar repos del workspace
navori workspace add-repo bonum --name webapp --path ~/dev/bonum/webapp --stack vite-react-ts-mantine
navori workspace add-repo bonum --name backend --path ~/dev/bonum/nexus --stack nestjs

# Crear ticket
navori ticket new bonum BNM-123 --title "Checkout flow rebuild"

# En cada repo que toca el ticket, agrega una referencia:
# echo "ticket: BNM-123" >> progress/current.md

# Ver el ticket + en qué repos aparece
navori ticket show bonum BNM-123
```
The workspace also saves inheritable defaults:

```bash
navori init --workspace bonum    # hereda engines, plugins, branchBase, etc.

# Ajustar un default sin editar el manifest a mano
navori workspace set-default bonum branchBase main
navori workspace set-default bonum prTarget develop      # PRs van a develop, no a main
navori workspace set-default bonum engines claude,cursor
navori workspace set-default bonum plugins.engram.enabled true
```
Re-render all repositories in the workspace at once:

```bash
navori workspace render bonum           # preview (no toca disco)
navori workspace render bonum --apply    # escribe en cada repo
```
Storage: `~/.navori/workspaces/<name>/` (manifest + tickets/ + backups/).

## Global rollout after a Navori bump

When you update the CLI (`npm i -g navori@latest`), the global registry applies
the changes to **all** your repositories with one command:

```bash
navori render --all            # preview: qué cambiaría en cada repo del registro
navori render --all --apply     # escribe el render nuevo en todos
navori render --all --verbose   # además lista cada bloque managed que cambió, por repo
navori render --all --prune     # además limpia repos que ya no existen
```
The output is a self-explanatory report: a header with the registry and mode
(preview/apply), one line per repository (`created`/`updated`/`conflict`/`removed`/`unchanged`),
a notice that **names** repositories with hand-edited blocks (conflicts, which render does not
overwrite), and a summary: `ok · changed · conflict · failed`.

The registry (`~/.navori/registry.json`) populates automatically: each `navori init` /
`navori refresh` registers the repository. To add repositories that were already installed,
scan once:

```bash
navori registry scan ~/dev ~/otra-carpeta   # registra todo lo que tenga navori.config.json
navori registry ls                          # ver el registro (✓ presente / ✗ missing)
navori registry prune                       # quitar los que ya no existen
```
The registry is independent of workspaces: it records which repositories exist; the workspace
defines the policy profile (`branchBase`/`prTarget`) each repository inherits.

## Managed blocks with versioning

Each block that `navori` injects into your `CLAUDE.md` carries metadata:

```html
<!-- navori:managed id="idioma-rol" hash="3fbef743" version="0.0.1" source="@navori/core" -->
contenido sincronizado
<!-- /navori:managed id="idioma-rol" -->
```
- **`hash`**: detects whether you edited the block; `sync` warns before replacing your changes.
- **`version`**: when a new version of `@navori/core` or a plugin is released, `sync` reports "update available".
- **`source`**: identifies the package that owns the block (`doctor` shows each block's origin).

If you modify a managed block by hand and then run `sync`, you will see:

```
Conflict in 'idioma-rol':
  - tu versión
  + versión del Core
```

Choose `skip-conflicts`, interactive resolution for `CLAUDE.md` blocks, or `abort`.
Conflicts in whole files are never overwritten automatically.

Before each `sync`, automatic backups are stored in `~/.navori/backups/<timestamp>/` and retained for 30 days.

## Surgical customization

Change just one thing without re-init:

```bash
navori configure plugins              # multiselect de plugins activos
navori configure quality-gate         # comandos del quality gate
navori configure language en          # switch a inglés (fallback a es)
navori configure engines              # multiselect: claude / codex / agents-md / cursor / copilot / pi
navori configure branch-base main     # punto de fork / rama protegida
navori configure pr-target develop    # rama destino del PR (gh pr create --base)
navori configure workspace bonum      # asociar a un workspace
navori configure migrate              # renombra claves retiradas (el config vuelve a cargar)
```
`migrate` is the recovery path when retired keys under `harness`/`models`/`effort` prevent
`navori.config.json` from loading. Other commands abort when reading that config, so `migrate`
reads the raw JSON, backs up the file, and rewrites it. One-to-one renames are automatic. If two
retired keys map to the same destination with different values, Navori does not guess: it asks
or uses `--scout=<model> --scout-effort=<level>`. `--dry-run` does not write; `--all` processes
the entire registry (preview mode unless `--apply` is set).

## Config keys for the gate and native hooks

- `qualityGate.scoped` (string): reviewer's bounded lane — cheap `full` checks plus diff-related tests. If missing, use `fast`. It is interpolated as `navori.scopedGate`.
- `qualityGate.nativeHooks` (boolean): declares that the project's native pre-commit already runs `fast`; the `quality-gate-pre-commit` hook skips only its gate step.
- `plugins.<id>.nativeHook` (boolean): The native git hook runs the check for that plugin, so its hook is not registered (the scripts are still installed).

## `progress/current.md` size limit

`progress/current.md` is loaded in every session, so it has a size limit. The pre-commit hook
blocks agent commits that leave it above the hard limit or increase it while it is already over
that limit (human commits are not blocked). `navori doctor` measures its size in bytes using the
same limits and warns. The session-start hook warns, but does not block, when it exceeds the
soft limit.

## Migrating to 0.12

- The `global` command and launchd collector were removed (`audit --collect` remains). `doctor --json` no longer outputs `globalScope`.
- The `jscpd` and `semgrep` plugins have been retired: `navori add jscpd|semgrep` responds that they are retired.
- The Pi minimum rises to 1.1.0: Pi 0.87.x no longer provides `navori_subagent`. Minimum Node.js version: >= 22.12.
- `navori update` now updates the CLI (query npm, commit, install and then run `navori refresh`). The previous behavior is now `navori refresh`, without aliases: scripts that used `navori update` to re-synchronize the harness should change to `navori refresh`.
- Migrate with `navori render --apply` (prunes retired assets managed by Navori), then run `navori doctor` (reports leftovers).

## Extend the harness in your repo

Navori installs a baseline; what makes it valuable in **your** repository is the knowledge only
you have. There are four places to put it, ordered from least to most expensive in files, review,
and tokens per session. Start at the top of the table: the least expensive option is usually the
most effective as well.

| What you have | Where it goes |
|---|---|
| A repository-specific rule (your own pattern or data-layer convention) | The **user section** of the skill that already covers the topic. |
| Knowledge not covered by an installed skill | A **project-local skill**. |
| Stack knowledge reusable across repositories | A **local preset** (`navori preset init <id>`). |
| A wrapper for an MCP binary or server | A **plugin** (belongs in Navori, not your repository). |

**The user section is the default.** Each skill rendered by Navori includes a sentinel
`<!-- navori:user-section -->`; anything you write after it belongs to you, and `render`/`sync`
never changes it. No new files or config are needed, and the rule stays where the agent already
looks.

**A project-local skill** takes two steps:

```bash
# 1. la forma DIRECTORIO es la única que el host descubre.
#    Un `<id>.md` suelto en .claude/skills/ no se carga nunca.
mkdir -p .claude/skills/mi-skill && $EDITOR .claude/skills/mi-skill/SKILL.md

# 2. declara el id en navori.config.json:
#    "project": { "localSkills": ["mi-skill"] }
navori doctor   # valida que el archivo exista y que su description diga CUÁNDO usarla
```
Your frontmatter needs `name`, `type` (`behavior` \| `reference` \| `tool`), and a `description`
with an **activation trigger**. The host loads skills on demand by reading that line, so wording
such as *"Use when…"* activates the skill at the right time. `navori doctor` warns when a
description is missing; adding one is often the highest-return fix because the content is already
written.

Navori **never writes inside** a project-local skill. It has no managed block or user section;
the file is entirely yours.

→ Complete guide (with the four questions that make a proposal strong):
[`docs/EXTENDING.md`](https://github.com/UlisesCm/navori-harness/blob/main/docs/EXTENDING.md).
`SKILL.md` contract: [`docs/recipes/skill-authoring.md`](https://github.com/UlisesCm/navori-harness/blob/main/docs/recipes/skill-authoring.md).

## Philosophy

- **No opinion about your process.** The CLI detects and proposes; you decide.
- **Coexists with an existing harness.** `coexist` mode leaves what you already have intact.
- **Never overwrites silently.** Markers include hashes, and writes are backed up.
- **Read-only by default.** Reads do not ask for permission; destructive operations do.
- **Output stays readable.** Human-readable text plus `--json` for CI pipelines.
- **Bilingual-ready.** The schema supports `language: es | en`. Spanish (`es`) is complete today; English (`en`) uses an explicit fallback.

## License

MIT.

## Update Navori

`navori update` checks npm for the latest Navori version and shows the installation command
that matches your setup: global npm install, devDependency, dependency, or `npx`. It asks for
confirmation (unless `--yes` is set), installs the update, then runs `navori refresh` with the new
binary.

- `--cli-only`: Stops after updating the CLI, without `refresh`.
- If there is no network or Navori is already up to date: runs `refresh` directly.
- If the installation fails: prints the manual command and exits with code 1.
- Without TTY and without `--yes`: prints the command and exits with code 1.
- npm is the only supported package manager.
