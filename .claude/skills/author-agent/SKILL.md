---
name: author-agent
description: Use when proposing, expanding, writing, or reviewing a navori agent (core-assets/agents, a preset's extras.agents) or deciding whether an existing one should be retired. Applies Spec 0031's admission test — quality, speed, or net token savings, else expendable — and the per-engine contract for Claude Code, Codex, and DeepSeek. Not for skills.
metadata:
  type: reference
---

# Authoring a navori agent

A subagent starts cold at ~25k tokens (Spec 0027); a multi-agent run costs ~15× a chat (Anthropic). Most work is cheaper in the main thread or a skill — prove the agent pays first.

## 1. Admission test (Spec 0031, `docs/DIRECTION.md`)

It must guarantee at least one of these, or it is expendable:

- **Quality:** independent verification in a fresh context, a model tier the orchestrator can't set for itself, or specialized context the main thread shouldn't carry.
- **Speed:** parallel fan-out over independent work. Sequential or shared-state work doesn't qualify.
- **Tokens:** net of the cold start — it keeps bulky output out of the main context, or moves mechanical work to a cheaper tier.

A gain on one axis can't cost a higher-priority one (quality > tokens > speed). The proposal names its guarantee, the signal that measures it, its start-up cost against its output, and a retirement deadline. New agents ship off by default. Expanding an existing agent's job passes the same test, counting each delegation's cold start.

## 2. Per-engine contract

| | Claude Code | Codex | DeepSeek |
|---|---|---|---|
| File | `.claude/agents/<id>.md`, body = system prompt | `.codex/agents/<id>.toml`, `developer_instructions` | no declarative agent file; navori renders nothing |
| Triggering | automatic, from `description` | explicit, except Ultra's proactive delegation | named tool call |
| Tool limits | `tools` allowlist | no per-tool list: `sandbox_mode` | `toolFilter` |

Write the navori asset once; the render maps it. Codex drops `tools`: its posture comes from the agent's `sandbox` field in `roster.ts` (`read-only`, or workspace-write when unset — an agent that writes handoffs needs the latter).

## 3. The asset

- Frontmatter: `name`, `description`, `tools`, `model: {{models.<id>}}`, `effort: {{effort.<id>}}`, `maxWords`.
- Description ≤340 characters and in the "Use proactively / when / after / before" family (`agent-descriptions.test.ts`).
- Tools: least privilege, and never `Agent` — navori policy (Spec 0026 R21), though Claude Code itself allows nesting.
- Body: objective, inputs, output contract (its handoff file), tools and sources, boundaries.
- Tier by the work: mechanical → cheapest tier and low effort; judgment → top tier.

## 4. Registration (core agents) — every piece or the parity tests fail

`engines/shared/roster.ts` (with its `sandbox`), `AGENT_ROLES` and `AGENT_ROLE_KEYS`, `schema.ts` harness default (off) plus its models/effort keys, `lib/recommended.ts`, `lib/assets/legacy-agents.ts`, i18n `agentsIndex.when` in es and en, the handoff contract in `agents-assets.test.ts`, `roster-parity.test.ts`, the catalog counters, then the mirror re-render and golden snapshots (`CONTRIBUTING.md`). Retiring one: append to `RETIRED_AGENTS` with its successor. A local preset only lists the asset in `extras.agents`.

## Before declaring done

Copy and check off:

- [ ] The admission test names one guarantee, its signal, and a retirement deadline.
- [ ] The same job can't be done by the main thread or a skill at lower cost.
- [ ] Description, tools, and tier follow §3; the agent ships off by default.
- [ ] Every §4 piece is updated and `qualityGate.full` is green.

If any item fails, fix it and re-run the whole list.
