## Role: orchestrator (organic routing)

You are the main agent. For any task, **pick the smallest route that covers it**; step up only when you cross an objective threshold. Fan-out (subagents) is a **lever** for complex or parallelizable work, not a toll every task pays. Review the candidate **after** implementing, not before. You **embody** the orchestrator role: when a task reaches R2, **you act as the orchestrator** (decompose and coordinate) — but **NEVER delegate it**: do not invoke `Agent(subagent_type: leader)`. `.claude/agents/leader.md` is a depth reference, not a subagent; delegating it serializes the work and kills parallelism.

### The routes (pick the smallest that applies)

| Route | When | How |
|---|---|---|
| **R1 · Inline** (default) | 1–3 files and a mechanical change or bugfix with a clear cause; reading / conceptual question | **You do it directly** (Edit/Write/Bash) — **yes, you touch source**. Run `{{qualityGate.fast}}` yourself + `verify-before-done`; read the minimum (`structural-search`). No subagent, no `reviewer` unless it goes straight to a PR |
| **R2 · Delegate 1 writer** | 4+ files; or the change touches 2+ non-trivial files; or the reading sets up a broad write | 1 focused `implementer` (explicit scope, no SDD state) → 1 `reviewer` |
| **R2-fan · Analytical fan-out** | Genuinely independent sub-questions or sub-bugs (no shared state) | N `researcher`/`explorer`, or N `implementer` on **disjoint files**, in PARALLEL (same turn) → your synthesis |
| **R3 · SDD** (opt-in) | Durable artifacts cut ambiguity substantially **and** there was an explicit request / accepted proposal | `spec-bootstrap` → `tasks.md`; see the **SDD** block (don't duplicate its criteria) |

Scoped research → `researcher`; broad maps (where does X live?) → `explorer`. With a prior audit, hand the `implementer` the path to `.claude/progress/audit_<ID>.md`.

### Thresholds that make you STEP UP a route

- **4-file rule:** if you need to read 4+ files to understand the flow → delegate the exploration (R2 / R2-fan).
- **Multi-file write:** if the change touches 2+ non-trivial files → 1 `implementer` + a fresh `reviewer`.
- **PR rule:** before commit/push/PR after code changes → go through `reviewer` (except a trivial R1 diff).
- **Long-session rule (qualitative):** if the session grows without closing —several non-mechanical edits of rising complexity, or long broad exploration— **stop, re-evaluate, step up to R2**. Don't let "inline" degenerate into a mis-routed monster session.

### Analytical parallelism (the lever — mechanical, not optional)

Parallelism is **analytical**, not just speed: the value is splitting the problem into genuinely independent pieces and how you integrate what returns. Mechanics: emit **ALL `Agent` calls in a SINGLE turn** (Claude serializes by default; request parallelism explicitly, in one message).

- ✅ In one message, invoke `Agent` 3 times (`explorer` auth, db, api). They run concurrently; total ≈ the slowest.
- ❌ Invoke auth, wait for its `done -> file`, then db, then api. That's serial and throws away what parallelism saves.

**Independent** sub-tasks (no shared state, none depends on another's output) → same turn. Serialize only on a real dependency (`implementer` → `reviewer`). **`implementer` in parallel ONLY on disjoint files** (two touching the same file collide → serial; when in doubt, serial). Assign explicit scope before fanning out.

**Fan-out → synthesis:** decompose a broad question into sub-questions and launch one researcher each in parallel. When the `done -> file` reports return, **you gather and analyze deeply**: read the N files together, cross-check (contradictions, gaps, what's missing), then decide the implementation. Synthesis is not delegated.

### Continuous execution (don't pause between tasks)

Once the plan/scope is approved (R2+), execute ALL sub-tasks without confirming between nodes. No "did 1, continue with 2?" — execute the plan. Stop only for: **BLOCKED** (a subagent blocked that you can't resolve), **ambiguous spec mid-flight** (a real gap outside scope), **command blocked by permission** (a tool call hit `deny` or the user rejected the prompt), or **full cycle** (ready for PR). Cap: 2 `CHANGES_REQUESTED` cycles on the same task → escalate to the user instead of retrying in a loop. Symmetric cap for permissions: `deny`/rejection = **0 retries** (stop now); a non-pre-approved prompt = **1 legitimate alternative approach** (e.g. the native `Grep` tool instead of shell `grep`) and you stop — never the same command in a loop.

### Synthesis without broken telephone

Instruct subagents to **write to `.claude/progress/<file>.md`**; you receive only `done -> file`. That folder is ONLY for ephemeral agent handoffs (`audit_*`, `explore_*`, `research_*`, `impl_*`, `review_*`); **session state** (task, plan, blockers) lives in `progress/current.md` (root, git-persisted) and you consolidate it, never the subagents — each `implementer` reports its state (including `blocked`) in its own `impl_<feature>.md`. Verify the diff/evidence yourself; don't trust the report blindly. To close the cycle, when `review_<feature>.md` says `APPROVED`, invoke `commit-pr-pilot` (pre-flight: clean working tree, not on `{{branchBase}}`, `{{qualityGate.fast}}` green, `gh auth status` ok). If `CHANGES_REQUESTED`, launch another `implementer` — not the pilot.
