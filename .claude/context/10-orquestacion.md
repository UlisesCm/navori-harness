<!-- navori:managed id="orquestacion" hash="da71aacf" version="0.11.2" source="@navori/core" -->
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
- **Reviewer preflight:** before dispatching `reviewer`, run `navori handoff check <feature> --dir .navori/state/handoffs/ --json`; require `"status":"ok"`.
- Before dispatching `scribe`, run the same check and require `"status":"ok"`.

- **Planning precondition:** required before an `implementer`; handoff checks never bypass plan approval.
- Before plan approval or an option choice, give the chat decision summary in `formato-respuesta.md` (recommendation, rationale, scope, risks/blockers and verification). Artifacts supplement it; approval gates stay unchanged.
- **1 focused `implementer`**, then **1 `scribe`** for `markdownRequests` (default model for handoff-only; `sonnet` for shipped prose, R8), then **1 fresh `reviewer`**. Run serially; review the implementer's and scribe's output.
- **Review after implementation.**
- **Parallel implementers need disjoint files.**
- **`bun run format:check && bun run check:links && bun run check:render && bun run check:assets && bun run check:doc-budgets && bun run check:blame-ignore && bun run jscpd:check && bun run semgrep:check && cd packages/cli && bun run check:size && bun run test:coverage && bun lint && bun typecheck` green** is Pass 2 on the shipping diff.
- **A verification brief names the probe criterion**, never an open "verify X"; track long agents by artifact.

### Claude agent turn limits

Continue a foreground `Agent` at cap via `SendMessage`; fresh bounded redispatch only for remaining work needing another agent. Claude Code 2.1.287 has no `PostToolUse(Agent)` cap marker for background/resumed agents, and `SubagentStop` does not fire at cap. Missing markers or handoffs do not prove a cap.

### How much analysis does this task deserve (signal → mechanism)

Reading depth:

| Signal (verifiable, in the task or the ticket) | Mechanism |
|---|---|
| A non-trivial ticket arrives (ID, URL, pasted text) | `resolve-ticket` — the pipeline that chains the rest |
| …and it hits a critical area (`render/sync/backup writes and deletes in the user's repo, settings.json permissions, deny/ask rules and hooks, managed-block markers and the anti-rollback guard`), a structural migration, >3 layers, or no clear location | `auditor` (ticket encargo) → `audit_ticket_<ID>.md`, before decomposing |
| …**and** it cites evidence in 2+ repos, crosses frontend/backend, or names modules with no dependency between them | one `auditor` PER AREA, all calls in the SAME turn; you synthesize (`resolve-ticket`, phase 2) |
| New shared abstraction · state ownership change · shared contract (API/DTO/schema/event) · migration or schema change · new external dependency · concurrency/state sync · a critical area · hard-to-reverse decision · ≥2 genuinely viable approaches | the architectural pass (below) |
| Real scope, by the threshold the **SDD** block owns | propose SDD (scaffolds once accepted, via prose or `/spec-bootstrap`) — opt-in, never self-assigned; don't duplicate its criteria |
| No ticket: map debt or harden an area before a refactor (security/perf/SOLID/edge-cases) | `auditor` (area encargo) → `audit_deep_<scope>.md` + prioritized plan |
| A scoped question (does Y happen? what consumes X?) or a broad map (where does X live?) | `scout` |
| Independent sub-questions or sub-bugs (no shared state) | N `scout` in PARALLEL (same turn) → your synthesis |
| Already audited in this session, or trivial (typo, copy, color) | none extra — reuse the artifact. **The change still goes through `implementer` → `reviewer`** |
| Nothing above fires | none extra — go straight to the `implementer` |



### Analytical parallelism (the lever — mechanical, not optional)

Emit **ALL `Agent` calls in a SINGLE turn** — Claude serializes by default. **Independent** sub-tasks (no shared state or output dependency) go in the same turn; serialize only on a real dependency. Scope first; synthesis is **never** delegated — read the N `done -> file` reports together and cross-check.

### Nested dispatch unavailable

Without nested dispatch (Codex, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`), run `scout` before `architect`. Run `scribe` after.

### When delegation is genuinely impossible

Rare, and it leaves a trace: the operator forbade subagents or `Agent` is unavailable. Do the work and **say why in your reply**; the `publisher` will require `bun run format:check && bun run check:links && bun run check:render && bun run check:assets && bun run check:doc-budgets && bun run check:blame-ignore && bun run jscpd:check && bun run semgrep:check && cd packages/cli && bun run check:size && bun run test:coverage && bun lint && bun typecheck` green in pre-flight, since no review exists. An undeclared inline change is a deviation.

### Where the depth lives (read it when the moment asks)

Open when the moment asks: **`.claude/agents/orchestrator.md`** (decomposing, frugal delegation, anti-broken-telephone, per-agent output files, continuous execution and caps, closing the cycle, second opinion, reclaiming a worktree) · **`.claude/skills/resolve-ticket/SKILL.md`** (a ticket: the pipeline) · **`.claude/skills/solution-design/SKILL.md`** (an architectural signal: the design pass).
<!-- /navori:managed id="orquestacion" -->
