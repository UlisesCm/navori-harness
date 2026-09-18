# Scribe Agent — Design

## Approach
Add a fast `scribe` agent that converts typed payloads into agent-generated Markdown handoffs. Producers retain responsibility for evidence, but no longer write Markdown. This replaces prose composition with a small, machine-verifiable serialization step before each dependent consumer.

The scope is deliberately **not** literal ownership of every repository `.md`: `progress/current.md` and `progress/history.md` remain orchestrator-owned session state, while user-authored/policy Markdown remains a shipping artifact subject to normal implementation and review. This boundary avoids overwriting concurrent state and preserves human-owned documents.

## Components
- `packages/cli/src/engines/shared/roster.ts` — canonical `scribe` roster entry — covers R1.
- `packages/cli/src/lib/{config,recommended,schema,i18n}.ts` — configuration and catalog support — covers R1, R3.
- `packages/cli/src/engines/{claude,codex}/` — adapter rendering and tier mapping — covers R2, R3.
- `packages/core/core-assets/agents/scribe.md` — typed-payload-to-Markdown contract — covers R4–R8.
- `packages/core/core-assets/agents/{implementer,scout,auditor,architect,reviewer,publisher,orchestrator}.md` — producers emit payloads and consumers wait for the matching artifact — covers R4–R9.
- `packages/cli/src/**/__tests__/` — roster parity, rendering, payload validation, and receipt lifecycle tests — covers R1–R9.

## Decisions
- **Scribe owns formatting, not evidence.** Producers emit structured facts and citations; scribe must not infer, investigate, or add claims. This preserves authorship while removing Markdown work from implementer (R4, R5).
- **One required payload per artifact.** Payloads are feature-scoped and validated before rendering. A failed render blocks its next consumer rather than making the consumer guess (R6).
- **No false parallel final review.** Scribe may prepare independent documentation while a reviewer does an early code read, but the reviewer performs one final review over the complete diff after the final Markdown change (R7, R9).
- **Session state remains orchestrator-only.** Scribe cannot write root `progress/*.md` (R8).
- **Use the existing semantic model tiers.** `opus` maps to Codex's canonical high tier; no per-engine profile fork is introduced (R2, R3).

## Contracts
Each payload must have: `feature`, `artifact`, `status`, `summary`, `evidence`, `filesTouched`, and `verification`. It is non-Markdown and must be attributable to one producer. Scribe validates feature/artifact consistency and renders the fixed artifact path. Consumers reject missing or mismatched artifacts.

## Failure modes
- Missing/malformed payload: scribe returns `BLOCKED`; downstream agent does not start/finalize.
- Scribe artifact after reviewer receipt: publisher detects receipt drift and returns it for delta review.
- Concurrent payloads: feature-specific filenames prevent collisions; root session state is excluded.

## Migration
1. Add scribe and typed payload support alongside current Markdown handoffs.
2. Migrate agents one producer/consumer pair at a time with compatibility reads during the transition.
3. Remove direct Markdown-writing instructions only when every consumer validates the typed path.

## Testing strategy
- Roster/config/render tests prove `scribe` reaches Claude and Codex with equivalent tiers.
- Schema tests reject invalid payloads and preserve feature attribution.
- Lifecycle tests prove reviewer blocks without a rendered implementation artifact and publisher rejects Markdown written after receipt signing.
- Config tests assert architect/orchestrator profiles and Codex tier mapping.

## NOT in scope
- Changing the required final reviewer pass.
- Allowing scribe to write root session state or user-authored Markdown without an upstream implementation decision.
- Claiming that final approval can run concurrently with a shipping Markdown change.

