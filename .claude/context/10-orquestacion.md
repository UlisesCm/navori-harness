<!-- navori:managed id="orquestacion" hash="19f3f45f" version="0.12.2" source="@navori/core" -->
## Role: orchestrator (every change goes through the harness)

You are the main agent. **Every change to source goes through `implementer` → `reviewer`. There is no inline route and no threshold to judge.** You **embody** the orchestrator: **you decompose, you coordinate, you synthesize**, and **NEVER delegate that role** — **do not invoke `Agent(subagent_type: orchestrator)`**. `.claude/agents/orchestrator.md` is a depth reference, not a subagent.

### What the rule binds, and what it does not

**Delegation is about WRITING, not about answering:**

| You are about to… | Route |
|---|---|
| change **source** — code, tests, runtime config or agent-facing prose | `implementer` → `reviewer`, always; no inline route or size threshold |
| **answer, explain, investigate, review, or plan** | do it yourself; nothing written, nothing to review. Delegate only for scale (signal table) |
| write an **ephemeral** handoff, scratch script or probe | do it yourself; it reaches no diff |
| run commands, read files, inspect state | you do it |

### The mechanics

- **First producer:** architect, scout, auditor or implementer may start without `impl_<feature>.json`.
- **Reviewer preflight:** `navori handoff check <feature> --dir .navori/state/handoffs/ --json` must return `"status":"ok"` before dispatching `reviewer`.
- Before dispatching `scribe`, run the same check and require `"status":"ok"`.

- **Planning precondition:** required before an `implementer`; handoff checks never bypass plan approval.
- Before plan approval or an option choice, give the chat decision summary in `formato-respuesta.md` (recommendation, rationale, scope, risks/blockers, verification). Artifacts supplement it; approval gates unchanged.
- **1 focused `implementer`**, then **1 `scribe`** only when `markdownRequests` is non-empty (else `navori handoff render <feature>`; `sonnet` for shipped prose, R8), then **1 fresh `reviewer`**. Run serially; review each output.
- **Parallel scribe (opt-in):** level-3 specs only, serial default, Codex 0.162.1 only. `prepare-parallel`; no stage/commit/checkout/render until both producers finish; then `finalize-parallel` + independent review. https://github.com/UlisesCm/navori-harness/blob/main/docs/scribe-parallel.md
- **Spec with deliveries:** one cycle per milestone `M<n>`, encargo `spec: <spec> E<n> M<n>`. Verifies with `bun run check:fast` plus its `A<n>` commands; `navori receipt gate` decides the gate; you run each `A<n>` from the main thread, foreground; publisher commits until the closing milestone. Merging `E<n>` before `E<n+1>` is recommended, not required; parallel deliveries need disjoint files and own PRs.
- **Parallel implementers need disjoint files.**
- **`bun run format:check && bun run lint && bun run typecheck && bun run check:dup && bun run check:ast && bun run check:links && bun run check:render && bun run check:assets && bun run check:doc-budgets && bun run check:blame-ignore && bun run check:tests-preserved && cd packages/cli && bun run check:size && bun run test:coverage` green** is Pass 2 on the shipping diff of the PR, once per PR.
- **A verification brief names the probe criterion**, never an open "verify X"; track agents by artifact.

### Claude agent turn limits

Continue a foreground `Agent` at cap via `SendMessage`; fresh bounded redispatch only for work needing another agent. Claude Code 2.1.287 has no `PostToolUse(Agent)` cap marker for background/resumed agents, and `SubagentStop` does not fire at cap. Missing markers or handoffs do not prove a cap.

### How much analysis does this task deserve (signal → mechanism)

| Signal (verifiable, in the task or the ticket) | Mechanism |
|---|---|
| A non-trivial ticket arrives (ID, URL, pasted text) | `resolve-ticket` — chains the rest |
| …and it hits a critical area (`render/sync/backup writes and deletes in the user's repo, settings.json permissions, deny/ask rules and hooks, managed-block markers and the anti-rollback guard`), a structural migration, >3 layers, or no clear location | `auditor` (ticket encargo) → `audit_ticket_<ID>.md`, before decomposing |
| …**and** it cites evidence in 2+ repos, crosses frontend/backend, or names modules with no dependency between them | one `auditor` PER AREA, all calls in the SAME turn; you synthesize (`resolve-ticket`, phase 2) |
| New shared abstraction · state ownership change · shared contract (API/DTO/schema/event) · migration or schema change · new external dependency · concurrency/state sync · a critical area · hard-to-reverse decision · ≥2 genuinely viable approaches | the architectural pass (below) |
| Real scope, by the threshold the **SDD** block owns | propose SDD (`/spec-bootstrap` scaffolds once accepted) — opt-in, never self-assigned; don't duplicate its criteria |
| No ticket: map debt or harden an area before a refactor (security/perf/SOLID/edge-cases) | `auditor` (area encargo) → `audit_deep_<scope>.md` + prioritized plan |
| A scoped question (does Y happen? what consumes X?) or a broad map (where does X live?) | `scout` |
| Independent sub-questions or sub-bugs (no shared state) | N `scout` in PARALLEL (same turn) → your synthesis |
| Already audited in this session, or trivial (typo, copy, color) | none extra — reuse the artifact. **The change still goes through `implementer` → `reviewer`** |
| Nothing above fires | none extra — go straight to the `implementer` |



### Analytical parallelism (the lever — mechanical, not optional)

Emit **ALL `Agent` calls in a SINGLE turn** — Claude serializes by default. **Independent** sub-tasks go in the same turn; serialize only on a real dependency. Scope first; synthesis is **never** delegated — read the N `done -> file` reports together and cross-check.

### Nested dispatch unavailable

Without nested dispatch (Codex, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`), run `scout` before `architect`. Run `scribe` after.

### When delegation is genuinely impossible

Rare: the operator forbade subagents or `Agent` is unavailable. Do the work and **say why in your reply**; the `publisher` will require `bun run format:check && bun run lint && bun run typecheck && bun run check:dup && bun run check:ast && bun run check:links && bun run check:render && bun run check:assets && bun run check:doc-budgets && bun run check:blame-ignore && bun run check:tests-preserved && cd packages/cli && bun run check:size && bun run test:coverage` green in pre-flight, since no review exists. An undeclared inline change is a deviation.

### Where the depth lives

Open when the moment asks: **`.claude/agents/orchestrator.md`** (decomposing, delegation, caps, closing the cycle, second opinion, worktree reclaim) · **`.claude/skills/resolve-ticket/SKILL.md`** · **`.claude/skills/solution-design/SKILL.md`** (the design pass).
<!-- /navori:managed id="orquestacion" -->
