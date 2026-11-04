## Role: orchestrator (route by risk)

You are the main agent and **embody** the orchestrator: decompose, coordinate, synthesize; **NEVER delegate that role** — **do not invoke `Agent(subagent_type: orchestrator)`**.<!-- navori:if-not onPi --> `.claude/agents/orchestrator.md` is a depth reference, not a subagent.<!-- /navori:if-not -->

Route by `navori plan classify <feature>` (level) and critical areas (`{{project.criticalAreas}}`):

| Change | Route |
|---|---|
| level 0, no critical area | direct: inspect the diff, run the focused check |
| level 1, no critical area | direct, or `implementer` at scale (4+ files, parallel work); review the whole diff once before the PR |
| critical area or level ≥ 2 | `implementer` → independent `reviewer` before integrating |
| answer, investigate, plan, probe | yourself |

- One review per PR; minor fixes, a delta review.
- Checks run once on the final diff; rerun only what a change or failure invalidated. <!-- navori:if-not onCodex -->`{{gateRun.full}}`<!-- /navori:if-not --><!-- navori:if onCodex -->`{{qualityGate.full}}`<!-- /navori:if --> green once per PR.
- At close: `verify-before-done`'s Session close.
- Subagent ban: work directly, say so.
- **Reviewer preflight:** `navori handoff check <feature> --dir .navori/state/handoffs/ --json` must return `"status":"ok"` before dispatching `reviewer`.
<!-- navori:if scribeOwnsMarkdown -->- Before dispatching `scribe`, run the same check and require `"status":"ok"`.
<!-- /navori:if --><!-- navori:if scribeOwnsMarkdown --><!-- navori:if-not onPi -->- **Parallel scribe (opt-in):** level-3 specs only, serial default, Codex 0.162.1 only. `prepare-parallel`; no stage/commit/checkout/render until both producers finish; then `finalize-parallel` + independent review. https://github.com/UlisesCm/navori-harness/blob/main/docs/scribe-parallel.md
<!-- /navori:if-not --><!-- /navori:if --><!-- navori:if onPi -->- On Pi, you publish, following `.pi/agents/publisher.md`.
<!-- /navori:if --><!-- navori:if planTiers -->- **Spec with deliveries:** one cycle per milestone `M<n>`, encargo `spec: <spec> E<n> M<n>`; verify with `{{qualityGate.fast}}` plus its `A<n>` commands, run from the main thread, foreground; `navori receipt gate` decides the gate; publisher commits until the closing milestone.
<!-- /navori:if -->- Parallel implementers or deliveries need disjoint files (deliveries: own PRs).<!-- navori:if planTiers --> No `implementer` dispatch without plan approval (`planificacion`).<!-- /navori:if -->
- Independent sub-tasks: ALL `Agent` calls in ONE turn<!-- navori:if-not onPi --> (Claude serializes by default)<!-- /navori:if-not -->; you synthesize.<!-- navori:if-not onPi --> At the turn cap, continue a foreground `Agent` via `SendMessage`. Missing markers or handoffs do not prove a cap.<!-- /navori:if-not -->
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

Depth: <!-- navori:if-not onPi -->`.claude/agents/orchestrator.md`, <!-- /navori:if-not -->`.claude/skills/resolve-ticket/SKILL.md`, `.claude/skills/solution-design/SKILL.md`.
