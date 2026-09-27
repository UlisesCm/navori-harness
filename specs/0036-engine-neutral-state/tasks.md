# Engine-neutral ephemeral state — Tasks

One PR for #1046. Batches follow dependency order; each implementation slice uses the
implementer → reviewer chain and keeps this file current. Before editing hooks or generated
assets, refresh `origin/main`, inspect the landed Spec 0035 contract, and integrate its shared
input helper rather than duplicating it. No implementation starts from the other session's
uncommitted checkout.

## Batch A — Root identity and safe I/O

- [x] **T1** (R1, R2, R3, R6) — Add one checkout-contained state-root resolver in
  `packages/cli/src/lib/primitives/` and make handoff, plan, receipt, and `lib/plan/gate.ts`
  use it, including the gate's rejection log. Validate the feature slug before forming names and
  validate final artifact paths. Reject traversal, external absolute paths, and symlinked
  ancestors before any outside read or write; preserve explicit in-checkout legacy `--dir`.
  Resolve nested `--cwd` to its checkout root; reject symlinks in any supplied `--cwd`
  component and non-Git `--cwd` for enabled CLI gates. Validate the `nivel-0` gate branch too,
  preserving its existing behavior when `planTiers` is off. Do not claim resistance to a
  concurrently malicious local writer; the accepted threat boundary is in design D2.
  - Test: `lib/primitives/__tests__/state-root.test.ts` cases for neutral default, two linked
    worktrees, valid explicit legacy path, separator-bearing feature, `../`, external absolute
    path, symlinked `.navori` or destination, nested `--cwd`, ancestor-symlinked `--cwd` into
    another checkout, non-Git `--cwd`, raw in-checkout `..`, and enabled/disabled `nivel-0`
    gate behavior, with `// Covers: R1, R2, R3, R6`.
- [x] **T2** (R3, R4, R11) — Select one feature-scoped root for the entire invocation: neutral
  precedence, exactly one legacy match during the compatibility release, and explicit failure
  for two legacy matches. Do not treat a differently keyed receipt as a match or retry another
  root after a missing artifact.
  - Test: `lib/primitives/__tests__/state-root.test.ts` cases for all root combinations and
    continuation writes across plan, handoff, and receipt, with `// Covers: R3, R4, R11`.
- [x] **T3** (R5) — Make `checkReceipt` reject a mismatched `header.feature` for active and
  consumed receipts even with explicit `--dir`.
  - Test: `lib/diagnose/__tests__/receipt.test.ts` wrong-feature active and consumed cases,
    with `// Covers: R5`.

## Batch B — Git hygiene and render boundaries

- [x] **T4** (R7, R8, R11) — Narrow generated root ignore to `.navori/state/`, add neutral
  state to shared ephemeral and unreviewable-path registries, retain legacy exclusions for this
  release, and render protective `.navori/.gitignore`, `.claude/.gitignore`, and
  `.codex/.gitignore` in off/local/full modes, even for Claude-only configuration, without
  touching surrounding user content or presets.
  - Test: `engines/shared/__tests__/nested-gitignore.test.ts` and
    `commands/__tests__/render-gitignore.test.ts` exercise `git check-ignore -v`, tracked
    presets, legacy ignore in Claude-only/off mode, and edited blocks, with
    `// Covers: R7, R8, R11`.
- [x] **T5** (R8) — Keep neutral and legacy runtime state out of render/sync/backup outputs;
  add doctor findings for tracked or unignored state, a nonprotective nested block, and a broad
  user-authored `.navori/` rule that hides presets. Never auto-move or delete state.
  - Test: `engines/claude/__tests__/render-backup-exclude.test.ts` and
    `commands/__tests__/git-hygiene-doctor.test.ts` cover backup manifests and each finding,
    with `// Covers: R8`.

## Batch C — Hook ownership and generated contracts

- [ ] **T6** (R2, R10) — Move managed-drift and routing-watch stamps to checkout-local
  `.navori/state/hooks/` while retaining session-ID sanitization and fail-safe detector behavior.
  Leave old Git-common-dir stamps untouched and document the one-time re-arming of notices.
  - Test: `lib/__tests__/managed-drift-watch.test.ts` and
    `lib/__tests__/routing-watch.test.ts` cover two linked worktrees, identical session IDs,
    unsafe/missing roots, and old-stamp preservation, with `// Covers: R2, R10`.
- [ ] **T7** (R1, R9, R12) — Change source assets and Codex adaptation to cite neutral
  handoffs; remove only Codex's progress-path rewrite. Preserve engine vocabulary, hook
  registration, and the landed Spec 0035 input parser. Move `lib/plan/gate.ts` and
  `hooks/subagent-stop-handoff.sh` to the selected neutral/legacy feature root as appropriate.
  Re-render managed outputs. **Gate:** record the Spec 0035 merge commit and inspect its real
  helper/API first; if not merged, stop this batch instead of inventing a parallel helper.
  - Test: `lib/__tests__/handoff-wiring.test.ts`, `engines/codex/__tests__/render-codex.test.ts`,
    `lib/plan/__tests__/gate.test.ts`, a handoff-hook test, and
    `engines/__tests__/golden-render-tree.test.ts` assert Claude/Codex parity, rejection-log
    routing, neutral backstop scanning, and one input parse, with `// Covers: R1, R9, R12`.
- [x] **T8** (R6, R7, R10, R11) — Publish migration guidance in the existing user-facing docs:
  state ownership, the one-release read window, unchanged old stamps, re-arming, rollback, and
  versioned `progress/` versus versionable presets. State the trusted local-writer boundary and
  the possible outside-checkout I/O under concurrent malicious directory changes explicitly;
  do not promise automatic cleanup or race-proof containment.
  - Test: `bun run check:links` plus `lib/__tests__/handoff-wiring.test.ts` assertions for the
    stated paths and threat boundary, with `// Covers: R6, R7, R10, R11`.

## Closeout

- [ ] **T9** (R1–R12) — Verify a `// Covers: R<n>` test for every requirement, run the full
  project quality gate and reviewer Pass 2, then publish only after APPROVED and a fresh receipt.
  - Test: per-requirement annotation sweep over the tests named above and the full quality gate,
    with `// Covers: R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12` in the final integration
    test rather than a prose-only assertion.
