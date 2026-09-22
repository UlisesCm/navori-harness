# Main-session model advisor — Tasks

- [x] **T1** (R1, R2, R3, R5, R7) — Record verified host contracts and implement/test the pure advisor classifier.
- [x] **T2** (R1, R2, R4, R5, R6) — Render and test Claude session-model state plus first-main-tool advisory hook.
- [x] **T3** (R3, R4, R5, R6) — Render and test Codex SessionStart Astra advisory hook.
- [x] **T4** (R1–R7) — Add localized copy and regression tests proving subagent profiles remain unchanged.
- [x] **T5** (R5, R8) — Discard subagent tool events in shell, before the advisor's `node` block, and pin the absent spawn with a test.
- [x] **T6** (R1, R2, R5, R9) — Settle main-thread tool events in shell with `$CLAUDE_EFFORT` and sentinel files, keeping the mid-session effort rise detectable and failing open when the variable is undefined.
