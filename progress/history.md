# History

## 2026-10-05 15:41 codex — Bind interrupted retention to late workers

User approved the two-file correction after the interruption failure was reproduced on this checkout and isolated origin/main. The run owner publishes a monotonic retention marker before announcing retention; file owners read it after writer completion and HOME evidence checks. Marker I/O errors retain evidence and restore the environment. The guarantee applies to publication before the final deletion decision, without claiming universal cancellation/deletion serialization.

The integration suite replaces the fixed child timer with external release and covers actual post-disposal acknowledgment, publication failures and read failures. Focused acceptance passed 20 tests across two files; lint and format checks exited 0. Independent full-gate validation and a fresh content receipt are publication prerequisites; the final result is reported in [PR #1225](https://github.com/UlisesCm/navori-harness/pull/1225). This entry records the implementation checkpoint before that gate.

The guard was manually committed and pushed as 643b81de; PR #1225 opened as a draft to main. Its original CI quality job could not acquire a hosted runner. A5 operator/client attestations, live interruption/resumption and matched workflow measurements remain pending.

## 2026-10-05 12:17 codex — Unblock A5 Python JSON handoffs

Resolved the installed CLI hook discrepancy with the checkout-built CLI: 19 hooks approved, while the older global CLI resolved 18. The original pilot branch remains preserved.

The implementer guard conflated Markdown report metadata with write destinations. Added a bounded, parse-only Python JSON handoff recognizer; actual or uncertain Markdown writes retain their denials. Native render regenerated both hook mirrors and the Claude golden. The correction is isolated on a branch based on current main.

Validation: independent reviewer APPROVED after the complete configured gate exited 0: 359 test files, 7283 passed tests, one skipped; coverage floor, lint and typecheck green. The focused guard suite passed all 169 cases. Earlier review findings about branch ancestry, explicit types and scanner-compatible fixture construction were corrected through implementer and reviewer.

Publication is blocked: the progress-only receipt-renewal gate then exited 1 with an interrupted-temporary retention failure at `src/__tests__/temp-lifecycle.integration.test.ts:363`. The same focused command reproduced that exact failure on the changed checkout and isolated origin/main (9 passed, one failed each). Coordinator retention is not communicated durably to surviving workers. The two-file lifecycle correction is proposed and awaits explicit expanded-scope approval; no commit or push occurred.

Next: resume the bounded A5 producer on the preserved pilot branch. Operator/client attestations, host-live sensitive-command normalization, interruption/resumption and matched comparative measurements remain pending; the guard approval does not complete A5.

## 2026-10-05 10:30 codex — Centralize test temporary-directory ownership

Added per-run and per-file temporary ownership, cleanup after supported child completion, watch/fallback cleanup, stable dist-lock coordination and generated coverage-report disposal. Diagnostic evidence and uncertain interrupted roots remain inspectable; caller-owned reports remain preserved.

Independent review reproduced a late-child HOME write missed by the original final snapshot; the final snapshot now runs after child completion and before deletion. A controlled 11-second exact-root removal reproduced Vitest's default 10-second hook failure; a scoped 30-second teardown budget passes that control. The actual hook workload contains approximately 43,000 files / 204 MB and measured 9.1-second cleanup with coverage. This does not establish attribution of the earlier full-gate timeouts.

Validation: exact focused acceptance passed 56 tests. The final reviewer-owned configured full quality gate exited 0: 359 test files, 7195 passed tests, one skipped, coverage floor over 118 modules, lint and typecheck green (295.36-second test run). Two earlier full-gate attempts were red; their timeout attribution remains undetermined. The final controlled cleanup regression and original hook suite both pass.

Publication: the user requested a PR to main; final content receipt, atomic commit and publication follow independent review.
