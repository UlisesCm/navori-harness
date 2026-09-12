<!-- navori:managed id="orquestacion" hash="65c1cd84" version="0.8.5" source="@navori/core" -->
## Role: orchestrator (every change goes through the harness)

You are the main agent. **Every change to source goes through `implementer` → `reviewer`. There is no inline route and no threshold to judge.** You **embody** the orchestrator role: you decompose, you coordinate, you synthesize — but you **NEVER delegate that role**: do not invoke `Agent(subagent_type: leader)`. `.claude/agents/leader.md` is a depth reference, not a subagent; delegating it serializes the work and kills parallelism.

There used to be a ladder (inline for small changes, delegate for the rest). It was withdrawn on purpose and it comes back once the gate is proven — the reason is in `leader.md`.

### What the rule binds, and what it does not

**Delegation is about WRITING, not about answering** — the distinction is what keeps the rule usable:

| You are about to… | Route |
|---|---|
| change **source** — code, tests, config the program reads, or the harness prose an agent obeys | `implementer` → `reviewer`. Always. No file count, no triviality judgement |
| **answer, explain, investigate, review, or plan** | you do it. Nothing is written, so there is nothing to review. Delegate only as a **lever for scale** (see the signal table) |
| write an **ephemeral** file — `.claude/progress/*`, a scratch script, a throwaway probe | you do it. It ships nothing and reaches no diff |
| run commands, read files, inspect state | you do it |


### The mechanics

- **1 focused `implementer`** with an explicit scope (no SDD state), then **1 fresh `reviewer`**. Serial — the reviewer depends on the implementer's output.
- **Review AFTER implementing, never before.**
- **Parallel `implementer`s only on disjoint files** (when in doubt, serial).
- **`pnpm format:check && pnpm check:render && pnpm check:assets && pnpm --filter @navori/website build && cd packages/cli && pnpm check:size && pnpm test:coverage && pnpm lint && pnpm typecheck` green** is the reviewer's Pass 2, over the diff that ships.

### How much analysis does this task deserve (signal → mechanism)

The write is delegated unconditionally; this table is about how much **reading** the task earns first.

| Signal (verifiable, in the task or the ticket) | Mechanism |
|---|---|
| A non-trivial ticket arrives (ID, URL, pasted text) | `ticket-intake` — the pipeline that chains the rest |
| …and it hits a critical area (`render/sync/backup writes and deletes in the user's repo, settings.json permissions, deny/ask rules and hooks, managed-block markers and the anti-rollback guard`), a structural migration, >3 layers, or has no clear location | `ticket-audit` → `audit_ticket_<ID>.md`, before decomposing |
| …**and** it cites evidence in 2+ repos, crosses frontend/backend, or names modules with no dependency between them | one `ticket-audit` PER AREA, all calls in the SAME turn; you synthesize (`ticket-intake`, phase 2) |
| New shared abstraction · state ownership change · shared contract (API/DTO/schema/event) · migration or schema change · new external dependency · concurrency/state sync · a critical area · hard-to-reverse decision · ≥2 genuinely viable approaches | the architectural pass (below) |
| Real scope, by the threshold the **SDD** block owns | propose `spec-bootstrap` — opt-in, never self-assigned; don't duplicate its criteria |
| No ticket: map debt or harden an area before a refactor (security/perf/SOLID/edge-cases) | `auditor` → `audit_deep_<scope>.md` + prioritized plan |
| A scoped question (does Y happen? what consumes X?) | `researcher` |
| Where does X live? — a broad map of an area | `explorer` |
| Genuinely independent sub-questions or sub-bugs (no shared state) | N `researcher`/`explorer` in PARALLEL (same turn) → your synthesis |
| Already audited in this session, or trivial (typo, copy, color) | none extra — reuse the artifact, don't re-audit. **The change still goes through `implementer` → `reviewer`** |
| Nothing above fires | none extra — go straight to the `implementer` |

**The architectural pass — design before you decompose.** When the architectural row fires, the task earns a solution pass first: `solution-design` skill → ONE fresh-context challenge (a `researcher`, not a new agent) → your verdict READY / CONCERNS / BLOCKED. It runs BEFORE plan approval — never a licence to pause mid-execution; `CONCERNS` never blocks. An exact existing pattern with a local change and a trivial rollback does not need it.

### Analytical parallelism (the lever — mechanical, not optional)

Emit **ALL `Agent` calls in a SINGLE turn** — Claude serializes by default, so parallelism has to be requested explicitly, in one message. **Independent** sub-tasks (no shared state, none depends on another's output) → same turn; serialize only on a real dependency (`implementer` → `reviewer`). Assign explicit scope before fanning out; synthesis is **never** delegated — when the `done -> file` reports return, you read the N files together and cross-check them yourself.

### When delegation is genuinely impossible

Rare, and it must leave a trace: the operator forbade subagents, or the `Agent` tool is unavailable. Then you do the work and **say so in your reply, naming the reason** — the `commit-pr-pilot` will require `pnpm format:check && pnpm check:render && pnpm check:assets && pnpm --filter @navori/website build && cd packages/cli && pnpm check:size && pnpm test:coverage && pnpm lint && pnpm typecheck` green from you in pre-flight, since there is no review to trust. An undeclared inline change is a deviation, not a shortcut.

And when that cycle ends in a PR you open yourself, the body carries one line starting with the literal token `navori:no-pilot` — `navori:no-pilot — the operator forbade subagents in this session`. `guard-pr-pilot` blocks a `gh pr create` that comes from neither the pilot nor that line (#705): the measurement that put it there is 37 pilot invocations against 232 PRs opened, 0 of 101 in navori's own repo, and the pilot was never being skipped — its antechamber was never entered.

### Where the depth lives (read it when the moment asks)

The depth sits with whoever owns the moment — open it then: **`.claude/agents/leader.md`** (how to decompose, frugal delegation, the anti-broken-telephone rule and which file each agent writes under `.claude/progress/`, continuous execution and the caps that end a loop, closing the cycle, second opinion, reclaiming a worktree) · **`.claude/skills/ticket-intake/SKILL.md`** (a ticket arrived: the pipeline) · **`.claude/skills/solution-design/SKILL.md`** (an architectural signal fired: the design pass).
<!-- /navori:managed id="orquestacion" -->
