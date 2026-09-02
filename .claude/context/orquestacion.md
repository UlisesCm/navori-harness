<!-- navori:managed id="orquestacion" hash="93bd2000" version="0.7.1" source="@navori/core" -->
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

Parallelism is **analytical**, not just speed: the value is splitting the problem into genuinely independent pieces and how you integrate what returns. Mechanics: emit **ALL `Agent` calls in a SINGLE turn** (Claude serializes by default; request parallelism explicitly, in one message).

- ✅ In one message, invoke `Agent` 3 times (`explorer` auth, db, api). They run concurrently; total ≈ the slowest.
- ❌ Invoke auth, wait for its `done -> file`, then db, then api. That's serial and throws away what parallelism saves.

**Independent** sub-tasks (no shared state, none depends on another's output) → same turn. Serialize only on a real dependency (`implementer` → `reviewer`). **`implementer` in parallel ONLY on disjoint files** (two touching the same file collide → serial; when in doubt, serial). Assign explicit scope before fanning out.

**Fan-out → synthesis:** decompose a broad question into sub-questions and launch one researcher each in parallel. When the `done -> file` reports return, **you gather and analyze deeply**: read the N files together, cross-check (contradictions, gaps, what's missing), then decide the implementation. Synthesis is not delegated.

### Frugal delegation (shape a lean R2 encargo)

Fan-out is a lever, not a toll — so when you do delegate, hand the smallest encargo that covers the work:

- **Peel off the mechanical first.** Copies, renames, scaffolding, JSON/string edits → do them yourself in R1 or send them to a low-tier agent; never bundle them into an `implementer`'s encargo, where they inflate its context and its run without raising quality.
- **One encargo = one unit.** A pre-existing bug the `implementer` hits outside its scope → it reports and stops there (a trivial one-liner is the exception); **you** decide whether to open a separate unit. Scope doesn't self-expand mid-run.
- **Tier by sub-task, not by round.** A single fix round can mix tiers. Map: **low** → mechanical work (copies, renames, scaffolding, string/JSON edits, a one-line fix); **mid** → a scoped bugfix with a clear cause or a bounded feature; **high** → judgment work (design, security regex, ambiguous root-cause, removal semantics, critical areas).
- **One-pass review on small/medium diffs.** Fix a minor finding yourself instead of spawning a fresh `implementer` — but the approval is byte-bound (`.claude/progress/receipt.txt`), so an edit after `APPROVED` needs the `reviewer`'s **delta re-sign** (judges only the delta, rewrites the receipt); reserve the full re-review for a fix that touched shared machinery or a critical area.

### Continuous execution (don't pause between tasks)

Once the plan/scope is approved (R2+), execute ALL sub-tasks without confirming between nodes. No "did 1, continue with 2?" — execute the plan. Stop only for: **BLOCKED** (a subagent blocked that you can't resolve), **ambiguous spec mid-flight** (a real gap outside scope), **command blocked by permission** (a tool call hit `deny` or the user rejected the prompt), or **full cycle** (ready for PR). Cap: 2 `CHANGES_REQUESTED` cycles on the same task → escalate to the user instead of retrying in a loop. Symmetric cap for permissions: `deny`/rejection = **0 retries** (stop now); a non-pre-approved prompt = **1 legitimate alternative approach** (e.g. the native `Grep` tool instead of shell `grep`) and you stop — never the same command in a loop.

### Synthesis without broken telephone

Every `Agent` call carries the **literal path** of the file its subagent must write (`.claude/progress/<file>.md`) — the path itself, never a vague "write a report": prose gets summarized when you delegate, a literal path does not. You receive only `done -> file`. Those files are **input to the next step**, not chat summaries — the `reviewer` opens the `implementer`'s, the `commit-pr-pilot` opens the `reviewer`'s, and a `SubagentStop` hook flags one that lands empty or without its `Status:`/verdict line (that hook never sees one that didn't land at all — that check is yours) — so a host rule against writing report files does not reach them: it exempts files written as input to another tool, and these are. That folder is ONLY for ephemeral agent handoffs (`audit_*`, `plan_*`, `explore_*`, `research_*`, `solution_*`, `solution_review_*`, `impl_*`, `review_*`, `receipt.txt`); **session state** (task, plan, blockers) lives in `progress/current.md` (root, git-persisted) and you consolidate it, never the subagents — each `implementer` reports its state (including `blocked`) in its own `impl_<feature>.md`. **After** its `done -> file` lands (not while it runs — that duplicates work in flight), re-verify only the **load-bearing claims**, the ones your decision rests on: each cited `file:line` exists and says what the report says, plus the diff it touched. Don't re-run its investigation; take the rest from the report. To close the cycle, invoke `commit-pr-pilot` — when `review_<feature>.md` says `APPROVED` (R2+), or directly for a genuine R1 diff that never went through a `reviewer`. The pilot gates the PR on `pnpm format:check && pnpm check:render && pnpm check:assets && pnpm --filter @navori/website build && cd packages/cli && pnpm check:size && pnpm test:coverage && pnpm lint && pnpm typecheck` (green over the shipping diff — the reviewer's Pass-2 evidence in R2+, or the pilot's own run in R1). Pre-flight: not on `main`, `gh auth status` ok (no clean-working-tree check — the pilot's trigger IS the uncommitted diff, and the pilot owns that commit). If `CHANGES_REQUESTED`, launch a **fresh** `implementer` scoped to just the findings — not a resume of the hot one (dragging a large transcript re-feeds its whole history every turn and rarely pays for a bounded fix round), and not the pilot.

**Second opinion (post-`APPROVED`).** On a non-trivial diff — or any change touching a critical area — a review from a **different provider** is one command away *when this repo also renders the `codex` engine*. The command lives in the `codex-cross-review` sub-block of `.claude/agents/leader.md`, which navori injects only in that case: `grep -n codex-cross-review .claude/agents/leader.md` — no match means this repo renders Claude only and the option does not apply here.

**Reclaim the worktree (ask, never assume).** The pilot ends its report with a `worktree:` line, because it runs inside the worktree and cannot remove it — you can. Nothing else reclaims them: each is a full checkout, and a repo that never cleans up ends with tens of GB of them. When that line says `safe to remove`, ask the user once, plainly ("the PR is open and the branch is pushed — remove the worktree at `<path>`?"), and act on the answer. Remove with `git worktree remove` (never `rm -rf`: that leaves the entry in git's index) followed by `git worktree prune`. When it says `NOT safe`, do NOT ask — report which of the two reasons it gave and leave it alone; a worktree holding uncommitted or unpushed work is the only copy of it. And never take a merged PR as proof on its own: **squash merge leaves no ancestry**, so `git merge-base --is-ancestor` answers "not merged" for branches that shipped days ago — what proves the work landed is the squash commit in the base branch (`git log <base> --grep="(#<PR>)"`).
<!-- /navori:managed id="orquestacion" -->
