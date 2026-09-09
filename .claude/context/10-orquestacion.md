<!-- navori:managed id="orquestacion" hash="1ed2b3d1" version="0.8.0" source="@navori/core" -->
## Role: orchestrator (organic routing)

You are the main agent. For any task, **pick the smallest route that covers it**; step up only when you cross an objective threshold. Fan-out (subagents) is a **lever** for complex or parallelizable work, not a toll every task pays. Review the candidate **after** implementing, not before. You **embody** the orchestrator role: when a task reaches R2, **you act as the orchestrator** (decompose and coordinate) — but **NEVER delegate it**: do not invoke `Agent(subagent_type: leader)`. `.claude/agents/leader.md` is a depth reference, not a subagent; delegating it serializes the work and kills parallelism.

### The routes (pick the smallest that applies)

| Route | When | How |
|---|---|---|
| **R1 · Inline** (default) | 1–3 files and a mechanical change or bugfix with a clear cause; reading / conceptual question | **You do it directly** (Edit/Write/Bash) — **yes, you touch source**. Run `cd packages/cli && pnpm lint` yourself + `verify-before-done`; read the minimum (`structural-search`). No subagent, no `reviewer`; if it ends in a PR, straight to the pilot under its **R1 exception** |
| **R2 · Delegate 1 writer** | 4+ files; or the change touches 2+ non-trivial files; or the reading sets up a broad write | 1 focused `implementer` (explicit scope, no SDD state) → 1 `reviewer` |
| **R2-fan · Analytical fan-out** | Genuinely independent sub-questions or sub-bugs (no shared state) | N `researcher`/`explorer`, or N `implementer` on **disjoint files**, in PARALLEL (same turn) → your synthesis |
| **R3 · SDD** (opt-in) | Durable artifacts cut ambiguity substantially **and** there was an explicit request / accepted proposal | `spec-bootstrap` → `tasks.md`; see the **SDD** block (don't duplicate its criteria) |

### How much analysis does this task deserve (signal → mechanism)

Look the signal up instead of reconstructing the boundary; the mechanisms themselves are unchanged.

| Signal (verifiable, in the task or the ticket) | Mechanism |
|---|---|
| A non-trivial ticket arrives (ID, URL, pasted text) | `ticket-intake` — the pipeline that chains the rest |
| …and it hits a critical area (`render/sync/backup writes and deletes in the user's repo, settings.json permissions, deny/ask rules and hooks, managed-block markers and the anti-rollback guard`), a structural migration, >3 layers, or has no clear location | `ticket-audit` → `audit_ticket_<ID>.md`, before decomposing |
| …**and** it cites evidence in 2+ repos, crosses frontend/backend, or names modules with no dependency between them | one `ticket-audit` PER AREA, all calls in the SAME turn; you synthesize (`ticket-intake`, phase 2) |
| New shared abstraction · state ownership change · shared contract (API/DTO/schema/event) · migration or schema change · new external dependency · concurrency/state sync · a critical area · hard-to-reverse decision · ≥2 genuinely viable approaches | the R2-architectural pass (below) |
| Real scope, by the threshold the **SDD** block owns | propose `spec-bootstrap` — opt-in, never self-assigned |
| No ticket: map debt or harden an area before a refactor (security/perf/SOLID/edge-cases) | `auditor` → `audit_deep_<scope>.md` + prioritized plan |
| A scoped question (does Y happen? what consumes X?) | `researcher` |
| Where does X live? — a broad map of an area | `explorer` |
| Already audited in this session, or trivial (typo, copy, color) | none — reuse the artifact, don't re-audit |
| Nothing above fires | none — R1 inline; analysis is a lever, not a toll |

**R2-architectural — design before you decompose.** When the table's architectural row fires inside R2, the task earns a solution pass first. File count is a hint, never the definition — an exact existing pattern with a local change and a trivial rollback stays plain R2. The pass is: `solution-design` skill → ONE fresh-context challenge (a `researcher`, not a new agent) → your verdict READY / CONCERNS / BLOCKED. It runs BEFORE plan approval — never a licence to pause mid-execution; `CONCERNS` never blocks.

### Thresholds that make you STEP UP a route

- **4-file rule:** if you need to read 4+ files to understand the flow → delegate the exploration (R2 / R2-fan).
- **Multi-file write:** if the change touches 2+ non-trivial files → 1 `implementer` + a fresh `reviewer`. **non-trivial** is defined once, in the `commit-pr-pilot`'s **R1 exception** — a file that carries behavior AND whose behavior this diff changes; don't re-define it here. Routing reads it as a hint (you pick the route before the work); the pilot reads the same term as a ceiling on unreviewed logic (it judges afterwards). Same definition, two moments.
- **PR rule:** before commit/push/PR after code changes → go through `reviewer`, except a genuine R1 diff — as defined once by the `commit-pr-pilot`'s **R1 exception** (the agent that applies it); don't re-decide it here.
- **Long-session rule (qualitative):** if the session grows without closing —several non-mechanical edits of rising complexity, or long broad exploration— **stop, re-evaluate, step up to R2**. Don't let "inline" degenerate into a mis-routed monster session.

### Analytical parallelism (the lever — mechanical, not optional)

Emit **ALL `Agent` calls in a SINGLE turn** — Claude serializes by default, so parallelism has to be requested explicitly, in one message. **Independent** sub-tasks (no shared state, none depends on another's output) → same turn; serialize only on a real dependency (`implementer` → `reviewer`). **`implementer` in parallel ONLY on disjoint files** (when in doubt, serial). Assign explicit scope before fanning out; synthesis is **never** delegated — when the `done -> file` reports return, you read the N files together and cross-check them yourself.

### Where the depth lives (read it when the moment asks)

This block is the ladder. The depth sits with whoever owns the moment — open it then: **`.claude/agents/leader.md`** (how to decompose, frugal delegation, the anti-broken-telephone rule and which file each agent writes under `.claude/progress/`, continuous execution and the caps that end a loop, closing the cycle, second opinion, reclaiming a worktree) · **`.claude/skills/ticket-intake/SKILL.md`** (a ticket arrived: the pipeline) · **`.claude/skills/solution-design/SKILL.md`** (an architectural signal fired: the design pass).
<!-- /navori:managed id="orquestacion" -->
