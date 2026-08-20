---
name: pr-create
description: Use when closing a cycle's PR (e.g. Phase 8 of ticket-intake). Superseded by the commit-pr-pilot agent — this skill just points there so the commit+PR flow has a single owner.
type: reference
---

<!-- navori:managed id="pr-create" hash="856dbb9b" version="0.6.0" source="@navori/core" -->
# pr-create — superseded by `commit-pr-pilot`

The commit + PR flow has **one owner**: the `commit-pr-pilot` agent
(`.claude/agents/commit-pr-pilot.md`). It owns the pre-flight, the PR gate
(`pnpm format:check && cd packages/cli && pnpm test && pnpm lint` green), the review/R1 handling, the body template and the
commit/PR language (per the config's `commits`).

**To close a cycle, invoke `commit-pr-pilot`.** Don't draft the PR from a separate
template here — a second flow drifts from the pilot (that's why this skill was
collapsed into it).

This pointer stays so flows that reference `pr-create` (e.g. `ticket-intake`
Phase 8) resolve to the pilot instead of a duplicate implementation.
<!-- /navori:managed id="pr-create" -->
