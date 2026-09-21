# Scribe Agent — Design

## Approach
Add a fast `scribe` agent that converts typed payloads into agent-generated Markdown handoffs. Producers retain responsibility for evidence, but no longer write Markdown. This replaces prose composition with a small, machine-verifiable serialization step before each dependent consumer.

The scope is deliberately **not** literal ownership of every repository `.md`: `progress/current.md` and `progress/history.md` remain orchestrator-owned session state, while user-authored/policy Markdown remains a shipping artifact subject to normal implementation and review. This boundary avoids overwriting concurrent state and preserves human-owned documents.

## Components
- `packages/cli/src/engines/shared/roster.ts` — canonical `scribe` roster entry — covers R1.
- `packages/cli/src/lib/{config,recommended,schema,i18n}.ts` — configuration and catalog support — covers R1, R3.
- `packages/cli/src/engines/{claude,codex}/` — adapter rendering and tier mapping — covers R2, R3.
- `packages/core/core-assets/agents/scribe.md` — typed-payload-to-Markdown contract — covers R4–R8. WITHDRAWN (2026-09-21, see "Amendment" below) for R4–R7: this contract was never implemented; `scribe.md` keeps its "not yet wired" note. Still covers R8.
- `packages/core/core-assets/agents/{implementer,scout,auditor,architect,reviewer,publisher,orchestrator}.md` — producers emit payloads and consumers wait for the matching artifact — covers R4–R9. WITHDRAWN (2026-09-21) for R4–R7, same as above: no producer/consumer agent file was changed to emit or wait for typed payloads. Still covers R8, R9 (both predate and do not depend on scribe).
- `packages/cli/src/**/__tests__/` — roster parity, rendering, payload validation, and receipt lifecycle tests — covers R1–R9. WITHDRAWN (2026-09-21) for the payload-validation and receipt-lifecycle tests tied to R4–R7 — never written, since T2/T3/T4 never started. Roster/rendering tests for R1–R3 shipped in T1 and remain in place.

## Decisions
- **Scribe owns formatting, not evidence.** Producers emit structured facts and citations; scribe must not infer, investigate, or add claims. This preserves authorship while removing Markdown work from implementer (R4, R5). WITHDRAWN (2026-09-21, see "Amendment" below): R4 and R5 are withdrawn, so this decision was never implemented — recorded here for the historical record of the original design intent.
- **One required payload per artifact.** Payloads are feature-scoped and validated before rendering. A failed render blocks its next consumer rather than making the consumer guess (R6). WITHDRAWN (2026-09-21): R6 is withdrawn; no payload schema or rendering gate was built.
- **No false parallel final review.** Scribe may prepare independent documentation while a reviewer does an early code read, but the reviewer performs one final review over the complete diff after the final Markdown change (R7, R9). Partially WITHDRAWN (2026-09-21): the R7 half (scribe drafting docs from upstream evidence) is withdrawn and unimplemented. The R9 half (reviewer performs one final review over the complete diff) is still in force — it predates scribe and does not depend on it.
- **Session state remains orchestrator-only.** Scribe cannot write root `progress/*.md` (R8). Still in force — unaffected by the withdrawal.
- **Use the existing semantic model tiers.** `opus` maps to Codex's canonical high tier; no per-engine profile fork is introduced (R2, R3). Still in force — T1 shipped this.

## Contracts
Each payload must have: `feature`, `artifact`, `status`, `summary`, `evidence`, `filesTouched`, and `verification`. It is non-Markdown and must be attributable to one producer. Scribe validates feature/artifact consistency and renders the fixed artifact path. Consumers reject missing or mismatched artifacts.

## Failure modes
- Missing/malformed payload: scribe returns `BLOCKED`; downstream agent does not start/finalize.
- Scribe artifact after reviewer receipt: publisher detects receipt drift and returns it for delta review.
- Concurrent payloads: feature-specific filenames prevent collisions; root session state is excluded.

## Migration
1. Add scribe and typed payload support alongside current Markdown handoffs. **Done (T1)**: scribe added to the roster/config/adapters; no typed-payload support was built.
2. Migrate agents one producer/consumer pair at a time with compatibility reads during the transition. WITHDRAWN (2026-09-21, see "Amendment" below): never started, no producer/consumer agent file was touched.
3. Remove direct Markdown-writing instructions only when every consumer validates the typed path. WITHDRAWN (2026-09-21): moot — step 2 never started, so this step has no precondition to satisfy. Agents keep writing Markdown directly, as before scribe.

## Testing strategy
- Roster/config/render tests prove `scribe` reaches Claude and Codex with equivalent tiers. Still in force — shipped in T1.
- Schema tests reject invalid payloads and preserve feature attribution. WITHDRAWN (2026-09-21, see "Amendment" below): R6's payload schema was never built, so this test category was never written (T2).
- Lifecycle tests prove reviewer blocks without a rendered implementation artifact and publisher rejects Markdown written after receipt signing. WITHDRAWN (2026-09-21): tied to R4/R5/R7's rendering pipeline, never built (T3/T4).
- Config tests assert architect/orchestrator profiles and Codex tier mapping. Still in force — shipped in T1.

## Amendment — T2/T3/T4 withdrawn (2026-09-21)
T1 shipped (roster, config, rendering). T2, T3, and T4 — the typed-payload pipeline that would route implementer handoffs through `scribe` — are withdrawn before implementation. `scribe` stays in the roster with its current "not yet wired" note in `packages/core/core-assets/agents/scribe.md`; that note remains accurate and is out of scope for this amendment.

### Why: subagent cold start dominates the work being delegated
Per the official docs on subagents and prompt caching (https://code.claude.com/docs/en/prompt-caching.md, section "Subagents and the cache"): a subagent starts its own conversation with its own system prompt and tool set, separate from the parent's; its first request doesn't read the parent's cache because the prefixes differ, so it warms a cache of its own and pays `cache_creation` pricing rather than the much cheaper `cache_read` (0.1x). Subagents also fall outside the main conversation's TTL bucket, getting only a 5-minute TTL by default — shorter than a typical implementer cycle, so each scribe invocation in the intended per-handoff flow pays a fresh cold start rather than reusing a warm cache.

### The numbers
- **Artifact size** (measured in this repo): 68 files matching `.claude/progress/impl_*.md`, mean 1,528 words / median 1,341 / max 5,479 ≈ ~2,000 tokens for a typical handoff.
- **Subagent cold-start cost** (prior measurement, MCP-grants experiment in this repo): ~25,000 tokens of context to spin up a subagent turn.
- **Official pricing** (per 1M tokens): Opus 5 $5 in / $25 out, Sonnet 5 $2 in / $10 out, Haiku 4.5 $1 in / $5 out.
- **Today** (implementer/sonnet writes the handoff itself): ~2,000 output tokens on sonnet ≈ $0.020 marginal.
- **With scribe**: ~25,000 tokens of cold-start context on haiku at `cache_creation` pricing (1.25x the $1/1M input rate) ≈ $0.031, plus ~2,000 output tokens on haiku ≈ $0.010, totaling ≈ **$0.041** — and that excludes the orchestrator turn described below, so the real delta is larger still.
- **Dispatch mechanism, not a new turn**: `implementer` does not hold the `Agent` tool (`packages/core/core-assets/agents/implementer.md:4` — `Read, Write, Edit, Glob, Grep, Bash, Monitor, TaskStop`), so it cannot invoke `scribe` directly; the handoff has to go through the orchestrator, which does hold `Agent` (`packages/core/core-assets/agents/orchestrator.md:4` — `Read, Glob, Grep, Bash, Agent`). But that round-trip is not a new mechanism the scribe change would introduce — the orchestrator already dispatches every subagent (implementer, reviewer, scout, etc.) through that same `Agent` tool today. What scribe adds is one more dispatch per cycle, not a new kind of turn, so its marginal cost is lower than a naive "doubles the cost" framing would suggest.

**Conclusion**: the subagent's own cold start (~25k tokens) costs more than the ~2k-token artifact it would produce. Delegating handoff serialization to `scribe` is not an economy under current pricing and TTL behavior — the cold-start-vs-artifact-size gap carries the conclusion on its own, independent of the dispatch-mechanism point above.

### Open question (not a task)
`scribe` may still pay off where the producer agent is context-saturated (so offloading formatting has a different marginal cost) or for artifacts substantially larger than ~2k tokens (where the fixed cold-start cost amortizes better). Neither condition is verified; this is a research note, not a commitment, and no task tracks it.

## NOT in scope
- Changing the required final reviewer pass.
- Allowing scribe to write root session state or user-authored Markdown without an upstream implementation decision.
- Claiming that final approval can run concurrently with a shipping Markdown change.

