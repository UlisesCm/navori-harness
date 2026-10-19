> [English](skill-authoring.md) | [Español](skill-authoring.es.md) | [简体中文](skill-authoring.zh-CN.md)

# Recipe — authoring SKILL.md in navori

> The contract for a skill file: frontmatter, types, caps, and triggers.
> Implements spec 0003 §3.2.1 (output discipline) and §3.2.2 (triggers).
> Enforced by `packages/cli/src/lib/assets/__tests__/skill-caps.test.ts` against the assets
> bundled by navori (core, presets, plugins).
>
> **Where your skill belongs** — core, preset, plugin, or project-local — is a separate question,
> answered in [`../EXTENDING.md`](../EXTENDING.md). This document assumes you have already decided.

## Where the file lives

There is one supported shape, because it is the only one the host discovers: a **directory** containing its `SKILL.md`.

```
.claude/skills/<id>/SKILL.md
```

With this structure, the skill can be loaded immediately. The flat form (a standalone `<id>.md` in the `skills/` root) belongs to `.claude/commands/`, which is a different feature. This applies both to skills rendered by navori and to your own skills.

## Frontmatter

```yaml
---
name: nextjs-app-router
description: Use when touching app/ in Next.js App Router — Server vs Client Components. Not for data fetching (see nextjs-data-fetching).
metadata:
  type: reference
  # maxWords: 520           # optional — override the type cap
  # maxWordsComposed: 700   # optional — ceiling for the ALREADY composed file (see below)
---
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Skill ID (kebab-case). |
| `description` | yes | One line with an **activation trigger** (see below). |
| `metadata.type` | yes | `behavior` \| `reference` \| `tool`. It belongs under `metadata:` (#810): a top-level `type` is read as null. |
| `metadata.maxWords` | no | Raises the type cap when the length is justified. |
| `metadata.maxWordsComposed` | no | Ceiling for the composed file when a plugin extends it. |

Only `name`, `description`, and `metadata` are portable across engines (Claude Code, Codex, DeepSeek); an engine-specific key does not travel. `description` is limited to 500 characters — the lowest limit of the three — and ends with `Not for <neighboring skill>` when there is a skill it could be confused with.

## Caps by type

The body (everything after the frontmatter) has a word cap. Tokens are spent each time the skill loads, so keep it tight.

| Type | Cap | When |
|---|---|---|
| `behavior` | ≤200 | Defines how the agent acts (for example, `verify-before-done`). |
| `reference` | ≤500 | Documents a pattern/stack (for example, `mantine-ui-patterns`). |
| `tool` | ≤300 | Wraps an external tool. |

If a skill exceeds its cap, the test fails. To exceed it deliberately, declare `maxWords: N` — the override is explicit, never silent, and **the reason must be written in a comment** next to the field. Several core assets use it today; inspect them with `grep -rn 'maxWords:' packages/core/core-assets packages/plugins`.

### `maxWordsComposed` — the file the session actually loads

`maxWords` is the **asset author's** budget: what that file argues on its own. Its justification must not disappear because a plugin appended a section. `maxWordsComposed` is what the **session pays for**: the final `SKILL.md`, with every plugin extension injected and project values interpolated.

Declare it only for a skill that something extends (`injectInto`). When nothing extends it, the composed file **is** the asset, and `maxWords` already measures the right thing. Real example: `review-diff` declares `maxWords: 1200` and `maxWordsComposed: 1450` — 1200 for the core, 200 for a plugin extension, plus room for `project.criticalAreas` that render interpolates into the block.

## Triggers in `description`

The host loads a skill **on demand**, reading its `description` and deciding whether the situation fits. That trigger makes the skill work by itself at the right moment, so it has the highest return in the file: include an activation verb, and make the skill activate when needed.

- ✅ `Applies before touching src/api/.`
- ✅ `Use when defining HTTP contracts.`
- ✅ `Use when the user edits app/.`
- ↗ `Medusa rules.` → improve it with `Applies when touching src/modules/.`
- ↗ `Automate browser interactions and test web pages.` → says what it does; add when it should run

Common verbs in Spanish/English are accepted (`Aplica`, `Usar`, `cuando`, `antes de`, `Use when/this`): navori assets are written in English, but you can write your own skill in your language.

In prose engines (`AGENTS.md`, Codex, Cursor, Copilot), the trigger is also printed in the skills index, shortened to the first clause and cut off at 120 characters, so put it first. The `CLAUDE.md` index no longer prints it (#908): Claude Code reads the full `description` from its native listing. Put the entire “when to use it” in `description`, not in a body section. The body loads only after the skill activates.

## Optional pieces: declare a fallback

If your skill depends on something that may be missing from a machine — an external binary, an MCP server, persistent memory — state in the file what to do when it is absent; do not assume it is always available. Without this, a missing piece is reported as “found nothing” rather than “could not search”: the “silent skipping” anti-pattern (#824). A failed channel is not the same as zero results, and confusing them creates a false negative. `locate-code` is an example: it falls back to `Grep`/manual reading when no structural or textual provider is enabled, and to `Grep` plus bounded reading when `ast-grep` is not installed. Each fallback names its own degradation step instead of taking it for granted.

## Project-local skills

A skill you write in your repository (`project.localSkills`) follows the **same file contract**, with two differences:

- **navori never touches it.** It has no managed block or user section; the whole file belongs to you.
- **You choose the caps** — `skill-caps.test.ts` audits bundled assets. Those caps are still the right reference, because your own session pays for those tokens.

`navori doctor` accompanies them with two actionable warnings: that the declared ID has a file (`missingLocalSkills`) and that `description` contains a trigger (`triggerlessSkills`). They are suggestions, not blockers, and never change the verdict.
