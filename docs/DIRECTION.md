> [English](DIRECTION.md) | [Español](DIRECTION.es.md) | [简体中文](DIRECTION.zh-CN.md)

# DIRECTION — Navori Source of Truth

> **Read this BEFORE proposing or building anything in Navori** (human or AI agent).
> It sets the project's direction: what it is, where it is going, and what it should and should not do.
> An idea that conflicts with an invariant here needs to go through "What requires discussion"
> before implementation. Formal decisions live in `specs/`; this document summarizes and links
> to them without duplicating them.

## What is navori

navori is an npm package whose CLI (`navori`) reproduces a **multi-agent harness + SDD** in any
repository. It supports multiple engines: Claude Code, native Codex (implemented in Spec 0004),
Pi (opt-in; verified controls are documented in [`docs/pi.md`](./pi.md)), AGENTS.md, Cursor, and
Copilot. The engine adapters share a rendering pipeline but do not promise identical feature sets. Navori
rebuilds each engine's resources **idempotently** from the single source of truth
(`navori.config.json`) without overwriting the user's manual work. The project is an MVP in
internal production (rolled out to 15 Bonum repositories), in a Bun workspace monorepo with `@navori/cli`,
`@navori/core`, and `apps/website`.

## North Star

**Every repository should enter an AI session with guardrails, orchestration doctrine,
memory, and quality already in place—reproducibly and without degrading the user's work.**
Navori generates the harness; it does not run agent tools. Instead, it specifies which tools
and doctrine to use through skills, permissions, and protocols materialized as managed assets.

Navori is **tool-for-self first**: each feature should help Ulises and Bonum work better,
not simply popularize the product. The MVP already covers the real workflow; the next priority
is to **harden what exists** rather than add new surface area.

## Harness status

The ephemeral state of execution is local to the checkout and neutral to the engine: handoffs in
`.navori/state/handoffs/` and hook stamps in `.navori/state/hooks/`. It is not versioned.
By contrast, `progress/current.md`, `progress/history.md` and `.navori/presets/` remain
versionable project knowledge. This separation introduces no hidden persistent configuration:
`navori.config.json` remains the harness's source of truth.

## Goals

- **Reproducibility**: `render` rebuilds the entire harness from `navori.config.json`. Zero
  hidden state; the checked-in config is the only source of truth.
- **Hybrid, non-destructive model**: managed content is synchronized; user-authored content is
  left untouched. The defining capability is regenerating the harness without destroying manual work.
- **Multi-engine with a single pipeline**: adding a provider should require roughly one
  declarative table, not a new rendering implementation (shared spine, Specs 0007/0008).
- **Quality that lasts**: the CLI and generated assets should behave predictably, backed by a
  strict quality gate.
- **Token efficiency**: the rendered harness is loaded in every session, so reducing its
  always-on footprint compounds over time (Specs 0005/0006).
- **Workspace-level foundation**: add durable knowledge shared across a workspace (Domain,
  Spec 0011) without replacing repository-specific configuration.

## Non-goals

Explicitly **out of scope** unless a strong new reason changes it:

- **Product promotion, branding, marketing, monetization, product localization, or a Rust control plane.**
  Public documentation and website localization are an approved exception; CLI localization
  remains out of scope. Navori is a tool for its own team, not a market product (Spec 0003).
- **Formalized public plugin ecosystem.** Plugins are internal bundles, not a
  marketplace.
- **Selective-installation architecture** modeled on other tools.
- **Large new features while existing functionality still needs hardening.** Priority:
  quality > tokens > speed, in that order.
- **LSP / Serena (Rung 3 of the search ladder).** Discarded due to fixed overhead (~3k
  tok/session + language server); the ladder is cut in Rung 2/ast-grep (Spec 0005).
  CodeGraph (Spec 0009) was added as a low-cost local AST index, not as an LSP. It was removed from the engine
  on 2026-09-15 together with `tgrep` (Spec 0017) — **partial and temporary** withdrawal: the announcement
  was to reimplement them from scratch with an integration that made them work with each other, and
# 838 (2026-09-16) closed that cycle.

Today both are opt-in plugins again, with routing
  *Code discovery* choosing between structural (CodeGraph) and textual (tgrep/native) discovery
  by the type of question, not by prose doctrine. What was measured before reimplementation
  —codegraph with correct wiring and zero calls; tgrep at 7.4% by doctrine and 40.7% with
  mechanical guard—remains as history of the previous design in
  [`docs/research/tgrep-como-funcionaba.md`](research/tgrep-como-funcionaba.md); the rejection
  LSP/Serena is not re-litigated for this.
- **Have Navori execute agent tools.** Navori generates the harness (skills, allowlists,
  plugins, and protocols); the agent runs grep, ast-grep, tests, and other tools.
- **"Voice of Navori" / app-builder / review 4R** — parked (Spec 0010, superseded by 0046).
- **Doctrine floor per machine in `~/.claude`** (global layer, Spec 0010). It was not adopted: it cost
  ~5.5-6k LOC and retired with Spec 0046; sessions outside a repo with Navori are left without
  harness on purpose.

## Design principles and invariants (do not revisit without a new reason)

1. **5 cascading layers** — Core → Preset → Workspace → Project config (`navori.config.json` +
   plugins opt-in) → Engine adapters. Each layer builds on the previous one. *Why*: separate
   a universal baseline from stack-, organization-, repository-, and engine-specific
   configuration without duplication.
2. **Multi-engine from day one** — the core is engine-agnostic even when only some engines
   are rendered. *Why*: adding a provider should not require rewriting the pipeline.
3. **Source of truth = checked-in `navori.config.json`** — `render` rebuilds from this file.
   *Why*: complete reproducibility without hidden state.
4. **Hybrid sync model with markers** — `<!-- navori:managed ... -->` syncs;
   Everything outside the markers belongs to the user and remains untouched. `hash` detects
   content drift; `version` records the Navori version that last changed the block's content
   (not the version that rendered it). Re-rendering unchanged content with a newer CLI therefore
   does not touch the file.
   `harnessVersion` in `navori.config.json` is the repo-level record of the latest version that
   applied a real change and supports anti-rollback (#1262). *Why*: regenerate idempotently
   without overwriting manual work or adding noise to the diff.
5. **Render preview by default** — `render` does not write to disk; `--apply` writes atomically
   (with fsync) after creating a backup. *Why*: never surprise the user with changes on disk.
6. **Plugins as bundles** — each plugin comes with optional pieces (settings fragment,
   claude-md block, skill, hook, doctor check) and is declared within the Project config layer.
   *Why*: cohesive opt-in additions without introducing another layer.
7. **A single render pipeline (shared spine)** — inventory resolution, placement, backup,
   writes, and pruning happen once; engines are declarative tables on that shared pipeline
   (Specs 0007/0008). *Why*: a pipeline fix reaches every engine and prevents silent divergence.
8. **Zero footprint without opt-in** — the Domain is **additive**: it steps aside when a
   repository has its own Navori config and never degrades what that repository already has.
   *Why*: a workspace-level foundation must not disrupt existing repositories.
9. **Navori generates; it does not execute** — the harness teaches agents which tools to use.
   A project may opt into a narrowly scoped native Codex integration that observes host profiles
   and evaluations and can authorize one fixed PR publication, following an authenticated human
   decision and immutable scope. The engine retains its normal execution model. This exception
   does not allow a general-purpose execution API, runner, model broker, new dependency, always-on
   surface, global changes to permissions/configuration/trust, or waivers of R6/A9/A10. The
   approved scope allows implementation of an authorized host browser driver; it does not claim
   that the controller, publication effect, or profile observation already exists or is accepted.
   Prefer existing supported host ownership when it meets the guarantees. Any new parent client
   must enforce the same immutable scope and human-entry limit
   ([rule](../specs/0050-codex-resultados-equivalentes/design.md)). *Why*: keep the CLI simple
   and the harness portable.
10. **Self-hosting** — this repository and all non-Bonum repositories commit the harness
    (`.claude/`, `CLAUDE.md`, and `navori.config.json`): Navori uses its own tooling. Repositories
    under `/bonum` ignore the local harness by convention.

## PR and verification unit

The functional delivery is the unit of a PR; the milestone is the unit of verification and
commit. A small spec fits in one PR. A larger spec is split into two to four PRs according to
`sdd.deliveries`. Run the full gate once per PR against the exact contents to be published.
There is no integration branch: merge deliveries in order into `prTarget`. Master plans follow
the same rules. Details and evidence: [`docs/research/distribucion-entregas-agentes.md`](research/distribucion-entregas-agentes.md).

## Admission criterion by surface

Before adding a new surface (plugin, MCP server, managed block or skill), the
admission order by mechanism is: always-on rules → on-demand skill → MCP → local CLI → direct
API. Prefer the smallest runtime surface, lowest token overhead, and fewest moving parts. This
is a different axis from [`docs/EXTENDING.md`](./EXTENDING.md), which orders where repository
knowledge belongs by ownership: user section → project-local skill → local preset → plugin →
core. On that axis, the always-on core block is the most expensive, last step. The axes are
independent: one selects the mechanism; the other selects where the knowledge lives.

Claude first, native first: use a driver only when the host no longer provides that capability.
The typed inventory, not prose, determines that decision. The generated table is in
[`native-overlap.md`](./native-overlap.md).

An MCP server earns a place only if it meets **both** conditions: (1) **universal**—it applies
to virtually every session, not just a niche case; and (2) **MCP is better than a skill-wrapped
CLI or API**—the job needs a capability only MCP provides, such as interactive session state,
streaming, an authentication handshake, or structured browsing. Stateless request/response work
belongs in a skill, not a server.

Other harnesses (ECC) justify this rule by saying that each default connector loads roughly 30
tool schemas into every session. That cost claim is outdated for Claude Code: the
[official context-window documentation](https://code.claude.com/docs/en/context-window) says
MCP tool schemas are **deferred by default** and loaded on demand through tool search; only the
tool-name list is always loaded. Navori's criterion is architectural (stateless work belongs in
a skill, with fewer moving parts), not ECC's token-cost argument.

`packages/core/core-assets/` does not declare any `mcpServers` today — zero connectors
default. This rule is a criterion for what is to come, not an audit of what already exists.

**Withdrawn** (surface, verdict, and replacement, so a decision is not repeated without its
evidence): none today. `tgrep` and `codegraph` passed through this table between 2026-09-15 and
#838 (2026-09-16). The earlier measurements and why they do not count as a low-value rejection
are documented in [`docs/research/tgrep-como-funcionaba.md`](./research/tgrep-como-funcionaba.md).

## Agent admission criteria

An agent (from the core or from a preset) is admissible **only if it guarantees at least one**
of these three things. If it does not guarantee any, it is **expendable** and is proposed for withdrawal
([Spec 0031](../specs/0031-admision-de-agentes/requirements.md)).

- **Quality:** a result that is verifiably better than the main thread could produce—for
  example, independent verification in a fresh context, a model tier the orchestrator cannot
  assign to itself, or specialized context the main thread should not load.
- **Speed:** less total time for parallel fan-out over independent work.
- **Tokens:** **net** savings after cold-start cost (about 25k tokens at the `cache_creation`
  price, measured in Spec 0027). For example, keep bulky output out of the main context when it
  will not be read there, or delegate mechanical work to a cheaper tier.

Application rules:

- **The priority order applies across all axes:** a lower-priority gain cannot come at the
  expense of a higher-priority goal (quality > tokens > speed). For example, faster parallel
  implementation does not justify lower quality.
- **Every proposal states** its guarantee, the signal used to measure it, its startup cost
  relative to its output, and a dated retirement criterion (for example, no invocations for N
  days → `RETIRED_AGENTS`).
- **A new agent is turned off by default** until its signal supports it. Exception: `architect`
  (spec 0032 R35) — the user decided to always enable it, without a flag, because the level that activates it
  (2/3) is decided by `navori plan classify`, not the model, so the cost is limited without
  need for a separate switch.
- **Expanding the work of an existing agent** goes through the same testing before being deployed,
  with the cold start of each delegation counted in the token axis.

The local skill `author-agent` in this repo applies the criteria when proposing or reviewing an agent.

## What requires discussion before switching

These decisions have already been made and should not be revisited without a new reason. Changing
one requires a **new spec or an amendment to the current spec**, not a standalone PR:

- Any of the 10 invariants above.
- The list of Non-goals (reconsidering branding, a plugin marketplace, LSP, and similar items
  requires a documented reason that the context has changed).
- The order of priority of goals: **quality > tokens > speed**.
- The admission criteria for agents (Spec 0031).
- The lean scope of the Domain (Spec 0011; 0010 superseded by 0046): expansion into "voice",
  app-builder, or review 4R is deliberately parked.
- The form of the managed assets (markers, `hash`/`version`, managed zone vs user zone):
  breaking this contract breaks `sync` on all already installed repos.

Rule of thumb: if your idea contradicts an invariant or reopens a Non-goal, **open/edit first
a spec** on `specs/` and get it approved; only then is it implemented.

## How to contribute within the constraints (humans and agents)

1. **Read this document first**, then `docs/architecture.md` (how rendering and the layers
   work), and the spec or specs for the area you plan to change (`specs/000X-*.md`).

   Before writing, **identify the layer where the change has the greatest effect** by reading
   [`docs/EXTENDING.md`](./EXTENDING.md). Its five destinations run from least to most
   expensive; the least expensive is often the most effective. Adding a rule to an existing
   skill gets it in front of the agent sooner and carries the right authority. The guide also
   gives four questions that make a proposal stronger.
2. **Formal decisions belong in `specs/`.** Do not introduce new direction through a PR. If a
   change needs an architectural decision, document it in a spec. Respect the status in the
   header (`proposed`, `planning only — NO implementar`, or `EJECUTADA`) **and verify it against
   the code**, the more current source (see "References").
3. **Quality gate (required before closing changes in `packages/cli`)** — `pnpm check` from
   the root of monorepo. This is what validates the CI job `quality`, or the PR fails.

   The gate is defined in **one place**: `qualityGate.full` in `navori.config.json`. `pnpm check`
   is its alias, and the managed blocks in `CLAUDE.md` are generated from that configuration.
   This document deliberately does not repeat the command list: a second copy can drift out of
   sync, as happened once before (#508).

   Details not apparent from the command—the mirror re-render triggers, golden snapshots, and
   what qualifies as a documentation-only change—are in `CONTRIBUTING.md`.
4. **Commits**: use Conventional Commits, write them in Mexican Spanish, and keep each commit atomic.
5. **Branches and PRs**: start each ticket on a new branch based on `dev` and open a PR to `dev`.
   Only release PRs from `dev` go to `main`, using a merge commit (`branchBase`/`prTarget` in
   `navori.config.json`). Never commit a `/bonum` repository's local harness.
6. **Memory (engram)**: `mem_search` at the beginning if the message references navori; `mem_save`
   proactive following a design decision; `mem_session_summary` before closing.

## Convention: self-sufficient rule with typed binding (issue #816)

Write the obligation in the rule itself and link its rationale to a single owner instead of
repeating it inline. This convention comes from the dsh pattern
([source](research/deepseek-harness-lessons.md#32--el-patrón-canónico)):

```
- **<obligación>**: <condición o excepción, si hace falta> (`[<ancla>](<ruta>)`).
```
The anchor vocabulary is limited to four terms, each pointing to a different kind of owner
Navori already has; it does not create a new destination:

| Anchor | Owner of the other side |
|---|---|
| `[rule]` | the formal spec in `specs/` that governs the behavior |
| `[why]` | the invariant or section in `docs/DIRECTION.md`, `docs/architecture.md`, or `docs/research/` that explains the full trade-off |
| `[decision]` | the GitHub issue or PR recording the decision, when no spec or document exists yet |
| `[scope]` | the skill or section of `CLAUDE.md` that defines where the rule applies and where it does not |

Pattern rules:

- **One owner per rule.** If the rationale already lives in `docs/DIRECTION.md` or a spec, the
  rule links to that source instead of repeating it. Duplication is the drift this pattern is
  designed to prevent.
- **No header fragments between files.** Today there is no gate that verifies anchors `#slug`
  (see the finding in [`deepseek-harness-lessons.md`§3.3](research/deepseek-harness-lessons.md#33--qué-significa-para-navori)). A file-level link
  is checked with `test -f` and remains valid if the destination heading changes. A fragment
  within the **same** file, such as one in this section, is different: Markdown resolves it
  without relying on another renderer's slug-generation rules.
- **Before applying this pattern to managed blocks, add `verify-md-links`** — this is already
  identified as a prerequisite in the cited `§3.3`. Until that gate exists, apply the pattern
  selectively at low-risk points rather than broadly.

## References

- `docs/architecture.md` — how the render works, the 5 layers and the managed blocks.
- `docs/EXTENDING.md` — which layer is the best home for a proposed addition (user section / project-local skill / local preset / plugin / core), and the four questions that strengthen a proposal.
- `docs/recipes/skill-authoring.md` — the contract for a `SKILL.md`: frontmatter, types, caps and
  triggers.
- `specs/` — formal architectural decisions. The current set covers 0001–0021 plus
  `gitignore-harness`: 0001 workspace rendering,
  0002 engine Claude, 0003 v0.2 quality/tokens, 0004 engine Codex, 0005 efficient reading, 0006
  context reduction, 0007/0008 unified render-plan, 0009 codegraph, 0010 (superseeded by 0046),
  0011 Domain, 0012 solutioning layer, 0013 redefinition of `audit`, 0014 foreign harness, 0015
  orchestration outside of always-on, 0016 permission mode parity, 0017 tgrep search layer
  (retired 2026-09-15, reintroduced by #838 on 2026-09-16 with new integration — its banner and
  0009 remain as minutes of the design of that first round, not of the current code; detail in
  `docs/research/tgrep-como-funcionaba.md`),
  0018 harness by workspace, 0019 orchestration that fits at boot, 0020 delegation by
  native mechanism, 0021 OTel events as third source.

  **How to read them accurately.** Each spec header records the intent at the time it was written;
  the code shows what was ultimately implemented. Some specs were written before implementation
  and retain their original status: 0001 and 0002 still say `proposed` even though their content
  is in production. Eleven specs still have no `Status` field. Reading a spec alongside the code
  quickly reveals the current state. Undecided work is clearly marked `planning only — NO
  implementar hasta aprobación`, as in 0005 and 0006. Normalizing these legacy headers remains a
  worthwhile improvement because new readers see them first.
- `docs/audit-2026-07.md` — audit of the generated harness and the CLI.
- `CLAUDE.md` (root) — live repo instructions (sections "What is this project",
  "Decisions already made", "Quality gate").
## CodeGraph remains opt-in for new installations

The Spec 0039 T31 measurement concluded `quitar-del-default`: CodeGraph did not meet the
pre-registered threshold for the measured Claude discovery workload. Therefore, `navori init --full`
no longer enables it by default, though it remains available by explicit opt-in. Existing
configurations are unchanged, and `navori doctor` reports the policy. This result does not
establish savings across other repositories, engines, or subagent payloads. Evidence and limits:
[`codegraph-costo-neto.md`](./research/codegraph-costo-neto.md).
