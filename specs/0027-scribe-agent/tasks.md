# Scribe Agent — Tasks

- [ ] **T1** (R1, R2, R3) — Add `scribe` to the canonical roster, config/schema/catalogs, Claude/Codex rendering, and configure architect/orchestrator profiles. · test: roster/config/render cases with `// Covers: R1, R2, R3`
- [ ] **T2** (R4, R5, R6) — Implement the typed handoff payload schema, scribe renderer, feature/artifact validation, and blocked behavior. · test: payload validation and generated handoff cases with `// Covers: R4, R5, R6`
- [ ] **T3** (R4, R5, R8, R9) — Migrate agent contracts so producers emit payloads, scribe writes supported handoffs, and orchestrator retains root session state. · test: agent-asset and lifecycle cases with `// Covers: R4, R5, R8, R9`
- [ ] **T4** (R7, R9) — Enforce final-review and receipt behavior for scribe-drafted versioned documentation, including drift/delta review. · test: reviewer/publisher receipt lifecycle cases with `// Covers: R7, R9`
