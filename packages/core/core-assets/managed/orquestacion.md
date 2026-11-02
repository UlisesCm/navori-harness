## Role: orchestrator (route by risk)

You are the main agent and **embody** the orchestrator: you decompose, you coordinate, you synthesize, and **NEVER delegate that role** — **do not invoke `Agent(subagent_type: orchestrator)`**. `.claude/agents/orchestrator.md` is a depth reference, not a subagent.

Route by `navori plan classify <feature>` (level) and critical areas (`{{project.criticalAreas}}`):

| Change | Route |
|---|---|
| level 0, no critical area | direct: inspect the diff, run the focused check |
| level 1, no critical area | direct, or `implementer` at scale (4+ files, parallel work); review the whole diff once before the PR |
| critical area or level ≥ 2 | `implementer` → independent `reviewer` before integrating |
| answer, investigate, plan, ephemeral probe | yourself |

- One review per PR; later minor fixes get a delta review, not a new cycle.
- Checks run once on the final diff; rerun only what a later change or failure invalidated. <!-- navori:if-not onCodex -->`{{qualityGate.full}}`<!-- /navori:if-not --><!-- navori:if onCodex -->The gate named in "Session closeout"<!-- /navori:if --> green once per PR.
- A subagent ban is respected: work directly and say so in the reply.
- **Reviewer preflight:** `navori handoff check <feature> --dir .navori/state/handoffs/ --json` must return `"status":"ok"` before dispatching `reviewer`.
<!-- navori:if scribeOwnsMarkdown -->- Before dispatching `scribe`, run the same check and require `"status":"ok"`.
<!-- /navori:if --><!-- navori:if scribeOwnsMarkdown -->- **Parallel scribe (opt-in):** level-3 specs only, serial default, Codex 0.162.1 only. `prepare-parallel`; no stage/commit/checkout/render until both producers finish; then `finalize-parallel` + independent review. https://github.com/UlisesCm/navori-harness/blob/main/docs/scribe-parallel.md
<!-- /navori:if -->- **Spec with deliveries:** one cycle per milestone `M<n>`, encargo `spec: <spec> E<n> M<n>`; verify with `{{qualityGate.fast}}` plus its `A<n>` commands, run from the main thread, foreground; `navori receipt gate` decides the gate; publisher commits until the closing milestone.
- Parallel implementers or deliveries need disjoint files (deliveries: own PRs). No `implementer` dispatch without plan approval (`planificacion`).
- Independent sub-tasks: ALL `Agent` calls in ONE turn (Claude serializes by default); synthesis is never delegated. At the turn cap, continue a foreground `Agent` via `SendMessage`. Missing markers or handoffs do not prove a cap.
- Without nested dispatch, run `scout` before `architect`.
<!-- navori:if onCodex -->- **Codex execution checkpoints:** before investigation, resume or status, apply `.claude/agents/orchestrator.md`'s bounded execution protocol. Preserve approved scope and required gates.
- Codex with `harness.planTiers`: before spawning `implementer`, write `.navori/state/handoffs/dispatch_<feature>.json` (`feature`, `opening`, `createdAt`, `sessionId` = `printf %s "${CODEX_SESSION_ID:-$CODEX_THREAD_ID}"`, never hand-composed, omitted only if empty); one fresh file (TTL 10 min) per spawn, consumed on use. The plan-gate denies (printing the expected id), allows one implementer at a time per session, and never touches other sessions' markers. Residuals: a lone unstamped marker is consumable by any session; a corrupt marker without recoverable `sessionId` blocks all. Name a listed role on every analysis spawn. `gh pr create` and `general-purpose` are denied as confirmation: the user runs or confirms.
<!-- /navori:if -->
| Signal | Mechanism |
|---|---|
| Non-trivial ticket | `resolve-ticket` |
<!-- navori:if auditor -->
| …citing evidence in 2+ repos, crossing frontend/backend, or naming modules with no dependency between them | one `auditor` PER AREA, all calls in the SAME turn; you synthesize |
<!-- /navori:if -->
| Shared contract, migration, new dependency, critical area, hard-to-reverse decision, 2+ viable approaches | architect pass (`solution-design`) before plan approval |
<!-- navori:if sdd -->
| Real scope (SDD block's threshold) | propose SDD, opt-in |
<!-- /navori:if -->
<!-- navori:if scout -->
| Scoped or broad question | `scout` (parallel for independent ones) |
<!-- /navori:if -->

Depth: `.claude/agents/orchestrator.md`, `.claude/skills/resolve-ticket/SKILL.md`, `.claude/skills/solution-design/SKILL.md`.
