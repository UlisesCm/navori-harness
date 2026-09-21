# Scribe Agent — Tasks

- [x] **T1** (R1, R2, R3) — Add `scribe` to the canonical roster, config/schema/catalogs, Claude/Codex rendering, and configure architect/orchestrator profiles. · test: roster/config/render cases with `// Covers: R1, R2, R3`
- [ ] ~~T2~~ **WITHDRAWN, not started** (was R4, R5, R6) — Implement the typed handoff payload schema, scribe renderer, feature/artifact validation, and blocked behavior. See "Amendment — T2/T3/T4 withdrawn" in `design.md`.
- [ ] ~~T3~~ **WITHDRAWN, not started** (was R4, R5, R8, R9) — Migrate agent contracts so producers emit payloads, scribe writes supported handoffs, and orchestrator retains root session state. See "Amendment — T2/T3/T4 withdrawn" in `design.md`.
- [ ] ~~T4~~ **WITHDRAWN, not started** (was R7, R9) — Enforce final-review and receipt behavior for scribe-drafted versioned documentation, including drift/delta review. See "Amendment — T2/T3/T4 withdrawn" in `design.md`.

## Amendment (2026-09-21)
T2, T3, and T4 are withdrawn: subagent cold-start cost (~25k tokens, `cache_creation` pricing, no `cache_read` reuse) dominates the ~2k tokens of Markdown a scribe hop would serialize, and the chain would also force an orchestrator turn that doesn't exist today (no agent holds the `Agent` tool). Full evidence and cost accounting in `design.md`. T1 stays delivered as-is; `scribe` remains in the roster, unused pending a producer/consumer contract.
