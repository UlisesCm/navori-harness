[English](EXTENDING.md) | [Español](EXTENDING.es.md) | [简体中文](EXTENDING.zh-CN.md)

# EXTENDING — where your additions belong

> Navori is designed to be extended. The harness you install is a floor, not a ceiling: what makes it valuable in **your** repository is the knowledge only you have. This guide maps where to put that knowledge so it has the greatest effect.
>
> Read [`DIRECTION.md`](./DIRECTION.md) for the project's direction. Here we answer a practical question: *I have something new—a rule, a skill, a tool, a block of doctrine—where should I put it so it works now and still works six months from now?*
>
> This guide serves two audiences: **(a)** people extending Navori within their own repository and **(b)** people contributing to Navori. Most readers belong to (a), where the return per minute invested is highest.

## The good news: you probably already have a place for it

There are five destinations, ordered from least to most expensive. “Least expensive” means fewer files, less review, and fewer tokens per session. The least expensive option is also usually the most effective because it puts your knowledge where the agent was already going to look.

Start at the top and move down only when the previous option falls short.

| What you have | Where it belongs | Who versions it |
|---|---|---|
| A rule for **your repository** (a local pattern, data-layer convention, or critical area) | the **user section** of the skill that already covers the topic | your repository |
| Knowledge not covered by an installed skill | a **project-local skill** — `.claude/skills/<id>/SKILL.md` | your repository |
| Knowledge about a **stack**, reusable across several of your repositories | a **local preset** — `.navori/presets/<id>/` | your repository |
| A wrapper for an **external tool** (a binary or MCP server) | a **plugin** | Navori |
| **Universal** doctrine: true for any repository, stack, and engine | **core** | Navori |

Each step is meant to make the next one rarely necessary. If you are choosing between two, use the one higher in the table: you can promote it later, and promotion is easier than removal.

## Ephemeral state migration

The runtime stores handoffs in `.navori/state/handoffs/` and hook status in `.navori/state/hooks/`. Both are local to a checkout and must not be versioned. During **one release**, existing handoffs in `.claude/progress/` and `.codex/progress/` remain readable; an explicit continuation with `--dir` keeps using that location. When that window ends, Navori will not clean anything up automatically: it will not copy, move, or delete old or new state. To roll back, use the previous CLI version and explicitly select the directory with `--dir` when needed.

The previous stamps in `<git-common-dir>/navori/` also remain intact. Each checkout starts with its own detector baseline, so a notification may **re-arm once** after the update. This is not cleanup or migration of those stamps. The versioned `progress/` directory—including `progress/current.md` and `progress/history.md`—and presets under `.navori/presets/` retain their semantics and may be versioned; they are not ephemeral state.

Path validation protects against observable traversal and symlinks under the assumption of a **trusted local writer**. It does not provide race-proof containment: malicious **concurrent changes** to checkout directories can redirect reads or writes **outside the checkout** between validation and use. Static checks reduce the window but **cannot guarantee** that the **race** is avoided. The CLI does not clean up or repair those paths.

---

## 1. user section — the default, and almost always the best choice

Every skill Navori renders includes a `<!-- navori:user-section -->` sentinel. Everything you write below it is yours: `render` and `sync` preserve it in full, and it survives every CLI upgrade. The templates already suggest what to add; see the end of `.claude/skills/review-diff/SKILL.md`.

What you get: **no new files, no configuration, and no extra review**. The rule stays in the skill the agent already loads for that topic. This is the fastest way to turn your knowledge into agent behavior.

`navori doctor` points out user sections that still contain the template: they are open opportunities to add repository-specific rules to generic skills.

## 2. Project-local skill

When a topic deserves its own file, this option is entirely yours.

1. Create `.claude/skills/<id>/SKILL.md`. The **directory form** is what the host discovers, so the skill is loadable as soon as it has that structure (`packages/cli/src/lib/assets/skill-meta.ts`, `resolveLocalSkillPath`).
2. Write frontmatter with a `description` that says **when** to use the skill. That trigger lets the host load it automatically at the right time. The full contract—fields, types, and limits—is in [`recipes/skill-authoring.md`](./recipes/skill-authoring.md).
3. Declare the id in `project.localSkills` in `navori.config.json`. Then `doctor` checks that it exists (and warns if `<id>/SKILL.md` is missing), while prose engines list it in their skill index as `project-local`. In Claude, the host discovers it through its `description` alone (`CLAUDE.md` no longer has a skill index, #1273).

**Navori never writes inside this file.** It has no managed block or user section: the whole file is yours, and future renders will not touch it. Navori indexes the skill and checks it for you:

| `doctor` warning | What you can do |
|---|---|
| `missingLocalSkills` | Connect the declared id to your file so the skill appears in the index. |
| `triggerlessSkills` | Add the trigger that lets an existing skill activate itself. |

The second warning has the greatest payoff: writing good skill content is the hard part, but without a trigger the skill cannot do its job. Add a *“Use when…”* description to activate it.

## 3. Local preset

`navori preset init <id>` creates `.navori/presets/<id>/` with a manifest, `managed/stack.md`, and `skills/`, and wires it into the configuration. Resolution is **local → bundled**, so a local preset with the id of an official preset takes precedence. This is the clean way to adapt a bundled preset to your team's environment without changing the package.

The preset JSON can declare `libraries: [<lib-skill id>]`: these are the library skills it always includes, combined with `project.libraries` during rendering. Ids unknown to the CLI registry are discarded with a warning. The manifest `id` must match the filename or the preset will not load.

If you only want to add library skills to *this* repository without creating a preset, declare `project.extraLibraries: [<lib-skill id>]` (or `extraLibraries` inside a workspace for that workspace). These are your ids: `update` never changes them, and rendering combines them with detected and preset libraries. The root value is **not** inherited by workspaces; each workspace declares its own. An unknown id produces a warning in `render` and `doctor`. Removing a detected or preset library this way is not supported.

A local preset is the right step when the knowledge belongs to a **stack** and you want it to work the same way in your next repository. Write it once and use it in each one.

## 4. Plugin — a wrapper for an external tool

This is how Navori connects the harness to the outside world: a plugin wraps a binary or MCP server and keeps its installation, permissions, hooks, and documentation together. Existing plugins—`engram`, `acli`, `gh`, `tgrep`, and `codegraph`—share this shape: each declares `externalTool.checkBinary`. Follow that pattern; it lets `navori add <plugin>` offer installation and lets `doctor` verify the tool.

> **`codegraph` and `tgrep` are the sixth and seventh plugins.** They were retired on 2026-09-15 and reintroduced by #838 on 2026-09-16 with a new integration: *Code discovery* routing between structural and textual discovery. The earlier design's anatomy—external binary, MCP server, guard, session hook, and five doctrine injections—remains documented piece by piece in [`docs/research/tgrep-como-funcionaba.md`](research/tgrep-como-funcionaba.md).

If what you want to add has no tool to install, that is good news: it is probably a skill or a managed block, and those options are much quicker to ship.

A `plugin.json` offers up to six pieces. Include only the ones you need:

| Piece | What it provides |
|---|---|
| `externalTool` | A binary to check, a platform-specific install command (`darwin`, `linux`, or `win32`; any other platform key makes the plugin fail to load), and `installDocs`, the official installation URL for a platform without a command. Optional `capabilityProbe` (`{args, mustContain, minVersion}`) declares a capability flag that the binary must support when `--version` does not report it reliably—for example, when `--version` prints a minor version that differs from the package's. `doctor` and `init` run `args` and warn if the output does not contain `mustContain`. Unlike `pinnedVersion`, which requires an exact match with `--version`, `minVersion` is informational: it appears in the message but is never compared with the installed version. Optional `versionAdvisory` (`[{below, reason: {es, en}, ref?}]`) lists curated versions with a known problem. If the installed version is below `below` (exclusive; `below` is the first fixed version and must be exact `x.y.z`), `doctor` warns without using the network. This is informational only: it never affects the health verdict or `--strict`. The three version fields serve different purposes: `pinnedVersion` requires exact equality and warns for both older and newer versions; `capabilityProbe.minVersion` is displayed only; and `versionAdvisory.below` is the floor for versions known to have a problem. Convention: add an entry only when it has an upstream `ref` (issue or release); `reason` must include both `es` and `en`. If upgrading alone does not clear the condition, put the remedy in `reason` (for engram, run `engram setup codex` again). Every matching entry is reported; a prerelease of the fixed version counts as fixed. Optional `latestRelease` (`{source, id, notify?}`) opts into the notice that a newer upstream release is available (#1244). It cannot be combined with `pinnedVersion`; if both are present, loading fails. The query runs in a detached worker once per day per tool, without a token, against `api.github.com/repos/<id>/releases/latest` when `source` is `github`, or `registry.npmjs.org/<id>/latest` when `source` is `npm`. Only stable versions in `x.y.z` form are saved (`v` prefixes are accepted; anything else is marked “unparseable” in `doctor` and is never reported). The notice appears at session start if it fits the context budget; otherwise the session points to `navori doctor`. `notify` is the minimum change level that triggers a notice: `major`, `minor`, or `patch` (default: `minor`). Host tools (Claude Code, Codex, and Pi) are not monitored because they notify users themselves. When adding this field, bump the manifest's `version` in `plugin.json`. |
| `managed[]` | Blocks injected into `CLAUDE.md`. |
| `settingsFragment` | The permissions your tool needs, already configured. |
| `scripts[]` | Files copied to `.claude/scripts/`. |
| `hooks[]` | Hooks registered for events such as `SessionStart` and `PreToolUse`. |
| `skills[]` | Plugin-owned assets **or** extensions to existing assets through `injectInto`. |

**`injectInto` is the most elegant part of the format.** If a plugin has doctrine for an agent that already exists, inject it into that agent's file. The agent learns about the tool without anyone maintaining a parallel copy. `engram` reaches four destinations (`orchestrator`, `implementer`, `reviewer`, and `auditor`) without adding a single new asset—four stronger agents for the cost of two extension files.

Measure the result: the **composed** file is what the session loads, and it has its own ceiling (`maxWordsComposed`). Injection costs much less than duplication; that ceiling helps keep it that way.

## 5. Core — what works for everyone

The bar is high for good reason: core content is rendered into every repository where Navori is installed. A good candidate is **true for every repository, stack, and engine**. If a sentence needs “if you use X,” it belongs in a preset. If it needs “on our team,” it belongs in a user section. All three are useful contributions; they belong at different layers.

If the idea really is universal, the path is open: reread the invariants and non-goals in `DIRECTION.md`. If the idea touches one of them, propose it in a spec under `specs/`. A spec is where a substantial idea gets a serious discussion.

---

## Four questions that make a proposal stronger

Answer these before writing. Doing so makes the change easier to review. They are the same four questions reviewers ask.

## 1. Where does this topic live today?

Open the list of skills the host shows in your session (`CLAUDE.md` no longer has an “Available skills” block, #1273). It includes core skills, workflow skills, auto-detected library skills, and preset skills. Spending a minute on this list often reveals that the topic already has a home. Then your contribution can go in that skill's **user section** or through `injectInto`—faster to write and backed by the authority the skill already has.

Keeping a topic's knowledge in one place helps the agent respond consistently. Adding to an existing home, instead of creating a neighboring copy, reinforces that consistency.

## 2. How does it fit the project's direction?

`DIRECTION.md` declares ten invariants and a list of non-goals—the agreement that keeps Navori consistent across versions and repositories. Align with them and the proposal is quick to review.

If your idea needs to change one of them, there is a path for that too: propose a spec. Specs are how the project changes direction, and anyone with a case to make can open that discussion.

## 3. What does it cost, and what does it contribute?

The limits are concrete. Knowing them helps you write with focus:

- Startup context has a budget of **8000 bytes** (`NAVORI_CTX_BUDGET`, in `packages/core/core-assets/hooks/session-start-context.sh`). The agent reads everything in it every session, making it the harness's most valuable space. Content that does not fit becomes a *“read this with `Read`”* pointer. That still helps, but delivers less value.
- Each skill type has a word limit. `maxWords` lets you raise it when the length is justified; the override is explicit so the reason sits next to the number.
- A managed block in `CLAUDE.md` costs tokens in every session of every repository that contains it.

Use this question to sharpen any text: *Does it deliver more value than the space it takes?* A precise paragraph often beats a page, and the whole harness benefits.

## 4. Is this an implementation or a decision?

Both are welcome, and they work better as separate contributions. If your change affects **how a decision is made**—what gets delegated, what is rendered always-on, what Navori writes into a user's repository, or what permissions the harness has—put that part in a spec, where it can be discussed on its own merits. Once the decision is settled, the implementation can follow cleanly.

---

## Checklist before you submit

For (a), extending your repository:

- [ ] I checked the skills shown in my session and know whether the topic already has a home.
- [ ] I chose the least expensive option that works (user section before skill; skill before preset).
- [ ] The `description` says **when** to use the skill, not only what it does.
- [ ] `.claude/skills/<id>/SKILL.md` uses the directory form, and its id is declared in `project.localSkills`.
- [ ] `navori doctor` passes.

For (b), contributing to Navori—everything above, plus:

- [ ] I read `DIRECTION.md` and know which invariant the change supports (or which spec proposes it).
- [ ] If I am extending an existing asset, I use `injectInto` and build on what is already there.
- [ ] I respect the word limit for the asset type, or declare `maxWords` with the reason beside it.
- [ ] The quality gate (`pnpm check`) passes, and the mirror re-render is in the same PR. Exact triggers are in [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## If you are reviewing a proposal

Ask four questions, in order and conversationally. There is usually a version of the idea that fits; finding it is part of the review.

1. **What is its natural layer?** (Use the table above.)
2. **Does this topic already have a home?** If it does, use a user section or `injectInto` to get there faster.
3. **How does it fit the project's direction?** If it proposes a change, give it a fair discussion in a spec.
4. **What does it cost, and what does it return?** If it enters always-on context, say what the reader gains in exchange.

## References

- [`DIRECTION.md`](./DIRECTION.md) — purpose, goals, non-goals, and invariants.
- [`recipes/skill-authoring.md`](./recipes/skill-authoring.md) — the `SKILL.md` contract: frontmatter, types, limits, and triggers.
- [`architecture.md`](./architecture.md) — how rendering works, the five layers, and managed blocks.
- [`../packages/cli/src/engines/README.md`](../packages/cli/src/engines/README.md) — the sixth, most ambitious destination: **adding an engine**. It explains the `EngineAdapter` contract and spike checklist, designed to make a new provider cost one declarative table.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — quality gate, mirror re-render, commits, and pull requests.
