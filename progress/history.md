# History

## 2026-10-05 10:30 codex — Centralize test temporary-directory ownership

Added per-run and per-file temporary ownership, cleanup after supported child completion, watch/fallback cleanup, stable dist-lock coordination and generated coverage-report disposal. Diagnostic evidence and uncertain interrupted roots remain inspectable; caller-owned reports remain preserved.

Independent review reproduced a late-child HOME write missed by the original final snapshot; the final snapshot now runs after child completion and before deletion. A controlled 11-second exact-root removal reproduced Vitest's default 10-second hook failure; a scoped 30-second teardown budget passes that control. The actual hook workload contains approximately 43,000 files / 204 MB and measured 9.1-second cleanup with coverage. This does not establish attribution of the earlier full-gate timeouts.

Validation: exact focused acceptance passed 56 tests. The final reviewer-owned configured full quality gate exited 0: 359 test files, 7195 passed tests, one skipped, coverage floor over 118 modules, lint and typecheck green (295.36-second test run). Two earlier full-gate attempts were red; their timeout attribution remains undetermined. The final controlled cleanup regression and original hook suite both pass.

Publication: the user requested a PR to main; final content receipt, atomic commit and publication follow independent review.
