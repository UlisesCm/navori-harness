# Engine-neutral ephemeral state — Requirements

**Status:** draft · **Issue:** #1046 · **Base reviewed:** `origin/main` at `3bf6b61f` · **Date:** 2026-09-26

## Context

Runtime handoffs are split between `.claude/progress/` and `.codex/progress/`, while hook stamps
live under Git's common directory. A new engine inherits path translation and linked worktrees
can share hook state. The user approved checkout-local `.navori/state/` and one release of readable
legacy handoffs. Versioned `progress/` and `.navori/presets/` are not ephemeral.

## Requirements (EARS)

- **R1** — WHEN a new feature writes a plan, handoff, or receipt without `--dir`, the CLI SHALL
  place it beneath the active checkout's `.navori/state/handoffs/`, independent of engine.
- **R2** — WHEN two linked worktrees use the same feature or session identifier, the system SHALL
  keep their handoffs, receipts, and hook stamps isolated to their respective checkouts.
- **R3** — WHEN an invocation specifies `--dir`, the CLI SHALL use only that directory for its
  reads and writes; it SHALL NOT silently fall back to another state root.
- **R4** — WHEN `--dir` is omitted for a feature with existing legacy artifacts, the CLI SHALL
  select one feature-matching root consistently for reads and continuation writes for one
  compatibility release. IF more than one legacy root matches, THEN it SHALL fail with an
  instruction to supply `--dir`. A neutral match SHALL take precedence over legacy matches.
- **R5** — WHEN checking an active or consumed receipt, the CLI SHALL reject a receipt whose
  declared feature differs from the requested feature, regardless of root selection or `--dir`.
- **R6** — IF the feature identifier, supplied `--cwd`, state root, or explicit handoff directory
  contains an unsafe path component detectable at validation time (separator in feature,
  symlink, `..` traversal, or an absolute path outside the checkout), THEN every state-reading
  or state-writing command SHALL reject it before accessing that path. A nested, nonsymlinked
  `--cwd` SHALL resolve to its Git checkout top level; a symlinked `--cwd` or non-Git directory
  SHALL fail closed for enabled CLI gates. A process that concurrently modifies checkout
  directories can still redirect CLI reads or writes outside the checkout; defending against
  that concurrent local writer is explicitly outside this requirement.
- **R7** — WHEN navori generates ignore rules, it SHALL ignore `.navori/state/` without ignoring
  `.navori/presets/`; with root-ignore management disabled, a nested `.navori/.gitignore` SHALL
  protect state while preserving user-authored rules.
- **R8** — WHEN render, sync, backup, or doctor inspect the checkout, they SHALL classify
  `.navori/state/` and legacy ephemeral roots as runtime data, exclude them from backup and
  versioned output, and never remove or relocate existing state automatically. Doctor SHALL
  report tracked or unignored state and a broad user-authored `.navori/` rule that hides presets.
- **R9** — WHEN generated agents, skills, hooks, the plan gate, and CLI defaults refer to new
  ephemeral state, they SHALL use the engine-neutral contract, without a Codex-specific
  progress-path rewrite. The handoff backstop SHALL inspect neutral handoffs, and engine-specific
  vocabulary adaptation SHALL remain intact.
- **R10** — WHEN a hook records or checks a detector stamp, it SHALL use checkout-local
  `.navori/state/hooks/`, preserve sanitized session identifiers, and fail safely if the checkout
  or state root is unavailable. The migration SHALL document and test that old shared stamps
  remain untouched and notices may re-arm once.
- **R11** — WHEN migrating from a previous render, existing handoffs under `.claude/progress/`
  or `.codex/progress/` SHALL remain readable for one compatibility release and ignored by Git
  in every engine/mode combination, including Claude-only with root-ignore management off;
  no command SHALL copy, move, or delete them as part of the upgrade.
- **R12** — WHEN rendering both Claude and Codex after the pending Codex parity changes, tests
  SHALL verify the same neutral handoff and hook-state paths for both engines without dropping
  hook registration or introducing duplicate input parsing.

## Not in scope

- Moving versioned `progress/current.md` or `progress/history.md`.
- Moving, deleting, or automatically importing legacy files or Git-common-dir hook stamps.
- Adding a public configurable state-root option beyond existing `--dir`.
- Replacing user-authored broad ignore rules; doctor reports the consequence instead.
