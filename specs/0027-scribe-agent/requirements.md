# Scribe Agent — Requirements

## Context
Implementation agents spend time composing Markdown handoffs that other agents consume. A dedicated fast agent must own those generated handoffs without weakening the evidence, review, or receipt contracts.

## Requirements (EARS)
- **R1** — The system SHALL include `scribe` in the canonical roster, configuration schema, model/effort catalogs, adapters, i18n, and parity checks.
- **R2** — WHEN Navori renders a configured `scribe`, the Claude and Codex adapters SHALL render equivalent model tiers and reasoning effort.
- **R3** — The project configuration SHALL set `architect` to `opus`/`high` and `orchestrator` to `opus`/`medium`; Codex SHALL map those tiers through its canonical tier-to-model map.
- **R4** — WHEN an implementation agent completes code work, it SHALL emit a typed, non-Markdown handoff payload; `scribe` SHALL create the corresponding `impl_<feature>.md` before `reviewer` starts its final review.
- **R5** — WHEN scout, auditor, architect, reviewer, or publisher needs an agent-generated Markdown handoff, it SHALL emit evidence in a typed payload and `scribe` SHALL render the prescribed Markdown artifact without inventing technical claims.
- **R6** — IF a required payload is absent, malformed, belongs to another feature, or cannot be rendered, THEN the consumer SHALL stop with a named blocker and SHALL NOT substitute an unverified Markdown artifact.
- **R7** — WHEN versioned project documentation changes, `scribe` MAY draft it from upstream evidence, but `reviewer` SHALL inspect the complete final code-and-documentation diff and sign a receipt after the last shipping Markdown edit.
- **R8** — The system SHALL preserve single-writer ownership of `progress/current.md` and `progress/history.md` by the orchestrator; these session-state files are outside scribe ownership.
- **R9** — The system SHALL preserve the existing implementer → reviewer requirement for every shipping source change and shall not allow a scribe artifact to bypass it.

