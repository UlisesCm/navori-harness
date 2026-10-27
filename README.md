> [English](README.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

<div align="center">

# navori

**Multi-agent harness and SDD scaffolder for Claude Code and other AI engines.**

[![npm](https://img.shields.io/npm/v/navori?color=8b5cf6)](https://www.npmjs.com/package/navori)
[![CI](https://github.com/UlisesCm/navori-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/UlisesCm/navori-harness/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/navori)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/navori?color=8b5cf6)](./LICENSE)

</div>

`navori` brings your Claude Code setup—agents, skills, hooks, `CLAUDE.md`, and `AGENTS.md`—to any repository with a **single command**. It keeps that setup up to date without overwriting your local customizations or existing work.

```bash
npx navori init           # wizard con detección de stack
# o, sin preguntas — harness completo sin instalar nada externo:
npx navori init --recommended
# o, + proveedores externos (tgrep, acli) y política estricta:
npx navori init --full
```

`--recommended` runs the complete harness with software you already have (Engram is always active; `+gh` is enabled when the repository has a GitHub remote) and never installs anything. `--full` adds external providers (you must install their binaries; CodeGraph is opt-in), a strict policy (`posture`/`reviewRigor`/`testsForNewCode`), a required monorepo scan, and a required pre-commit hook.

> 📦 npm: [`navori`](https://www.npmjs.com/package/navori) · 📖 Full CLI reference: [`packages/cli/README.md`](./packages/cli/README.md)

---

## The problem

When you build a useful harness for an agent—specialized agents, skills, hooks, quality gates, and SDD conventions—that knowledge lives in `.claude/` and `CLAUDE.md` in **one** repository. Reusing it elsewhere means copy-pasting, and keeping copies in sync is manual work that decays over time.

`navori` makes that harness **versioned and reproducible**: a checked-in `navori.config.json` describes the repository, and the CLI rebuilds everything from it. Markers such as `<!-- navori:managed -->` separate CLI-managed content from your own edits.

## What it generates

From `navori init`:

- **`navori.config.json`** — the repository's source of truth: stack, preset, plugins, quality gate, and detected libraries.
- **`CLAUDE.md`** with versioned *managed blocks* that the CLI synchronizes while preserving anything you write outside them.
- **`.claude/`** with agents, skills, hooks, and `settings.json`—read-only by default, with guards for destructive commands.

## How it works

**Five cascading layers**—each refines the previous one, and the more specific setting wins:

```
Core  →  Preset  →  Workspace  →  Project config  →  Engine adapters
```

- **Core** — the universal baseline: agents, skills, hooks, and the SDD protocol.
- **Preset** — a stack-specific layer with neutral bases (`vite-react-ts`, `express`) and specialized variants on top (Next.js, NestJS, Express+Mongoose, Vite+Mantine, Astro, Medusa, background-worker…).
- **Library skills** — modular skills that work across presets and are injected through dependency detection. A repository gets `socketio`, `mongoose`, `redux-toolkit`, `formik`, `zod`, and similar skills when it has the matching dependency, regardless of its preset.
- **Workspace** — inheritable defaults and cross-repository tickets for changes that span repositories.
- **Project config** — your overrides in `navori.config.json`.
- **Engine adapters** — Claude Code (`.claude/`) and full Codex (`AGENTS.md`, `.agents/skills`, `.codex/agents`, hooks, and MCP), plus universal `AGENTS.md`, Cursor, and Copilot. Pi is opt-in (`.pi/` with an extension and agents, and skills in `.agents/skills`); its minimum and tested version is 1.1.0, and it requires Node.js >= 22.19. See [docs/pi.md](./docs/pi.md) for the matrix and limits.

For full parity, use `"engines": ["claude", "codex"]`. For a lightweight Codex setup alongside Claude, use `["claude", "agents-md"]`; no additional `codexMode` setting is needed.

Codex has **parity of guarantees**: each hook, agent, skill, and rule has an equivalent in Codex or a documented limitation ([`docs/native-overlap.md`](./docs/native-overlap.md); see the [live verification](./docs/research/codex-paridad-verificacion.md)).

- After `navori render --apply` with Codex, run `navori codex trust` to approve the hooks. Repeat when they change (for example, when enabling `masterPlan` or tgrep) and in every worktree; `navori doctor` reports missing trust by path.
- Codex >= 0.160.0 is required; `doctor` warns if the version is older.
- Hooks call the globally installed npm binary, so keep it up to date. `doctor` warns if it is older than the repository's version.
- The tgrep search guard blocks only when an index exists (`tgrep index`); without an index, searches pass through.

**Synchronization model** — managed blocks carry `hash`, `version`, and `source`. `sync` reports available updates and warns before replacing a block you edited by hand. It creates a backup before each write.

**Model profile by agent** — each agent is rendered with its own `model` and `effort`: `orchestrator` and `architect` use `opus`/`xhigh` for judgment and design; `implementer`, `reviewer`, `scout`, and `auditor` use `sonnet`/`medium` for synthesis; `publisher` and `scribe` use `haiku`/`low` for mechanical work. Mechanical work does not cost as much as judgment-intensive work. Together with focused output and event-specific quality gates (only what applies, in parallel), this lowers the cost per session. See [`docs/recipes/model-tiering.md`](./docs/recipes/model-tiering.md).

## Planning by levels

`navori plan classify` measures task complexity (0–10) from repository signals (`project.criticalPaths`, a new dependency, schema migration, money/credentials/PII, and so on) and assigns a level:

| Level | What it means |
|---|---|
| 0 | Trivial — no workplan; direct exemption from the gate. |
| 1 | Standard — an `implementer`/`reviewer` workplan, with no prior design. |
| 2 | Requires design — first goes through `architect` (`opus`/`xhigh`), who delivers a `solution_<scope>.md` with at least three options and a recommendation. |
| 3 | Same as level 2, with broader scope (multiple repositories or a shared contract) — the same `architect` decides on the design before anyone writes code. |

With `harness.planTiers: true`, a `PreToolUse` hook (`navori plan gate`) denies dispatching a subagent without a valid workplan for its level. Two consecutive rejections raise the requirement to the next level (more artifacts, not just more attempts). If `navori` is not installed or has no `plan` subcommand, the hook has no verdict: in modes that show a prompt, it asks for confirmation instead of silently blocking. `navori plan classify --diff` runs the same classifier against the actual diff and warns when the work exceeds its declared level.

**Coexistence** — already have your own harness (orchestration/SDD)? `blocks.exclude` lets Navori coexist without overwriting your blocks: choose not to render `orquestacion` / `sdd` with `navori configure blocks`, and the rest of the harness stays the same.

## Commands

| Command | What it does |
|---|---|
| `init` | Bootstraps with stack detection and a wizard (or `--recommended` with no questions and no external installs, or `--full` to add external providers and a strict policy). |
| `refresh` | Redetects the repository, refreshes the config, and runs the full engine — *bring me up to date*. |
| `update` | Updates Navori from npm and runs `refresh` with the new binary (`--cli-only` stops after updating the CLI). |
| `render` | Generates native files for each configured engine (preview by default; `--apply` writes them). `--all` renders **every** repository in the global registry at once—the rollout after a Navori bump in one command. |
| `registry` | Global registry of your Navori repositories (`ls` / `scan <dir>` / `add` / `remove` / `prune`). `init` and `refresh` register repositories automatically; `scan` adds existing ones. |
| `sync` | Refreshes all configured engines with conflict resolution and backups. |
| `add` / `remove` / `configure` | Enables a plugin / disables it and cleans up its blocks and scripts / adjusts a config section without re-init. `configure migrate` renames retired keys that prevent the config from loading (`--all` applies to the whole registry). |
| `doctor` / `status` / `audit` | Audits config and drift, and reports external tool versions (informational; does not affect `--strict`) / quick snapshot / measures how the harness was used in your sessions (results, availability windows, snapshot comparison). |
| `sync` (per file) | In addition to blocks, offers interactive per-file replacement for unmarked files (`--accept-new-files` accepts them all at once). |
| `spec <classify\|check>` | Classifies a spec as a PR or delivery PR (`classify`) and validates its `tasks.md` (`check`): milestones, criteria, coverage, and vertical deliveries. |
| `plan <sub>` | Planning by levels (`classify`, `render`, `update`, `check`, `gate`); see [Planning by levels](#planning-by-levels). |
| `gate <fast\|full>` | Runs the quality gate, writing full output to a log (`.navori/state/gate/`) and only a compact verdict to stdout. |
| `handoff <check>` | Validates the implementer's handoff before dispatching the next agent. |
| `codex trust` | Approves project hooks in `~/.codex/config.toml`. |
| `receipt <sign\|check\|gate\|review>` | Receipt for reviewed content before publishing; `gate` decides whether each milestone needs the scoped or full gate. |
| `tools notice` | Emits pending external-tool version notices for the startup hook (`--ack` marks them as delivered). |
| `master <sub>` | Master plan by stages (`init`, `ux`, `mode`, `advance`, `check`, …) and deliveries (`delivery-*`, gated with `--approved-by`). |
| `adopt` | Brings a harness file you wrote by hand under Navori management (wraps it, does not rewrite it). |
| `workspace` / `ticket` / `dominio` | Cross-repository config and tickets, plus the durable workspace knowledge base. |
| `preset` / `scan` / `backup` / `migrations` / `bench` | Local presets, monorepos, restore, and benchmark. |

→ Full command table, presets, and plugins: [`packages/cli/README.md`](./packages/cli/README.md).

## Migrating to 0.12

- The `global` command and launchd collector were removed (`audit --collect` remains). `doctor --json` no longer emits `globalScope`.
- The `jscpd` and `semgrep` plugins were removed: `navori add jscpd|semgrep` reports that they are retired.
- The Pi floor rises to 1.1.0: Pi 0.87.x no longer provides `navori_subagent`. Minimum Node.js version: >= 22.12.
- `navori update` now updates the CLI (checks npm, confirms, installs, then runs `navori refresh`). The previous behavior is now `navori refresh`, with no alias: scripts that used `navori update` to resync the harness must switch to `navori refresh`.
- Migrate with `navori render --apply` (prunes retired assets managed by Navori), then run `navori doctor` (reports leftovers).

## Extend Navori in your repository

Navori installs a baseline; what makes it valuable in **your** repository is the knowledge only you have. There are four places to put it, ordered from least to most expensive. The least expensive often has the greatest impact because it puts your rule where the agent was already going to look.

| What you have | Where it goes |
|---|---|
| A repository-specific rule (your own pattern or data-layer convention) | The **user section** of the skill that already covers the topic. |
| Knowledge no installed skill covers | A **project-local skill** in `.claude/skills/<id>/SKILL.md` plus `project.localSkills`. |
| Stack knowledge reusable across repositories | A **local preset** (`navori preset init <id>`). |
| A wrapper for a binary or MCP server | A **plugin** (belongs in Navori, not your repository). |

`navori doctor` supports what you add and points out open opportunities: a declared id with no file, a skill that will activate once its `description` says when to use it, or a user section ready for your repository's rules.

→ The full guide—including four questions that make a proposal strong—is in [`docs/EXTENDING.md`](./docs/EXTENDING.md). The `SKILL.md` file contract (frontmatter, types, caps, triggers) is in [`docs/recipes/skill-authoring.md`](./docs/recipes/skill-authoring.md).

## Monorepo structure

```
navori-harness/
├─ packages/
│  ├─ cli/            # el CLI `navori` (publicado a npm)
│  ├─ core/           # @navori/core — managed assets (agentes, skills, presets, hooks), bundleados al CLI
│  └─ plugins/        # acli · codegraph · engram · gh · tgrep
├─ apps/
│  └─ website/        # landing + docs (Astro, deploy a GitHub Pages)
└─ package.json      # workspaces + trustedDependencies (bun)
```

`@navori/core` and the plugins are **bundled into the CLI** at build time (they are not published separately): a single `npm i -g navori` includes everything.

## Development

Local development uses Node 26.12.1 (pinned in `.nvmrc`) and bun 1.4.4; CI runs on Node 24; the published CLI keeps its declared minimum of Node >= 22.12.

```bash
bun install
bun run build                 # build de todos los paquetes

bun check                     # quality gate completo (lo que valida CI en PRs a main)
bun check:fast                # pasada rápida: format, jscpd, ast-grep, lint, typecheck
bun hooks:install             # instala el pre-commit: check:fast (sin tests)

# probar el binario local sin publicar:
node packages/cli/dist/index.js init --cwd /ruta/a/un/repo
```

**Quality gate**: run `bun check` from the repository root. It aliases `qualityGate.full` in `navori.config.json`, the **only place** where the gate is defined. The managed blocks in `CLAUDE.md` and the command run by `publisher` come from there. Do not copy it into another file: a second copy will drift.

→ How to contribute, what triggers mirror re-rendering, and the PR rules: [`CONTRIBUTING.md`](./CONTRIBUTING.md). What is and is not accepted: [`docs/DIRECTION.md`](./docs/DIRECTION.md) and [`docs/EXTENDING.md`](./docs/EXTENDING.md).

## Releases

Releases are manual and must follow **this order**. The flow is `dev` → `main`: tickets merge into `dev`, and `main` receives releases only from `dev`. Since 0.8.2, the commit in step 4 goes **through a PR**, not a direct push. The README used to document a direct release while warning in the same line that there would be no PR to review beforehand—in other words, CI would not validate the release tree until it had already landed.

1. Write the minor-version entry (a headline and 3–5 bullets, in Spanish and English) in `apps/website/src/content/releases.ts`. If the current CLI minor has no entry, the "release notes" block in `landing-inventory.test.ts` fails.
2. Bump the version in `packages/cli/package.json`.
3. **Re-render the mirror; this is mandatory:**

```bash
   bun run --filter navori build && node packages/cli/dist/index.js render --apply


```

   Each managed block marker records the CLI version, so the bump in step 2 makes the rendered mirror for this **entire** repository stale. From 0.6.0 to 0.6.1, this affected **30 files** across `.claude/` and `CLAUDE.md`. Skipping this step tags an inconsistent tree and makes the first post-release CI on `main` fail (`bun run check:render`, #421). With a PR, this is caught before landing; that was the blind spot of the direct push.
4. Commit `chore(release): navori vX.Y.Z`, including the version bump **and** the re-render from step 3. Push it to `dev` and open a PR to `dev`, like any other ticket.
5. Open a PR from `dev` → `main` with a **merge commit, not squash**. This keeps `dev` as an ancestor of `main`, so the next release does not bring rewritten history. After the merge, `dev` is behind the merge commit; fast-forward it to `main` so both branches match.
6. Tag `vX.Y.Z` — **automatic since 0.8.6**. `release-tag.yml` runs when `packages/cli/package.json` changes on `main` and creates and pushes an annotated tag on the HEAD of that push (the merge commit from step 5, which contains the `chore(release)` commit), if the tag does not already exist. It is idempotent, so rerunning it does nothing.

   This was automated because the step was skipped in **0.8.4 and 0.8.5**, and the second omission happened *after* the exact command had been written here. The damage is delayed and silent: `check-asset-commands.mjs` compares against the latest tag, so a release without a tag is checked against the previous one. It keeps saying "exists in v0.8.3" for a repository already on 0.8.4, and nothing fails.

   If you need to do it manually: `git tag -a vX.Y.Z <HEAD de main tras el paso 5> && git push origin vX.Y.Z`. Tags for releases before the `dev` → `main` flow point directly to the `chore(release)` commit, as `v0.8.2` → `285fa51` and `v0.8.3` → `6f32a00`.
7. Run `npm publish` from `packages/cli`.

The website footer prints the version by importing the CLI's `package.json` (`apps/website/src/components/Footer.astro`), and `deploy-website.yml` watches that file in its `paths` filter, so the version bump in step 2 redeploys the site. **If the site displays an old version, check that filter first**: until 0.8.4 it did not include the CLI manifest, and the site fell two releases behind, showing `v0.8.2` while 0.8.4 was already on npm.

## Credits and inspiration

Navori did not emerge in a vacuum. These projects inspired it; credit for each belongs to its creators:

| Project | What it contributed |
|---|---|
| [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) | The project closest to Navori: an ecosystem configurator with SDD, persistent memory, and organic routing by task complexity. |
| [gstack](https://github.com/garrytan/gstack) | Role-based skills that chain together; host auto-detection with a config per host; cross-model review. |
| [harness-sdd](https://github.com/betta-tech/harness-sdd) | EARS notation, required requirement↔test traceability, and the filesystem as the spec's state machine. |
| [ejemplo-harness-subagentes](https://github.com/betta-tech/ejemplo-harness-subagentes) | The Leader/Implementer/Reviewer pattern and anti-broken-telephone principle: state on disk, references in chat. |
| [superpowers](https://github.com/obra/superpowers) | Subagent-driven development: a fresh agent per task and specs "for an enthusiastic junior." |
| [ponytail](https://github.com/DietrichGebert/ponytail) | The anti-overengineering decision ladder—"weak on the solution, never on the reading." |
| [codegraph](https://github.com/colbymchenry/codegraph) | Precise context through a pre-indexed graph instead of grep/read loops. Available by opt-in with `navori add codegraph`; not enabled by default with `init --full`. An active Navori plugin, it was briefly retired on 2026-09-15 and reintroduced on 2026-09-16 (#838) alongside `tgrep`—see the [record](./docs/research/tgrep-como-funcionaba.md). |
| [graphify](https://github.com/Graphify-Labs/graphify) | A deterministic knowledge graph (code + docs) committed to the repository, like managed assets. |
| [caveman](https://github.com/JuliusBrussee/caveman) | Token efficiency as a cross-cutting skill: concise writing without losing technical accuracy. |
| [Goose](https://goose-docs.ai/) | Portable YAML recipes for sharing workflows across a team and CI/CD. |
| [Pi](https://pi.dev/) | "Primitives, not features": on-demand skills and extensibility over baked-in workflows. |

→ Project notes, with verified details and nuances: [`docs/inspiration.md`](./docs/inspiration.md).

## License

[MIT](./LICENSE)
