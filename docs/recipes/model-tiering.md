> [English](model-tiering.md) | [Español](model-tiering.es.md) | [简体中文](model-tiering.zh-CN.md)

# Recipe — model profiles and effort by agent in navori

> How to choose values for `{{models.<agent>}}` / `{{effort.<agent>}}`, the placeholders
> that render interpolates into each `.claude/agents/*.md` frontmatter.
> Defaults live in `packages/cli/src/lib/config/recommended.ts` (`RECOMMENDED_MODELS`,
> `RECOMMENDED_EFFORT`) and are seeded into `navori.config.json` by `init --recommended` /
> `--full`. Enforced by `packages/cli/src/lib/__tests__/recommended.test.ts`.

## Principle

Choose a model for each agent based on what its task needs, not one tier for everyone:

- **Mechanical** (map a directory, draft a commit): inexpensive, fast tier.
- **Standard implementation** (code that is already planned, textual synthesis): mid-tier.
- **Judgment** (review, audit, decide architecture): top tier.

Without an explicit profile, each subagent inherits the session model (typically the most expensive one), so mechanical work costs the same as judgment work.

## Recommended defaults

These are real `ModelsSchema` / `EffortSchema` keys (`packages/cli/src/lib/config/schema.ts`) that match file IDs under `core-assets/agents/`. The canonical roster lives in `engines/shared/roster.ts` (`ROSTER_AGENTS`).

| Agent | `models.<agent>` | `effort.<agent>` | Why |
|---|---|---|---|
| `orchestrator` | `opus` | `xhigh` | Orchestrates, defines scope, and arbitrates `CHANGES_REQUESTED` — the only pure-judgment role, so it is not downgraded. |
| `architect` | `opus` | `xhigh` | Designs level 2/3 tasks (`navori plan classify` chooses the level, not the model): reads a lot of code and weighs trade-offs before anyone writes code; keeps the orchestrator tier (spec 0026 F) instead of dropping to the synthesis tier. |
| `implementer` | `sonnet` | `medium` | Writes code from an already scoped task; sonnet performs almost like opus for coding at a fraction of the cost. |
| `reviewer` | `sonnet` | `medium` | Reviews against a spec/quality gate — synthesis against a contract, not architecture from scratch. |
| `scout` | `sonnet` | `medium` | Maps and/or investigates bounded questions; writes findings, not just file lists. |
| `auditor` | `sonnet` | `medium` | Architectural audit (SOLID, security, performance, edge cases) — closer to judgment than synthesis; `auditor.md` explicitly says so. |
| `publisher` | `haiku` | `low` | Drafts commits, PRs, and comments from an already approved diff — mechanical work. |
| `scribe` | `haiku` | `low` | Serializes verified evidence into Markdown — mechanical, like publisher. |

## Effort follows the same logic

`effort.<agent>` is the other control on the same axis: an expensive model plus high effort means more reasoning tokens and more tool calls per invocation. A mechanical agent on `sonnet`/`low` still costs less in aggregate than the same agent on `opus`/`xhigh` when run N times per session (for example, one `scout` per sub-map in a fan-out). The `orchestrator` effort also seeds `effortLevel` in `settings.json`, because that role is the main agent — it is not spawned as a subagent, so there is no other place to set its tier.

## Codex

Codex resolves model and effort independently. Family defaults are Opus → Sol, Sonnet → Luna, and Haiku → Luna; `models.codexMap` can map each tier to another family or a full ID. A full ID such as `gpt-6-sol` is pinned; a family such as `sol`, `luna`, or `astra` selects the highest compatible numbered version in Codex's local catalog, for example `gpt-6.1-sol`.

Claude effort only feeds into Codex resolution: Sonnet with `medium` becomes `high`, even if the model comes from a pin or `codexMap`. Other effort values remain unchanged (`Sonnet low` stays `low`, and `Sonnet high` stays `high`). An explicit per-agent override takes precedence for its corresponding field.

Overrides can be defined by native TOML agent name in `models.codexProfiles`. Keys must be exact names such as `implementer`; `orchestrator` is reserved for the main agent and uses `.codex/config.toml`. Each record can set `model`, `effort`, or both, independently:

```json
{
  "models": {
    "codexProfiles": {
      "orchestrator": { "model": "gpt-6.1-sol", "effort": "xhigh" },
      "implementer": { "model": "luna", "effort": "medium" }
    }
  }
}
```

The inventory includes the main agent and enabled Codex agents, along with project-native TOML files that navori does not manage. Those files are read from the checkout; user-local files are not rewritten. Rendering expresses managed intent for future starts while preserving user fields, newer values from the same family, and agent TOML owned by the user.

An entry in `models_cache.json` only supplies candidates. Freshness is `unknown` when there is no externally verified source, timestamp, and context; if the catalog is missing, malformed, or has no compatible entries, status is `degraded`. The cache, its mtime, and its slugs do not prove current availability. `configured`, render candidate, and `observed` are distinct states: without an observation tied to the started context, the effective result remains unknown and application is `pending`, with the remedy to start a new Codex context and verify model and effort there. No quality equivalence between models is claimed.

Pi resolves its model from `models.piMap` (opus/sonnet/haiku as `provider/id`) and inherits the parent Pi model for tiers without an entry; it does not read `codexMap`. Effort transformation and named overrides are limited to Codex. Claude profiles remain unchanged.

```json
{
  "models": { "piMap": { "sonnet": "anthropic/claude-sonnet-5-5", "opus": "anthropic/claude-opus-5-5" } }
}
```

## Do not put everything in the top tier

Cost multiplies per invocation, not per session. Putting every agent on `opus`/`xhigh` does not improve quality where no real judgment is needed; it only burns budget on every call. `init --recommended` / `--full` seed the table defaults; `init --yes` seeds nothing (each subagent inherits the session model).

## When to raise a tier

Use a concrete signal, not intuition: 2+ consecutive `CHANGES_REQUESTED` cycles on the same complex task (the cap is documented in `orquestacion.md`) indicate that the `implementer` tier — or the failing role's tier — is insufficient for that complexity, not that another retry is needed. Raise that agent by one tier before retrying the loop.

## Tier by fix, not by review round

When a review produces N findings, do not send the whole round to the same high tier. Classify each fix by what it requires, not by the round it belongs to. This applies the principle above to each fix instead of each agent; sub-tasks of different tiers can coexist within one round.

| Fix type | Examples | Tier |
|---|---|---|
| Mechanical | String tables, JSON edits, one-line notes, renames | Low/mid |
| Judgment | Design decisions, security regex, removal semantics | High |
