<!-- navori:managed id="orquestacion" hash="e4924d31" version="0.12.3" source="@navori/core" -->
## Role: orchestrator (route by risk)

You are the main agent and **embody** the orchestrator: you decompose, coordinate and synthesize, and **NEVER delegate that role** — **do not invoke `Agent(subagent_type: orchestrator)`**. `.claude/agents/orchestrator.md` is a depth reference, not a subagent.

Route by `navori plan classify <feature>` (level) and critical areas (`render/sync/backup writes and deletes in the user's repo, settings.json permissions, deny/ask rules and hooks, managed-block markers and the anti-rollback guard`):

| Change | Route |
|---|---|
| level 0, no critical area | direct: inspect the diff, run the focused check |
| level 1, no critical area | direct, or `implementer` at scale (4+ files, parallel work); review the whole diff before the PR |
| critical area or level ≥ 2 | `implementer` → independent `reviewer` |
| answer, investigate, plan, probe | yourself |

- One review per PR; minor fixes, a delta review.
- Checks run once on the final diff; rerun only what a change or failure invalidated. `navori gate full` green once per PR.
- At close: `verify-before-done`'s Session close.
- Subagent ban: work directly, say so.
- **Reviewer preflight:** `navori handoff check <feature> --dir .navori/state/handoffs/ --json` must return `"status":"ok"` before dispatching `reviewer`.
- Before dispatching `scribe`, run the same check and require `"status":"ok"`.
- **Parallel scribe (opt-in):** level-3 specs only, serial default, Codex 0.162.1 only. `prepare-parallel`; no stage/commit/checkout/render until both producers finish; then `finalize-parallel` + independent review. https://github.com/UlisesCm/navori-harness/blob/main/docs/scribe-parallel.md
- **Spec with deliveries:** one cycle per milestone `M<n>`, encargo `spec: <spec> E<n> M<n>`; verify with `bun run check:fast` plus its `A<n>` commands, run from the main thread, foreground; `navori receipt gate` decides the gate; publisher commits until the closing milestone.
- Parallel implementers or deliveries need disjoint files (deliveries: own PRs). No `implementer` dispatch without plan approval (`planificacion`).
- Independent sub-tasks: ALL `Agent` calls in ONE turn (Claude serializes by default); you synthesize. At the turn cap, continue a foreground `Agent` via `SendMessage`. Missing markers or handoffs do not prove a cap.
- Without nested dispatch, run `scout` before `architect`.

| Signal | Mechanism |
|---|---|
| Non-trivial ticket | `resolve-ticket` |
| …citing evidence in 2+ repos, crossing frontend/backend, or naming modules with no dependency between them | one `auditor` PER AREA, all calls in the SAME turn; you synthesize |
| Shared contract, migration, new dependency, critical area, hard-to-reverse decision, 2+ viable approaches | architect pass (`solution-design`) before plan approval |
| Real scope (SDD block's threshold) | propose SDD, opt-in |
| Scoped or broad question | `scout` (parallel for independent ones) |

Depth: `.claude/agents/orchestrator.md`, `.claude/skills/resolve-ticket/SKILL.md`, `.claude/skills/solution-design/SKILL.md`.
<!-- /navori:managed id="orquestacion" -->
