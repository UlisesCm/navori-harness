# History

## 2026-10-08 16:40 claude — Revisión adaptativa, entrega E1 (#1275, PR #1278)

Cambios:
- **M1:** `qualityGate.scoped` y `{{navori.scopedGate}}`. El reviewer corre scoped + `A<n>` en rondas `CHANGES_REQUESTED` y el full solo al firmar `APPROVED`.
- **M2:** `receipt gate` y `receipt sign` para workplans (`decideWorkplanGate`, fail closed a full).
- **M3:** `qualityGate.full` ordenado de barato a caro, `fast` = lint + typecheck y `check:scoped` estático sin tests (~8 s). Se descartó `vitest related`: sobre módulos hub seleccionó 241 archivos y tardó 518 s, contra ~408 s del full.
- El prompt del reviewer volvió bajo su techo de bytes: se quitó el literal del full de la fila CR.
Quality gate: full verde en la ronda de firma, receipt `gateKind: full` (reviewer APPROVED tras 1 CR por bytes del prompt).
Notas: la rama se rebaseó sobre #1276 a mitad de ciclo. Se abrió #1277 (evidencia `A<n>` en worktrees).

## 2026-10-08 13:00 claude — Prompts de reviewer y publisher más chicos (#1264)

Cambios: publisher deja de recalcular el shipping set en prosa y lee `navori receipt check --json` con una tabla estado→acción (28,367 → 24,144 B renderizado); reviewer elimina literales duplicados del gate, la regla de navegador repetida y el Setup 5 que repetía el routing (22,194 → 20,050 B); test nuevo `agent-prompt-bytes` fija topes de bytes; `harnessVersion` registrado por el render.
Quality gate: `bun check` verde, receipt firmado (reviewer APPROVED, nivel 2 con architect + challenge; P-B/R-B descartados).
Notas: comentario de maxWords del publisher quedó desactualizado (3557 palabras reales); ahorro ~6.4 KB por ciclo.

## 2026-10-08 11:30 claude — Tope duro de progress/current.md (#1263, fase 2)

Cambios: el hook de pre-commit bloquea (trinquete) un commit de agente cuyo `progress/current.md` supera 8000 bytes y creció respecto a HEAD; el hook de arranque avisa desde 4000 bytes; `doctor` mide bytes; topes definidos una vez en `doc-budgets.ts` e interpolados en los hooks; sin override. Doctrina de cierre paso 3 actualizada.
Quality gate: verde completo, receipt firmado (reviewer APPROVED, nivel 2 con architect + challenge).
Notas: repos sin `qualityGate.fast` y commits fuera del detector quedan en #1266.

## 2026-10-08 10:30 claude — Acotar progress/current.md (#1263)

Cambios: `navori doctor` avisa (humano y `--json` `progressSize`) cuando `progress/current.md` supera 4000 caracteres (mitad de `SESSION_CONTEXT_DELIVERY_BUDGET_CHARS`), solo informativo; el paso 3 de la doctrina de cierre aclara que los checkpoints van a `history.md`; goldens re-renderizados; `progress/current.md` recortado de 38.8 KB a ~680 caracteres (el log previo queda en `git show 22cc6dea:progress/current.md`).
Quality gate: verde completo, receipt firmado (reviewer APPROVED).
Notas: el primer gate falló por otra sesión corriendo vitest en el mismo checkout; se aisló el trabajo en este worktree.

## 2026-10-05 21:25 codex — Recover audit privacy, usage and bounded mining

Recovered PR #1222's malformed report and context-safe public projection, qualified metadata route and canonical hook capture. Private CLI/lifecycle exports now require checked private storage and explicit identity; human content requires per-call opt-in. Exclusive private arm claims replace the disproved unlink-only contention assumption. Native Node 26 crash tests invoke the built CLI rather than removed TypeScript-transform flags.

Pinned usage tests prove response deduplication, inherited-history exclusion and actual new post-resume child execution. Legacy Claude miners use incremental requested-family scans, shared accounted state and explicit availability/losses while preserving admitted-row parity. Three fresh synthetic 500 MiB parser runs and separate miner probes document sampled resource measurements without universal performance or integrity claims. Bundle comment handling and equivalent explanatory copy preserve executable behavior and every distinct legal notice under the unchanged size limit.

Unrelated master/delivery/plan source inherited from dev was aligned exactly to main; original commits and branches remain preserved. Native render/goldens are part of the recovered audit diff.

Validation: scoped T4, T6 and T8 independent reviews approved. Latest T8/alignment full configured gate exited 0: 361 test files, 7,750 passed tests, two skipped, coverage floor over 118 modules/one documented exception, lint/typecheck green, bundle 1,228,783/1,228,800 bytes. Differential Semgrep reported zero new findings, with limited scanner coverage. Root checked a fresh scoped receipt before closure edits. Whole-PR review on the final documentation and publication remain prerequisites; this entry records verified scoped results. T9–T12 and the separate A5 operator/comparative pilot remain pending.

The first whole-PR review then reproduced false complete coverage for a skipped symlink and stopped before its full gate. A focused correction now records symlink, depth and unreadable-directory losses, preserves them through cached enumeration and distinguishes an absent host root from lost entries. The original repro returns unknown coverage; focused discovery/parse/report/command acceptance passed 508 tests with one existing skip, lint/typecheck green and bundle 1,228,777 bytes. Fresh whole-PR review and stable-byte full validation remain required after this correction.
## 2026-10-05 16:04 codex — Resume A5 after merged guard and retention corrections

Verified PR #1225 merged as 9f3cc9b9 with GitHub quality SUCCESS. Independent correction review passed the complete gate (7288 tests passed, one skipped); commit 50fb1c72 published the late-worker retention fix. The preserved pilot branch integrated current main without conflicts as 47840a4c.

The rebuilt mirror check reported zero drift and local doctor exited 0 with informative warnings. The bounded producer verified local command help and supplied a structured operator checklist plus the measured disposable CLI outcomes. Scribe preflight rejected a session-state Markdown target; the implementer's Python handoff correction then received an implementer-no-markdown denial. Stopped without retry or bypass. The operator subsequently removed that request manually using the absolute handoff path; fresh scribe preflight returned status ok without findings or warnings. Scribe completed the document update. Reviewer requested tier correction before the gate: the inherited full branch classifies at level 1, score 6. The regenerated plan passes check/classify and user approved it with "si vamos"; no new runtime source changes are authorized. Final prose review and the feature gate remain publication prerequisites, with their outcomes recorded in the feature review artifact. Actual operator/client attestations, host-hook correlation, execution interruption/resumption and matched comparative measurements remain pending.

### A5 level-1 verification checkpoint

The fresh reviewer confirmed SPEC_OK and read the inherited main-target shipping context. Its complete gate exited 1: 360 test files passed and one suite failed; 7430 tests passed and one skipped, 284.64s. gate-hook-worktree.test.ts afterAll exceeded the 30000ms budget at vitest.setup.ts:21 during file.dispose. Lint/typecheck were not reached and no receipt was signed.

The exact focused suite later passed 299 tests on the pilot branch (136.08s) and isolated current main 9f3cc9b9 (136.67s). Runs partly overlapped; this is neither a controlled performance comparison nor a matching full-baseline run. A serial unchanged complete gate then repeated the same failure (493.33s,7430 tests passed,one skipped), with no other test process from this session. No receipt, commit or publication followed. The slow disposal phase and failure origin remain unconfirmed; no helper or timeout change was made.

Architect and fresh challenge artifacts now specify a reversible two-file diagnostic observer, ordinary worker-exit JSON delivery outside afterAll, exact target selection and explicit observation-loss/perturbation limits. Root verdict CONCERNS requires nonthrowing collection, preserved HOME/retention/errors/30s budget and removal of only the probe delta. The regenerated level-2 plan passes classify/render/check (score 7 with shared-contract floor; inherited diff score 9); user approved the two-file diagnostic scope with "si vamos con eso". Implementer owns that reversible probe and controls; a fresh reviewer follows. Its diagnostic coverage run cannot be claimed as a shipping gate or permanent fix.

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
## 2026-10-05 22:27 codex — Prepara publicación del piloto A5 con excepción de validación

Resolved the stale CLI hook inventory through the checkout-built CLI and retained the reviewed dual-workflow delivery implementation and pilot documentation. Prepared both disposable repositories for real Claude capture; genuine successful Bash events were consumed through supported acceptance indexing, and both scoped setup reviews and local receipts are approved. No comparative measurement, interruption/resumption, operator/client attestation or A5 completion is inferred.

The user explicitly authorized a bounded timeout exception. Implementer and independent reviewer approved only the new cleanup timeout selector in packages/cli/vitest.setup.ts: NAVORI_A5_CLEANUP_TIMEOUT_EXCEPTION=1 selects 120 seconds; the normal default remains 30 seconds. Cleanup, HOME isolation and retention checks are preserved; no causal performance fix is claimed.

Validation: the complete configured shipping gate exited 0 with 7430 passed, one skipped, zero failed across 361 files (367.09-second test run), plus all prechecks, lint and typecheck green. This result used the disclosed exception flag. Review a5-cleanup-timeout-exception is APPROVED for all 48 main-target shipping paths; supported receipt check reports status ok/fresh true. Publication targets main. Codex's prior PR-creation denial requires the operator's final creation command; no bypass is attempted. Runtime memory identity is unregistered, so this checkpoint is persisted only in project progress.
## 2026-10-05 22:34 codex — Conserva integración A5 para PR draft y continuación mañana

Integrated current main fcf8c8b4 at85bf42bf while preserving approved D3/D4/D5 delivery source and incoming audit source. Implementer resolved source conflicts through exact-byte preservation; supported rendering and golden regeneration reconciled the managed hooks. Scribe restored the approved pilot document from the exact original autostash. Normal merge completion passed all pre-commit checks. Progress conflicts preserve both history branches; original autostash77701a96 remains as a backup and no unrelated shared stash was touched.

Fresh independent integration gate exited1 at check:size: bundle1231.3KB exceeds the unchanged1200KB limit. All preceding checks passed; coverage/lint/types were not reached in this chain. Failure origin is not attributed without a matching baseline. No integration shipping approval or fresh receipt is claimed; the earlier7430-pass gate under the explicit timeout exception belongs to the previous base.

User explicitly chose a draft PR and continuation tomorrow. Publish the branch as WIP only; Codex's prior PR-creation denial requires the operator's final manual command, with no retry or bypass. Next: investigate bundle growth, obtain the necessary scoped source fix through implementer and reviewer, then run the full gate before marking ready. A5 comparison, interruption/resumption and operator/client decisions remain pending. No agent-attributed memory write because runtime identity is unregistered.
## 2026-10-05 22:43 codex — Cierra sesión con PR draft1228

Session closed — 2026-10-05 22:43: operator created PR https://github.com/UlisesCm/navori-harness/pull/1228; fresh GitHub read confirms OPEN, draft=true, target main, head feat/dual-workflow-live-pilot. User explicitly stops here. Next: investigate bundle1231.3KB versus1200KB, scope any fix through implementer then reviewer, and run the complete gate before readiness. Current integration receipt check confirms no matching fresh receipt (stored receipt belongs to prior a5-cleanup-timeout-exception); no repeat full run is attempted at the user's stop. Measured A5 remains pending. Preserve local child repositories, real captures and autostash77701a96. Feature branch remains on this worktree because main is checked out at navori-harness-pr1221; do not move or delete that other worktree. Runtime memory registration remains unavailable, so session closure is persisted in project progress only.
