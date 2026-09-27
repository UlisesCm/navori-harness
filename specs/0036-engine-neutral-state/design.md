# Engine-neutral ephemeral state — Design

**Issue:** #1046 · **Base reviewed:** `origin/main` at `3bf6b61f` · **Signals:** shared CLI/generated-asset contract, checkout-scoped ownership, migration, render and hook safety.

## Approach

Use one checkout-local, engine-neutral runtime namespace: `.navori/state/handoffs/` for plans, handoffs, and receipts, and `.navori/state/hooks/` for detector stamps. The active checkout, not Git's common directory or the selected engine, owns both. Keep `progress/current.md` and `progress/history.md` versioned and `.navori/presets/` versionable. Extend the existing ephemeral-path registry and nested-ignore renderer rather than introducing a second state manager. This satisfies R1, R2, R7–R10.

The existing pattern of `.claude/progress/` plus Codex path rewriting is the cheapest change but cannot give an N+1 engine a neutral contract or isolate hook stamps. Neutral handoffs with shared Git-common-dir stamps preserve existing hook semantics but fail checkout isolation (R2). The user chose checkout-local state and one release of legacy reads. Rollback uses the older render and explicit `--dir`; no state is moved or deleted.

## Components

- `packages/cli/src/lib/primitives/` — a shared state-root resolver for handoff, plan, receipt, and the plan gate. It selects **one** feature root and validates the feature slug plus canonical containment of each final artifact path before any state access or write (R1–R6, R9, R11). The public `--dir` remains the only override; do not repurpose deprecated `progress.dir` from `packages/cli/src/lib/config/schema.ts`.
- `packages/cli/src/commands/{handoff,plan,receipt}.ts` and their library helpers — remove the engine-relative defaults, pass the selected root through the whole invocation, and never silently retry another root after a read failure (R1, R3–R5, R11). Receipt validation belongs in `packages/cli/src/lib/diagnose/receipt.ts`, at `checkReceipt` after `readReceiptFile`, not solely in root selection (R5).
- `packages/cli/src/engines/shared/ephemeral-paths.ts` (`EPHEMERAL_HARNESS_PATHS`) and `packages/cli/src/lib/primitives/progress-dirs.ts` (`PROGRESS_DIRS`) — include `.navori/state/` in ignore, backup, doctor, and unreviewable-path boundaries; retain both legacy progress roots and legacy stamp entries during compatibility (R7, R8, R11).
- `packages/cli/src/engines/shared/gitignore-harness.ts`, `nested-gitignore-harness.ts` (`renderNestedGitignore`), `packages/cli/src/commands/render.ts` (`runRender`), and `packages/cli/src/commands/doctor.ts` — narrow the managed root rule from `.navori/` to `.navori/state/`, render `.navori/.gitignore` with only `state/` even when root-ignore management is off, preserve user-authored rules, and diagnose tracked/unignored state or broad rules that hide presets (R7, R8).
- `packages/core/core-assets/hooks/{managed-drift-watch,routing-watch}.sh` — write detector stamps under checkout-local `.navori/state/hooks/`, retaining sanitized session IDs and fail-open detector behavior when state cannot be made safe (R2, R10). `hooks/subagent-stop-handoff.sh` also scans neutral handoffs while retaining legacy visibility. `packages/cli/src/lib/plan/gate.ts` reads and writes the selected feature root, including its rejection log. Generated agent/skill/hook text and `packages/cli/src/engines/codex/compat.ts` use neutral handoff references; only the progress-path rewrite goes away, not engine vocabulary or hook registration (R9, R12).
- Render/sync/backup exclusion consumers of `EPHEMERAL_HARNESS_PATHS`, including `packages/cli/src/engines/shared/execute-plan.ts` (`commitWrites`), remain the single exclusion path. They must never treat the whole `.navori/` directory as ephemeral (R7, R8).

## Decisions and contracts

### D1 — One feature-scoped root (R1, R3, R4, R11)

Explicit `--dir` selects exactly that directory for every read and continuation write; it never falls back. Without `--dir`, inspect feature identity in the active checkout only. A feature-matching neutral artifact wins. Otherwise, exactly one matching legacy root is selected for the entire invocation and its continuation writes. If both `.claude/progress/` and `.codex/progress/` match, fail with an actionable `--dir` message. If none matches, use `.navori/state/handoffs/`. Do not let `receipt.txt` alone count as a match: parse its header and compare the feature, including the consumed receipt. A command must not pick a different root merely because its own artifact is absent in the selected root; report the missing artifact. This deliberately favors consistency over opportunistic cross-root recovery.

Feature identity is checked against each recognized workplan/handoff's feature-bearing filename or payload, and a receipt's parsed header. An invalid or unreadable candidate is an error within a selected root, not permission to switch roots. The selection is performed once at the CLI boundary and passed to plan/handoff/receipt helpers; there is no helper-local fallback. For a new feature, all writes use the neutral root. No cross-worktree search is permitted.

### D2 — Canonical, fail-closed state paths (R2, R3, R6)

Inspect every lexical component of the supplied `--cwd` before resolving it: reject symlinks at any level, including host aliases such as `/var` (the caller can pass the physical `/private/var` path). Then use `git rev-parse --show-toplevel` to identify the active checkout. A nested nonsymlinked directory is valid; a non-Git directory fails closed for enabled CLI gates. Validate each feature with the existing `FEATURE_SLUG` shape from `lib/handoff/check.ts` before forming a path, then validate the final artifact path as well as the root. Reject raw `..` segments of relative `--dir` **before** `resolve` normalizes them. Absolute `--dir` is accepted **only** when its canonical target remains inside the checkout, so an old external handoff path requires an explicit manual relocation rather than an unsafe exception. Reject symlinked ancestors and state targets observed at validation time, even if they point back inside the checkout. For missing components, inspect existing ancestors with `lstat`/`realpath`, create one directory at a time, then recheck canonical containment and symlink status immediately before opening or renaming a state file. Writes use exclusive temporary files in the validated directory and reject a symlinked destination. Reads use the same observed-path policy. An unsafe or inaccessible root fails closed for enabled CLI gates; detector hooks instead exit without writing or marking a detector complete.

The resolver is a static-input safety boundary, **not** a generic filesystem sandbox. The user accepted a trusted local-writer threat model: another process that concurrently replaces or moves checkout directories may still cause CLI reads or writes outside the checkout between validation and use. Immediate rechecks reduce the window but do not close that race; neither path strings nor simple `openat` guarantee checkout containment after an already-open directory moves. Do not claim otherwise in docs or review. The resolver must not delete paths or repair a symlink. Test `.navori` and final handoff-directory symlinks, ancestor `--cwd` symlinks (including a link into a second checkout), absolute external paths, raw traversal within the checkout, and a valid explicit legacy path inside the checkout.

### D3 — Receipt identity is a gate invariant (R5)

`checkReceipt` rejects `header.feature !== options.feature` for active and consumed receipts, including an explicit `--dir`. This check runs before reporting freshness or success. Root selection may use the header to choose a legacy root, but it cannot replace the check: a receipt can change between selection and validation. A mismatch is an error, never a stale-but-acceptable receipt.

### D4 — Narrow ignore and non-destructive render (R7, R8, R11)

During the compatibility release, render protects **both** legacy progress roots unconditionally,
including a Claude-only repo with root-ignore management off. This is a retained-state safety
rule, not a reason to render the Codex engine itself.

Append `.navori/state/` to `EPHEMERAL_HARNESS_PATHS`; retain legacy paths for one compatibility release. Its shared consumers exclude runtime state from backup, managed ignore, and doctor, but never exclude `.navori/presets/`. Render invokes `renderNestedGitignore(cwd, ".navori", …)` as it already does for `.claude` and `.codex`; the generated nested managed block contains only `state/` and preserves surrounding user content. Managed root ignore narrows its own `.navori/` entry. Do not rewrite a user-authored broad ignore; doctor reports that it hides presets. Doctor also reports a tracked state file, an unignored state root, or an edited nested block that no longer protects `state/`. Render, sync, and backup do not copy, move, prune, or snapshot new or legacy runtime state, including on upgrade or rollback.

### D5 — Hooks and Codex parity (R2, R9, R10, R12)

Detector hooks derive the active checkout root, validate `.navori/state/hooks/`, sanitize session identifiers as before, and write separate managed-drift/routing-watch namespaces there. A missing checkout, unsafe root, or unwritable state makes a detector exit without stamping or mutating the repository. Old Git-common-dir stamps remain untouched; each worktree starts a fresh detector baseline, so a notice can re-arm once after upgrade. Document this behavior in the user-facing migration notes and prove it with two linked worktrees using the same session ID.

Spec 0035 is active in another checkout, **not assumed merged**. Before editing hooks or generated assets, fetch and rebase on current `origin/main`, record the merge commit that contains Spec 0035, and inspect its actual helper/API. If it has not landed, stop hook implementation rather than inventing a parallel parser or path helper. Change its landed shared helper instead of layering a second parser. Keep every registered Codex hook connected. A combined Claude/Codex render test must assert neutral handoff and hook paths, one input parse, and unchanged hook registration; it is not enough to assert a transformed string in `compat.ts`.

## Failure modes and migration

An in-flight feature under one legacy root continues there for the compatibility release; explicit `--dir` remains deterministic afterward. Neutral artifacts win over stale legacy artifacts. Two matching legacy roots require human disambiguation. A receipt for another feature never authorizes the requested feature. A read or write through an escaping/symlinked state root fails rather than creating untracked files elsewhere. Ignore drift is diagnosed, not force-overwritten. Hook state is reset per checkout without cleaning old shared stamps. These are compatibility behaviors, not an import mechanism (R3–R8, R10, R11).

Release notes state that legacy `.claude/progress/` and `.codex/progress/` remain readable and ignored for **one release**, but will not be automatically copied, moved, or deleted when that window ends. Existing `<git-common-dir>/navori/` stamps are likewise left in place. The versioned root `progress/` and presets are not migrated.

## Testing strategy

| Risk | Probe criterion | Requirements |
|---|---|---|
| Engine-specific default or cross-worktree collision | Two linked worktrees using the same feature/session ID produce distinct handoff, receipt, and stamp paths; new writes are neutral in both | R1, R2, R10 |
| Inconsistent fallback | For neutral + legacy matches, neutral wins for plan, handoff, and receipt; for one legacy match, all three stay there; for two legacy matches, all fail with `--dir`; explicit `--dir` never falls back | R3, R4, R11 |
| Wrong-feature authorization | A feature-B `receipt.txt` and `receipt.consumed.txt` both fail feature-A checks, including explicit `--dir` | R5 |
| Unsafe paths observed at validation | Separator-bearing feature, symlinked `.navori`, symlinked handoff target, raw `..` including in-checkout traversal, and absolute external `--dir` reject; nested physical `--cwd` resolves to checkout root, ancestor-symlinked/non-Git `--cwd` fails; valid in-checkout legacy `--dir` works. Concurrent hostile checkout mutation is out of scope, not a passing security probe | R6 |
| Ignore or backup regression | `git check-ignore -v`, `git status`, render/backup manifests, and doctor results across off/local/full modes show state excluded, presets available, broad user rule reported, and no state relocation | R7, R8, R11 |
| Generated-asset parity | Claude and Codex output share neutral references; Codex vocabulary and registered hooks remain; hook input is parsed once with or without Spec 0035 landed | R9, R12 |
| Detector migration | Same session ID in two worktrees gives isolated stamps; old common-dir stamp remains unchanged; first post-upgrade notice can re-arm once; unsafe/missing root leaves no stamp | R2, R10 |

Tests covering each requirement carry the `// Covers: R<n>` annotation required by the spec contract. The test list in `tasks.md` binds each R1–R12 to at least one named case.

## NOT in scope

- Moving or ignoring versioned `progress/`, changing local preset semantics, or adding a configurable state root.
- Automatically copying, deleting, or importing legacy handoffs or hook stamps, including when compatibility expires.
- Broadening user-authored ignore rules or silently forcing edited managed blocks.
- Implementing Spec 0035 inside this issue; only integrate with its landed contract before #1046 implementation.
