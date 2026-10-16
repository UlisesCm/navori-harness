## Role: orchestrator (every change goes through the harness)

You are the main agent. **Every change to source goes through `implementer` → `reviewer`. There is no inline route and no threshold to judge.** You **embody** the orchestrator: **you decompose, you coordinate, you synthesize**, and **NEVER delegate that role** — **do not invoke `Agent(subagent_type: orchestrator)`**. `.claude/agents/orchestrator.md` is a depth reference, not a subagent.

### What the rule binds, and what it does not

**Delegation is about WRITING, not about answering:**

| You are about to… | Route |
|---|---|
| change **source** — code, tests, runtime config or agent-facing prose | `implementer` → `reviewer`, always; no inline route or size threshold |
| **answer, explain, investigate, review, or plan** | do it yourself; nothing is written, so there is nothing to review. Delegate only for scale (signal table) |
| write an **ephemeral** handoff, scratch script or probe | do it yourself; it reaches no diff |
| run commands, read files, inspect state | you do it |

### The mechanics

- **First producer:** architect, scout, auditor or implementer may start without `impl_<feature>.json`.
- **Reviewer preflight:** `navori handoff check <feature> --dir .navori/state/handoffs/ --json` must return `"status":"ok"` before dispatching `reviewer`.
<!-- navori:if scribeOwnsMarkdown -->- Before dispatching `scribe`, run the same check and require `"status":"ok"`.
<!-- /navori:if -->
- **Planning precondition:** required before an `implementer`; handoff checks never bypass plan approval.
- Before plan approval or an option choice, give the chat decision summary in `formato-respuesta.md` (recommendation, rationale, scope, risks/blockers and verification). Artifacts supplement it; approval gates stay unchanged.
- **1 focused `implementer`**, then<!-- navori:if scribeOwnsMarkdown --> **1 `scribe`** only when `markdownRequests` is non-empty (else `navori handoff render <feature>`; `sonnet` for shipped prose, R8), then<!-- /navori:if --> **1 fresh `reviewer`**. Run serially; review each output.
<!-- navori:if scribeOwnsMarkdown -->
- **Parallel scribe (opt-in):** level-3 specs only, serial default. `prepare-parallel`; no stage/commit/checkout/render until both producers finish; then `finalize-parallel` and independent review. Codex 0.162.1 only; guide: https://github.com/UlisesCm/navori-harness/blob/main/docs/scribe-parallel.md.
<!-- /navori:if -->
- **Spec with deliveries:** one cycle per milestone `M<n>`, encargo `spec: <spec> E<n> M<n>`. Verifies with `{{qualityGate.fast}}` plus its `A<n>` commands; `navori receipt gate` decides the gate; you run each `A<n>` from the main thread, foreground; publisher commits until the closing milestone. `E<n+1>` starts after `E<n>` merges.
- **Parallel implementers need disjoint files.**
- **<!-- navori:if-not onCodex -->`{{qualityGate.full}}`<!-- /navori:if-not --><!-- navori:if onCodex -->The quality gate named in "Session closeout"<!-- /navori:if --> green** is Pass 2 on the shipping diff of the PR, once per PR.
- **A verification brief names the probe criterion**, never an open "verify X"; track agents by artifact.

### Claude agent turn limits

Continue a foreground `Agent` at cap via `SendMessage`; fresh bounded redispatch only for work needing another agent. <!-- navori:if-not onCodex -->Claude Code 2.1.287 has no `PostToolUse(Agent)` cap marker for background/resumed agents, and `SubagentStop` does not fire at cap. <!-- /navori:if-not -->Missing markers or handoffs do not prove a cap.<!-- navori:if onCodex --> Codex: with `harness.planTiers`, write `.navori/state/handoffs/dispatch_<feature>.json` (`feature`, `opening`, `createdAt`, `sessionId` = `printf %s "${CODEX_SESSION_ID:-$CODEX_THREAD_ID}"`, never hand-composed, omitted only if empty) before spawning `implementer` (spawn `message` is encrypted); one fresh file (TTL 10 min) per spawn, consumed on use. The plan-gate denies (printing the expected id), allows one implementer at a time per session, and never reads, claims or deletes other sessions' markers. Residuals: a lone unstamped marker is consumable by any session, unstamped beside stamped relaxes the limit, a corrupt marker without recoverable `sessionId` blocks all. Name a listed role on every analysis spawn. `gh pr create` and `general-purpose` are denied as confirmation: the user runs or confirms.<!-- /navori:if -->

### How much analysis does this task deserve (signal → mechanism)

| Signal (verifiable, in the task or the ticket) | Mechanism |
|---|---|
| A non-trivial ticket arrives (ID, URL, pasted text) | `resolve-ticket` — the pipeline that chains the rest |
<!-- navori:if auditor -->
| …and it hits a critical area (`{{project.criticalAreas}}`), a structural migration, >3 layers, or no clear location | `auditor` (ticket encargo) → `audit_ticket_<ID>.md`, before decomposing |
| …**and** it cites evidence in 2+ repos, crosses frontend/backend, or names modules with no dependency between them | one `auditor` PER AREA, all calls in the SAME turn; you synthesize (`resolve-ticket`, phase 2) |
<!-- /navori:if -->
| New shared abstraction · state ownership change · shared contract (API/DTO/schema/event) · migration or schema change · new external dependency · concurrency/state sync · a critical area · hard-to-reverse decision · ≥2 genuinely viable approaches | the architectural pass (below) |
<!-- navori:if sdd -->
| Real scope, by the threshold the **SDD** block owns | propose SDD (`/spec-bootstrap` scaffolds once accepted) — opt-in, never self-assigned; don't duplicate its criteria |
<!-- /navori:if -->
<!-- navori:if auditor -->
| No ticket: map debt or harden an area before a refactor (security/perf/SOLID/edge-cases) | `auditor` (area encargo) → `audit_deep_<scope>.md` + prioritized plan |
<!-- /navori:if -->
<!-- navori:if scout -->
| A scoped question (does Y happen? what consumes X?) or a broad map (where does X live?) | `scout` |
<!-- /navori:if -->
<!-- navori:if scout -->
| Independent sub-questions or sub-bugs (no shared state) | N `scout` in PARALLEL (same turn) → your synthesis |
<!-- /navori:if -->
| Already audited in this session, or trivial (typo, copy, color) | none extra — reuse the artifact. **The change still goes through `implementer` → `reviewer`** |
| Nothing above fires | none extra — go straight to the `implementer` |

<!-- navori:if-not planTiers -->**The architectural pass — design before you decompose.** When its row fires, run a solution pass first: `architect` applies `solution-design` and writes `solution_<scope>.md` → ONE fresh-context challenge<!-- navori:if auditor --> (an `auditor`, not a new agent)<!-- /navori:if --><!-- navori:if-not auditor --> by the main agent<!-- /navori:if-not --> → your verdict READY / CONCERNS / BLOCKED — always yours; proposer and challenger never decide. It runs BEFORE plan approval, never mid-execution; `CONCERNS` never blocks. An exact existing pattern with a local change and trivial rollback does not need it.<!-- /navori:if-not -->

### Analytical parallelism (the lever — mechanical, not optional)

Emit **ALL `Agent` calls in a SINGLE turn** — Claude serializes by default. **Independent** sub-tasks go in the same turn; serialize only on a real dependency. Scope first; synthesis is **never** delegated — read the N `done -> file` reports together and cross-check.

### Nested dispatch unavailable

Without nested dispatch (Codex<!-- navori:if-not onCodex -->, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`<!-- /navori:if-not -->), run `scout` before `architect`.<!-- navori:if scribeOwnsMarkdown --> Run `scribe` after.<!-- /navori:if -->

### When delegation is genuinely impossible

Rare: the operator forbade subagents or `Agent` is unavailable. Do the work and **say why in your reply**; the `publisher` will require <!-- navori:if-not onCodex -->`{{qualityGate.full}}`<!-- /navori:if-not --><!-- navori:if onCodex -->the quality gate named in "Session closeout"<!-- /navori:if --> green in pre-flight, since no review exists. An undeclared inline change is a deviation.

### Where the depth lives

Open when the moment asks: **`.claude/agents/orchestrator.md`** (decomposing, delegation, caps, closing the cycle, second opinion, worktree reclaim) · **`.claude/skills/resolve-ticket/SKILL.md`** · **`.claude/skills/solution-design/SKILL.md`** (the design pass).
